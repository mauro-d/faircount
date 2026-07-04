import { createRandom } from './random.mjs'

const DEFAULT_EPSILON = 0.05
const DEFAULT_DELTA = 0.01

let warnedNoExpectedSize = false

// Sample-set capacity for the total/unbiased CVM variant (Karayel, Watt, Khu,
// Meel & Tan, ITP 2025, Algorithm 3): ⌈(12/ε²)·ln(3m/δ)⌉, rounded up to an even
// number so exactly n/2 elements are kept on each sub-sample. The dependence on
// m is only logarithmic, so a rough upper bound is fine.
export function computeThreshold (epsilon, delta, expectedSize) {
  if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
    throw new RangeError(`epsilon must be a number in (0, 1), got ${epsilon}`)
  }
  if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
    throw new RangeError(`delta must be a number in (0, 1), got ${delta}`)
  }
  if (typeof expectedSize !== 'number' || !Number.isFinite(expectedSize) || expectedSize < 0) {
    throw new RangeError(`expectedSize must be a non-negative finite number, got ${expectedSize}`)
  }
  const m = expectedSize > 0 ? expectedSize : 1
  const n = Math.ceil((12 / (epsilon * epsilon)) * Math.log((3 * m) / delta))
  return Math.max(2, n + (n % 2))
}

// Core engine: the total, unbiased CVM variant (Karayel et al., ITP 2025,
// Algorithm 3; building on the CVM algorithm, arXiv:2301.10191). Sub-sampling keeps a
// uniformly random half of the buffer instead of an independent ½-coin per
// element, which makes it total (never fails) and unbiased (E[estimate] = F0).
// Feed values with add(), read result(); values must be Set-comparable.
export class CVM {
  constructor (options = {}) {
    const {
      epsilon = DEFAULT_EPSILON,
      delta = DEFAULT_DELTA,
      expectedSize = 0,
      seed,
      random
    } = options

    if (random !== undefined && typeof random !== 'function') {
      throw new TypeError('random must be a function returning a float in [0, 1)')
    }

    // computeThreshold validates epsilon, delta and expectedSize, so an invalid
    // parameter throws here, before the warning below can fire.
    this.threshold = computeThreshold(epsilon, delta, expectedSize)

    // Optional, but omitting it sizes the threshold for a length-1 stream, which is
    // too small for the (ε, δ) guarantee on a real one. Warn once instead of failing.
    if (expectedSize === 0 && !warnedNoExpectedSize) {
      warnedNoExpectedSize = true
      process.emitWarning(
        'faircount: expectedSize was not set; the (ε, δ) guarantee assumes it bounds the stream length. Pass it to size the threshold correctly.',
        { code: 'CVM_NO_EXPECTED_SIZE' }
      )
    }

    this.epsilon = epsilon
    this.delta = delta
    this.expectedSize = expectedSize

    this._keep = this.threshold / 2
    this._random = random ?? createRandom(seed)
    this._X = new Set()
    this._p = 1
  }

  // Algorithm 3, lines 3-10: insert the element with probability p, remove it
  // otherwise; when the buffer fills up, keep a uniformly random half and halve p.
  add (element) {
    if (this._random() < this._p) {
      const X = this._X
      X.add(element)
      if (X.size === this.threshold) {
        this._subsample()
        this._p /= 2
      }
    } else {
      this._X.delete(element)
    }
    return this
  }

  // Keep a uniformly random n/2-subset of the buffer (partial Fisher–Yates:
  // shuffle the kept slots to the front, drop the rest). Each element is retained
  // with probability exactly ½, and once p is halved the estimate |X|/p is exactly
  // what it was before the sub-sample.
  _subsample () {
    const arr = [...this._X]
    const keep = this._keep
    const len = arr.length
    for (let i = 0; i < keep; i++) {
      const j = i + Math.floor(this._random() * (len - i))
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
    const next = new Set()
    for (let i = 0; i < keep; i++) next.add(arr[i])
    this._X = next
  }

  addMany (elements) {
    for (const element of elements) this.add(element)
    return this
  }

  get distinct () {
    return this._X.size / this._p
  }

  get sampleCount () {
    return this._X.size
  }

  result () {
    return {
      estimate: this._X.size / this._p,
      samples: this._X.size,
      threshold: this.threshold,
      p: this._p
    }
  }

  reset () {
    this._X = new Set()
    this._p = 1
    return this
  }
}
