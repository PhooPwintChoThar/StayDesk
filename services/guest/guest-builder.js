// Builder: assemble a guest profile with required identity plus optional stay/privacy fields (FR-1, NFR-4).

const LOYALTY_TIERS = ["none", "member", "silver", "gold", "platinum"];

export class GuestBuilder {
  constructor(body = {}) {
    this.body = body;
  }

  build() {
    const email = trim(this.body.email)?.toLowerCase();
    const firstName = trim(this.body.firstName);
    const lastName = trim(this.body.lastName);
    const phone = trim(this.body.phone) || null;
    const address = trim(this.body.address) || null;
    const idDocument = trim(this.body.idDocument) || null;
    const preferences = trim(this.body.preferences) || null;
    const loyaltyTier = (trim(this.body.loyaltyTier) || "none").toLowerCase();
    const loyaltyNumber = trim(this.body.loyaltyNumber) || null;
    const consent =
      this.body.consent === true || this.body.consent === "true";

    if (!email || !firstName || !lastName) {
      return {
        error: "Valid email, firstName, and lastName are required.",
      };
    }

    if (this.body.phone != null && typeof this.body.phone !== "string") {
      return { error: "Valid email, firstName, and lastName are required." };
    }

    if (!LOYALTY_TIERS.includes(loyaltyTier)) {
      return {
        error: `loyaltyTier must be one of: ${LOYALTY_TIERS.join(", ")}.`,
      };
    }

    return {
      guest: {
        email,
        firstName,
        lastName,
        phone,
        address,
        idDocument,
        preferences,
        loyaltyTier,
        loyaltyNumber,
        consentAt: consent ? new Date().toISOString() : null,
      },
    };
  }
}

function trim(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

export function buildGuest(body) {
  return new GuestBuilder(body).build();
}
