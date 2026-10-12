CREATE TABLE IF NOT EXISTS hotels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_types (
  id TEXT PRIMARY KEY,
  hotel_id TEXT NOT NULL REFERENCES hotels(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_plans (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  nightly_rate NUMERIC(12, 2) NOT NULL CHECK (nightly_rate >= 0),
  currency CHAR(3) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  hotel_id TEXT NOT NULL REFERENCES hotels(id),
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  room_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'maintenance', 'inactive')),
  UNIQUE (hotel_id, room_number)
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
  CHECK (check_out > check_in)
);

CREATE INDEX IF NOT EXISTS holds_room_dates_idx
  ON holds (room_type_id, check_in, check_out);

CREATE INDEX IF NOT EXISTS holds_expiry_idx
  ON holds (expires_at)
  WHERE status = 'held';