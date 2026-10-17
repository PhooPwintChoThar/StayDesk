export function createRecorder(db) {
  return async function record({ queueName, payload, status, channel, recipient, subject, error }) {
    await db.query(
      `INSERT INTO notifications (event, reservation_no, guest_id, channel, recipient, subject, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        payload?.event || queueName,
        payload?.reservationNo ?? null,
        payload?.guestId ?? null,
        channel ?? null,
        recipient ?? null,
        subject ?? null,
        status,
        error ?? null
      ]
    );
  };
}
