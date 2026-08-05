import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CVM, computeThreshold } from '../src/index.mjs'

// Deterministic workload: `total` tokens drawn from `unique` distinct values,
// returned with its exact F0 for comparison.
function makeData (total, unique, seed) {
  const data = []
  const set = new Set()
  let s = seed
  for (let i = 0; i < total; i++) {
    s = (s * 48271) % 2147483647
    const v = `v${Math.floor((s / 2147483647) * unique)}`
    data.push(v)
    set.add(v)
  }
  return { data, f0: set.size }
}

// Skewed variant of the same workload: log-uniform ("zipf-like") ids, so a few
// hot values dominate the stream and the delete branch churns on them.
function makeSkewedData (total, unique, seed) {
  const data = []
  const set = new Set()
  let s = seed
  for (let i = 0; i < total; i++) {
    s = (s * 48271) % 2147483647
    const v = `v${Math.floor(Math.exp((s / 2147483647) * Math.log(unique))) - 1}`
    data.push(v)
    set.add(v)
  }
  return { data, f0: set.size }
}

test('computeThreshold is ⌈(12/ε²)·ln(3m/δ)⌉ rounded up to even', () => {
  const eps = 0.25
  const delta = 0.01
  const m = 1000
  const n = Math.ceil((12 / (eps * eps)) * Math.log((3 * m) / delta))
  assert.equal(computeThreshold(eps, delta, m), n + (n % 2))
  assert.equal(computeThreshold(eps, delta, m) % 2, 0)
  assert.ok(computeThreshold(eps, delta, m) >= 2)
})

test('computeThreshold treats expectedSize 0 as 1 and grows as ε shrinks', () => {
  assert.equal(computeThreshold(0.25, 0.01, 0), computeThreshold(0.25, 0.01, 1))
  assert.ok(computeThreshold(0.05, 0.01, 1000) > computeThreshold(0.25, 0.01, 1000))
})

test('computeThreshold validates its inputs', () => {
  assert.throws(() => computeThreshold(0, 0.01, 100), RangeError)
  assert.throws(() => computeThreshold(1, 0.01, 100), RangeError)
  assert.throws(() => computeThreshold(0.05, 0, 100), RangeError)
  assert.throws(() => computeThreshold(0.05, 1, 100), RangeError)
  assert.throws(() => computeThreshold(0.05, 0.01, -1), RangeError)
  assert.throws(() => computeThreshold(0.05, 0.01, Infinity), RangeError)
  assert.throws(() => computeThreshold('0.05', 0.01, 100), RangeError)
})

test('every error carries a code, so callers need not match messages', () => {
  const codeOf = (fn) => { try { fn(); return null } catch (err) { return err.code } }
  const valid = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 1000, seed: 1 }).add('a').toJSON()

  assert.equal(codeOf(() => computeThreshold(0, 0.1, 10)), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({ epsilon: 5, expectedSize: 10 })), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({ random: 'nope', expectedSize: 10 })), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({})), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({ expectedSize: 10 }).add(10n).toJSON()), 'CVM_UNSERIALIZABLE_VALUE')
  assert.equal(codeOf(() => CVM.fromJSON({ ...valid, p: 0.3 })), 'CVM_INVALID_SNAPSHOT')
  assert.equal(codeOf(() => CVM.fromJSON('nope')), 'CVM_INVALID_SNAPSHOT')
})

test('constructor validates parameters', () => {
  assert.throws(() => new CVM({ epsilon: 0, expectedSize: 10 }), RangeError)
  assert.throws(() => new CVM({ epsilon: 1, expectedSize: 10 }), RangeError)
  assert.throws(() => new CVM({ delta: 0, expectedSize: 10 }), RangeError)
  assert.throws(() => new CVM({ delta: 1.5, expectedSize: 10 }), RangeError)
  assert.throws(() => new CVM({ expectedSize: -1 }), RangeError)
  assert.throws(() => new CVM({ random: 'nope', expectedSize: 10 }), TypeError)
})

test('expectedSize is required: it is what makes the bound true', () => {
  // No default can be right here. Sizing for a length-1 stream, which is what
  // the old default did, quietly gives up the guarantee the library exists for.
  assert.throws(() => new CVM({}), { name: 'TypeError', code: 'CVM_INVALID_OPTION', message: /expectedSize is required/ })
  assert.throws(() => new CVM({ epsilon: 0.5, delta: 0.1 }), TypeError)

  // A snapshot written before it was required still restores: it carries 0.
  const old = { version: 1, epsilon: 0.5, delta: 0.1, expectedSize: 0, threshold: computeThreshold(0.5, 0.1, 0), p: 1, values: ['a'] }
  assert.equal(CVM.fromJSON(old).add('b').distinct, 2)
})

test('estimate is exact when F0 never exceeds the threshold', () => {
  // Few distinct values => |X| never reaches threshold => no sub-sampling, p=1.
  const cvm = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 1000, seed: 1 })
  const { data, f0 } = makeData(5000, 100, 7)
  assert.ok(f0 < cvm.threshold, 'precondition: F0 below threshold')
  cvm.addMany(data)
  const r = cvm.result()
  assert.equal(r.p, 1)
  assert.equal(r.samples, f0)
  assert.equal(r.estimate, f0)
})

test('the sub-sample keeps exactly half and halves p with it, every time', () => {
  // Equation 2 cancels only because the retention rate and the p update are the
  // same f. Move one without the other and every estimate is skewed, with the
  // paper's proof no longer covering the code.
  // A coin of 0 inserts every value, so the cadence is exact: the buffer fills
  // after `threshold` values, and after every `threshold / 2` from then on.
  const cvm = new CVM({ epsilon: 0.999, delta: 0.999, expectedSize: 0, random: () => 0 })
  const half = cvm.threshold / 2
  let value = 0

  for (let round = 1; round <= 6; round++) {
    const untilFull = round === 1 ? cvm.threshold : half
    for (let i = 0; i < untilFull; i++) cvm.add(`v${value++}`)

    assert.equal(cvm.sampleCount, half, `round ${round} kept ${cvm.sampleCount}, not ${half}`)
    assert.equal(cvm.result().p, 2 ** -round, `round ${round} left p at ${cvm.result().p}`)
  }
})

test('the sub-sample is uniform over every half-subset', () => {
  // The partial Fisher-Yates is ours, the uniform n/2-subset is the paper's
  // requirement. A shuffle drawing j from the whole range instead of the
  // remaining tail still keeps n/2 values and quietly biases which ones, which
  // no count-based assertion would catch.
  const epsilon = 0.999
  const delta = 0.999
  const threshold = computeThreshold(epsilon, delta, 0)
  const snapshot = {
    version: 1,
    epsilon,
    delta,
    expectedSize: 0,
    threshold,
    p: 1,
    values: Array.from({ length: threshold - 1 }, (_, i) => i)
  }

  const seen = new Map()
  const trials = 200_000
  for (let i = 0; i < trials; i++) {
    const cvm = CVM.fromJSON(snapshot)
    cvm.add(threshold - 1)
    const kept = cvm.toJSON().values.sort((a, b) => a - b).join(',')
    seen.set(kept, (seen.get(kept) ?? 0) + 1)
  }

  const subsets = 3432 // C(14, 7)
  assert.equal(seen.size, subsets, `only ${seen.size} of ${subsets} subsets ever appeared`)
  assert.ok([...seen.keys()].every((k) => k.split(',').length === threshold / 2))

  // Too many cells to compare one by one: chi-square over all of them rejects a
  // 5% skew at this many rounds, and passes the real sampler at |z| well under 1.
  const expected = trials / subsets
  let chiSquare = 0
  for (const count of seen.values()) chiSquare += ((count - expected) ** 2) / expected
  const z = (chiSquare - (subsets - 1)) / Math.sqrt(2 * (subsets - 1))
  assert.ok(Math.abs(z) < 5, `chi-square z ${z.toFixed(2)} says the subsets are not equally likely`)
})

test('is total: never fails, even on inputs that make the original return ⊥', () => {
  // A coin of 0 inserts every value, so the buffer refills and sub-samples over
  // and over: the original stalls with a full buffer and returns ⊥, this one
  // always shrinks to n/2. A coin of 0.9 would fire the sub-sample once and then
  // insert nothing ever again, which proves nothing.
  const cvm = new CVM({ epsilon: 0.9, delta: 0.9, expectedSize: 1000, random: () => 0 })
  assert.doesNotThrow(() => {
    for (let i = 0; i < cvm.threshold * 8; i++) cvm.add(`x${i}`)
  })
  assert.ok(Number.isFinite(cvm.distinct))
  assert.ok(cvm.sampleCount < cvm.threshold, 'the buffer never stays full')
  assert.ok(cvm.result().p < 2 ** -8, 'sub-sampling fired many times')
})

test('keeps the buffer within the threshold (memory bound)', () => {
  const cvm = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: 200_000, seed: 3 })
  let maxSamples = 0
  for (let i = 0; i < 200_000; i++) {
    cvm.add(`v${i % 80_000}`)
    if (cvm.sampleCount > maxSamples) maxSamples = cvm.sampleCount
  }
  assert.ok(maxSamples < cvm.threshold, `samples ${maxSamples} reached threshold ${cvm.threshold}`)
  assert.ok(cvm.result().p < 1, 'sub-sampling should have engaged')
})

test('the parameters cannot be assigned, so the memory bound cannot be lifted', () => {
  // `_keep` is fixed at construction. A writable `threshold` would let the
  // buffer grow past it and, worse, leave the sub-sample keeping the old count
  // while `p` still halves, which is where unbiasedness comes from.
  const cvm = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 100 })
  for (const field of ['threshold', 'epsilon', 'delta', 'expectedSize']) {
    assert.throws(() => { cvm[field] = 999_999 }, TypeError, `${field} accepted an assignment`)
  }

  for (let i = 0; i < 5000; i++) cvm.add(`v${i}`)
  assert.ok(cvm.sampleCount <= cvm.threshold, `samples ${cvm.sampleCount} exceeded threshold ${cvm.threshold}`)
})

test('same seed reproduces the same estimate under hot-key churn', () => {
  const { data, f0 } = makeSkewedData(60_000, 30_000, 5)
  const opts = { epsilon: 0.2, delta: 0.05, expectedSize: data.length, seed: 42 }
  assert.ok(f0 > new CVM(opts).threshold, 'precondition: sub-sampling engages')
  const a = new CVM(opts).addMany(data).distinct
  const b = new CVM(opts).addMany(data).distinct
  assert.equal(a, b)

  const cvm = new CVM(opts)
  let maxSamples = 0
  for (const v of data) {
    cvm.add(v)
    if (cvm.sampleCount > maxSamples) maxSamples = cvm.sampleCount
  }
  assert.ok(maxSamples < cvm.threshold, `samples ${maxSamples} reached threshold ${cvm.threshold}`)
})

test('addMany takes arrays and other iterables alike', () => {
  const { data } = makeData(5000, 100, 7)
  const fromArray = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 5000, seed: 3 }).addMany(data).distinct
  const fromIterable = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 5000, seed: 3 }).addMany(data.values()).distinct
  assert.equal(fromArray, fromIterable)

  // An array subclass with its own iterator must be iterated through it.
  class OddOnly extends Array {
    * [Symbol.iterator] () {
      for (let i = 0; i < this.length; i++) if (this[i] % 2 === 1) yield this[i]
    }
  }
  const cvm = new CVM({ epsilon: 0.5, delta: 0.5, expectedSize: 10, seed: 1 })
  cvm.addMany(OddOnly.from([1, 2, 3, 4, 5]))
  assert.equal(cvm.distinct, 3)
})

test('a snapshot round-trips through JSON and preserves the estimate', () => {
  const { data } = makeData(100_000, 30_000, 123)
  const cvm = new CVM({ epsilon: 0.1, delta: 0.05, expectedSize: data.length, seed: 4 }).addMany(data)
  assert.ok(cvm.result().p < 1, 'precondition: sub-sampling engaged')

  const restored = CVM.fromJSON(JSON.parse(JSON.stringify(cvm)))
  assert.deepEqual(restored.result(), cvm.result())
  assert.equal(restored.epsilon, cvm.epsilon)
  assert.equal(restored.delta, cvm.delta)
  assert.equal(restored.expectedSize, cvm.expectedSize)
})

test('a restored estimator keeps counting from the saved state', () => {
  const first = Array.from({ length: 20_000 }, (_, i) => `a${i}`)
  const second = Array.from({ length: 20_000 }, (_, i) => `b${i}`)
  const opts = { epsilon: 0.2, delta: 0.05, expectedSize: 40_000, seed: 8 }

  const saved = new CVM(opts).addMany(first)
  const restored = CVM.fromJSON(JSON.parse(JSON.stringify(saved))).addMany(second)
  const fresh = new CVM(opts).addMany(second)

  assert.ok(restored.distinct > fresh.distinct * 1.5,
    `restored ${restored.distinct} should cover both halves, a fresh run saw ${fresh.distinct}`)
  assert.ok(Math.abs(restored.distinct - 40_000) / 40_000 <= 0.2)
})

test('toJSON keeps JSON-safe values and refuses the rest', () => {
  const opts = { epsilon: 0.5, delta: 0.1, expectedSize: 100, random: () => 0 }
  assert.equal(new CVM(opts).addMany(['s', 42, true, null]).toJSON().values.length, 4)

  for (const value of [10n, Symbol('x'), NaN, Infinity, { id: 1 }, ['a']]) {
    assert.throws(() => new CVM(opts).add(value).toJSON(), TypeError, `should refuse ${String(value)}`)
  }
})

test('fromJSON rejects a snapshot that contradicts itself', () => {
  const valid = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 1000, seed: 1 }).addMany(['a', 'b', 'c']).toJSON()

  assert.throws(() => CVM.fromJSON(null), TypeError)
  assert.throws(() => CVM.fromJSON('nope'), TypeError)
  assert.throws(() => CVM.fromJSON({ ...valid, version: 2 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, threshold: valid.threshold + 2 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, epsilon: 0.25 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, p: 0.3 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, p: 0 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, p: 2 }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, values: 'abc' }), TypeError)
  assert.throws(() => CVM.fromJSON({ ...valid, values: ['a', 'a'] }), RangeError)
  assert.throws(() => CVM.fromJSON({ ...valid, values: [{ id: 1 }] }), TypeError)
  assert.throws(() => CVM.fromJSON({ ...valid, values: Array.from({ length: valid.threshold }, (_, i) => `v${i}`) }), RangeError)

  // A halved p is the one thing that legitimately differs from the fresh state.
  assert.equal(CVM.fromJSON({ ...valid, p: 0.25 }).result().p, 0.25)
})

test('reset clears state and reuses parameters', () => {
  const cvm = new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 1000, seed: 2 })
  cvm.addMany(makeData(3000, 80, 5).data)
  assert.ok(cvm.sampleCount > 0)
  cvm.reset()
  assert.equal(cvm.sampleCount, 0)
  assert.equal(cvm.result().p, 1)
  assert.equal(cvm.distinct, 0)
})

test('a fixed seed makes runs reproducible', () => {
  const { data } = makeData(50_000, 20_000, 9)
  const a = new CVM({ epsilon: 0.1, seed: 42, expectedSize: data.length }).addMany(data).distinct
  const b = new CVM({ epsilon: 0.1, seed: 42, expectedSize: data.length }).addMany(data).distinct
  assert.equal(a, b)
})
