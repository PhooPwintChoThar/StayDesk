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
import MyProfileScreen from "./MyProfileScreen.jsx";
import PaymentsScreen from "./PaymentsScreen.jsx";

const DEV_ROLE_SWITCH = import.meta.env.VITE_DEV_ROLE_SWITCH === "true";

const initialSearch = {
  checkIn: "",
  checkOut: "",
  roomTypeId: "",
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
  consent: false,
  channel: "email",
};
const initialFilters = { from: "", to: "", status: "", roomTypeId: "", q: "" };

const ROLES = [
  { value: "guest", label: "Guest", initials: "G" },
  { value: "agent", label: "Front Desk Agent", initials: "FA" },
  { value: "manager", label: "Manager", initials: "M" },
];

// Views each role may open. Real authorization lives in the gateway; this only
// decides what the UI renders and shows in the sidebar.
const ALLOWED_VIEWS = {
  guest: ["reservations", "payments", "profile"],
  agent: ["reservations", "guests", "payments"],
  manager: ["reservations", "guests", "payments"],
};

const NAV_ITEMS = {
  reservations: { label: "Reservations", icon: "calendar" },
  guests: { label: "Guests", icon: "guests" },
  payments: { label: "Payments", icon: "billing" },
  profile: { label: "My profile", icon: "guests" },
};

function viewHeading(view, role) {
  if (view === "payments") return { eyebrow: "Billing", title: "Payments" };
  if (view === "profile") return { eyebrow: "Guest services", title: "My profile" };
  if (view === "guests") return { eyebrow: "Guest services", title: "Guest Lookup" };
  if (role === "guest") {
    return { eyebrow: "Guest services", title: "Book a room / My bookings" };
  }
  return { eyebrow: "Front desk", title: "Reservations Management" };
}

const day = (value) => String(value ?? "").slice(0, 10);

function nights(checkIn, checkOut) {
  const diff =
    Date.parse(`${day(checkOut)}T00:00:00Z`) -
    Date.parse(`${day(checkIn)}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : "";
}

const ICONS = {
  calendar: "M5 5h14v15H5z M5 10h14 M9 3v4 M15 3v4",
  guests: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20c0-4 4-6 8-6s8 2 8 6",
  billing: "M3 6h18v12H3z M3 10h18 M7 15h4",
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
  authMode,
  setAuthMode,
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
          {authMode === "sign-in" ? (
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
                <div className="auth-actions">
                  <button disabled={busy} type="submit" className="primary-action">
                    Sign in
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    className="page-btn"
                    onClick={() => setAuthMode("sign-up")}
                  >
                    Sign up
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <section aria-labelledby="create-guest-heading">
              <h2 id="create-guest-heading">Sign up</h2>
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
                <div className="auth-actions">
                  <button disabled={busy} type="submit" className="primary-action">
                    Create guest account
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    className="page-btn"
                    onClick={() => setAuthMode("sign-in")}
                  >
                    Sign in
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState(() => getSession());
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState("sign-in");
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
  const [roomTypeOptions, setRoomTypeOptions] = useState([]);
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

  // View guard: whatever the stored view is (after login, logout, a role change
  // or manipulated state), a view the role may not open falls back to
  // "reservations". Rendering below always uses activeView, never raw view.
  const allowedViews = Object.hasOwn(ALLOWED_VIEWS, role)
    ? ALLOWED_VIEWS[role]
    : ["reservations"];
  const activeView = allowedViews.includes(view) ? view : "reservations";
  useEffect(() => {
    if (view !== activeView) setView(activeView);
  }, [view, activeView]);

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

  function resetWorkspace() {
    setError("");
    setAuthError("");
    setGuests([]);
    setSelectedGuest(null);
    setGuestReservations([]);
    setLookedUp(null);
    setLookupNo("");
    setOpenMenu(null);
    setEditing(null);
    setBookingOpen(false);
    setConfirmation(null);
  }

  function handleLogout() {
    logout();
    setSession(null);
    setView("reservations");
    setReservations([]);
    resetWorkspace();
  }

  const loadReservations = useCallback(async () => {
    const params = new URLSearchParams();
    if (sessionRef.current?.claims?.role !== "guest") {
      if (filters.status) params.set("status", filters.status);
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
    }

    try {
      const result = await apiRequest(`/reservations?${params}`);
      setReservations(result.reservations || []);
    } catch (err) {
      setReservations([]);
      setError(err.message);
    }
  }, [filters.status, filters.from, filters.to]);

  useEffect(() => {
    if (session && activeView === "reservations") loadReservations();
  }, [session, activeView, loadReservations]);

  async function changeRole(nextRole) {
    setDevRole(nextRole);
    resetWorkspace();
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
    setGuest({
      ...initialGuest,
      email: role === "guest" ? session?.claims?.sub || "" : "",
    });
    setConfirmation(null);
    setError("");
    apiRequest("/room-types")
      .then((result) => setRoomTypeOptions(result.roomTypes || []))
      .catch((err) => {
        setRoomTypeOptions([]);
        setError(err.message);
      });
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
      if (search.guests) params.set("guests", search.guests);

      const result = await apiRequest(`/availability?${params}`);
      setAvailability((result.availability || []).filter((room) => room.available));
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
      await loadReservations();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelReservation(reservationNo) {
    setOpenMenu(null);
    setError("");

    const path = `/reservations/${encodeURIComponent(reservationNo)}`;
    let message = `Cancel reservation ${reservationNo}?`;
    let feeAmount = 0;
    try {
      const quote = await apiRequest(`${path}/cancellation-quote`);
      const hasQuote =
        quote &&
        quote.refundAmount != null &&
        quote.feeAmount != null &&
        Number.isFinite(Number(quote.refundAmount)) &&
        Number.isFinite(Number(quote.feeAmount));
      if (hasQuote) {
        feeAmount = Number(quote.feeAmount);
        message = `Refund ${quote.refundAmount} ${quote.currency}, fee ${quote.feeAmount} ${quote.currency} (rule ${quote.rule}). ${message}`;
      }
    } catch {
      // Quote unavailable: fall back to the plain confirmation message.
    }
    if (!window.confirm(message)) return;

    const options = { method: "DELETE" };
    // Only managers are offered the waiver (the gateway enforces it as well).
    if (role === "manager" && feeAmount > 0 && window.confirm("Waive the cancellation fee?")) {
      options.body = JSON.stringify({ waiveFee: true });
    }

    try {
      await apiRequest(path, options);
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
  const visibleReservations =
    role === "guest"
      ? reservations
      : reservations.filter(
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
        authMode={authMode}
        setAuthMode={setAuthMode}
        onSignIn={handleSignIn}
        onCreateGuest={handleCreateGuest}
      />
    );
  }

  const heading = viewHeading(activeView, role);

  return (
    <main className="page-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">H</div>
          <span className="brand-name">StayDesk</span>
        </div>

        <div className="nav-caption">Menu</div>
        <nav className="nav" aria-label="Sidebar navigation">
          {allowedViews.map((item) => (
            <button
              key={item}
              type="button"
              className={`nav-item ${activeView === item ? "active" : ""}`}
              aria-current={activeView === item ? "page" : undefined}
              onClick={() => {
                setView(item);
                setError("");
              }}
            >
              <Icon name={NAV_ITEMS[item].icon} />
              <span>{NAV_ITEMS[item].label}</span>
            </button>
          ))}
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
            <p className="eyebrow">{heading.eyebrow}</p>
            <div className="page-title">{heading.title}</div>
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

        {activeView === "reservations" && (
          <>
            {role !== "guest" && (
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
            )}

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
                    Room type (optional)
                    <select
                      value={search.roomTypeId}
                      onChange={(event) =>
                        setSearch({ ...search, roomTypeId: event.target.value })
                      }
                    >
                      <option value="">All room types</option>
                      {roomTypeOptions.map((roomType) => (
                        <option key={roomType.id} value={roomType.id}>
                          {roomType.name}
                        </option>
                      ))}
                    </select>
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
                          readOnly={role === "guest"}
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
                        Passport or ID number (optional)
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

            <section className="register-panel">
              <div className="register-header">
                <div>
                  <h2>{role === "guest" ? "My bookings" : "Active Booking Register"}</h2>
                  <p className="muted">
                    {role === "guest"
                      ? "Review, modify or cancel your stays"
                      : "Review, modify or cancel guest stays"}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary-action"
                  onClick={openBooking}
                >
                  + New Reservation
                </button>
              </div>

              {role !== "guest" && (
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
              )}

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
          </>
        )}

        {activeView === "guests" && (
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
                {selectedGuest.address && (
                  <p className="muted">{selectedGuest.address}</p>
                )}
                <div className="lookup-actions">
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => exportGuest(selectedGuest.id)}
                  >
                    Export profile
                  </button>
                  {role === "manager" && (
                    <button
                      type="button"
                      className="page-btn"
                      onClick={() => deleteGuest(selectedGuest.id)}
                    >
                      Delete profile
                    </button>
                  )}
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

        {activeView === "payments" && <PaymentsScreen session={session} />}

        {activeView === "profile" && <MyProfileScreen session={session} />}
      </div>
    </main>
  );
}
