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
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
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