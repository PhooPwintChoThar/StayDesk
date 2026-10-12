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