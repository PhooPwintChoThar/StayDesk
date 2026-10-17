// Iterator: walks the payments of a reservation (initial deposit, top-ups) and
// yields how much to refund from each, newest first, until the amount is covered.
// Callers just loop over the plan; they never deal with how the payments are
// stored or how much of each was already refunded.

const round = (amount) => Math.round(Number(amount) * 100) / 100;

export function* refundPlan(sources, amount) {
  let remaining = round(amount);
  for (const source of sources) {
    if (remaining <= 0) return;
    const refundable = round(Math.max(0, Number(source.amount) - Number(source.refunded || 0)));
    if (refundable <= 0) continue;
    const take = Math.min(remaining, refundable);
    yield { source, amount: round(take) };
    remaining = round(remaining - take);
  }
  if (remaining > 0) {
    throw new Error("Held amount is inconsistent with recorded deposits.");
  }
}
