CREATE TABLE IF NOT EXISTS guests (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  id_document TEXT,
  preferences TEXT,
  loyalty_tier TEXT NOT NULL DEFAULT 'none',
  loyalty_number TEXT,
  consent_at TIMESTAMPTZ,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE guests ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_document TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS preferences TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS loyalty_tier TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS loyalty_number TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS password_hash TEXT;

UPDATE guests SET loyalty_tier = 'none' WHERE loyalty_tier IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guests_email_unique_idx
  ON guests (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS guests_phone_unique_idx
  ON guests (REGEXP_REPLACE(phone, '[^0-9]', '', 'g'))
  WHERE phone IS NOT NULL AND phone <> '';

CREATE UNIQUE INDEX IF NOT EXISTS guests_loyalty_number_unique_idx
  ON guests (LOWER(loyalty_number))
  WHERE loyalty_number IS NOT NULL AND loyalty_number <> '';
