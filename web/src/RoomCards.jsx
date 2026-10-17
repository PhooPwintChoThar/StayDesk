import { useState } from "react";
import { assetUrl } from "./api.js";

function price(value, currency) {
  if (value == null) return "—";
  const amount = Number(value).toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${currency || ""} ${amount}`.trim();
}

function Gallery({ name, photos }) {
  const [index, setIndex] = useState(0);
  if (!photos?.length) {
    return <div className="room-card-photo room-card-photo-empty">No photos yet</div>;
  }
  const current = photos[Math.min(index, photos.length - 1)];
  const step = (delta) => setIndex((index + delta + photos.length) % photos.length);
  return (
    <div className="room-card-photo">
      <img src={assetUrl(current.url)} alt={`${name} photo ${index + 1} of ${photos.length}`} loading="lazy" />
      {photos.length > 1 && (
        <>
          <button type="button" className="gallery-nav prev" aria-label={`Previous ${name} photo`} onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" className="gallery-nav next" aria-label={`Next ${name} photo`} onClick={() => step(1)}>
            ›
          </button>
          <div className="gallery-dots" aria-hidden="true">
            {photos.map((photo, dot) => (
              <span key={photo.id} className={dot === index ? "active" : ""} />
            ))}
          </div>
        </>
      )}
      <span className="gallery-count">{photos.length} photo{photos.length === 1 ? "" : "s"}</span>
    </div>
  );
}

// Booking-app style cards for room types. With `nights` the card shows the stay
// total and rooms left; without it the card is a catalogue entry.
export default function RoomCards({ rooms, nights, guests, selectedId, onSelect, busy }) {
  return (
    <ul className="room-cards" aria-label="Available rooms">
      {rooms.map((room) => {
        const id = room.roomTypeId || room.id;
        const left = room.roomsAvailable;
        const selected = selectedId === id;
        return (
          <li key={id} className={`room-card ${selected ? "selected" : ""}`}>
            <Gallery name={room.name} photos={room.photos} />
            <div className="room-card-body">
              <div className="room-card-main">
                <h4>{room.name}</h4>
                {room.description && <p className="muted">{room.description}</p>}
                <ul className="room-card-facts">
                  <li>Sleeps up to {room.maxOccupancy}</li>
                  {nights ? <li>{nights} night{nights === 1 ? "" : "s"}{guests ? ` · ${guests} guest${Number(guests) === 1 ? "" : "s"}` : ""}</li> : null}
                </ul>
                {left != null && left > 0 && left <= 2 && (
                  <p className="room-card-urgent">Only {left} room{left === 1 ? "" : "s"} left!</p>
                )}
              </div>
              <div className="room-card-price">
                <span className="muted">per night</span>
                <strong>{price(room.nightlyRate, room.currency)}</strong>
                {nights ? (
                  <span className="room-card-total">
                    {price(Number(room.nightlyRate) * nights, room.currency)} total
                  </span>
                ) : null}
                {onSelect && (
                  <button
                    type="button"
                    className="primary-action"
                    disabled={busy || left === 0}
                    aria-label={`Select ${room.name}`}
                    onClick={() => onSelect(room)}
                  >
                    {selected ? "Selected" : "Select"}
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
