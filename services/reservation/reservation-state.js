// State: a reservation behaves differently in each stage of its life
// (pending -> confirmed -> checked in -> checked out, or cancelled). Each state
// object answers "may this happen now?" so the rules live in one place instead of
// being repeated in every endpoint (NFR-7). A rule returns null when the action is
// allowed, or [httpStatus, error, message] when it is not.

const conflict = (message) => [409, "Conflict", message];
const forbidden = (message) => [403, "Forbidden", message];

const ended = ({ reservation, today }) => reservation.checkOut <= today;

const openStay = (who) => ({
  modify({ role, ...context }) {
    if (ended(context)) return conflict("This stay has already ended and can no longer be modified.");
    return who === "anyone" || role !== "guest"
      ? null
      : forbidden("Your payment has been approved and the booking is confirmed. Please contact the front desk to change it.");
  },
  cancel({ role, ...context }) {
    if (ended(context)) return conflict("This stay has already ended and can no longer be cancelled.");
    return who === "anyone" || role !== "guest"
      ? null
      : forbidden("Your payment has been approved and the booking is confirmed. Please contact the front desk to cancel.");
  },
});

const STATES = {
  pending: {
    name: "pending",
    ...openStay("anyone"),
    checkIn: () => conflict("The payment has not been approved yet, so the guest cannot check in."),
    checkOut: () => conflict("The guest has not checked in yet."),
    approvePayment: () => ({ next: "confirmed" }),
  },
  confirmed: {
    name: "confirmed",
    ...openStay("staff"),
    checkIn({ reservation, today }) {
      if (today < reservation.checkIn) return conflict(`Check-in opens on ${reservation.checkIn}.`);
      if (today >= reservation.checkOut) {
        return conflict("The stay dates have passed; this booking can no longer be checked in.");
      }
      return null;
    },
    checkOut: () => conflict("The guest has not checked in yet."),
    approvePayment: () => ({ next: "confirmed" }),
  },
  checkedIn: {
    name: "checked-in",
    modify: () => conflict("The guest has already checked in; this stay can no longer be modified."),
    cancel: () => conflict("The guest has already checked in; this stay can no longer be cancelled."),
    checkIn: () => conflict("The guest has already checked in."),
    checkOut: () => null,
    approvePayment: () => ({ next: "confirmed" }),
  },
  checkedOut: {
    name: "checked-out",
    modify: () => conflict("The guest has already checked out."),
    cancel: () => conflict("The guest has already checked out."),
    checkIn: () => conflict("The guest has already checked in."),
    checkOut: () => conflict("The guest has already checked out."),
    approvePayment: () => ({ next: "confirmed" }),
  },
  cancelled: {
    name: "cancelled",
    modify: () => conflict("Cancelled reservations cannot be modified."),
    cancel: () => conflict("Reservation is already cancelled."),
    checkIn: () => conflict("Cancelled reservations cannot be checked in."),
    checkOut: () => conflict("Cancelled reservations cannot be checked out."),
    approvePayment: () => ({ error: conflict("The reservation is cancelled.") }),
  },
};

// Accepts either a raw database row or the API shape of a reservation.
export function stateOf(reservation) {
  if (reservation.status === "cancelled") return STATES.cancelled;
  if (reservation.checked_out_at ?? reservation.checkedOutAt) return STATES.checkedOut;
  if (reservation.checked_in_at ?? reservation.checkedInAt) return STATES.checkedIn;
  return reservation.status === "pending" ? STATES.pending : STATES.confirmed;
}

// Normalises the calendar fields each rule needs.
export function stayOf(reservation) {
  return {
    checkIn: reservation.checkInDate ?? reservation.checkIn,
    checkOut: reservation.checkOutDate ?? reservation.checkOut,
  };
}
