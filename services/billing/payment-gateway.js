// Adapter + Factory Method: billing talks to a payment-gateway port, not a stub if-statement (NFR-6).

export function createPaymentGateway(mode = process.env.PAYMENT_MODE) {
  return {
    authorize() {
      if (mode === "decline") {
        return { approved: false, reason: "The deposit was declined." };
      }
      return { approved: true, gatewayRef: "stub-approved" };
    },
  };
}
