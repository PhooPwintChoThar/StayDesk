import { readFile } from 'node:fs/promises';
import { app, outbox } from './app.js';
import { pool } from './db.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await pool.query(schema);
outbox.start();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Billing service listening on port ${port}`));
