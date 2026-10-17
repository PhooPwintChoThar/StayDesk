import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiRequest,
  getDevRole,
  getSession,
  login,
  loginWithRole,
  logout,
  registerGuestAccount,
  setRole as setDevRole,
  subscribeSession,
} from "./api.js";

const DEV_ROLE_SWITCH = import.meta.env.VITE_DEV_ROLE_SWITCH === "true";

const initialSearch = {
  checkIn: "",
  checkOut: "",
  roomTypeId: "",
  hotelId: "",
  guests: "1",
};
const initialGuest = {
  email: "",
  firstName: "",
  lastName: "",
  phone: "",
  address: "",
  idDocument: "",
  preferences: "",
  loyaltyTier: "none",
  loyaltyNumber: "",
  consent: false,
  channel: "email",
};
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

const ICONS = {
  dashboard: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  calendar: "M5 5h14v15H5z M5 10h14 M9 3v4 M15 3v4",
  rooms: "M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6",
  guests: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20c0-4 4-6 8-6s8 2 8 6",
  housekeeping: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5L18 18 M18 6l-2.5 2.5 M8.5 15.5L6 18",
  billing: "M3 6h18v12H3z M3 10h18 M7 15h4",
  reports: "M5 20V10 M12 20V4 M19 20v-7",
  settings: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M13 4v6 M7 14v6",
  check: "M5 12l4 4 10-10",
  close: "M6 6l12 12 M18 6L6 18",
  cash: "M12 3v18 M16 7c0-2-2-3-4-3s-4 1-4 3 2 3 4 3 4 1 4 3-2 3-4 3-4-1-4-3",
};

function Icon({ name, size = 18, className = "nav-icon" }) {
  return (
      <svg className={className} viewBox="0 0 24 24" width={size} height={size}
           fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICONS[name]} />
      </svg>
  );
}

function LoginScreen({
  authError,
  busy,
  loginForm,
  setLoginForm,
  guestForm,
  setGuestForm,
  onSignIn,
  onCreateGuest,
}) {
  return (
    <main className="page-shell auth-shell">
      <section className="register-panel auth-panel">
        <div className="register-header">
          <div>
            <h1>StayDesk</h1>
            <p className="muted">Hotel guest and reservation access</p>
          </div>
        </div>

        {authError && (
          <p role="alert" className="error">
            {authError}
          </p>
        )}

        <div className="auth-grid">
          <section aria-labelledby="sign-in-heading">
            <h2 id="sign-in-heading">Sign in</h2>
            <form className="form-grid" onSubmit={onSignIn}>
              <label>
                Username or email
                <input
                  required
                  value={loginForm.username}
                  onChange={(event) =>
                    setLoginForm({ ...loginForm, username: event.target.value })
                  }
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  value={loginForm.password}
                  onChange={(event) =>
                    setLoginForm({ ...loginForm, password: event.target.value })
                  }
                />
              </label>
              <button disabled={busy} type="submit" className="primary-action">
                Sign in
              </button>
            </form>
          </section>

          <section aria-labelledby="create-guest-heading">
            <h2 id="create-guest-heading">Create guest account</h2>
            <form className="form-grid" onSubmit={onCreateGuest}>
              <label>
                First name
                <input
                  required
                  value={guestForm.firstName}
                  onChange={(event) =>
                    setGuestForm({ ...guestForm, firstName: event.target.value })
                  }
                />
              </label>
              <label>
                Last name
                <input
                  required
                  value={guestForm.lastName}
                  onChange={(event) =>
                    setGuestForm({ ...guestForm, lastName: event.target.value })
                  }
                />
              </label>
              <label>
                Email
                <input
                  required
                  type="email"
                  value={guestForm.email}
                  onChange={(event) =>
                    setGuestForm({ ...guestForm, email: event.target.value })
                  }
                />
              </label>
              <label>
                Phone (optional)
                <input
                  value={guestForm.phone}
                  onChange={(event) =>
                    setGuestForm({ ...guestForm, phone: event.target.value })
                  }
                />
              </label>
              <label>
                Guest password
                <input
                  required
                  type="password"
                  value={guestForm.password}
                  onChange={(event) =>
                    setGuestForm({ ...guestForm, password: event.target.value })
                  }
                />
              </label>
              <button disabled={busy} type="submit" className="primary-action">
                Create guest account
              </button>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState(() => getSession());
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [guestForm, setGuestForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    password: "",
  });
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
  const [hotels, setHotels] = useState([]);
  const [lookupNo, setLookupNo] = useState("");
  const [lookedUp, setLookedUp] = useState(null);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    return subscribeSession(setSession);
  }, []);

  useEffect(() => {
    if (session || !DEV_ROLE_SWITCH || !getDevRole()) {
      return undefined;
    }

    let cancelled = false;
    setAuthBusy(true);
    loginWithRole(getDevRole())
      .catch((err) => {
        if (!cancelled) setAuthError(err.message);
      })
      .finally(() => {
        if (!cancelled) setAuthBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  const role = session?.claims?.role || (DEV_ROLE_SWITCH ? getDevRole() : null);
  const currentRole = ROLES.find((item) => item.value === role) || ROLES[0];

  async function handleSignIn(event) {
    event.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      await login(loginForm.username.trim(), loginForm.password);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateGuest(event) {
    event.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      await registerGuestAccount(guestForm);
      setGuestForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        password: "",
      });
      setLoginForm({ username: guestForm.email.trim(), password: guestForm.password });
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLogout() {
    logout();
    setSession(null);
    setView("reservations");
    setError("");
    setAuthError("");
    setReservations([]);
    setGuests([]);
    setSelectedGuest(null);
    setGuestReservations([]);
    setLookedUp(null);
    setLookupNo("");
  }

  const loadReservations = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);

    try {
      const result = await apiRequest(`/reservations?${params}`);
      if (sessionRef.current?.claims?.role === "guest") {
        setReservations([]);
        return;
      }
      setReservations(result.reservations || []);
    } catch (err) {
      setReservations([]);
      if (sessionRef.current?.claims?.role !== "guest") setError(err.message);
    }
  }, [filters.status, filters.from, filters.to]);

  useEffect(() => {
    if (session && view === "reservations") loadReservations();
  }, [session, view, loadReservations]);

  async function changeRole(nextRole) {
    setDevRole(nextRole);
    setError("");
    setAuthError("");
    setGuests([]);
    setSelectedGuest(null);
    setGuestReservations([]);
    setLookedUp(null);
    setLookupNo("");
    if (nextRole === "guest") {
      setView("reservations");
      setReservations([]);
    }
    try {
      await loginWithRole(nextRole);
    } catch (err) {
      setAuthError(err.message);
    }
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
    apiRequest("/hotels")
      .then((result) => setHotels(result.hotels || []))
      .catch(() => setHotels([]));
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
      if (search.hotelId) params.set("hotelId", search.hotelId);
      if (search.guests) params.set("guests", search.guests);

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
          guest: {
            email: guest.email,
            firstName: guest.firstName,
            lastName: guest.lastName,
            phone: guest.phone,
            address: guest.address,
            idDocument: guest.idDocument,
            preferences: guest.preferences,
            loyaltyTier: guest.loyaltyTier,
            loyaltyNumber: guest.loyaltyNumber,
            consent: guest.consent,
          },
          roomTypeId: selectedRoom.roomTypeId,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
          guests: Number(search.guests) || undefined,
          channel: guest.channel,
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
      if (lookedUp?.reservationNo === reservationNo) setLookedUp(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function lookupReservation(event) {
    event.preventDefault();
    setError("");
    setLookedUp(null);
    setBusy(true);
    try {
      const reservation = await apiRequest(
        `/reservations/${encodeURIComponent(lookupNo.trim())}`,
      );
      setLookedUp(reservation);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
      if (lookedUp?.reservationNo === editing.reservationNo) {
        setLookedUp(null);
      }
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

  async function exportGuest(guestId) {
    setError("");
    try {
      const result = await apiRequest(
        `/guests/${encodeURIComponent(guestId)}/export`,
      );
      const blob = new Blob([JSON.stringify(result, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `guest-${guestId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteGuest(guestId) {
    if (!window.confirm("Permanently delete this guest profile?")) return;
    setError("");
    try {
      await apiRequest(`/guests/${encodeURIComponent(guestId)}`, {
        method: "DELETE",
      });
      setGuests((current) => current.filter((item) => item.id !== guestId));
      if (selectedGuest?.id === guestId) {
        setSelectedGuest(null);
        setGuestReservations([]);
      }
    } catch (err) {
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
  const confirmedList = reservations.filter((r) => r.status === "confirmed");
  const confirmedCount = confirmedList.length;
  const cancelledCount = reservations.filter((r) => r.status === "cancelled").length;
  const confirmedRevenue = confirmedList.reduce(
      (sum, r) => sum + (Number(r.totalAmount) || 0), 0);
  const revenueCurrency = reservations[0]?.currency || "";
  const confirmedPct = reservations.length
      ? Math.round((confirmedCount / reservations.length) * 100) : 0;
  const today = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  if (!session) {
    return (
      <LoginScreen
        authError={authError}
        busy={authBusy}
        loginForm={loginForm}
        setLoginForm={setLoginForm}
        guestForm={guestForm}
        setGuestForm={setGuestForm}
        onSignIn={handleSignIn}
        onCreateGuest={handleCreateGuest}
      />
    );
  }

  return (
    <main className="page-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">H</div>
          <span className="brand-name">StayDesk</span>
        </div>

        <div className="nav-caption">Menu</div>
        <nav className="nav" aria-label="Sidebar navigation">
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="dashboard" /><span>Dashboard</span>
          </button>
          <button type="button"
                  className={`nav-item ${view === "reservations" ? "active" : ""}`}
                  onClick={() => { setView("reservations"); setError(""); }}>
            <Icon name="calendar" /><span>Reservations</span>
          </button>
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="rooms" /><span>Rooms</span>
          </button>
          {role !== "guest" && (
            <button type="button"
                    className={`nav-item ${view === "guests" ? "active" : ""}`}
                    onClick={() => { setView("guests"); setError(""); }}>
              <Icon name="guests" /><span>Guests</span>
            </button>
          )}
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="housekeeping" /><span>Housekeeping</span>
          </button>
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="billing" /><span>Billing</span>
          </button>
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="reports" /><span>Reports</span>
          </button>
          <button type="button" className="nav-item" disabled title="Coming soon">
            <Icon name="settings" /><span>Settings</span>
          </button>
        </nav>

        <div className="user-card">
          <div className="user-avatar">{currentRole.initials}</div>
          <div className="user-meta">
            <div className="user-name">{session?.claims?.sub || currentRole.label}</div>
            <div className="user-role">{currentRole.label}</div>
            <label className="role-label">
              {DEV_ROLE_SWITCH ? (
                <>
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
                </>
              ) : (
                <span>{session?.claims?.sub}</span>
              )}
            </label>
            <button type="button" className="page-btn" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </aside>

      <div className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{view === "reservations" ? "Front desk" : "Guest services"}</p>
            <div className="page-title">
              {view === "reservations" ? "Reservations Management" : "Guest Lookup"}
            </div>
          </div>
          <div className="topbar-right">
            <div className="system-date">System Date: {today}</div>
            <div className="role-chip">{currentRole.label}</div>
          </div>
        </header>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {view === "reservations" && (
          <>
            <section className="register-panel" aria-labelledby="lookup-heading">
              <div className="register-header">
                <div>
                  <h2 id="lookup-heading">Look up a reservation</h2>
                  <p className="muted">Find a booking by confirmation number</p>
                </div>
              </div>
              <form onSubmit={lookupReservation} className="form-grid">
                <label>
                  Confirmation number
                  <input
                    required
                    value={lookupNo}
                    onChange={(event) => setLookupNo(event.target.value)}
                    placeholder="R-…"
                  />
                </label>
                <button disabled={busy} type="submit" className="primary-action">
                  Find reservation
                </button>
              </form>
              {lookedUp && (
                <div className="confirmation-card" role="status">
                  <p>
                    <strong>{lookedUp.reservationNo}</strong>
                    {" · "}
                    {lookedUp.roomTypeId}
                    {" · "}
                    {day(lookedUp.checkIn)} to {day(lookedUp.checkOut)}
                    {" · "}
                    {lookedUp.totalAmount} {lookedUp.currency}
                  </p>
                  <span className={`status-pill ${lookedUp.status}`}>
                    {lookedUp.status}
                  </span>
                  {lookedUp.status === "confirmed" && (
                    <div className="lookup-actions">
                      <button
                        type="button"
                        className="page-btn"
                        onClick={() => startModify(lookedUp)}
                      >
                        Modify
                      </button>
                      <button
                        type="button"
                        className="page-btn"
                        onClick={() => cancelReservation(lookedUp.reservationNo)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            {role !== "guest" && (
            <section className="kpi-grid" aria-label="Booking summary">
              <article className="kpi-card kpi-primary">
                <div className="kpi-top"><span>Total bookings</span>
                  <span className="kpi-icon"><Icon name="calendar" /></span></div>
                <strong>{reservations.length}</strong>
                <small>in current view</small>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Confirmed</span>
                  <span className="kpi-icon"><Icon name="check" /></span></div>
                <strong>{confirmedCount}</strong>
                <div className="kpi-bar" aria-hidden="true"><i style={{ width: `${confirmedPct}%` }} /></div>
                <small>{confirmedPct}% of bookings</small>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Cancelled</span>
                  <span className="kpi-icon"><Icon name="close" /></span></div>
                <strong>{cancelledCount}</strong>
                <small>in current view</small>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Confirmed revenue</span>
                  <span className="kpi-icon"><Icon name="cash" /></span></div>
                <strong>{confirmedRevenue.toLocaleString()}</strong>
                <small>{revenueCurrency || "—"} total</small>
              </article>
            </section>
            )}
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
                    Hotel (optional)
                    <select
                      value={search.hotelId}
                      onChange={(event) =>
                        setSearch({ ...search, hotelId: event.target.value })
                      }
                    >
                      <option value="">All hotels</option>
                      {hotels.map((hotel) => (
                        <option key={hotel.id} value={hotel.id}>
                          {hotel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Guests
                    <input
                      type="number"
                      min="1"
                      required
                      value={search.guests}
                      onChange={(event) =>
                        setSearch({ ...search, guests: event.target.value })
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
                          {room.name || room.roomTypeId} —{" "}
                          {room.roomsAvailable ??
                            (room.available ? "Available" : "Unavailable")}
                          {" · "}
                          {room.nightlyRate} {room.currency} per night
                          {room.maxOccupancy
                            ? ` · up to ${room.maxOccupancy} guests`
                            : ""}
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
                      <label>
                        Address (optional)
                        <input
                          value={guest.address}
                          onChange={(event) =>
                            setGuest({ ...guest, address: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        ID document (optional)
                        <input
                          value={guest.idDocument}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              idDocument: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Preferences (optional)
                        <input
                          value={guest.preferences}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              preferences: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Loyalty tier
                        <select
                          value={guest.loyaltyTier}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              loyaltyTier: event.target.value,
                            })
                          }
                        >
                          <option value="none">None</option>
                          <option value="member">Member</option>
                          <option value="silver">Silver</option>
                          <option value="gold">Gold</option>
                          <option value="platinum">Platinum</option>
                        </select>
                      </label>
                      <label>
                        Loyalty number (optional)
                        <input
                          value={guest.loyaltyNumber}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              loyaltyNumber: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Confirmation channel
                        <select
                          value={guest.channel}
                          onChange={(event) =>
                            setGuest({ ...guest, channel: event.target.value })
                          }
                        >
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </select>
                      </label>
                      <label className="consent-row">
                        <input
                          type="checkbox"
                          checked={guest.consent}
                          onChange={(event) =>
                            setGuest({
                              ...guest,
                              consent: event.target.checked,
                            })
                          }
                        />
                        Store my profile and send booking confirmations
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
                    <section aria-labelledby="confirmation-heading" role="status" className="confirmation-card">
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

            {role !== "guest" && (
            <section className="register-panel">
              <div className="register-header">
                <div>
                  <h2>Active Booking Register</h2>
                  <p className="muted">Review, modify or cancel guest stays</p>
                </div>
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
                        <td colSpan="9" className="empty-cell">No reservations found.</td>
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
            )}
            {role === "guest" && !bookingOpen && (
              <div className="register-panel">
                <button
                  type="button"
                  className="primary-action"
                  onClick={openBooking}
                >
                  + New Reservation
                </button>
              </div>
            )}
          </>
        )}

        {view === "guests" && (
          <section aria-labelledby="guests-heading" className="register-panel">
            <div className="register-header">
              <h2 id="guests-heading">Find a guest</h2>
            </div>
            <form onSubmit={searchGuests} className="form-grid">
              <label>
                Name, email, phone or loyalty number
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
                <p className="muted">
                  {selectedGuest.loyaltyTier || "none"}
                  {selectedGuest.loyaltyNumber
                    ? ` · ${selectedGuest.loyaltyNumber}`
                    : ""}
                  {selectedGuest.address ? ` · ${selectedGuest.address}` : ""}
                </p>
                <div className="lookup-actions">
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => exportGuest(selectedGuest.id)}
                  >
                    Export profile
                  </button>
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => deleteGuest(selectedGuest.id)}
                  >
                    Delete profile
                  </button>
                </div>
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
