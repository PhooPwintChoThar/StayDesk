import { app } from './app.js';
import { startConsumer } from './consumer.js';
import { sendEmail, sendSms } from './mailer.js';

const amqp = await import('amqplib');
const connection = await amqp.connect(
  process.env.RABBITMQ_URL || 'amqp://localhost:5672'
);
const channel = await connection.createChannel();

await startConsumer(channel, { sendEmail, sendSms });

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Notification service listening on port ${port}`);
});

async function shutdown() {
  server.close();
  await channel.close();
  await connection.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
