import pg from 'pg';

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
        || 'postgres://postgres:postgres@localhost:55432/payment_db'
});