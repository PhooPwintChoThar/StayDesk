import { createCancellationPolicy } from "../cancellation-policy.js";

describe("cancellation policy strategies", () => {
  it("refunds the configured percent for the full policy", () => {
    expect(createCancellationPolicy({ name: "full", refundPercent: 80 }).refundPercent()).toBe(80);
  });

  it("refunds half when check-in is at least two days away", () => {
    const policy = createCancellationPolicy({ name: "partial" });
    const now = new Date("2027-03-01T00:00:00Z");
    expect(policy.refundPercent("2027-03-10", now)).toBe(50);
    expect(policy.refundPercent("2027-03-01", now)).toBe(0);
  });

  it("refunds nothing for the none policy", () => {
    expect(createCancellationPolicy({ name: "none" }).refundPercent()).toBe(0);
  });
});
