// Pure firing gates shared by the simulation-facing ship model.

export function canFireMount({ held, live, bears, cooling, charged }) {
  return held && live && bears && !cooling && charged;
}
