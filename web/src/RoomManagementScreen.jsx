import { Fragment, useCallback, useEffect, useState } from "react";
import { apiRequest, assetUrl } from "./api.js";
import { showToast } from "./toast.js";

const NEW_TYPE = "__new__";

const emptyType = { name: "", maxOccupancy: "2", nightlyRate: "", description: "", photos: [] };
const emptyRoom = { roomNumber: "", roomTypeId: "" };
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export function validatePhotos(files) {
  for (const file of files) {
    if (!PHOTO_TYPES.includes(file.type)) return `${file.name} is not a JPEG, PNG or WebP image.`;
    if (file.size > MAX_PHOTO_BYTES) return `${file.name} is larger than 8 MB.`;
  }
  return "";
}

// Safari keeps only a reference to a picked file and reads it when the request is
// sent. If the file is gone by then (a photo Safari converted into a temporary file,
// an iCloud file that is not downloaded, a moved file) the upload fails with
// "Failed to load resource: bad URL". Copying the bytes at selection time makes the
// upload independent of the file on disk and reports unreadable files at once.
function readBytes(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function readPhotos(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(
    files.map(async (file) => {
      try {
        return new File([await readBytes(file)], file.name, { type: file.type, lastModified: file.lastModified });
      } catch {
        throw new Error(
          `${file.name} could not be read. If it is in iCloud or was moved, save it on this computer and choose it again.`,
        );
      }
    }),
  );
}

async function uploadPhotos(roomTypeId, files) {
  if (!files?.length) return null;
  const form = new FormData();
  for (const file of files) form.append("photos", file);
  return apiRequest(`/room-types/${encodeURIComponent(roomTypeId)}/photos`, { method: "POST", body: form });
}

function photoUploadMessage(typeName, reason) {
  return `Room type ${typeName.trim()} was saved, but its photos could not be uploaded (${reason}). Use its Photos button below to add them.`;
}

export function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function money(value, currency) {
  if (value == null) return "No rate";
  return `${Number(value).toFixed(2)} ${currency || ""}`.trim();
}

function typePayload(form) {
  return {
    name: form.name.trim(),
    maxOccupancy: Number(form.maxOccupancy),
    nightlyRate: Number(form.nightlyRate),
    description: form.description.trim() || undefined,
  };
}

function TypeFields({ form, setForm, prefix, withPhotos = false }) {
  return (
    <>
      <label>
        Room type name
        <input
          required
          aria-label={`${prefix} name`}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="e.g. Junior Suite"
        />
      </label>
      <label>
        Max guests
        <input
          required
          type="number"
          min="1"
          max="20"
          aria-label={`${prefix} max guests`}
          value={form.maxOccupancy}
          onChange={(event) => setForm({ ...form, maxOccupancy: event.target.value })}
        />
      </label>
      <label>
        Price per night
        <input
          required
          type="number"
          min="0.01"
          step="0.01"
          aria-label={`${prefix} price per night`}
          value={form.nightlyRate}
          onChange={(event) => setForm({ ...form, nightlyRate: event.target.value })}
        />
      </label>
      <label>
        Description (optional)
        <input
          aria-label={`${prefix} description`}
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </label>
      {withPhotos && (
        <label>
          Photos (optional, as many as you like)
          <input
            key={form.photos?.length ? "chosen" : "empty"}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            aria-label={`${prefix} photos`}
            onChange={async (event) => {
              const input = event.target;
              try {
                const photos = await readPhotos(input.files);
                setForm((current) => ({ ...current, photos, photoError: "" }));
              } catch (err) {
                input.value = "";
                setForm((current) => ({ ...current, photos: [], photoError: err.message }));
              }
            }}
          />
          {form.photos?.length > 0 && <span className="muted">{form.photos.length} photo(s) selected</span>}
          {form.photoError && <span role="alert" className="error">{form.photoError}</span>}
        </label>
      )}
    </>
  );
}

function RoomStatus({ room }) {
  if (room.status !== "maintenance") {
    return <span className="status-pill available">Available</span>;
  }
  const started = room.maintenanceFrom <= localToday();
  return (
    <>
      <span className={`status-pill ${started ? "maintenance" : "scheduled"}`}>
        {started ? "Maintenance" : "Maintenance scheduled"}
      </span>
      <div className="muted">
        {room.maintenanceFrom} → back {room.maintenanceTo}
        {room.maintenanceNote ? ` · ${room.maintenanceNote}` : ""}
      </div>
    </>
  );
}

function PhotoManager({ type, busy, onUpload, onRemove }) {
  const [files, setFiles] = useState([]);
  const [readError, setReadError] = useState("");
  const [inputKey, setInputKey] = useState(0);
  return (
    <div className="photo-manager">
      {type.photos.length === 0 && <p className="muted">No photos yet. Guests see photos when they search for rooms.</p>}
      <ul className="photo-grid" aria-label={`${type.name} photos`}>
        {type.photos.map((photo, index) => (
          <li key={photo.id}>
            <img src={assetUrl(photo.url)} alt={`${type.name} photo ${index + 1}`} />
            <button
              type="button"
              className="page-btn"
              disabled={busy}
              aria-label={`Remove ${type.name} photo ${index + 1}`}
              onClick={() => onRemove(photo)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onUpload(files)) {
            setFiles([]);
            setInputKey((key) => key + 1);
          }
        }}
      >
        <label>
          Add photos
          <input
            key={inputKey}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            aria-label={`Add ${type.name} photos`}
            onChange={async (event) => {
              const input = event.target;
              try {
                setFiles(await readPhotos(input.files));
                setReadError("");
              } catch (err) {
                input.value = "";
                setFiles([]);
                setReadError(err.message);
              }
            }}
          />
          {readError && <span role="alert" className="error">{readError}</span>}
        </label>
        <button type="submit" className="primary-action" disabled={busy || files.length === 0}>
          Upload {files.length > 0 ? `${files.length} photo${files.length === 1 ? "" : "s"}` : "photos"}
        </button>
      </form>
    </div>
  );
}

export default function RoomManagementScreen() {
  const [roomTypes, setRoomTypes] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [roomForm, setRoomForm] = useState(emptyRoom);
  const [newTypeForm, setNewTypeForm] = useState(emptyType);
  const [typeForm, setTypeForm] = useState(emptyType);
  const [editingType, setEditingType] = useState(null);
  const [editingRoom, setEditingRoom] = useState(null);
  const [maintenance, setMaintenance] = useState(null);
  const [photosFor, setPhotosFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [typeResult, roomResult] = await Promise.all([
        apiRequest("/room-types"),
        apiRequest("/rooms"),
      ]);
      setRoomTypes((typeResult.roomTypes || []).map((type) => ({ ...type, photos: type.photos || [] })));
      setRooms(roomResult.rooms || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action, successMessage) {
    setError("");
    setBusy(true);
    try {
      await action();
      await load();
      showToast(successMessage);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createRoom(event) {
    event.preventDefault();
    const creatingType = roomForm.roomTypeId === NEW_TYPE;
    const photoProblem = creatingType ? validatePhotos(newTypeForm.photos) : "";
    if (photoProblem) {
      setError(photoProblem);
      return;
    }
    const body = creatingType
      ? { roomNumber: roomForm.roomNumber.trim(), newRoomType: typePayload(newTypeForm) }
      : { roomNumber: roomForm.roomNumber.trim(), roomTypeId: roomForm.roomTypeId };
    let photoError = "";
    const ok = await run(async () => {
      const room = await apiRequest("/rooms", { method: "POST", body: JSON.stringify(body) });
      if (creatingType) {
        // The room and its type exist now; a photo problem must not look like a failed save.
        await uploadPhotos(room.roomTypeId, newTypeForm.photos).catch((err) => {
          photoError = err.message;
        });
      }
    }, `Room ${body.roomNumber} added.`);
    if (ok) {
      if (photoError) setError(photoUploadMessage(newTypeForm.name, photoError));
      setRoomForm(emptyRoom);
      setNewTypeForm(emptyType);
    }
  }

  async function createType(event) {
    event.preventDefault();
    const payload = typePayload(typeForm);
    const photoProblem = validatePhotos(typeForm.photos);
    if (photoProblem) {
      setError(photoProblem);
      return;
    }
    let photoError = "";
    const ok = await run(async () => {
      const type = await apiRequest("/room-types", { method: "POST", body: JSON.stringify(payload) });
      await uploadPhotos(type.id, typeForm.photos).catch((err) => {
        photoError = err.message;
      });
    }, `Room type ${payload.name} added.`);
    if (ok) {
      if (photoError) setError(photoUploadMessage(payload.name, photoError));
      setTypeForm(emptyType);
    }
  }

  async function saveType(event) {
    event.preventDefault();
    const payload = typePayload(editingType);
    const ok = await run(
      () =>
        apiRequest(`/room-types/${encodeURIComponent(editingType.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, description: editingType.description.trim() }),
        }),
      `Room type ${payload.name} updated.`,
    );
    if (ok) setEditingType(null);
  }

  async function addPhotos(type, files) {
    const problem = validatePhotos(files);
    if (problem) {
      setError(problem);
      return false;
    }
    return run(() => uploadPhotos(type.id, files), `${files.length} photo(s) added to ${type.name}.`);
  }

  async function removePhoto(type, photo) {
    if (!window.confirm(`Remove this ${type.name} photo?`)) return;
    await run(
      () => apiRequest(photo.url, { method: "DELETE" }),
      `Photo removed from ${type.name}.`,
    );
  }

  async function deleteType(type) {
    if (!window.confirm(`Delete room type ${type.name}?`)) return;
    await run(
      () => apiRequest(`/room-types/${encodeURIComponent(type.id)}`, { method: "DELETE" }),
      `Room type ${type.name} deleted.`,
    );
  }

  async function saveRoom(event) {
    event.preventDefault();
    const ok = await run(
      () =>
        apiRequest(`/rooms/${encodeURIComponent(editingRoom.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            roomNumber: editingRoom.roomNumber.trim(),
            roomTypeId: editingRoom.roomTypeId,
          }),
        }),
      `Room ${editingRoom.roomNumber.trim()} updated.`,
    );
    if (ok) setEditingRoom(null);
  }

  async function deleteRoom(room) {
    if (!window.confirm(`Delete room ${room.roomNumber}? This cannot be undone.`)) return;
    await run(
      () => apiRequest(`/rooms/${encodeURIComponent(room.id)}`, { method: "DELETE" }),
      `Room ${room.roomNumber} deleted.`,
    );
  }

  async function scheduleMaintenance(event) {
    event.preventDefault();
    const ok = await run(
      () =>
        apiRequest(`/rooms/${encodeURIComponent(maintenance.id)}/maintenance`, {
          method: "PUT",
          body: JSON.stringify({
            from: maintenance.from,
            to: maintenance.to,
            note: maintenance.note.trim() || undefined,
          }),
        }),
      `Room ${maintenance.roomNumber} is under maintenance from ${maintenance.from} to ${maintenance.to}.`,
    );
    if (ok) setMaintenance(null);
  }

  async function endMaintenance(room) {
    if (!window.confirm(`Return room ${room.roomNumber} to service now?`)) return;
    await run(
      () =>
        apiRequest(`/rooms/${encodeURIComponent(room.id)}/maintenance`, { method: "DELETE" }),
      `Room ${room.roomNumber} is available again.`,
    );
  }

  const today = localToday();

  return (
    <>
      {error && <p role="alert" className="error">{error}</p>}

      <section aria-labelledby="add-room-heading" className="register-panel">
        <div className="register-header">
          <div>
            <h2 id="add-room-heading">Add a room</h2>
            <p className="muted">Use an existing room type or create a new one with its price.</p>
          </div>
        </div>
        <form onSubmit={createRoom} className="form-grid">
          <label>
            Room number
            <input
              required
              value={roomForm.roomNumber}
              onChange={(event) => setRoomForm({ ...roomForm, roomNumber: event.target.value })}
              placeholder="e.g. 301"
            />
          </label>
          <label>
            Room type
            <select
              required
              value={roomForm.roomTypeId}
              onChange={(event) => setRoomForm({ ...roomForm, roomTypeId: event.target.value })}
            >
              <option value="">Select a room type</option>
              {roomTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name} ({money(type.nightlyRate, type.currency)}/night, up to {type.maxOccupancy})
                </option>
              ))}
              <option value={NEW_TYPE}>+ New room type…</option>
            </select>
          </label>
          {roomForm.roomTypeId === NEW_TYPE && (
            <TypeFields form={newTypeForm} setForm={setNewTypeForm} prefix="New room type" withPhotos />
          )}
          <button
            disabled={busy || !roomForm.roomNumber.trim() || !roomForm.roomTypeId}
            type="submit"
            className="primary-action"
          >
            Add room
          </button>
        </form>
      </section>

      <section aria-labelledby="rooms-heading" className="register-panel">
        <div className="register-header">
          <div>
            <h2 id="rooms-heading">Rooms</h2>
            <p className="muted">
              A room can only go under maintenance for dates with no reservations on it.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table aria-label="Rooms">
            <thead>
              <tr>
                <th>ROOM</th>
                <th>ROOM TYPE</th>
                <th>PRICE / NIGHT</th>
                <th>STATUS</th>
                <th>UPCOMING STAYS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <RoomRows
                  key={room.id}
                  room={room}
                  roomTypes={roomTypes}
                  busy={busy}
                  today={today}
                  editing={editingRoom?.id === room.id ? editingRoom : null}
                  setEditing={setEditingRoom}
                  onSave={saveRoom}
                  maintenance={maintenance?.id === room.id ? maintenance : null}
                  setMaintenance={setMaintenance}
                  onSchedule={scheduleMaintenance}
                  onEndMaintenance={() => endMaintenance(room)}
                  onDelete={() => deleteRoom(room)}
                />
              ))}
              {rooms.length === 0 && (
                <tr>
                  <td colSpan="6" className="empty-cell">No rooms yet. Add a room above.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="room-types-heading" className="register-panel">
        <div className="register-header">
          <div>
            <h2 id="room-types-heading">Room types and prices</h2>
            <p className="muted">Price changes apply to new bookings; existing bookings keep their price.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table aria-label="Room types">
            <thead>
              <tr>
                <th>PHOTOS</th>
                <th>NAME</th>
                <th>MAX GUESTS</th>
                <th>PRICE / NIGHT</th>
                <th>ROOMS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {roomTypes.map((type) =>
                editingType?.id === type.id ? (
                  <tr key={type.id} className="reject-row">
                    <td colSpan="6">
                      <form className="form-grid" onSubmit={saveType}>
                        <TypeFields form={editingType} setForm={setEditingType} prefix={`Edit ${type.name}`} />
                        <button type="submit" className="primary-action" disabled={busy}>Save</button>
                        <button type="button" className="page-btn" onClick={() => setEditingType(null)}>
                          Cancel
                        </button>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <Fragment key={type.id}>
                  <tr>
                    <td>
                      {type.photos[0] ? (
                        <img className="type-thumb" src={assetUrl(type.photos[0].url)} alt={`${type.name} cover`} />
                      ) : (
                        <span className="muted">None</span>
                      )}
                      <div className="muted">{type.photos.length} photo{type.photos.length === 1 ? "" : "s"}</div>
                    </td>
                    <td>
                      {type.name}
                      {type.description && <div className="muted">{type.description}</div>}
                    </td>
                    <td>{type.maxOccupancy}</td>
                    <td>{money(type.nightlyRate, type.currency)}</td>
                    <td>{type.roomCount}</td>
                    <td>
                      <div className="lookup-actions">
                        <button
                          type="button"
                          className="page-btn"
                          aria-expanded={photosFor === type.id}
                          onClick={() => setPhotosFor(photosFor === type.id ? null : type.id)}
                        >
                          Photos
                        </button>
                        <button
                          type="button"
                          className="page-btn"
                          onClick={() =>
                            setEditingType({
                              id: type.id,
                              name: type.name,
                              maxOccupancy: String(type.maxOccupancy),
                              nightlyRate: type.nightlyRate == null ? "" : String(type.nightlyRate),
                              description: type.description || "",
                              photos: [],
                            })
                          }
                        >
                          Edit
                        </button>
                        {type.roomCount === 0 && (
                          <button type="button" className="page-btn" disabled={busy} onClick={() => deleteType(type)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {photosFor === type.id && (
                    <tr className="reject-row">
                      <td colSpan="6">
                        <PhotoManager
                          type={type}
                          busy={busy}
                          onUpload={(files) => addPhotos(type, files)}
                          onRemove={(photo) => removePhoto(type, photo)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ),
              )}
              {roomTypes.length === 0 && (
                <tr>
                  <td colSpan="6" className="empty-cell">No room types yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <h3>Add a room type</h3>
        <form className="form-grid" onSubmit={createType}>
          <TypeFields form={typeForm} setForm={setTypeForm} prefix="Room type" withPhotos />
          <button type="submit" className="primary-action" disabled={busy}>
            Add room type
          </button>
        </form>
      </section>
    </>
  );
}

function RoomRows({
  room,
  roomTypes,
  busy,
  today,
  editing,
  setEditing,
  onSave,
  maintenance,
  setMaintenance,
  onSchedule,
  onEndMaintenance,
  onDelete,
}) {
  return (
    <>
      <tr>
        <td>{room.roomNumber}</td>
        <td>{room.roomTypeName}</td>
        <td>{money(room.nightlyRate, room.currency)}</td>
        <td><RoomStatus room={room} /></td>
        <td>{room.upcomingReservations}</td>
        <td>
          <div className="lookup-actions">
            <button
              type="button"
              className="page-btn"
              disabled={busy}
              onClick={() =>
                setMaintenance({
                  id: room.id,
                  roomNumber: room.roomNumber,
                  from: room.maintenanceFrom || today,
                  to: room.maintenanceTo || "",
                  note: room.maintenanceNote || "",
                })
              }
            >
              {room.status === "maintenance" ? "Change maintenance" : "Set maintenance"}
            </button>
            {room.status === "maintenance" && (
              <button type="button" className="page-btn" disabled={busy} onClick={onEndMaintenance}>
                End maintenance
              </button>
            )}
            <button
              type="button"
              className="page-btn"
              disabled={busy}
              onClick={() => setEditing({ id: room.id, roomNumber: room.roomNumber, roomTypeId: room.roomTypeId })}
            >
              Edit
            </button>
            <button type="button" className="page-btn" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        </td>
      </tr>
      {maintenance && (
        <tr className="reject-row">
          <td colSpan="6">
            <form className="form-grid" onSubmit={onSchedule}>
              <label>
                Out of service from
                <input
                  type="date"
                  required
                  min={today}
                  value={maintenance.from}
                  onChange={(event) => setMaintenance({ ...maintenance, from: event.target.value })}
                />
              </label>
              <label>
                Back in service on
                <input
                  type="date"
                  required
                  min={maintenance.from || today}
                  value={maintenance.to}
                  onChange={(event) => setMaintenance({ ...maintenance, to: event.target.value })}
                />
              </label>
              <label>
                Reason (optional)
                <input
                  value={maintenance.note}
                  onChange={(event) => setMaintenance({ ...maintenance, note: event.target.value })}
                />
              </label>
              <button
                type="submit"
                className="primary-action"
                disabled={busy || !maintenance.from || !maintenance.to || maintenance.to <= maintenance.from}
              >
                Save maintenance
              </button>
              <button type="button" className="page-btn" onClick={() => setMaintenance(null)}>
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
      {editing && (
        <tr className="reject-row">
          <td colSpan="6">
            <form className="form-grid" onSubmit={onSave}>
              <label>
                Room number
                <input
                  required
                  value={editing.roomNumber}
                  onChange={(event) => setEditing({ ...editing, roomNumber: event.target.value })}
                />
              </label>
              <label>
                Room type
                <select
                  value={editing.roomTypeId}
                  onChange={(event) => setEditing({ ...editing, roomTypeId: event.target.value })}
                >
                  {roomTypes.map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="primary-action" disabled={busy || !editing.roomNumber.trim()}>
                Save room
              </button>
              <button type="button" className="page-btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
