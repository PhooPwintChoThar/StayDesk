import pg from 'pg';

const database = process.env.NODE_ENV === 'test' ? 'guest_test' : 'guest_db';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || `postgres://postgres:postgres@localhost:55432/${database}`
});
