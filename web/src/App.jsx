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
import RoomManagementScreen, { localToday } from "./RoomManagementScreen.jsx";
import RoomCards from "./RoomCards.jsx";
import BookingDetails from "./BookingDetails.jsx";
import GuestsScreen from "./GuestsScreen.jsx";
import Toaster from "./Toaster.jsx";
import { showToast, useErrorToast } from "./toast.js";

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
  additionalGuests: [],
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
  manager: ["reservations", "guests", "payments", "rooms"],
};

const NAV_ITEMS = {
  reservations: { label: "Reservations", icon: "calendar" },
  guests: { label: "Guests", icon: "guests" },
  payments: { label: "Payments", icon: "billing" },
  rooms: { label: "Room management", icon: "bed" },
  profile: { label: "My profile", icon: "guests" },
};

function viewHeading(view, role) {
  if (view === "payments") return { eyebrow: "Billing", title: "Payments" };
  if (view === "profile") return { eyebrow: "Guest services", title: "My profile" };
  if (view === "guests") return { eyebrow: "Guest services", title: "Guest Lookup" };
  if (view === "rooms") return { eyebrow: "Hotel setup", title: "Room management" };
  if (role === "guest") {
    return { eyebrow: "Guest services", title: "Book a room / My bookings" };
  }
  return { eyebrow: "Front desk", title: "Reservations Management" };
}

const day = (value) => String(value ?? "").slice(0, 10);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nextDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// A stay can be changed until the guest checks in or its check-out date passes.
const isOpenStay = (reservation) =>
  ["pending", "confirmed"].includes(reservation.status) &&
  !reservation.checkedInAt &&
  day(reservation.checkOut) > localToday();

// Guests may cancel only while the booking is still waiting for payment approval.
const canCancel = (reservation, role) =>
  isOpenStay(reservation) && (role !== "guest" || reservation.status === "pending");

function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_LABELS = { pending: "pending payment", confirmed: "confirmed", cancelled: "cancelled" };

// Guests change their booking themselves only while it waits for payment;
// the front desk can change dates until check-in.
const canModify = (reservation, role) =>
  isOpenStay(reservation) && (role !== "guest" || reservation.status === "pending");

const blankPerson = { name: "", idDocument: "" };

function partyOf(list, count) {
  return Array.from({ length: Math.max(0, (Number(count) || 1) - 1) }, (_, index) => list?.[index] || blankPerson);
}

// Name and passport/ID for guests 2..n (guest 1 is the person booking).
function PartyFields({ count, party, onChange }) {
  const people = partyOf(party, count);
  if (!people.length) return null;
  const update = (index, field, value) =>
    onChange(people.map((person, i) => (i === index ? { ...person, [field]: value } : person)));
  return (
    <div className="guest-party">
      <h4>Other guests staying</h4>
      {people.map((person, index) => (
        <div className="guest-party-row" key={index}>
          <label>
            Guest {index + 2} full name
            <input
              required
              value={person.name}
              onChange={(event) => update(index, "name", event.target.value)}
            />
          </label>
          <label>
            Guest {index + 2} passport or ID number
            <input
              required
              value={person.idDocument}
              onChange={(event) => update(index, "idDocument", event.target.value)}
            />
          </label>
        </div>
      ))}
    </div>
  );
}

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
  bed: "M21 15v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2M17 17v-2a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2",
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

// Front desk stay control: Check in -> Check out -> Succeeded.
function StayButton({ reservation, busy, onAction }) {
  if (reservation.status === "cancelled") return <span className="muted">—</span>;
  if (reservation.checkedInAt && reservation.checkedOutAt) {
    return <span className="status-pill succeeded">Succeeded</span>;
  }
  if (reservation.checkedInAt) {
    return (
      <button type="button" className="page-btn" disabled={busy} onClick={() => onAction("check-out")}>
        Check out
      </button>
    );
  }
  const waiting = reservation.status !== "confirmed";
  return (
    <button
      type="button"
      className="page-btn"
      disabled={busy || waiting}
      title={waiting ? "Waiting for the payment to be approved" : undefined}
      onClick={() => onAction("check-in")}
    >
      Check in
    </button>
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
  const [searched, setSearched] = useState(null);
  const [detailsFor, setDetailsFor] = useState(null);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [guest, setGuest] = useState(initialGuest);

  const [roomTypeOptions, setRoomTypeOptions] = useState([]);
  const [guestNames, setGuestNames] = useState({});

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useErrorToast(error, setError);
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
    setOpenMenu(null);
    setEditing(null);
    setBookingOpen(false);
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

  const loadRoomTypes = useCallback(() => {
    return apiRequest("/room-types")
      .then((result) => setRoomTypeOptions(result.roomTypes || []))
      .catch((err) => {
        setRoomTypeOptions([]);
        setError(err.message);
      });
  }, []);

  useEffect(() => {
    if (session) loadRoomTypes();
  }, [session, activeView, loadRoomTypes]);

  // Staff see guest names instead of raw ids.
  useEffect(() => {
    if (!session || role === "guest") return;
    const missing = [...new Set(reservations.map((item) => item.guestId))].filter(
      (id) => UUID_PATTERN.test(id) && !(id in guestNames),
    );
    if (!missing.length) return;
    apiRequest(`/guests?ids=${encodeURIComponent(missing.join(","))}`)
      .then((result) => {
        setGuestNames((current) => {
          const next = { ...current };
          for (const id of missing) next[id] = null;
          for (const item of result.guests || []) {
            next[item.id] = `${item.firstName} ${item.lastName}`.trim();
          }
          return next;
        });
      })
      .catch(() => {});
  }, [session, role, reservations, guestNames]);

  const typeName = (id) => roomTypeOptions.find((type) => type.id === id)?.name || id;
  const guestLabel = (id) => guestNames[id] || `${String(id).slice(0, 8)}…`;

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
    setSearched(null);
    setSelectedRoom(null);
    setGuest({
      ...initialGuest,
      email: role === "guest" ? session?.claims?.sub || "" : "",
    });
    setError("");
    loadRoomTypes();
    const guestId = session?.claims?.guestId;
    if (role === "guest" && guestId) {
      apiRequest(`/guests/${encodeURIComponent(guestId)}`)
        .then((profile) =>
          setGuest((current) => ({
            ...current,
            firstName: profile.firstName || current.firstName,
            lastName: profile.lastName || current.lastName,
            phone: profile.phone || current.phone,
            address: profile.address || current.address,
            idDocument: profile.idDocument || current.idDocument,
            preferences: profile.preferences || current.preferences,
          })),
        )
        .catch(() => {});
    }
  }

  async function stayAction(reservation, action) {
    setError("");
    const path = `/reservations/${encodeURIComponent(reservation.reservationNo)}`;
    const options = { method: "POST" };
    if (action === "check-out") {
      let summary = null;
      try {
        summary = await apiRequest(`${path}/payment-summary`);
      } catch {
        // The server re-checks the balance; fall back to a plain confirmation.
      }
      const owed = Number(summary?.balanceDue || 0);
      const question = owed > 0
        ? `The guest still owes ${owed.toFixed(2)} ${summary.currency}. Confirm the balance was collected at the desk and check out ${reservation.reservationNo}?`
        : `Check out ${reservation.reservationNo} now? The deposit will be applied to the bill.`;
      if (!window.confirm(question)) return;
      if (owed > 0) options.body = JSON.stringify({ collectBalance: true });
    } else if (!window.confirm(`Check in ${reservation.reservationNo} now?`)) {
      return;
    }
    setBusy(true);
    try {
      const updated = await apiRequest(`${path}/${action}`, options);
      if (updated.statement) {
        const bill = updated.statement;
        showToast(
          [
            `Total ${bill.totalAmount.toFixed(2)} ${bill.currency}: deposit applied ${bill.depositApplied.toFixed(2)}, payments ${bill.approvedPayments.toFixed(2)}, collected at desk ${bill.collectedAtDesk.toFixed(2)}.`,
            "Balance due 0.00.",
          ],
          { title: `${updated.reservationNo} checked out`, duration: 9000 },
        );
      } else if (action === "check-in") {
        showToast(updated.roomNumber ? `Room ${updated.roomNumber} is now occupied.` : "The guest is checked in.", {
          title: `${updated.reservationNo} checked in`,
        });
      }
      setReservations((current) =>
        current.map((item) => (item.reservationNo === updated.reservationNo ? updated : item)),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function searchRooms(event) {
    event.preventDefault();
    setError("");
    setAvailability([]);
    setSelectedRoom(null);
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
      setSearched({ checkIn: search.checkIn, checkOut: search.checkOut, guests: search.guests });
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
          checkIn: searched?.checkIn ?? search.checkIn,
          checkOut: searched?.checkOut ?? search.checkOut,
          guests: Number(searched?.guests ?? search.guests) || undefined,
          additionalGuests: partyOf(guest.additionalGuests, searched?.guests ?? search.guests).map((person) => ({
            name: person.name.trim(),
            idDocument: person.idDocument.trim(),
          })),
          channel: guest.channel,
        }),
      });
      showToast(
        [
          <>
            Reservation number: <strong>{reservation.reservationNo}</strong>
          </>,
          `Total: ${reservation.totalAmount} ${reservation.currency} · Status: ${reservation.status}`,
          `Deposit: ${reservation.depositAmount} ${reservation.currency}${reservation.roomNumber ? ` · Room ${reservation.roomNumber}` : ""}`,
          reservation.status === "pending"
            ? "The booking is pending until the front desk approves the payment. Upload the payment proof from the Payments page."
            : "",
        ],
        { title: reservation.status === "pending" ? "Booking received" : "Booking confirmed", duration: 10000 },
      );
      setBookingOpen(false);
      setSelectedRoom(null);
      setAvailability([]);
      setSearched(null);
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
      originalCheckIn: day(reservation.checkIn),
      guests: reservation.guests ? String(reservation.guests) : "",
      additionalGuests: [],
      datesOnly: role !== "guest",
    });
    if (role === "guest") {
      apiRequest(`/reservations/${encodeURIComponent(reservation.reservationNo)}`)
        .then((full) =>
          setEditing((current) =>
            current?.reservationNo === reservation.reservationNo
              ? { ...current, additionalGuests: full.additionalGuests || [] }
              : current,
          ),
        )
        .catch(() => {});
    }
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
          body: JSON.stringify(
            editing.datesOnly
              ? { roomTypeId: editing.roomTypeId, checkIn: editing.checkIn, checkOut: editing.checkOut }
              : {
                  roomTypeId: editing.roomTypeId,
                  checkIn: editing.checkIn,
                  checkOut: editing.checkOut,
                  guests: Number(editing.guests) || undefined,
                  additionalGuests: partyOf(editing.additionalGuests, editing.guests).map((person) => ({
                    name: person.name.trim(),
                    idDocument: person.idDocument.trim(),
                  })),
                },
          ),
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
              String(reservation.guestId).toLowerCase().includes(query) ||
              String(guestNames[reservation.guestId] || "").toLowerCase().includes(query) ||
              String(reservation.roomNumber || "").toLowerCase().includes(query)),
        );
  const confirmedList = reservations.filter((r) => r.status === "confirmed");
  const confirmedCount = confirmedList.length;
  const cancelledCount = reservations.filter((r) => r.status === "cancelled").length;
  const pendingCount = reservations.filter((r) => r.status === "pending").length;
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
      <Toaster />
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
              <span>
                {NAV_ITEMS[item].label}
              </span>
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

        {detailsFor && (
          <BookingDetails
            reservationNo={detailsFor.reservationNo}
            roomTypeName={typeName(detailsFor.roomTypeId)}
            viewerRole={role}
            onClose={() => setDetailsFor(null)}
            actions={(full) => (
              <>
                {canModify(full, role) && (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => {
                      setDetailsFor(null);
                      startModify(full);
                    }}
                  >
                    {role === "guest" ? "Modify booking" : "Change dates"}
                  </button>
                )}
                {canCancel(full, role) && (
                  <button
                    type="button"
                    className="page-btn"
                    onClick={() => {
                      setDetailsFor(null);
                      cancelReservation(full.reservationNo);
                    }}
                  >
                    Cancel booking
                  </button>
                )}
              </>
            )}
          />
        )}

        {activeView === "reservations" && (
          <>
            {role !== "guest" && (
            <section className="kpi-grid" aria-label="Booking summary">
              <article className="kpi-card kpi-primary">
                <div className="kpi-top"><span>Total bookings</span>
                  <span className="kpi-icon"><Icon name="calendar" /></span></div>
                <strong>{reservations.length}</strong>
                <small>{pendingCount} awaiting payment</small>
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
                      min={localToday()}
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
                      min={nextDay(search.checkIn || localToday())}
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

                {searched && availability.length > 0 && (
                  <>
                    <h3>
                      {availability.length} room type{availability.length === 1 ? "" : "s"} available ·{" "}
                      {day(searched.checkIn)} to {day(searched.checkOut)}
                    </h3>
                    <RoomCards
                      rooms={availability}
                      nights={nights(searched.checkIn, searched.checkOut)}
                      guests={searched.guests}
                      selectedId={selectedRoom?.roomTypeId}
                      onSelect={setSelectedRoom}
                      busy={busy}
                    />
                  </>
                )}
                {searched && availability.length === 0 && !busy && (
                  <p className="muted">
                    No rooms are free for those dates and guests. Try other dates.
                  </p>
                )}
                {!searched && roomTypeOptions.length > 0 && (
                  <>
                    <h3>Our rooms</h3>
                    <p className="muted">Choose your dates above to see prices for your stay.</p>
                    <RoomCards rooms={roomTypeOptions} />
                  </>
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
                        Passport or ID number
                        <input
                          required
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
                      <PartyFields
                        count={searched?.guests ?? search.guests}
                        party={guest.additionalGuests}
                        onChange={(additionalGuests) => setGuest({ ...guest, additionalGuests })}
                      />
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

              </section>
            )}

            {editing && (
              <section
                aria-labelledby="modify-heading"
                className="register-panel"
              >
                <div className="register-header">
                  <h2 id="modify-heading">
                    {editing.datesOnly ? "Change dates for" : "Modify"} {editing.reservationNo}
                  </h2>
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
                      min={editing.originalCheckIn < localToday() ? editing.originalCheckIn : localToday()}
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
                      min={nextDay(editing.checkIn)}
                      value={editing.checkOut}
                      onChange={(event) =>
                        setEditing({ ...editing, checkOut: event.target.value })
                      }
                    />
                  </label>
                  {!editing.datesOnly && (
                  <>
                  <label>
                    Room type
                    <select
                      required
                      value={editing.roomTypeId}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          roomTypeId: event.target.value,
                        })
                      }
                    >
                      {!roomTypeOptions.some((type) => type.id === editing.roomTypeId) && (
                        <option value={editing.roomTypeId}>{editing.roomTypeId}</option>
                      )}
                      {roomTypeOptions.map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name} (up to {type.maxOccupancy} guests)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Guests
                    <input
                      type="number"
                      min="1"
                      value={editing.guests}
                      onChange={(event) =>
                        setEditing({ ...editing, guests: event.target.value })
                      }
                    />
                  </label>
                  <PartyFields
                    count={editing.guests}
                    party={editing.additionalGuests}
                    onChange={(additionalGuests) => setEditing({ ...editing, additionalGuests })}
                  />
                  </>
                  )}
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
                    <option value="pending">Pending payment</option>
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
                        {typeName(type)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field search-field">
                  <label htmlFor="filter-search">Search</label>
                  <input
                    id="filter-search"
                    type="text"
                    placeholder="Booking ID, guest or room..."
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
                      <th>{role === "guest" ? "GUESTS" : "GUEST"}</th>
                      <th>ROOM</th>
                      <th>CHECK-IN</th>
                      <th>CHECK-OUT</th>
                      <th>NIGHTS</th>
                      <th>TOTAL</th>
                      <th>STATUS</th>
                      {role !== "guest" && (
                        <>
                          <th>CHECK-IN TIME</th>
                          <th>CHECK-OUT TIME</th>
                          <th>STAY</th>
                        </>
                      )}
                      <th>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleReservations.map((reservation) => (
                      <tr key={reservation.reservationNo}>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setDetailsFor(reservation)}
                          >
                            {reservation.reservationNo}
                          </button>
                        </td>
                        <td title={reservation.guestId}>
                          {role === "guest"
                            ? reservation.guests || "—"
                            : guestLabel(reservation.guestId)}
                        </td>
                        <td>
                          {typeName(reservation.roomTypeId)}
                          {reservation.roomNumber && (
                            <div className="muted">Room {reservation.roomNumber}</div>
                          )}
                        </td>
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
                            {STATUS_LABELS[reservation.status] || reservation.status}
                          </span>
                        </td>
                        {role !== "guest" && (
                          <>
                            <td>{dateTime(reservation.checkedInAt)}</td>
                            <td>{dateTime(reservation.checkedOutAt)}</td>
                            <td>
                              <StayButton
                                reservation={reservation}
                                busy={busy}
                                onAction={(action) => stayAction(reservation, action)}
                              />
                            </td>
                          </>
                        )}
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
                                disabled={!canModify(reservation, role)}
                                title={
                                  role === "guest" && reservation.status === "confirmed"
                                    ? "Confirmed bookings can be changed by the front desk"
                                    : undefined
                                }
                                onClick={() => startModify(reservation)}
                              >
                                Modify
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={!canCancel(reservation, role)}
                                title={
                                  role === "guest" && reservation.status === "confirmed"
                                    ? "Confirmed bookings can be cancelled by the front desk"
                                    : undefined
                                }
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
                        <td colSpan={role === "guest" ? 9 : 12} className="empty-cell">No reservations found.</td>
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

        {activeView === "guests" && <GuestsScreen role={role} typeName={typeName} />}

        {activeView === "payments" && <PaymentsScreen session={session} />}

        {activeView === "rooms" && <RoomManagementScreen />}

        {activeView === "profile" && <MyProfileScreen session={session} />}
      </div>
    </main>
  );
}
