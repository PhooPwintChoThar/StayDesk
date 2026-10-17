// Strategy: cancellation refund rules are swappable without changing cancel flow (FR-6, NFR-7).

function daysUntil(checkIn, now) {
  const start = Date.parse(`${String(checkIn).slice(0, 10)}T00:00:00Z`);
  return (start - now.getTime()) / 86_400_000;
}

const fullRefund = (refundPercent) => ({
  name: "full",
  refundPercent() {
    const percent = Number(refundPercent ?? 100);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("CANCELLATION_REFUND_PERCENT must be between 0 and 100.");
    }
    return percent;
  },
});

const partialRefund = {
  name: "partial",
  refundPercent(checkIn, now = new Date()) {
    return daysUntil(checkIn, now) >= 2 ? 50 : 0;
  },
};

const noRefund = {
  name: "none",
  refundPercent() {
    return 0;
  },
};

export function createCancellationPolicy({
  name = process.env.CANCELLATION_POLICY || "full",
  refundPercent = process.env.CANCELLATION_REFUND_PERCENT,
} = {}) {
  if (name === "none") return noRefund;
  if (name === "partial") return partialRefund;
  return fullRefund(refundPercent);
}
