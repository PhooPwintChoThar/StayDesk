import { useCallback, useEffect, useState } from "react";
import { apiRequest, setRole as setApiRole } from "./api.js";

const initialSearch = { checkIn: "", checkOut: "", roomTypeId: "" };
const initialGuest = { email: "", firstName: "", lastName: "", phone: "" };
const initialFilters = { from: "", to: "", status: "", roomTypeId: "", q: "" };

const ROLES = [
  { value: "guest", label: "Guest", initials: "G" },
  { value: "agent", label: "Front Desk Agent", initials: "FA" },
  { value: "manager", label: "Manager", initials: "M" },
];

const day = (value) => String(value ?? "").slice(0, 10);

function nights(checkIn, checkOut) {
  const diff =
    Date.parse(`${day(checkOut)}T00:00:00Z`) -
    Date.parse(`${day(checkIn)}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : "";
}

export default function App() {
  const [role, setRole] = useState("agent");
  const [view, setView] = useState("reservations");

  const [reservations, setReservations] = useState([]);
  const [filters, setFilters] = useState(initialFilters);
  const [openMenu, setOpenMenu] = useState(null);
  const [editing, setEditing] = useState(null);

  const [bookingOpen, setBookingOpen] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const [availability, setAvailability] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [guest, setGuest] = useState(initialGuest);
  const [confirmation, setConfirmation] = useState(null);

  const [guestQuery, setGuestQuery] = useState("");
  const [guests, setGuests] = useState([]);
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [guestReservations, setGuestReservations] = useState([]);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadReservations = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);

    try {
      const result = await apiRequest(`/reservations?${params}`);
      setReservations(result.reservations || []);
    } catch (err) {
      setReservations([]);
      setError(
        role === "guest"
          ? "Guests cannot view the booking register. Use + New Reservation to book."
          : err.message,
      );
    }
  }, [filters.status, filters.from, filters.to, role]);

  useEffect(() => {
    if (view === "reservations") loadReservations();
  }, [view, loadReservations]);

  function changeRole(nextRole) {
    setApiRole(nextRole);
    setRole(nextRole);
    setError("");
    setGuests([]);
    setSelectedGuest(null);
    setGuestReservations([]);
  }

  function openBooking() {
    setBookingOpen(true);
    setEditing(null);
    setSearch(initialSearch);
    setAvailability([]);
    setSelectedRoom(null);
    setGuest(initialGuest);
    setConfirmation(null);
    setError("");
  }

  async function searchRooms(event) {
    event.preventDefault();
    setError("");
    setAvailability([]);
    setSelectedRoom(null);
    setConfirmation(null);
    setBusy(true);

    try {
      const params = new URLSearchParams({
        checkIn: search.checkIn,
        checkOut: search.checkOut,
      });
      if (search.roomTypeId) params.set("roomTypeId", search.roomTypeId);

      const result = await apiRequest(`/availability?${params}`);
      setAvailability(result.availability || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function bookRoom(event) {
    event.preventDefault();
    if (!selectedRoom) return;

    setError("");
    setBusy(true);
    try {
      const reservation = await apiRequest("/reservations", {
        method: "POST",
        body: JSON.stringify({
          guest,
          roomTypeId: selectedRoom.roomTypeId,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
        }),
      });
      setConfirmation(reservation);
      setSelectedRoom(null);
      setAvailability([]);
      if (role !== "guest") await loadReservations();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelReservation(reservationNo) {
    setOpenMenu(null);
    if (!window.confirm(`Cancel reservation ${reservationNo}?`)) return;

    setError("");
    try {
      await apiRequest(`/reservations/${encodeURIComponent(reservationNo)}`, {
        method: "DELETE",
      });
      await loadReservations();
    } catch (err) {
      setError(err.message);
    }
  }

  function startModify(reservation) {
    setOpenMenu(null);
    setBookingOpen(false);
    setError("");
    setEditing({
      reservationNo: reservation.reservationNo,
      roomTypeId: reservation.roomTypeId,
      checkIn: day(reservation.checkIn),
      checkOut: day(reservation.checkOut),
    });
  }

  async function saveModify(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiRequest(
        `/reservations/${encodeURIComponent(editing.reservationNo)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            roomTypeId: editing.roomTypeId,
            checkIn: editing.checkIn,
            checkOut: editing.checkOut,
          }),
        },
      );
      setEditing(null);
      await loadReservations();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function searchGuests(event) {
    event.preventDefault();
    setError("");
    setSelectedGuest(null);
    setGuestReservations([]);
    setBusy(true);
    try {
      const result = await apiRequest(
        `/guests/search?q=${encodeURIComponent(guestQuery)}`,
      );
      setGuests(result.guests || []);
    } catch (err) {
      setGuests([]);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function showGuest(selected) {
    setError("");
    setSelectedGuest(selected);
    try {
      const result = await apiRequest(
        `/reservations?guestId=${encodeURIComponent(selected.id)}`,
      );
      setGuestReservations(result.reservations || []);
    } catch (err) {
      setGuestReservations([]);
      setError(err.message);
    }
  }

  const roomTypes = [
    ...new Set(reservations.map((reservation) => reservation.roomTypeId)),
  ];
  const query = filters.q.trim().toLowerCase();
  const visibleReservations = reservations.filter(
    (reservation) =>
      (!filters.roomTypeId || reservation.roomTypeId === filters.roomTypeId) &&
      (!query ||
        reservation.reservationNo.toLowerCase().includes(query) ||
        String(reservation.guestId).toLowerCase().includes(query)),
  );

  const currentRole = ROLES.find((item) => item.value === role);
  const today = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <main className="page-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">H</div>
        </div>

        <nav className="nav" aria-label="Sidebar navigation">
          <button type="button" className="nav-item">
            <span className="nav-icon">▣</span>
            <span>Dashboard</span>
          </button>
          <button
            type="button"
            className={`nav-item ${view === "reservations" ? "active" : ""}`}
            onClick={() => {
              setView("reservations");
              setError("");
            }}
          >
            <span className="nav-icon">▤</span>
            <span>Reservations</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">⌂</span>
            <span>Rooms</span>
          </button>
          <button
            type="button"
            className={`nav-item ${view === "guests" ? "active" : ""}`}
            onClick={() => {
              setView("guests");
              setError("");
            }}
          >
            <span className="nav-icon">◌</span>
            <span>Guests</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">↗</span>
            <span>Housekeeping</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">▥</span>
            <span>Billing</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">▨</span>
            <span>Reports</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">◫</span>
            <span>Settings</span>
          </button>
        </nav>

        <div className="user-card">
          <div className="user-avatar">{currentRole.initials}</div>
          <div className="user-meta">
            <label className="role-label">
              Signed in as
              <select
                value={role}
                onChange={(event) => changeRole(event.target.value)}
              >
                {ROLES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </aside>

      <div className="main-panel">
        <header className="topbar">
          <div className="page-title">
            {view === "reservations"
              ? "Reservations Management"
              : "Guest Lookup"}
          </div>
          <div className="system-date">System Date: {today}</div>
        </header>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {view === "reservations" && (
          <>
            {bookingOpen && (
              <section
                aria-labelledby="new-reservation-heading"
                className="register-panel"
              >
                <div className="register-header">
                  <h2 id="new-reservation-heading">New Reservation</h2>
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => setBookingOpen(false)}
                  >
                    Close
                  </button>
                </div>

                <h3 id="search-heading">Find a room</h3>
                <form onSubmit={searchRooms} className="form-grid">
                  <label>
                    Check-in
                    <input
                      type="date"
                      required
                      value={search.checkIn}
                      onChange={(event) =>
                        setSearch({ ...search, checkIn: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Check-out
                    <input
                      type="date"
                      required
                      value={search.checkOut}
                      onChange={(event) =>
                        setSearch({ ...search, checkOut: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Room type ID (optional)
                    <input
                      value={search.roomTypeId}
                      onChange={(event) =>
                        setSearch({ ...search, roomTypeId: event.target.value })
                      }
                    />
                  </label>
                  <button
                    disabled={busy}
                    type="submit"
                    className="primary-action"
                  >
                    Search availability
                  </button>
                </form>

                {availability.length > 0 && (
                  <ul aria-label="Available rooms" className="room-list">
                    {availability.map((room) => (
                      <li key={room.roomTypeId}>
                        <span>
                          {room.roomTypeId} —{" "}
                          {room.roomsAvailable ??
                            (room.available ? "Available" : "Unavailable")}
                          {" · "}
                          {room.nightlyRate} {room.currency} per night
                        </span>
                        <button
                          type="button"
                          className="page-btn"
                          disabled={!room.available || busy}
                          onClick={() => setSelectedRoom(room)}
                        >
                          Select
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {availability.length === 0 && !busy && !confirmation && (
                  <p>
                    No availability results yet. Search dates to find rooms.
                  </p>
                )}

                {selectedRoom && (
                  <>
                    <h3 id="booking-heading">Guest details</h3>
                    <form onSubmit={bookRoom} className="form-grid">
                      <label>
                        Email
                        <input
                          type="email"
                          required
                          value={guest.email}
                          onChange={(event) =>
                            setGuest({ ...guest, email: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        First name
                        <input
                          required
                          value={guest.firstName}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              firstName: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Last name
                        <input
                          required
                          value={guest.lastName}
                          onChange={(event) =>
                            setGuest({ ...guest, lastName: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Phone (optional)
                        <input
                          value={guest.phone}
                          onChange={(event) =>
                            setGuest({ ...guest, phone: event.target.value })
                          }
                        />
                      </label>
                      <button
                        disabled={busy}
                        type="submit"
                        className="primary-action"
                      >
                        Book room
                      </button>
                    </form>
                  </>
                )}

                {confirmation && (
                  <section aria-labelledby="confirmation-heading" role="status">
                    <h3 id="confirmation-heading">Booking confirmed</h3>
                    <p>
                      Reservation number:{" "}
                      <strong>{confirmation.reservationNo}</strong>
                    </p>
                    <p>
                      Total: {confirmation.totalAmount} {confirmation.currency}
                      {" · "}Status: {confirmation.status}
                    </p>
                    <p>
                      Deposit: {confirmation.depositAmount} {confirmation.currency}
                    </p>
                  </section>
                )}
              </section>
            )}

            {editing && (
              <section
                aria-labelledby="modify-heading"
                className="register-panel"
              >
                <div className="register-header">
                  <h2 id="modify-heading">Modify {editing.reservationNo}</h2>
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => setEditing(null)}
                  >
                    Close
                  </button>
                </div>
                <form onSubmit={saveModify} className="form-grid">
                  <label>
                    New check-in
                    <input
                      type="date"
                      required
                      value={editing.checkIn}
                      onChange={(event) =>
                        setEditing({ ...editing, checkIn: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    New check-out
                    <input
                      type="date"
                      required
                      value={editing.checkOut}
                      onChange={(event) =>
                        setEditing({ ...editing, checkOut: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Room type
                    <input
                      required
                      value={editing.roomTypeId}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          roomTypeId: event.target.value,
                        })
                      }
                    />
                  </label>
                  <button
                    disabled={busy}
                    type="submit"
                    className="primary-action"
                  >
                    Save changes
                  </button>
                </form>
              </section>
            )}

            <section className="register-panel">
              <div className="register-header">
                <h2>Active Booking Register</h2>
                <button
                  type="button"
                  className="primary-action"
                  onClick={openBooking}
                >
                  + New Reservation
                </button>
              </div>

              <div className="toolbar" aria-label="Reservation filters">
                <div className="field">
                  <label htmlFor="filter-from">Date Range</label>
                  <div className="date-range">
                    <input
                      id="filter-from"
                      type="date"
                      aria-label="From date"
                      value={filters.from}
                      onChange={(event) =>
                        setFilters({ ...filters, from: event.target.value })
                      }
                    />
                    <input
                      type="date"
                      aria-label="To date"
                      value={filters.to}
                      onChange={(event) =>
                        setFilters({ ...filters, to: event.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="filter-status">Status</label>
                  <select
                    id="filter-status"
                    value={filters.status}
                    onChange={(event) =>
                      setFilters({ ...filters, status: event.target.value })
                    }
                  >
                    <option value="">All Statuses</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="filter-room-type">Room Type</label>
                  <select
                    id="filter-room-type"
                    value={filters.roomTypeId}
                    onChange={(event) =>
                      setFilters({ ...filters, roomTypeId: event.target.value })
                    }
                  >
                    <option value="">All Room Types</option>
                    {roomTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field search-field">
                  <label htmlFor="filter-search">Search</label>
                  <input
                    id="filter-search"
                    type="text"
                    placeholder="Booking ID or guest ID..."
                    value={filters.q}
                    onChange={(event) =>
                      setFilters({ ...filters, q: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="table-wrap">
                <table role="table">
                  <thead>
                    <tr>
                      <th>BOOKING ID</th>
                      <th>GUEST ID</th>
                      <th>ROOM TYPE</th>
                      <th>CHECK-IN</th>
                      <th>CHECK-OUT</th>
                      <th>NIGHTS</th>
                      <th>TOTAL</th>
                      <th>STATUS</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleReservations.map((reservation) => (
                      <tr key={reservation.reservationNo}>
                        <td>{reservation.reservationNo}</td>
                        <td title={reservation.guestId}>
                          {String(reservation.guestId).slice(0, 8)}…
                        </td>
                        <td>{reservation.roomTypeId}</td>
                        <td>{day(reservation.checkIn)}</td>
                        <td>{day(reservation.checkOut)}</td>
                        <td>
                          {nights(reservation.checkIn, reservation.checkOut)}
                        </td>
                        <td>
                          {reservation.totalAmount} {reservation.currency}
                        </td>
                        <td>
                          <span className={`status-pill ${reservation.status}`}>
                            {reservation.status}
                          </span>
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="menu-button"
                            aria-label={`Actions for ${reservation.reservationNo}`}
                            aria-expanded={
                              openMenu === reservation.reservationNo
                            }
                            onClick={() =>
                              setOpenMenu(
                                openMenu === reservation.reservationNo
                                  ? null
                                  : reservation.reservationNo,
                              )
                            }
                          >
                            ⋯
                          </button>
                          {openMenu === reservation.reservationNo && (
                            <div className="action-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                disabled={reservation.status !== "confirmed"}
                                onClick={() => startModify(reservation)}
                              >
                                Modify
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={reservation.status !== "confirmed"}
                                onClick={() =>
                                  cancelReservation(reservation.reservationNo)
                                }
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {visibleReservations.length === 0 && (
                      <tr>
                        <td colSpan="9">No reservations found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pagination-row">
                <span>
                  Showing {visibleReservations.length} of {reservations.length}{" "}
                  entries
                </span>
              </div>
            </section>
          </>
        )}

        {view === "guests" && (
          <section aria-labelledby="guests-heading" className="register-panel">
            <div className="register-header">
              <h2 id="guests-heading">Find a guest</h2>
            </div>
            <form onSubmit={searchGuests} className="form-grid">
              <label>
                Name, email or phone
                <input
                  required
                  value={guestQuery}
                  onChange={(event) => setGuestQuery(event.target.value)}
                />
              </label>
              <button disabled={busy} type="submit" className="primary-action">
                Search guests
              </button>
            </form>

            {guests.length > 0 && (
              <div className="table-wrap">
                <table aria-label="Guest results">
                  <thead>
                    <tr>
                      <th>NAME</th>
                      <th>EMAIL</th>
                      <th>PHONE</th>
                      <th>GUEST ID</th>
                      <th>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guests.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.firstName} {item.lastName}
                        </td>
                        <td>{item.email}</td>
                        <td>{item.phone || "—"}</td>
                        <td>{item.id}</td>
                        <td>
                          <button
                            type="button"
                            className="page-btn"
                            onClick={() => showGuest(item)}
                          >
                            View stays
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selectedGuest && (
              <>
                <h3>
                  Stay history: {selectedGuest.firstName}{" "}
                  {selectedGuest.lastName}
                </h3>
                {guestReservations.length === 0 ? (
                  <p>No reservations for this guest.</p>
                ) : (
                  <ul aria-label="Stay history" className="room-list">
                    {guestReservations.map((reservation) => (
                      <li key={reservation.reservationNo}>
                        <span>
                          {reservation.reservationNo} · {reservation.roomTypeId}
                          {" · "}
                          {day(reservation.checkIn)} to{" "}
                          {day(reservation.checkOut)}
                        </span>
                        <span className={`status-pill ${reservation.status}`}>
                          {reservation.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
