import { createRandom } from './random.mjs'

const DEFAULT_EPSILON = 0.05
const DEFAULT_DELTA = 0.01
const SNAPSHOT_VERSION = 1

// Errors carry a `code` so callers can branch on it instead of matching message
// text. The helper drops itself from the stack trace.
export function fail (Type, code, message) {
  const error = new Type(message)
  error.code = code
  Error.captureStackTrace(error, fail)
  return error
}

// A restored value has to compare equal to the same value arriving later, or the
// sample would count it twice.
function isRestorable (value) {
  const type = typeof value
  return type === 'string' || type === 'boolean' || value === null ||
    (type === 'number' && Number.isFinite(value))
}

// Sample-set capacity for the total/unbiased CVM variant (Karayel, Watt, Khu,
// Meel & Tan, ITP 2025, Algorithm 3): ⌈(12/ε²)·ln(3m/δ)⌉, rounded up to an even
// number so exactly n/2 elements are kept on each sub-sample. The dependence on
// m is only logarithmic, so a rough upper bound is fine.
export function computeThreshold (epsilon, delta, expectedSize) {
  if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
    throw fail(RangeError, 'CVM_INVALID_OPTION', `epsilon must be a number in (0, 1), got ${epsilon}`)
  }
  if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
    throw fail(RangeError, 'CVM_INVALID_OPTION', `delta must be a number in (0, 1), got ${delta}`)
  }
  if (typeof expectedSize !== 'number' || !Number.isFinite(expectedSize) || expectedSize < 0) {
    throw fail(RangeError, 'CVM_INVALID_OPTION', `expectedSize must be a non-negative finite number, got ${expectedSize}`)
  }
  const m = expectedSize > 0 ? expectedSize : 1
  const n = Math.ceil((12 / (epsilon * epsilon)) * Math.log((3 * m) / delta))
  return Math.max(2, n + (n % 2))
}

// Core engine: the total, unbiased CVM variant (Karayel et al., ITP 2025,
// Algorithm 3; building on the CVM algorithm, arXiv:2301.10191). Sub-sampling
// keeps a uniformly random half of the buffer instead of an independent ½-coin
// per element, so the buffer always shrinks and the original's give-up path
// disappears. With no failed run to condition on, E[estimate] = F0 exactly.
// Feed values with add(), read result(); values must be Set-comparable.
export class CVM {
  #epsilon
  #delta
  #expectedSize
  #threshold

  constructor (options = {}) {
    const {
      epsilon = DEFAULT_EPSILON,
      delta = DEFAULT_DELTA,
      expectedSize,
      seed,
      random
    } = options

    // Required: it is what makes the (ε, δ) bound true, and a default would pick
    // one on the caller's behalf. Over-estimating costs a logarithm, so there is
    // no number here that is safe to guess.
    if (expectedSize === undefined) {
      throw fail(TypeError, 'CVM_INVALID_OPTION', 'expectedSize is required: pass the stream length you expect, an upper bound is fine')
    }
    if (random !== undefined && typeof random !== 'function') {
      throw fail(TypeError, 'CVM_INVALID_OPTION', 'random must be a function returning a float in [0, 1)')
    }

    this.#threshold = computeThreshold(epsilon, delta, expectedSize)
    this.#epsilon = epsilon
    this.#delta = delta
    this.#expectedSize = expectedSize

    this._keep = this.#threshold / 2
    this._random = random ?? createRandom(seed)
    this._X = new Set()
    this._p = 1
    this._holes = 0
  }

  // Algorithm 3, lines 3-10: insert the element with probability p, remove it
  // otherwise; when the buffer fills up, keep a uniformly random half and halve p.
  add (element) {
    if (this._random() < this._p) {
      const X = this._X
      X.add(element)
      if (X.size === this.#threshold) {
        this._subsample()
        this._p /= 2
      }
    } else if (this._X.delete(element)) {
      this._maybeCompact()
    }
    return this
  }

  // Deleted entries stay in the Set's chains until it is rebuilt, so churn on
  // hot keys slows every lookup down. Rebuilding it here leaves membership,
  // order and randomness untouched, and averages out to nothing per delete.
  _maybeCompact () {
    this._holes++
    if (this._holes >= this._X.size && this._holes >= 1024) {
      this._X = new Set(this._X)
      this._holes = 0
    }
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
    this._holes = 0
  }

  // Fast path for plain arrays: an indexed loop skips the iterator protocol. The
  // identity check keeps subclasses with a custom iterator on the generic path.
  addMany (elements) {
    if (Array.isArray(elements) && elements[Symbol.iterator] === Array.prototype[Symbol.iterator]) {
      for (let i = 0; i < elements.length; i++) this.add(elements[i])
    } else {
      for (const element of elements) this.add(element)
    }
    return this
  }

  get epsilon () {
    return this.#epsilon
  }

  get delta () {
    return this.#delta
  }

  get expectedSize () {
    return this.#expectedSize
  }

  get threshold () {
    return this.#threshold
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
      threshold: this.#threshold,
      p: this._p
    }
  }

  // State as a plain object, ready for JSON.stringify (which calls this method
  // on its own). Its size is bounded by the threshold, like memory.
  toJSON () {
    const values = [...this._X]
    for (let i = 0; i < values.length; i++) {
      if (!isRestorable(values[i])) {
        throw fail(TypeError, 'CVM_UNSERIALIZABLE_VALUE', `values must be a string, a finite number, a boolean or null to be saved, got ${String(values[i])}`)
      }
    }
    return {
      version: SNAPSHOT_VERSION,
      epsilon: this.#epsilon,
      delta: this.#delta,
      expectedSize: this.#expectedSize,
      threshold: this.#threshold,
      p: this._p,
      values
    }
  }

  // Rebuild an estimator from toJSON(). The snapshot holds the parameters, so it
  // is the only argument; counting resumes with fresh randomness, since the
  // generator's position is not part of the state.
  static fromJSON (snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw fail(TypeError, 'CVM_INVALID_SNAPSHOT', `snapshot must be an object, got ${snapshot}`)
    }
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw fail(RangeError, 'CVM_INVALID_SNAPSHOT', `snapshot version must be ${SNAPSHOT_VERSION}, got ${snapshot.version}`)
    }

    const { epsilon, delta, expectedSize, threshold, p, values } = snapshot
    // The constructor validates the parameters and recomputes the threshold, so a
    // mismatch means the snapshot no longer describes the state it carries.
    const cvm = new CVM({ epsilon, delta, expectedSize })
    if (threshold !== cvm.threshold) {
      throw fail(RangeError, 'CVM_INVALID_SNAPSHOT', `snapshot threshold is ${threshold}, but its parameters give ${cvm.threshold}`)
    }
    if (!(p > 0 && p <= 1) || 2 ** Math.round(Math.log2(p)) !== p) {
      throw fail(RangeError, 'CVM_INVALID_SNAPSHOT', `snapshot p must be a power of two in (0, 1], got ${p}`)
    }
    if (!Array.isArray(values)) {
      throw fail(TypeError, 'CVM_INVALID_SNAPSHOT', `snapshot values must be an array, got ${values}`)
    }
    // add() sub-samples as soon as the sample fills up, so a saved state is
    // always below the threshold.
    if (values.length >= threshold) {
      throw fail(RangeError, 'CVM_INVALID_SNAPSHOT', `snapshot holds ${values.length} values, at or above its threshold ${threshold}`)
    }
    for (let i = 0; i < values.length; i++) {
      if (!isRestorable(values[i])) {
        throw fail(TypeError, 'CVM_INVALID_SNAPSHOT', `snapshot values must be strings, finite numbers, booleans or null, got ${String(values[i])}`)
      }
    }
    const restored = new Set(values)
    if (restored.size !== values.length) {
      throw fail(RangeError, 'CVM_INVALID_SNAPSHOT', 'snapshot values contain duplicates')
    }

    cvm._X = restored
    cvm._p = p
    return cvm
  }

  reset () {
    this._X = new Set()
    this._p = 1
    this._holes = 0
    return this
  }
}
