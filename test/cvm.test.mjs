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

// A batch of values seen once at the start and never again, then traffic that
// keeps repeating. A sub-sample that favours the values it already holds keeps
// the cold prefix forever, and the estimate roughly doubles.
function makeColdPrefixData (coldValues, hotValues, repeats) {
  const data = []
  for (let i = 0; i < coldValues; i++) data.push(`cold${i}`)
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < hotValues; i++) data.push(`hot${i}`)
  }
  return { data, f0: coldValues + hotValues }
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
  assert.equal(codeOf(() => new CVM({ epsilon: 5 })), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({ random: 'nope' })), 'CVM_INVALID_OPTION')
  assert.equal(codeOf(() => new CVM({ expectedSize: 10 }).add(10n).toJSON()), 'CVM_UNSERIALIZABLE_VALUE')
  assert.equal(codeOf(() => CVM.fromJSON({ ...valid, p: 0.3 })), 'CVM_INVALID_SNAPSHOT')
  assert.equal(codeOf(() => CVM.fromJSON('nope')), 'CVM_INVALID_SNAPSHOT')
})

test('constructor validates parameters', () => {
  assert.throws(() => new CVM({ epsilon: 0 }), RangeError)
  assert.throws(() => new CVM({ epsilon: 1 }), RangeError)
  assert.throws(() => new CVM({ delta: 0 }), RangeError)
  assert.throws(() => new CVM({ delta: 1.5 }), RangeError)
  assert.throws(() => new CVM({ expectedSize: -1 }), RangeError)
  assert.throws(() => new CVM({ random: 'nope' }), TypeError)
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

test('estimate stays within ε of F0 with probability ≥ 1-δ (statistical)', () => {
  const epsilon = 0.1
  const delta = 0.05
  const { data, f0 } = makeData(100_000, 30_000, 123)

  const trials = 100
  let within = 0
  let relSum = 0
  for (let t = 0; t < trials; t++) {
    const cvm = new CVM({ epsilon, delta, expectedSize: data.length, seed: t + 1 })
    cvm.addMany(data)
    const rel = Math.abs(cvm.distinct - f0) / f0
    relSum += rel
    if (rel <= epsilon) within++
    assert.ok(cvm.result().p < 1, 'sub-sampling should have engaged')
  }
  assert.ok(within / trials >= 0.9, `only ${within}/${trials} within ε`)
  assert.ok(relSum / trials < epsilon, `mean relative error ${relSum / trials} too high`)
})

test('estimator is unbiased: mean over many seeds ≈ F0', () => {
  const { data, f0 } = makeData(100_000, 30_000, 123)
  const trials = 200
  let sum = 0
  for (let t = 1; t <= trials; t++) {
    sum += new CVM({ epsilon: 0.1, delta: 0.05, expectedSize: data.length, seed: t }).addMany(data).distinct
  }
  const bias = Math.abs(sum / trials - f0) / f0
  assert.ok(bias < 0.02, `mean estimate biased by ${(bias * 100).toFixed(2)}%`)
})

test('is total: never fails, even on inputs that make the original return ⊥', () => {
  // Constant coin 0.9 keeps the buffer full in the original algorithm; the new
  // variant sub-samples to exactly n/2, so it can never get stuck.
  const cvm = new CVM({ epsilon: 0.9, delta: 0.9, expectedSize: 1000, random: () => 0.9 })
  assert.doesNotThrow(() => {
    for (let i = 0; i < cvm.threshold * 4; i++) cvm.add(`x${i}`)
  })
  assert.ok(Number.isFinite(cvm.distinct))
})

test('keeps the buffer within the threshold (memory bound)', () => {
  const cvm = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: 200_000, seed: 3 })
  let maxSamples = 0
  for (let i = 0; i < 200_000; i++) {
    cvm.add(`v${i % 80_000}`)
    if (cvm.sampleCount > maxSamples) maxSamples = cvm.sampleCount
  }
  assert.ok(maxSamples <= cvm.threshold, `samples ${maxSamples} exceeded threshold ${cvm.threshold}`)
  assert.ok(cvm.result().p < 1, 'sub-sampling should have engaged')
})

test('stays unbiased on a skewed stream (hot-key churn in the delete branch)', () => {
  const { data, f0 } = makeSkewedData(60_000, 30_000, 5)
  const trials = 150
  let sum = 0
  for (let t = 1; t <= trials; t++) {
    sum += new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: data.length, seed: t }).addMany(data).distinct
  }
  const bias = Math.abs(sum / trials - f0) / f0
  assert.ok(bias < 0.03, `mean estimate biased by ${(bias * 100).toFixed(2)}% on skewed data`)
})

test('stays unbiased when early values never come back (cold prefix)', () => {
  const { data, f0 } = makeColdPrefixData(3000, 30_000, 4)
  const trials = 60
  let sum = 0
  for (let t = 1; t <= trials; t++) {
    const cvm = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: data.length, seed: t })
    sum += cvm.addMany(data).distinct
    if (t === 1) assert.ok(cvm.result().p < 1, 'precondition: sub-sampling engages')
  }
  const bias = Math.abs(sum / trials - f0) / f0
  assert.ok(bias < 0.05, `mean estimate biased by ${(bias * 100).toFixed(2)}% on a cold-prefix stream`)
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
  assert.ok(maxSamples <= cvm.threshold, `samples ${maxSamples} exceeded threshold ${cvm.threshold}`)
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

test('restoring keeps the estimator unbiased', () => {
  const { data, f0 } = makeData(60_000, 25_000, 17)
  const firstHalf = data.slice(0, data.length / 2)
  const secondHalf = data.slice(data.length / 2)

  const trials = 100
  let sum = 0
  for (let t = 1; t <= trials; t++) {
    const saved = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: data.length, seed: t }).addMany(firstHalf)
    sum += CVM.fromJSON(JSON.parse(JSON.stringify(saved))).addMany(secondHalf).distinct
  }
  const bias = Math.abs(sum / trials - f0) / f0
  assert.ok(bias < 0.03, `mean estimate biased by ${(bias * 100).toFixed(2)}% across save and restore`)
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
