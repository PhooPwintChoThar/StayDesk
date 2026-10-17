import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";
import { showToast } from "./toast.js";

const editableFields = ["firstName", "lastName", "phone", "address", "idDocument", "preferences"];

export default function MyProfileScreen({ session }) {
  const guestId = session?.claims?.guestId;
  const [profile, setProfile] = useState(null);
  const [state, setState] = useState(guestId ? "loading" : "missing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!guestId) {
      setState("missing");
      return undefined;
    }
    let cancelled = false;
    setState("loading");
    setError("");
    apiRequest(`/guests/${encodeURIComponent(guestId)}`)
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [guestId]);

  async function saveProfile(event) {
    event.preventDefault();
    if (!profile || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await apiRequest(`/guests/${encodeURIComponent(guestId)}`, {
        method: "PUT",
        body: JSON.stringify({
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone,
          address: profile.address,
          idDocument: profile.idDocument,
          preferences: profile.preferences,
        }),
      });
      setProfile(updated);
      showToast("Your profile has been saved.", { title: "Profile updated" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateField(field, value) {
    setProfile((current) => ({ ...current, [field]: value }));
  }

  return (
    <section className="register-panel" aria-labelledby="profile-heading">
      <div className="register-header">
        <div>
          <h2 id="profile-heading">My profile</h2>
          <p className="muted">Update your contact details and preferences</p>
        </div>
      </div>

      {state === "loading" && <p className="muted">Loading your profile…</p>}
      {state === "missing" && <p>No guest profile is linked to this account.</p>}
      {state === "error" && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {error && state === "ready" && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {state === "ready" && profile && (
        <form onSubmit={saveProfile} className="form-grid" aria-label="Edit profile">
          <label>
            First name
            <input
              required
              value={profile.firstName || ""}
              onChange={(event) => updateField("firstName", event.target.value)}
            />
          </label>
          <label>
            Last name
            <input
              required
              value={profile.lastName || ""}
              onChange={(event) => updateField("lastName", event.target.value)}
            />
          </label>
          <label>
            Email
            <input type="email" value={profile.email || ""} readOnly />
          </label>
          <label>
            Phone
            <input
              value={profile.phone || ""}
              onChange={(event) => updateField("phone", event.target.value)}
            />
          </label>
          <label>
            Address
            <input
              value={profile.address || ""}
              onChange={(event) => updateField("address", event.target.value)}
            />
          </label>
          <label>
            Passport or ID number
            <input
              value={profile.idDocument || ""}
              onChange={(event) => updateField("idDocument", event.target.value)}
            />
          </label>
          <label>
            Preferences
            <input
              value={profile.preferences || ""}
              onChange={(event) => updateField("preferences", event.target.value)}
            />
          </label>
          <button type="submit" className="primary-action" disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
        </form>
      )}
    </section>
  );
}
