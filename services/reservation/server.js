import { readFile } from 'node:fs/promises';
import { app } from './app.js';
import { pool } from './db.js';

await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Reservation service listening on port ${port}`));
