import { readFile } from 'node:fs/promises';
import { app } from './app.js';
import { QUEUE_NAMES, startConsumer } from './consumer.js';
import { pool } from './db.js';
import { createMailer, sendSms } from './mailer.js';
import { createRecorder } from './record.js';

await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

const mailer = createMailer();
console.log(`Email transport: ${mailer.transport}`);

const amqp = await import('amqplib');

// RabbitMQ can report healthy before it accepts connections; keep trying for a minute.
async function connectWithRetry(url, attempts = 30) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await amqp.connect(url);
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`RabbitMQ not ready (${error.code || error.message}); retrying in 2s`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const connection = await connectWithRetry(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
let shuttingDown = false;
connection.on('close', () => {
  if (shuttingDown) return;
  // Exit so Docker restarts the service and it reconnects cleanly.
  console.error('RabbitMQ connection closed; exiting so the service restarts.');
  process.exit(1);
});
const channel = await connection.createChannel();
await channel.prefetch(10);

const roomRateUrl = (process.env.ROOM_RATE_SERVICE_URL || 'http://room-rate:3000').replace(/\/$/, '');

// Events carry room type ids; show guests the room type's name instead.
async function enrich(payload) {
  if (!payload?.roomTypeId || payload.roomTypeName) return payload;
  try {
    const response = await fetch(`${roomRateUrl}/room-types`, {
      headers: process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}
    });
    const { roomTypes = [] } = await response.json();
    const match = roomTypes.find((type) => type.id === payload.roomTypeId);
    return match ? { ...payload, roomTypeName: match.name } : payload;
  } catch {
    return payload;
  }
}

const notifier = { sendEmail: mailer.sendEmail, sendSms };
const record = createRecorder(pool);
for (const queueName of QUEUE_NAMES) {
  await startConsumer(channel, notifier, queueName, { record, enrich });
}

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Notification service listening on port ${port}`);
});

async function shutdown() {
  shuttingDown = true;
  server.close();
  await channel.close();
  await connection.close();
  await pool.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
