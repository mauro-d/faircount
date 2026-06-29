// ⚠ Tests for the ORIGINAL CVM (Algorithm 1), kept only for pre-release
// comparison. Delete this file together with src/cvm-original.mjs, src/errors.mjs
// and bench/original.mjs once the new variant is adopted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OriginalCVM, computeOriginalThreshold } from '../src/cvm-original.mjs'
import { CVMFailureError } from '../src/errors.mjs'
import { CVM } from '../src/index.mjs'

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

test('[original] threshold is ⌈(12/ε²)·log₂(8m/δ)⌉', () => {
  const expected = Math.ceil((12 / (0.25 * 0.25)) * Math.log2((8 * 1000) / 0.01))
  assert.equal(computeOriginalThreshold(0.25, 0.01, 1000), expected)
})

test('[original] exact when F0 never exceeds the threshold', () => {
  const cvm = new OriginalCVM({ epsilon: 0.5, delta: 0.1, expectedSize: 1000, seed: 1 })
  const { data, f0 } = makeData(5000, 100, 7)
  cvm.addMany(data)
  assert.equal(cvm.distinct, f0)
})

test('[original] throws CVMFailureError on the ⊥ outcome', () => {
  const cvm = new OriginalCVM({ epsilon: 0.9, delta: 0.9, random: () => 0.9 })
  assert.throws(() => {
    for (let i = 0; i < cvm.threshold; i++) cvm.add(`x${i}`)
  }, (err) => err instanceof CVMFailureError && err.code === 'CVM_FAILURE')
})

test('[comparison] both variants stay within ε of F0', () => {
  const { data, f0 } = makeData(100_000, 30_000, 123)
  const opts = { epsilon: 0.1, delta: 0.05, expectedSize: data.length, seed: 7 }
  const eNew = new CVM(opts).addMany(data).distinct
  const eOld = new OriginalCVM(opts).addMany(data).distinct
  assert.ok(Math.abs(eNew - f0) / f0 <= 0.1, `new off by ${Math.abs(eNew - f0) / f0}`)
  assert.ok(Math.abs(eOld - f0) / f0 <= 0.1, `old off by ${Math.abs(eOld - f0) / f0}`)
})

test('[comparison] new threshold is smaller than original (less memory)', () => {
  const eps = 0.05
  const delta = 0.01
  const m = 10_000_000
  assert.ok(new CVM({ epsilon: eps, delta, expectedSize: m }).threshold <
    computeOriginalThreshold(eps, delta, m))
})
