// Uniform [0, 1) generator (same contract as Math.random). No seed → Math.random:
// fresh randomness each run, so δ stays a per-run probability rather than one
// frozen outcome. Seed → a deterministic mulberry32 PRNG for reproducible runs.
export function createRandom (seed) {
  if (seed === undefined || seed === null) return Math.random

  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError(`seed must be a finite number, got ${seed}`)
  }

  let a = seed >>> 0
  return function random () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
