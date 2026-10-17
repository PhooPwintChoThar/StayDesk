import pg from 'pg';

const database = process.env.NODE_ENV === 'test' ? 'reservation_test' : 'reservation_db';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || `postgres://postgres:postgres@localhost:55432/${database}`
});
