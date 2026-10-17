CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  reservation_no TEXT,
  guest_id TEXT,
  channel TEXT,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_reservation_no_idx
  ON notifications (reservation_no, created_at DESC);
