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
  status TEXT NOT NULL,
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
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS room_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_by TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_out_by TEXT;

-- A booking is pending until staff approve a payment for it.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled'));
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_stay_times_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_stay_times_check CHECK (
  (checked_in_at IS NULL OR status = 'confirmed')
  AND (checked_out_at IS NULL OR (checked_in_at IS NOT NULL AND checked_out_at >= checked_in_at))
);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS room_number TEXT;

CREATE INDEX IF NOT EXISTS reservations_guest_id_idx
  ON reservations (guest_id, check_in DESC);

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
-- Everyone staying, beyond the guest who booked: name and passport/ID number.
CREATE TABLE IF NOT EXISTS reservation_guests (
  id UUID PRIMARY KEY,
  reservation_no TEXT NOT NULL REFERENCES reservations(reservation_no) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position >= 2),
  full_name TEXT NOT NULL CHECK (full_name <> ''),
  id_document TEXT NOT NULL CHECK (id_document <> ''),
  UNIQUE (reservation_no, position)
);

-- Check-out settles the bill: the balance paid at the desk is a ledger row.
ALTER TABLE reservation_payments DROP CONSTRAINT IF EXISTS reservation_payments_type_check;
ALTER TABLE reservation_payments ADD CONSTRAINT reservation_payments_type_check
  CHECK (type IN ('deposit', 'topup', 'refund', 'cancellation_refund', 'settlement'));
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS balance_collected NUMERIC(12, 2);

-- Transactional outbox: events wait here until the broker has accepted them.
CREATE TABLE IF NOT EXISTS event_outbox (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS event_outbox_pending_idx
  ON event_outbox (id) WHERE published_at IS NULL;
