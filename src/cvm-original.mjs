// ⚠ ORIGINAL CVM (Algorithm 1, arXiv:2301.10191) — kept ONLY for pre-release
// comparison against the new total/unbiased variant in cvm.mjs. It is not part of
// the public API and nothing in the shipped library imports it. Delete this file
// (and src/errors.mjs, test/cvm-original.test.mjs, bench/original.mjs) once the
// new variant is adopted.
import { CVMFailureError } from './errors.mjs'
import { createRandom } from './random.mjs'

const DEFAULT_EPSILON = 0.05
const DEFAULT_DELTA = 0.01

// Original sample-set capacity: ⌈(12/ε²)·log₂(8m/δ)⌉.
export function computeOriginalThreshold (epsilon, delta, expectedSize) {
  const m = expectedSize > 0 ? expectedSize : 1
  return Math.ceil((12 / (epsilon * epsilon)) * Math.log2((8 * m) / delta))
}

// Original CVM estimator. Sub-sampling drops each element independently with
// probability ½, then halves p, and returns ⊥ (throws CVMFailureError) if the
// buffer stays full. The estimate |X|/p is biased.
export class OriginalCVM {
  constructor (options = {}) {
    const {
      epsilon = DEFAULT_EPSILON,
      delta = DEFAULT_DELTA,
      expectedSize = 0,
      seed,
      random
    } = options

    if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 1)) {
      throw new RangeError(`epsilon must be a number in (0, 1), got ${epsilon}`)
    }
    if (typeof delta !== 'number' || !(delta > 0 && delta < 1)) {
      throw new RangeError(`delta must be a number in (0, 1), got ${delta}`)
    }
    if (typeof expectedSize !== 'number' || !Number.isFinite(expectedSize) || expectedSize < 0) {
      throw new RangeError(`expectedSize must be a non-negative finite number, got ${expectedSize}`)
    }
    if (random !== undefined && typeof random !== 'function') {
      throw new TypeError('random must be a function returning a float in [0, 1)')
    }

    this.epsilon = epsilon
    this.delta = delta
    this.expectedSize = expectedSize
    this.threshold = computeOriginalThreshold(epsilon, delta, expectedSize)

    this._random = random ?? createRandom(seed)
    this._X = new Set()
    this._p = 1
  }

  add (element) {
    const X = this._X
    X.delete(element)
    if (this._random() < this._p) X.add(element)

    if (X.size === this.threshold) {
      for (const el of X) {
        if (this._random() < 0.5) X.delete(el)
      }
      this._p /= 2
      if (X.size === this.threshold) throw new CVMFailureError(this.threshold)
    }
    return this
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
    this._X.clear()
    this._p = 1
    return this
  }
}
