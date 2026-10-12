import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
        || 'postgres://postgres:postgres@localhost:55432/room_rate_db'
});