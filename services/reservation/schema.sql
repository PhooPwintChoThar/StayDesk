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
  deposit_net NUMERIC(12, 2) CHECK (deposit_net IS NULL OR deposit_net >= 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  guests INT CHECK (guests IS NULL OR guests >= 1),
  cancelled_at TIMESTAMPTZ,
  refund_amount NUMERIC(12, 2) CHECK (refund_amount IS NULL OR refund_amount >= 0),
  cancellation_fee NUMERIC(12, 2) CHECK (cancellation_fee IS NULL OR cancellation_fee >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (check_out > check_in)
);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guests INT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_net NUMERIC(12, 2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12, 2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(12, 2);

CREATE TABLE IF NOT EXISTS reservation_payments (
  id UUID PRIMARY KEY,
  reservation_no TEXT NOT NULL REFERENCES reservations(reservation_no) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'topup', 'refund', 'cancellation_refund')),
  billing_payment_id TEXT,
  deposit_ref TEXT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  reason TEXT,
  actor_id TEXT,
  actor_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reservation_payments_reservation_no_idx
  ON reservation_payments (reservation_no, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS reservation_payments_deposit_ref_idx
  ON reservation_payments (deposit_ref);