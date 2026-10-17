CREATE TABLE IF NOT EXISTS room_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_occupancy INT NOT NULL DEFAULT 2 CHECK (max_occupancy >= 1)
);

ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_occupancy INT;
UPDATE room_types SET max_occupancy = 2 WHERE max_occupancy IS NULL;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS description TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS room_types_name_unique_idx
  ON room_types (LOWER(name));

CREATE TABLE IF NOT EXISTS rate_plans (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  nightly_rate NUMERIC(12, 2) NOT NULL CHECK (nightly_rate >= 0),
  currency CHAR(3) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  room_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  maintenance_from DATE,
  maintenance_to DATE,
  maintenance_note TEXT
);

-- The system manages a single hotel: drop the multi-hotel columns from older databases.
ALTER TABLE rooms DROP COLUMN IF EXISTS hotel_id;
ALTER TABLE room_types DROP COLUMN IF EXISTS hotel_id;
DROP TABLE IF EXISTS hotels;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS maintenance_from DATE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS maintenance_to DATE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS maintenance_note TEXT;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_status_check;
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_maintenance_check;
UPDATE rooms
SET status = 'available', maintenance_from = NULL, maintenance_to = NULL, maintenance_note = NULL
WHERE status NOT IN ('available', 'maintenance')
   OR (status = 'maintenance' AND (maintenance_from IS NULL OR maintenance_to IS NULL OR maintenance_to <= maintenance_from))
   OR (status = 'available' AND (maintenance_from IS NOT NULL OR maintenance_to IS NOT NULL));
ALTER TABLE rooms ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('available', 'maintenance'));
ALTER TABLE rooms ADD CONSTRAINT rooms_maintenance_check CHECK (
  (status = 'available' AND maintenance_from IS NULL AND maintenance_to IS NULL)
  OR (status = 'maintenance' AND maintenance_from IS NOT NULL AND maintenance_to > maintenance_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS rooms_room_number_unique_idx
  ON rooms (LOWER(room_number));

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
  CHECK (check_out > check_in)
);

ALTER TABLE holds ADD COLUMN IF NOT EXISTS room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS holds_room_dates_idx
  ON holds (room_type_id, check_in, check_out);

CREATE INDEX IF NOT EXISTS holds_room_id_dates_idx
  ON holds (room_id, check_in, check_out);

CREATE INDEX IF NOT EXISTS holds_expiry_idx
  ON holds (expires_at)
  WHERE status = 'held';

CREATE TABLE IF NOT EXISTS room_type_photos (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_type_photos_type_idx
  ON room_type_photos (room_type_id, sort_order, created_at);
