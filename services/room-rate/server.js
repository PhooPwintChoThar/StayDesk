import { readFile } from 'node:fs/promises';
import { app, assignRoomsToLegacyHolds } from './app.js';
import { pool } from './db.js';
import { seedSampleData } from './sample-data.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await pool.query(schema);
if (await seedSampleData(pool, { onlyIfEmpty: true })) {
  console.log('Empty database: inserted sample room types, photos and rooms.');
}
await assignRoomsToLegacyHolds(pool);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Room-rate service listening on port ${port}`));
