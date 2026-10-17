// Memento: before a multi-step operation (cancel, check-out) changes a
// reservation and then calls other services, we save the fields it is about to
// change. If a later step fails, the snapshot is restored exactly, so the
// reservation never stays half-cancelled or half-checked-out (NFR-5).

const FIELDS = [
  "status",
  "cancelled_at",
  "refund_amount",
  "cancellation_fee",
  "deposit_net",
  "checked_out_at",
  "checked_out_by",
  "balance_collected",
];

export async function saveMemento(db, reservationNo) {
  const result = await db.query(
    `SELECT ${FIELDS.join(", ")} FROM reservations WHERE reservation_no = $1`,
    [reservationNo],
  );
  if (!result.rowCount) return null;
  return Object.freeze({ reservationNo, state: Object.freeze({ ...result.rows[0] }) });
}

export async function restoreMemento(db, memento) {
  if (!memento) return;
  const assignments = FIELDS.map((field, index) => `${field} = $${index + 2}`).join(", ");
  await db.query(
    `UPDATE reservations SET ${assignments} WHERE reservation_no = $1`,
    [memento.reservationNo, ...FIELDS.map((field) => memento.state[field])],
  );
}
