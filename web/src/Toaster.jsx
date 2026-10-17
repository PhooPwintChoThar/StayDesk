import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts } from "./toast.js";

export default function Toaster() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} role="status" className="toast">
          <div className="toast-body">
            {toast.title && <strong className="toast-title">{toast.title}</strong>}
            {toast.lines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
          {toast.duration > 0 && (
            <span className="toast-timer" style={{ animationDuration: `${toast.duration}ms` }} aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
}
