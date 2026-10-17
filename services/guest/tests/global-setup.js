import pg from 'pg';

// The suites TRUNCATE their tables, so they must never run against a live database.
export default async function globalSetup() {
  process.env.NODE_ENV = 'test';
  const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:55432/guest_test');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${name}": use a database whose name ends in _test.`);
  }

  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
