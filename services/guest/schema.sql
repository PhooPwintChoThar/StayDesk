CREATE TABLE IF NOT EXISTS guests (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS guests_email_unique_idx
  ON guests (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS guests_phone_unique_idx
  ON guests (REGEXP_REPLACE(phone, '[^0-9]', '', 'g'))
  WHERE phone IS NOT NULL AND phone <> '';