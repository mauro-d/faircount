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

test('constructor validates parameters', () => {
  assert.throws(() => new CVM({ epsilon: 0 }), RangeError)
  assert.throws(() => new CVM({ epsilon: 1 }), RangeError)
  assert.throws(() => new CVM({ delta: 0 }), RangeError)
  assert.throws(() => new CVM({ delta: 1.5 }), RangeError)
  assert.throws(() => new CVM({ expectedSize: -1 }), RangeError)
  assert.throws(() => new CVM({ random: 'nope' }), TypeError)
})

test('warns once when expectedSize is omitted', async () => {
  const seen = new Promise((resolve) => process.once('warning', resolve))
  new CVM({ epsilon: 0.5, delta: 0.1 }) // eslint-disable-line no-new
  const warning = await seen
  assert.equal(warning.code, 'CVM_NO_EXPECTED_SIZE')
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

test('estimate stays within ε of F0 with probability ≥ 1−δ (statistical)', () => {
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
