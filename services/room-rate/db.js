import pg from 'pg';

const database = process.env.NODE_ENV === 'test' ? 'room_rate_test' : 'room_rate_db';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || `postgres://postgres:postgres@localhost:55432/${database}`
});
