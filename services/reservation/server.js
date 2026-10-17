import { readFile } from 'node:fs/promises';
import { app } from './app.js';
import { pool } from './db.js';
import { createOutbox, domainEvents } from './events.js';

await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

// Every domain event the app announces is stored in the outbox and then
// delivered to RabbitMQ, retrying until the broker accepts it.
const outbox = createOutbox({ db: pool });
domainEvents.subscribe((queue, payload) => outbox.enqueue(queue, payload));
outbox.start();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Reservation service listening on port ${port}`));
