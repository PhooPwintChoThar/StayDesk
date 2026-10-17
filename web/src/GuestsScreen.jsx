import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "./api.js";
import BookingDetails from "./BookingDetails.jsx";
import { useErrorToast } from "./toast.js";

const STATUS_LABELS = { pending: "pending payment", confirmed: "confirmed", cancelled: "cancelled" };

function date(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function nights(checkIn, checkOut) {
  const diff = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : "";
}

function stayLabel(reservation) {
  if (reservation.checkedOutAt) return "checked out";
  if (reservation.checkedInAt) return "in house";
  return STATUS_LABELS[reservation.status] || reservation.status;
}

// Staff guest directory: every guest profile with booking counts, the guest's
// bookings on demand, and full booking details from there.
export default function GuestsScreen({ role, typeName = (id) => id }) {
  const [guests, setGuests] = useState([]);
  const [counts, setCounts] = useState({});
  const [query, setQuery] = useState("");
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [bookingsState, setBookingsState] = useState("idle");
  const [details, setDetails] = useState(null);
  useErrorToast(error, setError);

  const load = useCallback(async (search = "") => {
    setState("loading");
    setError("");
    try {
      const params = search ? `?q=${encodeURIComponent(search)}` : "";
      const [guestResult, countResult] = await Promise.all([
        apiRequest(`/guests${params}`),
        apiRequest("/reservations/guest-counts").catch(() => ({ counts: [] })),
      ]);
      setGuests(guestResult.guests || []);
      setCounts(Object.fromEntries((countResult.counts || []).map((item) => [item.guestId, item])));
      setState("ready");
    } catch (err) {
      setGuests([]);
      setError(err.message);
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openBookings(guest) {
    setSelected(guest);
    setBookings([]);
    setBookingsState("loading");
    try {
      const result = await apiRequest(`/reservations?guestId=${encodeURIComponent(guest.id)}`);
      setBookings(result.reservations || []);
      setBookingsState("ready");
    } catch (err) {
      setError(err.message);
      setBookingsState("error");
    }
  }

  async function exportGuest(guest) {
    setError("");
    try {
      const result = await apiRequest(`/guests/${encodeURIComponent(guest.id)}/export`);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `guest-${guest.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteGuest(guest) {
    if (!window.confirm(`Permanently delete the profile of ${guest.firstName} ${guest.lastName}?`)) return;
    setError("");
    try {
      await apiRequest(`/guests/${encodeURIComponent(guest.id)}`, { method: "DELETE" });
      setSelected(null);
      await load(query.trim());
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <section aria-labelledby="guests-heading" className="register-panel">
        <div className="register-header">
          <div>
            <h2 id="guests-heading">Guests</h2>
            <p className="muted">Every guest profile, with their bookings</p>
          </div>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            load(query.trim());
          }}
        >
          <label>
            Name, email or phone
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="submit" className="primary-action">
            Search guests
          </button>
          {query && (
            <button
              type="button"
              className="page-btn"
              onClick={() => {
                setQuery("");
                load();
              }}
            >
              Show all
            </button>
          )}
        </form>

        {state === "loading" && <p className="muted">Loading guests…</p>}

        {state === "ready" && (
          <div className="table-wrap">
            <table aria-label="Guest results">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>EMAIL</th>
                  <th>PHONE</th>
                  <th>PASSPORT / ID</th>
                  <th>ACCOUNT</th>
                  <th>SINCE</th>
                  <th>BOOKINGS</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((guest) => {
                  const count = counts[guest.id];
                  const total = count?.total ?? 0;
                  return (
                    <tr key={guest.id} className={selected?.id === guest.id ? "row-selected" : undefined}>
                      <td>
                        {guest.firstName} {guest.lastName}
                        {guest.address && <div className="muted">{guest.address}</div>}
                      </td>
                      <td>{guest.email}</td>
                      <td>{guest.phone || "—"}</td>
                      <td>{guest.idDocument || "—"}</td>
                      <td>{guest.hasAccount ? "Online account" : "Front desk profile"}</td>
                      <td>{date(guest.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          aria-label={`${total} bookings for ${guest.firstName} ${guest.lastName}`}
                          onClick={() => openBookings(guest)}
                        >
                          {total}
                        </button>
                        {count?.active > 0 && <div className="muted">{count.active} active</div>}
                      </td>
                    </tr>
                  );
                })}
                {guests.length === 0 && (
                  <tr>
                    <td colSpan="7" className="empty-cell">No guests found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination-row">
          <span>{guests.length} guest{guests.length === 1 ? "" : "s"}</span>
        </div>
      </section>

      {selected && (
        <section aria-labelledby="guest-bookings-heading" className="register-panel">
          <div className="register-header">
            <div>
              <h2 id="guest-bookings-heading">
                Bookings for {selected.firstName} {selected.lastName}
              </h2>
              <p className="muted">Click a booking to see all of its details</p>
            </div>
            <div className="lookup-actions">
              <button type="button" className="page-btn" onClick={() => exportGuest(selected)}>
                Export profile
              </button>
              {role === "manager" && (
                <button type="button" className="page-btn" onClick={() => deleteGuest(selected)}>
                  Delete profile
                </button>
              )}
              <button type="button" className="page-btn" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>
          {bookingsState === "loading" && <p className="muted">Loading bookings…</p>}
          {bookingsState === "ready" && (
            <div className="table-wrap">
              <table aria-label="Guest bookings">
                <thead>
                  <tr>
                    <th>BOOKING ID</th>
                    <th>ROOM</th>
                    <th>DATES</th>
                    <th>NIGHTS</th>
                    <th>GUESTS</th>
                    <th>TOTAL</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((booking) => (
                    <tr
                      key={booking.reservationNo}
                      className="clickable-row"
                      tabIndex={0}
                      aria-label={`Open booking ${booking.reservationNo}`}
                      onClick={() => setDetails(booking)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setDetails(booking);
                        }
                      }}
                    >
                      <td>{booking.reservationNo}</td>
                      <td>
                        {typeName(booking.roomTypeId)}
                        {booking.roomNumber && <div className="muted">Room {booking.roomNumber}</div>}
                      </td>
                      <td>{booking.checkIn} → {booking.checkOut}</td>
                      <td>{nights(booking.checkIn, booking.checkOut)}</td>
                      <td>{booking.guests || 1}</td>
                      <td>{booking.totalAmount} {booking.currency}</td>
                      <td>
                        <span className={`status-pill ${booking.status}`}>{stayLabel(booking)}</span>
                      </td>
                    </tr>
                  ))}
                  {bookings.length === 0 && (
                    <tr>
                      <td colSpan="7" className="empty-cell">No bookings for this guest.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {details && (
        <BookingDetails
          reservationNo={details.reservationNo}
          roomTypeName={typeName(details.roomTypeId)}
          viewerRole={role}
          onClose={() => setDetails(null)}
        />
      )}
    </>
  );
}
