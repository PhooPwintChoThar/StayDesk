// Facade: one small client per collaborating service. The reservation logic asks
// "hold a room" or "refund this deposit" instead of building URLs, payloads and
// error mapping for three remote APIs, so a change in one service's API touches
// one place only (NFR-6, NFR-7).
import { HttpError } from "./saga.js";

const url = (names, fallback) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name].replace(/\/$/, "");
  }
  return fallback;
};

const roomRateUrl = () => url(["ROOM_RATE_URL", "ROOM_RATE_SERVICE_URL"], "http://room-rate:3000");
const guestUrl = () => url(["GUEST_URL", "GUEST_SERVICE_URL"], "http://guest:3000");
const billingUrl = () => url(["BILLING_URL", "BILLING_SERVICE_URL"], "http://billing:3000");

const statusOf = (error) => error.response?.status;

export function createServiceClients(http) {
  const rooms = {
    async availability({ checkIn, checkOut, roomTypeId, guests, excludeHoldId }) {
      const response = await http.get(`${roomRateUrl()}/availability`, {
        params: {
          checkIn,
          checkOut,
          roomTypeId,
          guests: guests || undefined,
          excludeHoldId: excludeHoldId || undefined,
        },
      });
      return response.data.availability?.find((item) => item.roomTypeId === roomTypeId);
    },

    async hold({ roomTypeId, checkIn, checkOut, excludeHoldId }) {
      try {
        const response = await http.post(`${roomRateUrl()}/holds`, {
          roomTypeId,
          checkIn,
          checkOut,
          ...(excludeHoldId ? { excludeHoldId } : {}),
        });
        return {
          holdId: response.data.id,
          roomId: response.data.roomId ?? null,
          roomNumber: response.data.roomNumber ?? null,
        };
      } catch (error) {
        if (statusOf(error) === 409) {
          throw new HttpError(409, "Conflict", "No rooms are available for those dates.");
        }
        throw error;
      }
    },

    async confirm(holdId, expiredMessage) {
      try {
        await http.post(`${roomRateUrl()}/holds/${holdId}/confirm`);
      } catch (error) {
        if (statusOf(error) === 409) throw new HttpError(409, "Conflict", expiredMessage);
        throw error;
      }
    },

    // Releasing an already released or unknown hold is not an error.
    async release(holdId) {
      if (!holdId) return;
      try {
        await http.delete(`${roomRateUrl()}/holds/${holdId}`);
      } catch (error) {
        if (![404, 409].includes(statusOf(error))) throw error;
      }
    },

    async complete(holdId, checkOut) {
      await http.post(`${roomRateUrl()}/holds/${holdId}/complete`, { checkOut });
    },
  };

  const billing = {
    async authorize({ reservationNo, guestId, amount, currency }) {
      try {
        const response = await http.post(`${billingUrl()}/deposits`, { reservationNo, guestId, amount, currency });
        return response.data.id ?? response.data.depositId;
      } catch (error) {
        if (statusOf(error) === 402) {
          throw new HttpError(402, "PaymentDeclined", "The deposit was declined.");
        }
        throw error;
      }
    },

    async refund({ depositId, amount, currency }) {
      const response = await http.post(`${billingUrl()}/refunds`, { depositId, amount, currency });
      return response.data.refundId ?? response.data.id;
    },

    async approvedTotal(reservationNo) {
      const response = await http.get(
        `${billingUrl()}/payments/reservations/${encodeURIComponent(reservationNo)}/totals`,
      );
      return Number(response.data?.approvedTotal || 0);
    },

    async captureDeposits(reservationNo) {
      await http.post(`${billingUrl()}/deposits/capture`, { reservationNo });
    },

    // Cancels pending proofs and marks approved ones refund due (idempotent).
    async cancelProofs(reservationNo) {
      const response = await http.post(
        `${billingUrl()}/payments/reservations/${encodeURIComponent(reservationNo)}/cancel`,
      );
      return response.data;
    },

    async settle({ reservationNo, guestId, amount, currency }) {
      const response = await http.post(`${billingUrl()}/settlements`, { reservationNo, guestId, amount, currency });
      return response.data;
    },
  };

  const guests = {
    async getOrCreate(guest) {
      try {
        const response = await http.post(`${guestUrl()}/guests/get-or-create`, guest);
        const profile = response.data ?? {};
        return {
          guestId: profile.id,
          guestEmail: profile.email || guest.email,
          guestPhone: profile.phone || guest.phone,
          guestName: [profile.firstName ?? guest.firstName, profile.lastName ?? guest.lastName]
            .filter(Boolean)
            .join(" "),
        };
      } catch (error) {
        const status = statusOf(error);
        if (status === 400 || status === 409) {
          throw new HttpError(
            status,
            error.response.data?.error || "BadRequest",
            error.response.data?.message || "Invalid guest details.",
          );
        }
        throw error;
      }
    },

    // Contact details only decorate notifications, so a lookup failure is tolerated.
    async contact(guestId) {
      try {
        const response = await http.get(`${guestUrl()}/guests/${encodeURIComponent(guestId)}`);
        const guest = response.data ?? {};
        return {
          guestEmail: guest.email || null,
          guestPhone: guest.phone || null,
          guestName: [guest.firstName, guest.lastName].filter(Boolean).join(" ") || null,
        };
      } catch (error) {
        console.error(`Guest lookup for notification failed: ${error.message}`);
        return {};
      }
    },
  };

  return { rooms, billing, guests };
}
