import { useCallback, useEffect, useRef, useState } from "react";
import { apiBlob, apiRequest } from "./api.js";

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "application/pdf"];
const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".pdf"];
const REVOKE_DELAY_MS = 60_000;

const STATUS_FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

// ---------- helpers ----------
export function validateProofFile(file) {
  if (!file) return "Choose a proof file to upload.";
  const name = String(file.name || "").toLowerCase();
  const typeOk = ALLOWED_TYPES.includes(file.type);
  const extOk = ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
  if (!typeOk || !extOk) return "Only PNG, JPEG or PDF files are allowed.";
  if (file.size > MAX_PROOF_BYTES) {
    return "The file is too large. The maximum size is 5 MB.";
  }
  return "";
}

export function validateAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
    return "Enter an amount greater than 0 (up to 2 decimals).";
  }
  return "";
}

const pick = (source, keys) => {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return undefined;
};

function normalizeSummary(summary) {
  if (!summary) return null;
  return {
    total: pick(summary, ["totalAmount", "total"]),
    deposit: pick(summary, ["depositHeld", "depositAmount"]),
    approved: pick(summary, ["approvedPayments", "approvedTotal", "approvedAmount"]),
    balance: pick(summary, ["balanceDue", "balance"]),
    currency: summary.currency,
  };
}

function money(value, currency) {
  const number = Number(value);
  if (value === undefined || value === null || !Number.isFinite(number)) return "—";
  const text = number.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${text} ${currency}` : text;
}

const amountText = (value) => String(Math.round(Number(value) * 100) / 100);

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const day = (value) => String(value ?? "").slice(0, 10);

function StatusBadge({ status }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

// ---------- guest view ----------
function GuestPayments({ session }) {
  const guestId = session?.claims?.guestId;
  const mounted = useMounted();
  const detailSeq = useRef(0);

  const [reservations, setReservations] = useState([]);
  const [listState, setListState] = useState("loading");
  const [selectedNo, setSelectedNo] = useState("");
  const [summary, setSummary] = useState(null);
  const [proofs, setProofs] = useState([]);
  const [detailState, setDetailState] = useState("idle");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // The gateway returns only this guest's reservations; the filter below is a
  // second, purely cosmetic guard.
  useEffect(() => {
    let cancelled = false;
    setListState("loading");
    const path = guestId
      ? `/reservations?guestId=${encodeURIComponent(guestId)}`
      : "/reservations";
    apiRequest(path)
      .then((result) => {
        if (cancelled) return;
        const own = (result.reservations || []).filter(
          (item) => !guestId || item.guestId === guestId,
        );
        setReservations(own);
        setSelectedNo((current) => current || own[0]?.reservationNo || "");
        setListState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setListState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [guestId]);

  const loadDetail = useCallback(
    async (reservationNo) => {
      const seq = ++detailSeq.current;
      setDetailState("loading");
      setSummary(null);
      setProofs([]);
      try {
        const [summaryResult, proofResult] = await Promise.all([
          apiRequest(`/reservations/${encodeURIComponent(reservationNo)}/payment-summary`),
          apiRequest(`/payments/proofs?reservationNo=${encodeURIComponent(reservationNo)}`),
        ]);
        // Ignore answers for a reservation the guest has already moved away from.
        if (seq !== detailSeq.current || !mounted.current) return null;
        const normalized = normalizeSummary(summaryResult);
        setSummary(normalized);
        setProofs(
          (proofResult.proofs || []).filter(
            (proof) => Boolean(guestId) && proof.guestId === guestId,
          ),
        );
        setDetailState("ready");
        return normalized;
      } catch (err) {
        if (seq !== detailSeq.current || !mounted.current) return null;
        setError(err.message);
        setDetailState("error");
        return null;
      }
    },
    [guestId, mounted],
  );

  function resetForm() {
    setAmount("");
    setNote("");
    setFile(null);
    setFileKey((key) => key + 1);
  }

  useEffect(() => {
    if (!selectedNo) {
      detailSeq.current += 1;
      setDetailState("idle");
      return;
    }
    setError("");
    setSuccess("");
    resetForm();
    loadDetail(selectedNo).then((loaded) => {
      if (loaded && Number(loaded.balance) > 0) setAmount(amountText(loaded.balance));
    });
  }, [selectedNo, loadDetail]);

  function handleFileChange(event) {
    const chosen = event.target.files?.[0] || null;
    setSuccess("");
    if (!chosen) {
      setFile(null);
      setError("");
      return;
    }
    const problem = validateProofFile(chosen);
    if (problem) {
      setFile(null);
      setError(problem);
      event.target.value = "";
      return;
    }
    setFile(chosen);
    setError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !selectedNo) return;
    setSuccess("");

    const problem = validateProofFile(file) || validateAmount(amount);
    if (problem) {
      setError(problem);
      return;
    }
    const selected = reservations.find((item) => item.reservationNo === selectedNo);
    const currency = summary?.currency || selected?.currency;
    if (!currency) {
      setError("The reservation currency is unavailable. Please try again later.");
      return;
    }

    const form = new FormData();
    form.append("reservationNo", selectedNo);
    form.append("amount", amount.trim());
    form.append("currency", currency);
    form.append("note", note.trim());
    form.append("file", file);

    setBusy(true);
    setError("");
    try {
      await apiRequest("/payments/proofs", { method: "POST", body: form });
      if (!mounted.current) return;
      resetForm();
      setSuccess("Payment proof uploaded. Our staff will review it shortly.");
      const loaded = await loadDetail(selectedNo);
      if (loaded && Number(loaded.balance) > 0) setAmount(amountText(loaded.balance));
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const selected = reservations.find((item) => item.reservationNo === selectedNo);
  const currency = summary?.currency || selected?.currency || "";

  return (
    <section className="register-panel" aria-labelledby="payments-heading">
      <div className="register-header">
        <div>
          <h2 id="payments-heading">My payments</h2>
          <p className="muted">Upload proof of payment and follow its review</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {success && (
        <div role="status" className="confirmation-card">
          <p>{success}</p>
        </div>
      )}

      {listState === "loading" && <p className="muted">Loading your reservations…</p>}
      {listState === "ready" && reservations.length === 0 && (
        <p>You have no reservations yet. Book a room first, then come back to upload a payment proof.</p>
      )}

      {listState === "ready" && reservations.length > 0 && (
        <>
          <div className="form-grid">
            <label>
              Reservation
              <select
                value={selectedNo}
                onChange={(event) => setSelectedNo(event.target.value)}
              >
                {reservations.map((item) => (
                  <option key={item.reservationNo} value={item.reservationNo}>
                    {item.reservationNo} · {day(item.checkIn)} to {day(item.checkOut)} · {item.status}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {detailState === "loading" && <p className="muted">Loading payment details…</p>}

          {summary && (
            <section className="pay-grid" aria-label="Payment summary">
              <article className="kpi-card kpi-primary">
                <div className="kpi-top"><span>Total</span></div>
                <strong>{money(summary.total)}</strong>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Deposit held</span></div>
                <strong>{money(summary.deposit)}</strong>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Approved payments</span></div>
                <strong>{money(summary.approved)}</strong>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Balance due</span></div>
                <strong>{money(summary.balance)}</strong>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>Currency</span></div>
                <strong>{summary.currency || "—"}</strong>
              </article>
            </section>
          )}

          <h3>Upload payment proof</h3>
          <form className="form-grid" onSubmit={handleSubmit} noValidate>
            <label>
              Proof file (PNG, JPEG or PDF, max 5 MB)
              <input
                key={fileKey}
                type="file"
                accept="image/png,image/jpeg,application/pdf,.png,.jpg,.jpeg,.pdf"
                onChange={handleFileChange}
              />
            </label>
            <label>
              Amount {currency ? `(${currency})` : ""}
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setSuccess("");
                }}
              />
            </label>
            <label>
              Note (optional)
              <input
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="primary-action"
              disabled={busy || !selectedNo || detailState === "loading"}
            >
              {busy ? "Uploading…" : "Upload proof"}
            </button>
          </form>

          <h3>Payment proofs</h3>
          {detailState === "ready" && proofs.length === 0 && (
            <p>No payment proofs uploaded for this reservation yet.</p>
          )}
          {proofs.length > 0 && (
            <ul aria-label="Payment proofs" className="proof-list">
              {proofs.map((proof) => (
                <li key={proof.id}>
                  <div>
                    <strong>{proof.fileName}</strong>
                    <div className="muted">
                      {money(proof.amount, proof.currency)}
                      {proof.createdAt ? ` · ${formatDate(proof.createdAt)}` : ""}
                    </div>
                    {proof.note && <div className="muted">Your note: {proof.note}</div>}
                    {proof.status === "rejected" && (
                      <div className="proof-review-note">
                        Reviewer note: {proof.reviewNote || "No reason was given."}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={proof.status} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ---------- agent / manager view ----------
function StaffPayments() {
  const mounted = useMounted();
  const loadSeq = useRef(0);
  const pendingUrls = useRef(new Set());

  const [statusFilter, setStatusFilter] = useState("pending");
  const [numberInput, setNumberInput] = useState("");
  const [appliedNumber, setAppliedNumber] = useState("");
  const [proofs, setProofs] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState("");
  const [reviewingId, setReviewingId] = useState(null);
  const [openingId, setOpeningId] = useState(null);

  useEffect(
    () => () => {
      for (const url of pendingUrls.current) URL.revokeObjectURL(url);
      pendingUrls.current.clear();
    },
    [],
  );

  const loadQueue = useCallback(async () => {
    const seq = ++loadSeq.current;
    setState("loading");
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (appliedNumber) params.set("reservationNo", appliedNumber);
    const query = params.toString();
    try {
      const result = await apiRequest(`/payments/proofs${query ? `?${query}` : ""}`);
      if (seq !== loadSeq.current || !mounted.current) return;
      setProofs(result.proofs || []);
      setState("ready");
    } catch (err) {
      if (seq !== loadSeq.current || !mounted.current) return;
      setProofs([]);
      setError(err.message);
      setState("error");
    }
  }, [statusFilter, appliedNumber, mounted]);

  useEffect(() => {
    setError("");
    setRejectingId(null);
    setRejectNote("");
    loadQueue();
  }, [loadQueue]);

  async function viewFile(proof) {
    if (openingId) return;
    setOpeningId(proof.id);
    setError("");
    // Open the tab synchronously (inside the click) so popup blockers allow it.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const blob = await apiBlob(`/payments/proofs/${encodeURIComponent(proof.id)}/file`);
      const url = URL.createObjectURL(blob);
      pendingUrls.current.add(url);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => {
        URL.revokeObjectURL(url);
        pendingUrls.current.delete(url);
      }, REVOKE_DELAY_MS);
    } catch (err) {
      if (tab) tab.close();
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setOpeningId(null);
    }
  }

  async function review(proof, decision, note) {
    if (reviewingId) return;
    setReviewingId(proof.id);
    setError("");
    setSuccess("");
    try {
      const body = decision === "rejected" ? { decision, note: note.trim() } : { decision };
      await apiRequest(`/payments/proofs/${encodeURIComponent(proof.id)}/review`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!mounted.current) return;
      setRejectingId(null);
      setRejectNote("");
      setSuccess(decision === "approved" ? "Payment proof approved." : "Payment proof rejected.");
      await loadQueue();
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setReviewingId(null);
    }
  }

  function applyFilter(event) {
    event.preventDefault();
    setSuccess("");
    setAppliedNumber(numberInput.trim());
  }

  return (
    <section className="register-panel" aria-labelledby="payments-heading">
      <div className="register-header">
        <div>
          <h2 id="payments-heading">Payment proof review</h2>
          <p className="muted">Approve or reject proofs uploaded by guests</p>
        </div>
      </div>

      <form className="toolbar proof-toolbar" onSubmit={applyFilter}>
        <div className="field">
          <label htmlFor="proof-status-filter">Proof status</label>
          <select
            id="proof-status-filter"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setSuccess("");
            }}
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="proof-number-filter">Confirmation number</label>
          <input
            id="proof-number-filter"
            placeholder="R-…"
            value={numberInput}
            onChange={(event) => setNumberInput(event.target.value)}
          />
        </div>
        <div className="field search-field">
          <button type="submit" className="page-btn">
            Apply filter
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {success && (
        <div role="status" className="confirmation-card">
          <p>{success}</p>
        </div>
      )}

      {state === "loading" && <p className="muted">Loading payment proofs…</p>}
      {state === "ready" && proofs.length === 0 && (
        <p>No payment proofs match this filter.</p>
      )}

      {proofs.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Payment proofs">
            <thead>
              <tr>
                <th>RESERVATION</th>
                <th>AMOUNT</th>
                <th>FILE</th>
                <th>SUBMITTED</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {proofs.map((proof) => (
                <ProofRows
                  key={proof.id}
                  proof={proof}
                  rejecting={rejectingId === proof.id}
                  rejectNote={rejectNote}
                  setRejectNote={setRejectNote}
                  onStartReject={() => {
                    setRejectingId(proof.id);
                    setRejectNote("");
                  }}
                  onCancelReject={() => {
                    setRejectingId(null);
                    setRejectNote("");
                  }}
                  onView={() => viewFile(proof)}
                  onApprove={() => review(proof, "approved")}
                  onReject={() => review(proof, "rejected", rejectNote)}
                  busy={reviewingId === proof.id}
                  opening={openingId === proof.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ProofRows({
  proof,
  rejecting,
  rejectNote,
  setRejectNote,
  onStartReject,
  onCancelReject,
  onView,
  onApprove,
  onReject,
  busy,
  opening,
}) {
  const noteId = `reject-note-${proof.id}`;
  return (
    <>
      <tr>
        <td>{proof.reservationNo}</td>
        <td>{money(proof.amount, proof.currency)}</td>
        <td title={proof.note || undefined}>{proof.fileName}</td>
        <td>{formatDate(proof.createdAt)}</td>
        <td>
          <StatusBadge status={proof.status} />
          {proof.status === "rejected" && proof.reviewNote && (
            <div className="muted">{proof.reviewNote}</div>
          )}
        </td>
        <td>
          <div className="lookup-actions">
            <button type="button" className="page-btn" onClick={onView} disabled={opening}>
              View file
            </button>
            {proof.status === "pending" && (
              <>
                <button type="button" className="page-btn" onClick={onApprove} disabled={busy}>
                  Approve
                </button>
                <button
                  type="button"
                  className="page-btn"
                  onClick={onStartReject}
                  disabled={busy}
                >
                  Reject
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {rejecting && (
        <tr className="reject-row">
          <td colSpan="6">
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (rejectNote.trim()) onReject();
              }}
            >
              <label htmlFor={noteId}>
                Rejection note
                <textarea
                  id={noteId}
                  rows={2}
                  value={rejectNote}
                  onChange={(event) => setRejectNote(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="primary-action"
                disabled={busy || !rejectNote.trim()}
              >
                Submit rejection
              </button>
              <button type="button" className="page-btn" onClick={onCancelReject}>
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------- entry point ----------
export default function PaymentsScreen({ session }) {
  const role = session?.claims?.role;
  if (role === "guest") return <GuestPayments session={session} />;
  if (role === "agent" || role === "manager") return <StaffPayments />;
  return (
    <section className="register-panel">
      <p className="muted">Payments are not available for this account.</p>
    </section>
  );
}