// Reliable event publishing for the reservation service.
//
// Observer: domain code only announces what happened (domainEvents.publish).
// Subscribers decide what to do with it, so the booking logic does not know
// about RabbitMQ at all.
//
// Singleton: one RabbitMQ connection and channel per process, reused for every
// event, instead of opening a new TCP connection per message (NFR-1).
//
// Transactional outbox: events are first stored in this service's own database
// and then published by a dispatcher. If the broker is down, nothing is lost:
// the dispatcher retries until it succeeds (NFR-5).

export function createEventBus() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async publish(topic, payload) {
      for (const listener of listeners) {
        try {
          await listener(topic, payload);
        } catch (error) {
          console.error(`Event listener failed for ${topic}:`, error.message);
        }
      }
    },
  };
}

export const domainEvents = createEventBus();

let brokerInstance = null;

export function getBroker(url = process.env.RABBITMQ_URL || "amqp://localhost:5672") {
  if (brokerInstance) return brokerInstance;
  let channelPromise = null;
  const reset = () => {
    channelPromise = null;
  };
  const channel = () => {
    channelPromise ??= (async () => {
      const amqp = await import("amqplib");
      const connection = await amqp.connect(url);
      connection.on("close", reset);
      connection.on("error", reset);
      const confirmChannel = await connection.createConfirmChannel();
      confirmChannel.on("close", reset);
      return confirmChannel;
    })().catch((error) => {
      reset();
      throw error;
    });
    return channelPromise;
  };
  brokerInstance = {
    async publish(queue, payload) {
      const ch = await channel();
      await ch.assertQueue(queue, { durable: true });
      await new Promise((resolve, reject) => {
        ch.sendToQueue(
          queue,
          Buffer.from(JSON.stringify(payload)),
          { persistent: true, contentType: "application/json" },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    },
  };
  return brokerInstance;
}

export function createOutbox({ db, broker = getBroker(), batchSize = 50 }) {
  async function record(queue, payload) {
    await db.query(
      "INSERT INTO event_outbox (queue, payload) VALUES ($1, $2)",
      [queue, JSON.stringify(payload)],
    );
  }

  // SKIP LOCKED lets several instances of the service dispatch in parallel
  // without sending the same event twice (NFR-2).
  async function dispatch() {
    const client = await db.connect();
    let sent = 0;
    try {
      await client.query("BEGIN");
      const pending = await client.query(
        `SELECT id, queue, payload FROM event_outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      for (const event of pending.rows) {
        try {
          await broker.publish(event.queue, event.payload);
          await client.query("UPDATE event_outbox SET published_at = NOW() WHERE id = $1", [event.id]);
          sent += 1;
        } catch (error) {
          await client.query(
            "UPDATE event_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1",
            [event.id, error.message],
          );
          break;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return sent;
  }

  function start(intervalMs = 2000) {
    const timer = setInterval(() => {
      dispatch().catch((error) => console.error("Outbox dispatch failed:", error.message));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Store first, then try to send straight away; the timer catches anything left.
  async function enqueue(queue, payload) {
    await record(queue, payload);
    dispatch().catch((error) => console.error("Outbox dispatch failed:", error.message));
  }

  return { record, dispatch, start, enqueue };
}
