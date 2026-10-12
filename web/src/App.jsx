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

  return (
    <main className="page">
      <header>
        <h1>Hotel reservations</h1>
      </header>

      {error && <p role="alert" className="error">{error}</p>}

      <section aria-labelledby="search-heading">
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
        <section aria-labelledby="booking-heading">
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
        <section aria-labelledby="confirmation-heading" role="status">
          <h2 id="confirmation-heading">Booking confirmed</h2>
          <p>Reservation number: <strong>{confirmation.reservationNo}</strong></p>
          <p>Status: {confirmation.status}</p>
        </section>
      )}

      <section aria-labelledby="reservations-heading">
        <h2 id="reservations-heading">Reservations</h2>
        <label>
          Filter by status
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reservation</th>
                <th>Guest</th>
                <th>Room</th>
                <th>Dates</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleReservations.map((reservation) => (
                <tr key={reservation.reservationNo}>
                  <td>{reservation.reservationNo}</td>
                  <td>{reservation.guestId}</td>
                  <td>{reservation.roomTypeId}</td>
                  <td>{reservation.checkIn} – {reservation.checkOut}</td>
                  <td>{reservation.totalAmount} {reservation.currency}</td>
                  <td>{reservation.status}</td>
                  <td>
                    {reservation.status === 'confirmed' && (
                      <>
                        <button type="button" onClick={() => modifyReservation(reservation)}>
                          Modify
                        </button>
                        <button type="button" onClick={() => cancelReservation(reservation.reservationNo)}>
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {visibleReservations.length === 0 && (
                <tr><td colSpan="7">No reservations to display.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}