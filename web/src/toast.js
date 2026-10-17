// Pop-up notifications. Screens call showToast(); the single <Toaster /> in the
// app subscribes to this store (Observer) and renders the stack.
import { useEffect } from "react";

const listeners = new Set();
let toasts = [];
let nextId = 1;

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function showToast(message, { title = "", tone = "success", duration = tone === "error" ? 8000 : 6000 } = {}) {
  const id = nextId++;
  const lines = Array.isArray(message) ? message.filter(Boolean) : [message];
  toasts = [...toasts, { id, title, lines, tone, duration }];
  emit();
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id) {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function clearToasts() {
  toasts = [];
  emit();
}

export function subscribeToasts(listener) {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}

// Shows a screen's error as a pop-up and clears it, so the same error can pop up again.
export function useErrorToast(error, setError) {
  useEffect(() => {
    if (!error) return;
    showToast(error, { tone: "error" });
    setError("");
  }, [error, setError]);
}
