/** Deterministic simulation RNG; visual code keeps using `Math.random`. */
export function seededRandom(seed = (Date.now() >>> 0)) {
  let state = seed || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  random.seed = state;
  return random;
}

export function seedFromSearch(search) {
  const seed = Number.parseInt(new URLSearchParams(search).get('seed'), 10);
  return Number.isInteger(seed) ? seed : undefined;
}
