CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'refund')),
  reservation_no TEXT,
  guest_id TEXT,
  deposit_id UUID REFERENCES payments(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'declined', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (type = 'deposit' AND deposit_id IS NULL)
    OR (type = 'refund' AND deposit_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS payments_deposit_id_idx ON payments (deposit_id);

CREATE TABLE IF NOT EXISTS payment_proofs (
  id UUID PRIMARY KEY,
  reservation_no TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  note TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INT NOT NULL CHECK (file_size > 0),
  file_data BYTEA NOT NULL,
  status TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_proofs_reservation_no_idx
  ON payment_proofs (reservation_no, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS payment_proofs_guest_id_idx
  ON payment_proofs (guest_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS payment_proofs_status_idx
  ON payment_proofs (status, created_at DESC, id DESC);
-- Human-readable, traceable payment numbers.
CREATE SEQUENCE IF NOT EXISTS payment_proof_no_seq;
ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS payment_no TEXT;
ALTER TABLE payment_proofs ALTER COLUMN payment_no
  SET DEFAULT 'PMT-' || LPAD(nextval('payment_proof_no_seq')::text, 6, '0');
UPDATE payment_proofs SET payment_no = DEFAULT WHERE payment_no IS NULL;
ALTER TABLE payment_proofs ALTER COLUMN payment_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_proofs_payment_no_idx ON payment_proofs (payment_no);

CREATE SEQUENCE IF NOT EXISTS payment_txn_no_seq;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_no TEXT;
ALTER TABLE payments ALTER COLUMN payment_no
  SET DEFAULT 'TXN-' || LPAD(nextval('payment_txn_no_seq')::text, 6, '0');
UPDATE payments SET payment_no = DEFAULT WHERE payment_no IS NULL;
ALTER TABLE payments ALTER COLUMN payment_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_no_idx ON payments (payment_no);

-- At check-out the deposit is captured (applied to the bill) and any balance
-- collected at the desk is recorded as a settlement.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_check;
ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('deposit', 'refund', 'settlement'));
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('authorized', 'declined', 'refunded', 'captured'));
ALTER TABLE payments ADD CONSTRAINT payments_check CHECK (
  (type IN ('deposit', 'settlement') AND deposit_id IS NULL)
  OR (type = 'refund' AND deposit_id IS NOT NULL)
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS reviewed_by_role TEXT;


-- Transactional outbox: review notifications wait here until the broker accepts them.
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


-- Cancelling a booking cancels its pending proofs; money already approved
-- becomes refund_due until staff confirm it was returned (refunded).
ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_status_check;
ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refund_due', 'refunded'));
ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS refunded_by TEXT;
