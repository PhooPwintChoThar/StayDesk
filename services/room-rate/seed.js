import { readFile } from 'node:fs/promises';
import { pool } from './db.js';
import { seedSampleData } from './sample-data.js';

try {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await seedSampleData(pool);
  console.log('Room-rate sample data inserted.');
} finally {
  await pool.end();
}
