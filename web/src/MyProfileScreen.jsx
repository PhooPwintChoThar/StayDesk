import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

function text(value) {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function Row({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{text(value)}</dd>
    </>
  );
}

// Read-only guest profile. The loyalty tier is deliberately not editable here;
// only a manager can change it (Guests view).
export default function MyProfileScreen({ session }) {
  const guestId = session?.claims?.guestId;
  const [profile, setProfile] = useState(null);
  const [state, setState] = useState(guestId ? "loading" : "missing");
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

  return (
    <section className="register-panel" aria-labelledby="profile-heading">
      <div className="register-header">
        <div>
          <h2 id="profile-heading">My profile</h2>
          <p className="muted">Your contact details and preferences</p>
        </div>
      </div>

      {state === "loading" && <p className="muted">Loading your profile…</p>}
      {state === "missing" && <p>No guest profile is linked to this account.</p>}
      {state === "error" && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {state === "ready" && profile && (
        <>
          <h3>Contact details</h3>
          <dl className="detail-list" aria-label="Contact details">
            <Row label="Name" value={`${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()} />
            <Row label="Email" value={profile.email} />
            <Row label="Phone" value={profile.phone} />
            <Row label="Address" value={profile.address} />
          </dl>

          <h3>Preferences and documents</h3>
          <dl className="detail-list" aria-label="Preferences and documents">
            <Row label="Preferences" value={profile.preferences} />
            <Row label="ID document" value={profile.idDocument} />
          </dl>

          <h3>Loyalty</h3>
          <dl className="detail-list" aria-label="Loyalty">
            <Row label="Loyalty tier" value={profile.loyaltyTier || "none"} />
            <Row label="Loyalty number" value={profile.loyaltyNumber} />
          </dl>
        </>
      )}
    </section>
  );
}