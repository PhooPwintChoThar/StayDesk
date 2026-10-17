import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

try {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);

  await pool.query(`
    INSERT INTO hotels (id, name)
    VALUES ('hotel-1', 'Demo Hotel')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `);

  await pool.query(`
    INSERT INTO room_types (id, hotel_id, name, max_occupancy)
    VALUES
      ('standard', 'hotel-1', 'Standard', 2),
      ('deluxe', 'hotel-1', 'Deluxe', 4)
    ON CONFLICT (id) DO UPDATE SET
      hotel_id = EXCLUDED.hotel_id,
      name = EXCLUDED.name,
      max_occupancy = EXCLUDED.max_occupancy
  `);

  await pool.query(`
    INSERT INTO rate_plans (id, room_type_id, nightly_rate, currency, active)
    VALUES
      ('standard-flex', 'standard', 150.00, 'USD', TRUE),
      ('deluxe-flex', 'deluxe', 240.00, 'USD', TRUE)
    ON CONFLICT (id) DO UPDATE SET
      nightly_rate = EXCLUDED.nightly_rate,
      currency = EXCLUDED.currency,
      active = EXCLUDED.active
  `);

  await pool.query(`
    INSERT INTO rooms (id, hotel_id, room_type_id, room_number)
    VALUES
      ('room-101', 'hotel-1', 'standard', '101'),
      ('room-102', 'hotel-1', 'standard', '102'),
      ('room-201', 'hotel-1', 'deluxe', '201')
    ON CONFLICT (id) DO NOTHING
  `);

  console.log('Room-rate seed data inserted.');
} finally {
  await pool.end();
}
