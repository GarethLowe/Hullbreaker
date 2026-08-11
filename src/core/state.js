// -----------------------------------------------------------------------------
// state.js — capturing and restoring the simulation's live state.
//
// The simulation keeps its state in plain objects: a compartment, a module, a
// coolant loop, a shield facet, a damage-control party. Each of them is a bag of
// numbers and flags plus a reference to the authored table it was built from.
//
// The split this file relies on is exactly that one. **Primitives are state;
// object references are not.** A `def` is a shared row out of the hull tables
// and is identical for every ship of that class, so it is never worth copying
// and must never be overwritten. Everything else on those objects is what the
// last few minutes of being shot at did to them.
//
// Capturing generically rather than field-by-field is the whole point. A
// hand-written snapshot is a second copy of every state object's shape, kept in
// a different file from the definition, and it rots the first time somebody adds
// a field — silently, because a missing field restores as "whatever it happens
// to be" rather than as an error. `_tickFire` gained `fireSpreadT` and the
// magazines gained `deep` inside one week of work on this repo; either would
// have been missed. This walks whatever is actually there.
//
// The cost of being generic is that a nested object of state would be skipped.
// Nothing in the simulation has one — the state objects are deliberately flat —
// and `selfcheck` asserts the round trip over a heavily damaged ship, so growing
// one shows up as a failing test rather than as a retry that quietly heals you.
// -----------------------------------------------------------------------------

/** True for the things that are state rather than a shared authored table. */
function isValue(v) {
  const t = typeof v;
  return v === null || t === 'number' || t === 'string' || t === 'boolean'
    || t === 'undefined';
}

/** One state object's live values. Arrays of ids are copied; `def` is not. */
export function captureState(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (isValue(v)) {
      out[key] = v;
    } else if (Array.isArray(v) && v.every(isValue)) {
      out[key] = v.slice();
    }
  }
  return out;
}

/**
 * Put it back. Arrays are copied on the way in as well as out, so a snapshot
 * can be restored more than once and never shares mutable structure with the
 * ship it was taken from.
 */
export function applyState(obj, snap) {
  if (!snap) {
    return;
  }
  for (const key of Object.keys(snap)) {
    const v = snap[key];
    obj[key] = Array.isArray(v) ? v.slice() : v;
  }
}

/** A Map of state objects, keyed by id. */
export const captureMap = (map) => {
  const out = {};
  for (const [k, v] of map) {
    out[k] = captureState(v);
  }
  return out;
};

export const applyMap = (map, snap) => {
  if (!snap) {
    return;
  }
  for (const [k, v] of map) {
    applyState(v, snap[k]);
  }
};

/** A plain object of state objects — the shield's facets. */
export const captureRecord = (rec) => {
  const out = {};
  for (const k of Object.keys(rec)) {
    out[k] = captureState(rec[k]);
  }
  return out;
};

export const applyRecord = (rec, snap) => {
  if (!snap) {
    return;
  }
  for (const k of Object.keys(rec)) {
    applyState(rec[k], snap[k]);
  }
};

/** An array of state objects — the crew's parties. */
export const captureList = (arr) => arr.map(captureState);

export const applyList = (arr, snap) => {
  if (!snap) {
    return;
  }
  for (let i = 0; i < arr.length && i < snap.length; i++) {
    applyState(arr[i], snap[i]);
  }
};
