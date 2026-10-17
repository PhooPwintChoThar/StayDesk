import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";
import { ProofViewer, proofStatusLabel, reviewerLabel } from "./PaymentsScreen.jsx";

const TX_LABELS = {
  deposit: "Card deposit",
  refund: "Refund",
  settlement: "Paid at front desk",
};

function money(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toFixed(2)} ${currency || ""}`.trim();
}

function when(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function nightsBetween(checkIn, checkOut) {
  const diff = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : "—";
}

// Everything staff need about one booking: guests, stay, money and payments.
export default function BookingDetails({ reservationNo, roomTypeName, onClose, viewerRole = "agent", actions = null }) {
  const isGuest = viewerRole === "guest";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const path = `/reservations/${encodeURIComponent(reservationNo)}`;
    (async () => {
      try {
        const reservation = await apiRequest(path);
        const [guest, summary, proofs, transactions] = await Promise.all([
          apiRequest(`/guests/${encodeURIComponent(reservation.guestId)}`).catch(() => null),
          apiRequest(`${path}/payment-summary`).catch(() => null),
          apiRequest(`/payments/proofs?reservationNo=${encodeURIComponent(reservationNo)}`)
            .then((result) => result.proofs || [])
            .catch(() => []),
          isGuest
            ? Promise.resolve([])
            : apiRequest(`/payments/transactions?reservationNo=${encodeURIComponent(reservationNo)}`)
              .then((result) => result.transactions || [])
              .catch(() => []),
        ]);
        if (!cancelled) setData({ reservation, guest, summary, proofs, transactions });
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservationNo, isGuest]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !viewing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);

  const r = data?.reservation;
  const currency = r?.currency;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card booking-details"
        role="dialog"
        aria-modal="true"
        aria-label={`Booking ${reservationNo}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="register-header">
          <div>
            <p className="eyebrow">Booking details</p>
            <h3>{reservationNo}</h3>
          </div>
          <div className="lookup-actions">
            {data && actions?.(data.reservation)}
            <button type="button" className="page-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        {!data && !error && <p className="muted">Loading booking…</p>}
        {r && (
          <>
            <section className="detail-section">
              <h4>Stay</h4>
              <dl className="detail-grid">
                <dt>Status</dt>
                <dd>
                  <span className={`status-pill ${r.status}`}>{r.status === "pending" ? "pending payment" : r.status}</span>
                  {isGuest && r.status === "pending" && (
                    <div className="muted">You can change or cancel this booking until the payment is approved.</div>
                  )}
                </dd>
                <dt>Room</dt>
                <dd>{roomTypeName || r.roomTypeId}{r.roomNumber ? `, room ${r.roomNumber}` : ""}</dd>
                <dt>Dates</dt>
                <dd>{r.checkIn} to {r.checkOut} ({nightsBetween(r.checkIn, r.checkOut)} nights)</dd>
                <dt>Guests</dt>
                <dd>{r.guests || 1}</dd>
                <dt>Booked</dt>
                <dd>{when(r.createdAt)}</dd>
                <dt>Payment confirmed</dt>
                <dd>{when(r.confirmedAt)}</dd>
                <dt>Checked in</dt>
                <dd>{when(r.checkedInAt)}</dd>
                <dt>Checked out</dt>
                <dd>{when(r.checkedOutAt)}</dd>
              </dl>
            </section>

            <section className="detail-section">
              <h4>Guests</h4>
              <div className="table-wrap">
                <table aria-label="Guests on this booking">
                  <thead>
                    <tr><th>#</th><th>NAME</th><th>PASSPORT / ID</th><th>CONTACT</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>1</td>
                      <td>
                        {data.guest ? `${data.guest.firstName} ${data.guest.lastName}` : r.guestId}
                        <div className="muted">{isGuest ? "You" : "Booked by"}</div>
                      </td>
                      <td>{data.guest?.idDocument || "—"}</td>
                      <td>
                        {data.guest?.email || "—"}
                        {data.guest?.phone && <div className="muted">{data.guest.phone}</div>}
                      </td>
                    </tr>
                    {(r.additionalGuests || []).map((person) => (
                      <tr key={person.position}>
                        <td>{person.position}</td>
                        <td>{person.name}</td>
                        <td>{person.idDocument}</td>
                        <td className="muted">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="detail-section">
              <h4>Charges</h4>
              <dl className="detail-grid">
                <dt>Total price</dt>
                <dd><strong>{money(r.totalAmount, currency)}</strong></dd>
                <dt>Deposit</dt>
                <dd>{money(r.depositHeld ?? r.depositAmount, currency)}</dd>
                <dt>Approved payments</dt>
                <dd>{money(data.summary?.approvedProofsTotal, currency)}</dd>
                <dt>Paid at front desk</dt>
                <dd>{money(data.summary?.settledAtDesk ?? 0, currency)}</dd>
                <dt>Balance due</dt>
                <dd><strong>{money(data.summary?.balanceDue, currency)}</strong></dd>
              </dl>
            </section>

            <section className="detail-section">
              <h4>Payment proofs</h4>
              {data.proofs.length === 0 ? (
                <p className="muted">No payment proofs uploaded.</p>
              ) : (
                <div className="table-wrap">
                  <table aria-label="Payment proofs for this booking">
                    <thead>
                      <tr>
                        <th>PAYMENT NO</th><th>AMOUNT</th><th>STATUS</th>
                        {!isGuest && <th>REVIEWED BY</th>}
                        <th>{isGuest ? "REVIEWED ON" : "REVIEWED AT"}</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.proofs.map((proof) => (
                        <tr key={proof.id}>
                          <td>{proof.paymentNo}</td>
                          <td>{money(proof.amount, proof.currency)}</td>
                          <td><span className={`status-pill ${proof.status}`}>{proofStatusLabel(proof.status)}</span></td>
                          {!isGuest && <td>{reviewerLabel(proof)}</td>}
                          <td>{when(proof.reviewedAt)}</td>
                          <td>
                            <button type="button" className="page-btn" onClick={() => setViewing(proof)}>
                              View proof
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {!isGuest && (
            <section className="detail-section">
              <h4>Card transactions</h4>
              {data.transactions.length === 0 ? (
                <p className="muted">No card transactions.</p>
              ) : (
                <div className="table-wrap">
                  <table aria-label="Card transactions">
                    <thead>
                      <tr><th>PAYMENT NO</th><th>TYPE</th><th>AMOUNT</th><th>STATUS</th><th>DATE</th></tr>
                    </thead>
                    <tbody>
                      {data.transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td>{tx.paymentNo}</td>
                          <td>{TX_LABELS[tx.type] || tx.type}</td>
                          <td>{tx.type === "refund" ? "-" : ""}{money(tx.amount, tx.currency)}</td>
                          <td>{tx.status === "captured" && tx.type === "deposit" ? "applied to bill" : tx.status}</td>
                          <td>{when(tx.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            )}
          </>
        )}
        {viewing && <ProofViewer proof={viewing} showReviewer={!isGuest} onClose={() => setViewing(null)} />}
      </div>
    </div>
  );
}
