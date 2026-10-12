CREATE TABLE IF NOT EXISTS reservations (
  reservation_no TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL,
  room_type_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
  deposit_id TEXT,
  deposit_amount NUMERIC(12, 2) NOT NULL CHECK (deposit_amount >= 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (check_out > check_in)
);