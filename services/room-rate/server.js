import { readFile } from 'node:fs/promises';
import { app } from './app.js';
import { pool } from './db.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await pool.query(schema);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Room-rate service listening on port ${port}`));
