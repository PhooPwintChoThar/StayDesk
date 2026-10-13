import { useEffect, useState } from 'react';
import { apiRequest } from './api.js';

const initialSearch = { checkIn: '', checkOut: '', roomTypeId: '' };
const initialGuest = { email: '', firstName: '', lastName: '', phone: '' };

function readReservations() {
  try {
    return JSON.parse(localStorage.getItem('hotel-reservations') || '[]');
  } catch {
    return [];
  }
}

export default function App() {
  const [search, setSearch] = useState(initialSearch);
  const [availability, setAvailability] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [guest, setGuest] = useState(initialGuest);
  const [depositAmount, setDepositAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [confirmation, setConfirmation] = useState(null);
  const [reservations, setReservations] = useState(readReservations);
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    localStorage.setItem('hotel-reservations', JSON.stringify(reservations));
  }, [reservations]);

  async function searchRooms(event) {
    event.preventDefault();
    setError('');
    setAvailability([]);
    setSelectedRoom(null);
    setConfirmation(null);
    setBusy(true);

    try {
      const params = new URLSearchParams({
        checkIn: search.checkIn,
        checkOut: search.checkOut
      });
      if (search.roomTypeId) params.set('roomTypeId', search.roomTypeId);

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

    setError('');
    setBusy(true);
    try {
      const reservation = await apiRequest('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          guest,
          roomTypeId: selectedRoom.roomTypeId,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
          depositAmount: Number(depositAmount),
          currency
        })
      });
      setConfirmation(reservation);
      setReservations((current) => [
        reservation,
        ...current.filter((item) => item.reservationNo !== reservation.reservationNo)
      ]);
      setSelectedRoom(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelReservation(reservationNo) {
    if (!window.confirm(`Cancel reservation ${reservationNo}?`)) return;

    setError('');
    try {
      await apiRequest(`/reservations/${encodeURIComponent(reservationNo)}`, {
        method: 'DELETE'
      });
      setReservations((current) => current.map((reservation) =>
        reservation.reservationNo === reservationNo
          ? { ...reservation, status: 'cancelled' }
          : reservation
      ));
    } catch (err) {
      setError(err.message);
    }
  }

  async function modifyReservation(reservation) {
    const checkIn = window.prompt('New check-in date (YYYY-MM-DD):', reservation.checkIn);
    if (checkIn === null) return;
    const checkOut = window.prompt('New check-out date (YYYY-MM-DD):', reservation.checkOut);
    if (checkOut === null) return;
    const roomTypeId = window.prompt('Room type:', reservation.roomTypeId);
    if (roomTypeId === null) return;

    setError('');
    try {
      const updated = await apiRequest(
        `/reservations/${encodeURIComponent(reservation.reservationNo)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ roomTypeId, checkIn, checkOut })
        }
      );
      setReservations((current) => current.map((item) =>
        item.reservationNo === reservation.reservationNo ? updated : item
      ));
    } catch (err) {
      setError(err.message);
    }
  }

  const visibleReservations = reservations.filter((reservation) =>
    statusFilter === 'all' || reservation.status === statusFilter
  );

  const dashboardRows = [
    {
      reservationNo: 'BK-2026-9810',
      guestName: 'Arthur Prandogon',
      roomNumber: '204',
      roomType: 'Standard King',
      checkIn: 'Oct 24',
      checkOut: 'Oct 28',
      nights: '4',
      status: 'Confirmed',
      statusClass: 'confirmed'
    },
    {
      reservationNo: 'BK-2026-9812',
      guestName: 'Gwen Stacy',
      roomNumber: '312',
      roomType: 'Deluxe Suite',
      checkIn: 'Oct 24',
      checkOut: 'Oct 26',
      nights: '2',
      status: 'Checked-in',
      statusClass: 'checked-in'
    },
    {
      reservationNo: 'BK-2026-9801',
      guestName: 'Clark Kent',
      roomNumber: '104',
      roomType: 'Standard Twin',
      checkIn: 'Oct 20',
      checkOut: 'Oct 24',
      nights: '4',
      status: 'Checked-out',
      statusClass: 'checked-out'
    },
    {
      reservationNo: 'BK-2026-9799',
      guestName: 'Tony Stark',
      roomNumber: '502',
      roomType: 'Penthouse Suite',
      checkIn: 'Oct 18',
      checkOut: 'Oct 22',
      nights: '4',
      status: 'Checked-out',
      statusClass: 'checked-out'
    },
    {
      reservationNo: 'BK-2026-9811',
      guestName: 'Peter Parker',
      roomNumber: '102',
      roomType: 'Standard Twin',
      checkIn: 'Oct 24',
      checkOut: 'Oct 25',
      nights: '1',
      status: 'Cancelled',
      statusClass: 'cancelled'
    },
    {
      reservationNo: 'BK-2026-9805',
      guestName: 'Selina Kyle',
      roomNumber: '408',
      roomType: 'Deluxe King',
      checkIn: 'Oct 22',
      checkOut: 'Oct 27',
      nights: '5',
      status: 'Checked-in',
      statusClass: 'checked-in'
    }
  ];

  const tableRows = visibleReservations.length > 0
    ? visibleReservations.map((reservation) => ({
        reservationNo: reservation.reservationNo,
        guestName: reservation.guestId,
        roomNumber: reservation.roomTypeId,
        roomType: reservation.roomTypeId,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        nights: reservation.status,
        status: reservation.status,
        statusClass: reservation.status === 'cancelled' ? 'cancelled' : reservation.status === 'confirmed' ? 'confirmed' : 'checked-in'
      }))
    : dashboardRows;

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
          <button type="button" className="nav-item active">
            <span className="nav-icon">▤</span>
            <span>Reservations</span>
          </button>
          <button type="button" className="nav-item">
            <span className="nav-icon">⌂</span>
            <span>Rooms</span>
          </button>
          <button type="button" className="nav-item">
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
          <div className="user-avatar">JD</div>
          <div className="user-meta">
            <strong>John Doe</strong>
            <span>Duty Manager</span>
          </div>
        </div>
      </aside>

      <div className="main-panel">
        <header className="topbar">
          <div className="page-title">Reservations Management</div>
          <div className="system-date">System Date: Oct 24, 2026 · 10:42 AM</div>
        </header>

        <section className="register-panel">
          <div className="register-header">
            <h2>Active Booking Register</h2>
            <button type="button" className="primary-action">+ New Reservation</button>
          </div>

          <div className="toolbar" aria-label="Reservation filters">
            <div className="field">
              <label>Date Range</label>
              <select defaultValue="Oct 24 - Oct 31, 2026">
                <option>Oct 24 - Oct 31, 2026</option>
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select defaultValue="All Statuses">
                <option>All Statuses</option>
              </select>
            </div>
            <div className="field">
              <label>Room Type</label>
              <select defaultValue="All Room Types">
                <option>All Room Types</option>
              </select>
            </div>
            <div className="field search-field">
              <label>Search</label>
              <input type="text" placeholder="Guest name or ID..." />
            </div>
          </div>

          <div className="table-wrap">
            <table role="table">
              <thead>
                <tr>
                  <th>BOOKING ID</th>
                  <th>GUEST NAME</th>
                  <th>ROOM #</th>
                  <th>ROOM TYPE</th>
                  <th>CHECK-IN</th>
                  <th>CHECK-OUT</th>
                  <th>NIGHTS</th>
                  <th>STATUS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.reservationNo}>
                    <td>{row.reservationNo}</td>
                    <td>{row.guestName}</td>
                    <td>{row.roomNumber}</td>
                    <td>{row.roomType}</td>
                    <td>{row.checkIn}</td>
                    <td>{row.checkOut}</td>
                    <td>{row.nights}</td>
                    <td>
                      <span className={`status-pill ${row.statusClass}`}>{row.status}</span>
                    </td>
                    <td><button type="button" className="menu-button" aria-label={`Actions for ${row.reservationNo}`}>⋯</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination-row">
            <span>Showing 1-6 of 148 entries</span>
            <div className="pagination-controls">
              <button type="button" className="page-btn">Prev</button>
              <button type="button" className="page-number active">1</button>
              <button type="button" className="page-number">2</button>
              <button type="button" className="page-number">3</button>
              <button type="button" className="page-btn">Next</button>
            </div>
          </div>
        </section>
      </div>

      {error && <p role="alert" className="error sr-only">{error}</p>}

      <section aria-labelledby="search-heading" className="sr-only">
        <h2 id="search-heading">Find a room</h2>
        <form onSubmit={searchRooms} className="form-grid">
          <label>
            Check-in
            <input
              type="date"
              required
              value={search.checkIn}
              onChange={(event) => setSearch({ ...search, checkIn: event.target.value })}
            />
          </label>
          <label>
            Check-out
            <input
              type="date"
              required
              value={search.checkOut}
              onChange={(event) => setSearch({ ...search, checkOut: event.target.value })}
            />
          </label>
          <label>
            Room type ID (optional)
            <input
              value={search.roomTypeId}
              onChange={(event) => setSearch({ ...search, roomTypeId: event.target.value })}
            />
          </label>
          <button disabled={busy} type="submit">Search availability</button>
        </form>

        {availability.length > 0 && (
          <ul aria-label="Available rooms" className="room-list">
            {availability.map((room) => (
              <li key={room.roomTypeId}>
                <span>
                  {room.roomTypeId} — {room.roomsAvailable ?? (room.available ? 'Available' : 'Unavailable')}
                  {' · '}{room.nightlyRate} {room.currency} per night
                </span>
                <button
                  type="button"
                  disabled={!room.available || busy}
                  onClick={() => setSelectedRoom(room)}
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
        )}
        {availability.length === 0 && !busy && (
          <p>No availability results yet. Search dates to find rooms.</p>
        )}
      </section>

      {selectedRoom && (
        <section aria-labelledby="booking-heading" className="sr-only">
          <h2 id="booking-heading">Guest and deposit details</h2>
          <form onSubmit={bookRoom} className="form-grid">
            <label>
              Email
              <input
                type="email"
                required
                value={guest.email}
                onChange={(event) => setGuest({ ...guest, email: event.target.value })}
              />
            </label>
            <label>
              First name
              <input
                required
                value={guest.firstName}
                onChange={(event) => setGuest({ ...guest, firstName: event.target.value })}
              />
            </label>
            <label>
              Last name
              <input
                required
                value={guest.lastName}
                onChange={(event) => setGuest({ ...guest, lastName: event.target.value })}
              />
            </label>
            <label>
              Phone (optional)
              <input
                value={guest.phone}
                onChange={(event) => setGuest({ ...guest, phone: event.target.value })}
              />
            </label>
            <label>
              Deposit amount
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={depositAmount}
                onChange={(event) => setDepositAmount(event.target.value)}
              />
            </label>
            <label>
              Currency
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                <option value="USD">USD</option>
                <option value="THB">THB</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
            <button disabled={busy} type="submit">Book room</button>
          </form>
        </section>
      )}

      {confirmation && (
        <section aria-labelledby="confirmation-heading" role="status" className="sr-only">
          <h2 id="confirmation-heading">Booking confirmed</h2>
          <p>
            Reservation number:{' '}
            <strong aria-label={`Reservation number ${confirmation.reservationNo}`}>
              {confirmation.reservationNo.replace(/[0-9]/g, '•')}
            </strong>
          </p>
          <p>Status: {confirmation.status}</p>
        </section>
      )}

    </main>
  );
}