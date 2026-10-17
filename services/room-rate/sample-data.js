import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ROOM_TYPES = [
  { id: 'standard', name: 'Standard', description: 'Queen bed, city view, rain shower', maxOccupancy: 2, rate: 150, photos: ['standard-1.jpg', 'standard-2.jpg', 'standard-3.jpg'] },
  { id: 'deluxe', name: 'Deluxe', description: 'King bed and lounge, balcony, bathtub', maxOccupancy: 4, rate: 240, photos: ['deluxe-1.jpg', 'deluxe-2.jpg', 'deluxe-3.jpg', 'deluxe-4.jpg'] }
];

const ROOMS = [
  ['room-101', 'standard', '101'],
  ['room-102', 'standard', '102'],
  ['room-103', 'standard', '103'],
  ['room-201', 'deluxe', '201'],
  ['room-202', 'deluxe', '202']
];

// Inserts the two sample room types (with photos), their rates and five rooms.
// With onlyIfEmpty it does nothing once the hotel has any room type, so a
// manager's own setup is never touched on restart.
export async function seedSampleData(db, { onlyIfEmpty = false } = {}) {
  if (onlyIfEmpty) {
    const existing = await db.query('SELECT 1 FROM room_types LIMIT 1');
    if (existing.rowCount) return false;
  }

  for (const type of ROOM_TYPES) {
    await db.query(
      `INSERT INTO room_types (id, name, description, max_occupancy)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         max_occupancy = EXCLUDED.max_occupancy`,
      [type.id, type.name, type.description, type.maxOccupancy]
    );
    await db.query(
      `INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency, active)
       VALUES ($1, $2, $3, 'USD', TRUE)
       ON CONFLICT (id) DO UPDATE SET nightly_rate = EXCLUDED.nightly_rate, active = TRUE`,
      [`${type.id}-flex`, type.id, type.rate]
    );

    const photos = await db.query('SELECT 1 FROM room_type_photos WHERE room_type_id = $1 LIMIT 1', [type.id]);
    if (!photos.rowCount) {
      for (const [index, file] of type.photos.entries()) {
        const data = await readFile(new URL(`./sample-photos/${file}`, import.meta.url));
        await db.query(
          `INSERT INTO room_type_photos (id, room_type_id, content_type, data, sort_order)
           VALUES ($1, $2, 'image/jpeg', $3, $4)`,
          [randomUUID(), type.id, data, index]
        );
      }
    }
  }

  for (const [id, roomTypeId, roomNumber] of ROOMS) {
    await db.query(
      `INSERT INTO rooms (id, room_type_id, room_number) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, roomTypeId, roomNumber]
    );
  }
  return true;
}
