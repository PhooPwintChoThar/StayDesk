// Pop-up notifications. Screens call showToast(); the single <Toaster /> in the
// app subscribes to this store (Observer) and renders the stack.

const listeners = new Set();
let toasts = [];
let nextId = 1;

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function showToast(message, { title = "", duration = 6000 } = {}) {
  const id = nextId++;
  const lines = Array.isArray(message) ? message.filter(Boolean) : [message];
  toasts = [...toasts, { id, title, lines, duration }];
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
