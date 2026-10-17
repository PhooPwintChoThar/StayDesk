// State: legal hold transitions only — held → confirmed | released | expired (NFR-5).

const TRANSITIONS = {
  held: ["confirmed", "released", "expired"],
  confirmed: ["released"],
  released: [],
  expired: [],
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) === true;
}
