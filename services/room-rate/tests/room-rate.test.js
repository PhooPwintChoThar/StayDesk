import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { assignRoomsToLegacyHolds, createApp } from '../app.js';
import { seedSampleData } from '../sample-data.js';
import { pool } from '../db.js';

const now = new Date('2027-03-01T12:00:00');
const app = createApp({ db: pool, clock: () => now });
const checkIn = '2027-03-10';
const checkOut = '2027-03-12';

const hold = (body = {}) =>
  request(app).post('/holds').send({ roomTypeId: 'test-room-type', checkIn, checkOut, ...body });

const availability = (query = {}) =>
  request(app).get('/availability').query({ checkIn, checkOut, ...query });

beforeAll(async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
});

beforeEach(async () => {
  await pool.query('TRUNCATE holds, rooms, rate_plans, room_type_photos, room_types CASCADE');
  await pool.query(`
    INSERT INTO room_types (id, name, max_occupancy)
      VALUES ('test-room-type', 'Test Room', 2);
    INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency)
      VALUES ('test-rate', 'test-room-type', 120.00, 'USD');
    INSERT INTO rooms (id, room_type_id, room_number)
      VALUES ('test-room-1', 'test-room-type', '101');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('availability and holds', () => {
  it('returns availability for a room type', async () => {
    const response = await availability();

    expect(response.status).toBe(200);
    expect(response.body.availability).toEqual([
      expect.objectContaining({
        roomTypeId: 'test-room-type',
        name: 'Test Room',
        available: true,
        roomsAvailable: 1,
        nightlyRate: 120,
        currency: 'USD'
      })
    ]);
  });

  it('assigns a concrete room to a hold and reduces availability', async () => {
    const created = await hold();

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      roomId: 'test-room-1',
      roomNumber: '101',
      checkIn,
      checkOut,
      status: 'held'
    });

    const response = await availability();
    expect(response.body.availability[0]).toMatchObject({ available: false, roomsAvailable: 0 });
  });

  it('assigns different rooms to overlapping holds and frees rooms for other dates', async () => {
    await pool.query("INSERT INTO rooms (id, room_type_id, room_number) VALUES ('test-room-2', 'test-room-type', '102')");

    const first = await hold();
    const second = await hold({ checkIn: '2027-03-11', checkOut: '2027-03-13' });
    const third = await hold({ checkIn: '2027-03-11', checkOut: '2027-03-12' });
    const later = await hold({ checkIn: '2027-03-13', checkOut: '2027-03-14' });

    expect(first.body.roomNumber).toBe('101');
    expect(second.body.roomNumber).toBe('102');
    expect(third.status).toBe(409);
    expect(later.status).toBe(201);
  });

  it('excludes a specified hold and keeps its room when the stay is modified', async () => {
    await pool.query("INSERT INTO rooms (id, room_type_id, room_number) VALUES ('test-room-0', 'test-room-type', '100')");
    const created = await hold({ checkIn: '2027-03-10', checkOut: '2027-03-11' });
    await pool.query("UPDATE holds SET room_id = 'test-room-1' WHERE id = $1", [created.body.id]);

    const response = await availability({ excludeHoldId: created.body.id });
    expect(response.body.availability[0]).toMatchObject({ roomsAvailable: 2 });

    const replacement = await hold({ excludeHoldId: created.body.id });
    expect(replacement.status).toBe(201);
    expect(replacement.body.roomId).toBe('test-room-1');
  });

  it('stops counting a hold after its 10-minute expiry', async () => {
    const created = await hold();
    await pool.query('UPDATE holds SET expires_at = $2 WHERE id = $1', [
      created.body.id,
      new Date(now.getTime() - 1000).toISOString()
    ]);

    const response = await availability();
    expect(response.body.availability[0]).toMatchObject({ available: true, roomsAvailable: 1 });
  });

  it('allows only one of two concurrent holds on the last room', async () => {
    const responses = await Promise.all([hold(), hold()]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
  });

  it('filters availability by occupancy and hides room types without a rate', async () => {
    await pool.query(`
      INSERT INTO room_types (id, name, max_occupancy) VALUES ('family-room', 'Family', 4), ('no-rate', 'No Rate', 6);
      INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency) VALUES ('family-rate', 'family-room', 200, 'USD');
    `);

    const byGuests = await availability({ guests: 3 });

    expect(byGuests.status).toBe(200);
    expect(byGuests.body.availability.map((row) => row.roomTypeId)).toEqual(['family-room']);
    expect(byGuests.body.availability[0]).toMatchObject({ available: false, roomsAvailable: 0 });
  });

  it('confirms and releases a hold, and rejects releasing it twice', async () => {
    const created = await hold();

    const confirmed = await request(app).post(`/holds/${created.body.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');

    expect((await request(app).delete(`/holds/${created.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`/holds/${created.body.id}`)).status).toBe(409);
    expect((await availability()).body.availability[0].roomsAvailable).toBe(1);
  });

  it('assigns rooms to active holds created before room-level inventory', async () => {
    await pool.query(
      `INSERT INTO holds (id, room_type_id, check_in, check_out, expires_at, status)
       VALUES ('legacy', 'test-room-type', $1, $2, $3, 'confirmed')`,
      [checkIn, checkOut, now.toISOString()]
    );

    await assignRoomsToLegacyHolds(pool, now);

    const stored = await pool.query("SELECT room_id FROM holds WHERE id = 'legacy'");
    expect(stored.rows[0].room_id).toBe('test-room-1');
    expect((await availability()).body.availability[0].roomsAvailable).toBe(0);
  });
});

describe('room types', () => {
  it('lists room types with their rate and room count', async () => {
    const response = await request(app).get('/room-types');

    expect(response.status).toBe(200);
    expect(response.body.roomTypes).toEqual([
      {
        id: 'test-room-type',
        name: 'Test Room',
        description: null,
        maxOccupancy: 2,
        nightlyRate: 120,
        currency: 'USD',
        roomCount: 1,
        photos: []
      }
    ]);
  });

  it('creates, updates and deletes a room type in the database', async () => {
    const created = await request(app)
      .post('/room-types')
      .send({ name: 'Junior Suite', maxOccupancy: 3, nightlyRate: 199.5, description: 'Sea view' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'junior-suite',
      name: 'Junior Suite',
      maxOccupancy: 3,
      nightlyRate: 199.5,
      currency: 'USD',
      roomCount: 0
    });

    const duplicate = await request(app)
      .post('/room-types')
      .send({ name: 'junior suite', maxOccupancy: 2, nightlyRate: 100 });
    expect(duplicate.status).toBe(409);

    const updated = await request(app)
      .patch('/room-types/junior-suite')
      .send({ nightlyRate: 210, maxOccupancy: 4 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ nightlyRate: 210, maxOccupancy: 4, name: 'Junior Suite' });

    const rate = await pool.query("SELECT nightly_rate::float AS rate FROM rate_plans WHERE room_type_id = 'junior-suite'");
    expect(rate.rows).toEqual([{ rate: 210 }]);

    expect((await request(app).delete('/room-types/junior-suite')).status).toBe(200);
    const left = await pool.query("SELECT 1 FROM room_types WHERE id = 'junior-suite'");
    expect(left.rowCount).toBe(0);
  });

  it('validates room type input', async () => {
    const response = await request(app)
      .post('/room-types')
      .send({ name: '', maxOccupancy: 0, nightlyRate: -5 });

    expect(response.status).toBe(400);
  });

  it('refuses to delete a room type that still has rooms or bookings', async () => {
    expect((await request(app).delete('/room-types/test-room-type')).status).toBe(409);

    await hold();
    await pool.query('DELETE FROM rooms');
    expect((await request(app).delete('/room-types/test-room-type')).status).toBe(409);
  });
});

describe('rooms', () => {
  it('lists rooms with type, price and status', async () => {
    const response = await request(app).get('/rooms');

    expect(response.status).toBe(200);
    expect(response.body.rooms).toEqual([
      expect.objectContaining({
        id: 'test-room-1',
        roomNumber: '101',
        status: 'available',
        maintenanceFrom: null,
        maintenanceTo: null,
        roomTypeId: 'test-room-type',
        roomTypeName: 'Test Room',
        nightlyRate: 120,
        currency: 'USD',
        upcomingReservations: 0
      })
    ]);
  });

  it('creates a room with an existing room type', async () => {
    const created = await request(app).post('/rooms').send({ roomTypeId: 'test-room-type', roomNumber: '102' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ roomNumber: '102', status: 'available', roomTypeId: 'test-room-type' });

    const listed = await request(app).get('/rooms');
    expect(listed.body.rooms.map((room) => room.roomNumber)).toEqual(['101', '102']);
    expect((await availability()).body.availability[0].roomsAvailable).toBe(2);
  });

  it('creates a room together with a new room type in one step', async () => {
    const created = await request(app).post('/rooms').send({
      roomNumber: '301',
      newRoomType: { name: 'Family Suite', maxOccupancy: 5, nightlyRate: 320 }
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      roomNumber: '301',
      roomTypeId: 'family-suite',
      roomTypeName: 'Family Suite',
      nightlyRate: 320,
      maxOccupancy: 5
    });
  });

  it('rolls back a new room type when the room number is taken', async () => {
    const response = await request(app).post('/rooms').send({
      roomNumber: '101',
      newRoomType: { name: 'Penthouse', maxOccupancy: 4, nightlyRate: 900 }
    });

    expect(response.status).toBe(409);
    const types = await pool.query("SELECT 1 FROM room_types WHERE name = 'Penthouse'");
    expect(types.rowCount).toBe(0);
  });

  it('rejects bad room input', async () => {
    expect((await request(app).post('/rooms').send({ roomNumber: '102' })).status).toBe(400);
    expect((await request(app).post('/rooms').send({ roomTypeId: 'test-room-type' })).status).toBe(400);
    expect((await request(app).post('/rooms').send({ roomTypeId: 'nope', roomNumber: '102' })).status).toBe(404);
  });

  it('renames a room and blocks a type change while it has upcoming reservations', async () => {
    await pool.query("INSERT INTO room_types (id, name) VALUES ('other', 'Other')");

    const renamed = await request(app).patch('/rooms/test-room-1').send({ roomNumber: '101A' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.roomNumber).toBe('101A');

    const created = await hold();
    await request(app).post(`/holds/${created.body.id}/confirm`);

    const blocked = await request(app).patch('/rooms/test-room-1').send({ roomTypeId: 'other' });
    expect(blocked.status).toBe(409);
    expect((await request(app).delete('/rooms/test-room-1')).status).toBe(409);

    await request(app).delete(`/holds/${created.body.id}`);
    const moved = await request(app).patch('/rooms/test-room-1').send({ roomTypeId: 'other' });
    expect(moved.status).toBe(200);
    expect(moved.body.roomTypeId).toBe('other');

    expect((await request(app).delete('/rooms/test-room-1')).status).toBe(200);
    expect((await request(app).get('/rooms')).body.rooms).toEqual([]);
  });
});

describe('maintenance', () => {
  it('puts a room under maintenance for a period and takes it out of availability', async () => {
    const response = await request(app)
      .put('/rooms/test-room-1/maintenance')
      .send({ from: '2027-03-09', to: '2027-03-11', note: 'Repaint' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'maintenance',
      maintenanceFrom: '2027-03-09',
      maintenanceTo: '2027-03-11',
      maintenanceNote: 'Repaint'
    });

    expect((await availability()).body.availability[0].roomsAvailable).toBe(0);
    expect((await hold()).status).toBe(409);
    expect((await availability({ checkIn: '2027-03-11', checkOut: '2027-03-12' })).body.availability[0].roomsAvailable).toBe(1);
  });

  it('refuses maintenance when the room is reserved in that period', async () => {
    const created = await hold();
    await request(app).post(`/holds/${created.body.id}/confirm`);

    const response = await request(app)
      .put('/rooms/test-room-1/maintenance')
      .send({ from: '2027-03-11', to: '2027-03-15' });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('2027-03-10 to 2027-03-12');

    const stored = await pool.query("SELECT status FROM rooms WHERE id = 'test-room-1'");
    expect(stored.rows[0].status).toBe('available');
  });

  it('allows maintenance outside the reserved period', async () => {
    const created = await hold();
    await request(app).post(`/holds/${created.body.id}/confirm`);

    const response = await request(app)
      .put('/rooms/test-room-1/maintenance')
      .send({ from: '2027-03-12', to: '2027-03-14' });

    expect(response.status).toBe(200);
  });

  it('ignores released and expired holds when checking for reservations', async () => {
    const released = await hold();
    await request(app).delete(`/holds/${released.body.id}`);
    const expired = await hold();
    await pool.query("UPDATE holds SET status = 'expired' WHERE id = $1", [expired.body.id]);

    const response = await request(app)
      .put('/rooms/test-room-1/maintenance')
      .send({ from: checkIn, to: checkOut });

    expect(response.status).toBe(200);
  });

  it('validates the maintenance period', async () => {
    const past = await request(app).put('/rooms/test-room-1/maintenance').send({ from: '2027-02-01', to: '2027-02-03' });
    const reversed = await request(app).put('/rooms/test-room-1/maintenance').send({ from: '2027-03-05', to: '2027-03-04' });
    const missing = await request(app).put('/rooms/missing/maintenance').send({ from: '2027-03-05', to: '2027-03-06' });

    expect(past.status).toBe(400);
    expect(reversed.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it('ends maintenance and returns the room to available', async () => {
    await request(app).put('/rooms/test-room-1/maintenance').send({ from: checkIn, to: checkOut });

    const response = await request(app).delete('/rooms/test-room-1/maintenance');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'available', maintenanceFrom: null, maintenanceTo: null });
    expect((await availability()).body.availability[0].roomsAvailable).toBe(1);
  });

  it('returns a room to available once its maintenance window has passed', async () => {
    await pool.query(
      "UPDATE rooms SET status = 'maintenance', maintenance_from = '2027-02-20', maintenance_to = '2027-03-01' WHERE id = 'test-room-1'"
    );

    const response = await request(app).get('/rooms');

    expect(response.body.rooms[0]).toMatchObject({ status: 'available', maintenanceFrom: null });
  });
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('room type photos', () => {
  it('uploads several photos, serves them intact and lists them in order', async () => {
    const uploaded = await request(app)
      .post('/room-types/test-room-type/photos')
      .attach('photos', jpeg, 'a.jpg')
      .attach('photos', png, 'b.png');

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.photos).toHaveLength(2);
    expect(uploaded.body.photos[0].url).toMatch(/^\/room-types\/test-room-type\/photos\//);

    const more = await request(app).post('/room-types/test-room-type/photos').attach('photos', jpeg, 'c.jpg');
    expect(more.body.photos).toHaveLength(3);

    const served = await request(app).get(uploaded.body.photos[1].url).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(served.body, png)).toBe(0);

    const listed = await availability();
    expect(listed.body.availability[0].photos.map((photo) => photo.id)).toEqual(more.body.photos.map((photo) => photo.id));
  });

  it('rejects files that are not images', async () => {
    const response = await request(app)
      .post('/room-types/test-room-type/photos')
      .attach('photos', Buffer.from('not an image'), 'evil.jpg');

    expect(response.status).toBe(400);
    const stored = await pool.query('SELECT COUNT(*)::int AS count FROM room_type_photos');
    expect(stored.rows[0].count).toBe(0);
  });

  it('deletes a photo', async () => {
    const uploaded = await request(app).post('/room-types/test-room-type/photos').attach('photos', jpeg, 'a.jpg');
    const photo = uploaded.body.photos[0];

    const deleted = await request(app).delete(photo.url);

    expect(deleted.status).toBe(200);
    expect(deleted.body.photos).toEqual([]);
    expect((await request(app).get(photo.url)).status).toBe(404);
  });
});

describe('room availability for the front desk', () => {
  it('shows each room as available, booked or under maintenance for a date range', async () => {
    await pool.query(`
      INSERT INTO rooms (id, room_type_id, room_number) VALUES
        ('test-room-2', 'test-room-type', '102'),
        ('test-room-3', 'test-room-type', '103')
    `);
    const booked = await hold();
    await request(app).post(`/holds/${booked.body.id}/confirm`);
    await request(app).put('/rooms/test-room-3/maintenance').send({ from: '2027-03-11', to: '2027-03-13' });

    const response = await request(app).get('/rooms/availability').query({ checkIn, checkOut });

    expect(response.status).toBe(200);
    expect(response.body.rooms.map((room) => [room.roomNumber, room.state])).toEqual([
      ['101', 'booked'],
      ['102', 'available'],
      ['103', 'maintenance']
    ]);
    expect(response.body.rooms[0].bookings).toEqual([{ checkIn, checkOut, status: 'confirmed' }]);
    expect(response.body.summary).toEqual({ total: 3, available: 1, booked: 1, maintenance: 1 });
    expect((await request(app).get('/rooms/availability').query({ checkIn: 'x' })).status).toBe(400);
  });
});

describe('sample data', () => {
  it('fills an empty hotel with two room types, photos and five rooms, and leaves an existing setup alone', async () => {
    expect(await seedSampleData(pool, { onlyIfEmpty: true })).toBe(false);

    await pool.query('TRUNCATE holds, rooms, rate_plans, room_type_photos, room_types CASCADE');
    expect(await seedSampleData(pool, { onlyIfEmpty: true })).toBe(true);

    const types = (await request(app).get('/room-types')).body.roomTypes;
    expect(types.map((type) => [type.name, type.roomCount, type.photos.length > 0])).toEqual([
      ['Standard', 3, true],
      ['Deluxe', 2, true]
    ]);
    expect((await request(app).get(types[0].photos[0].url)).headers['content-type']).toBe('image/jpeg');
  });
});

describe('completing a stay', () => {
  it('frees the remaining nights after an early check-out', async () => {
    const created = await hold({ checkIn: '2027-03-10', checkOut: '2027-03-14' });
    await request(app).post(`/holds/${created.body.id}/confirm`);

    const completed = await request(app).post(`/holds/${created.body.id}/complete`).send({ checkOut: '2027-03-11' });

    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ checkIn: '2027-03-10', checkOut: '2027-03-11', status: 'confirmed' });
    expect((await availability({ checkIn: '2027-03-11', checkOut: '2027-03-14' })).body.availability[0].roomsAvailable).toBe(1);
    expect((await availability({ checkIn: '2027-03-10', checkOut: '2027-03-11' })).body.availability[0].roomsAvailable).toBe(0);
  });

  it('keeps at least the first night and never extends a stay', async () => {
    const created = await hold({ checkIn: '2027-03-10', checkOut: '2027-03-12' });
    await request(app).post(`/holds/${created.body.id}/confirm`);

    const sameDay = await request(app).post(`/holds/${created.body.id}/complete`).send({ checkOut: '2027-03-10' });
    expect(sameDay.body.checkOut).toBe('2027-03-11');
    const late = await request(app).post(`/holds/${created.body.id}/complete`).send({ checkOut: '2027-03-20' });
    expect(late.body.checkOut).toBe('2027-03-11');
    expect((await request(app).post('/holds/missing/complete').send({ checkOut: '2027-03-11' })).status).toBe(404);
  });
});

