import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRandom } from '../src/index.mjs'

test('no seed returns Math.random itself', () => {
  assert.equal(createRandom(), Math.random)
  assert.equal(createRandom(undefined), Math.random)
  assert.equal(createRandom(null), Math.random)
})

test('seed 0 is a real seed, not treated as "no seed"', () => {
  const random = createRandom(0)
  assert.notEqual(random, Math.random)
  assert.equal(typeof random, 'function')
})

test('returns values in [0, 1)', () => {
  const random = createRandom(7)
  for (let i = 0; i < 1000; i++) {
    const v = random()
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`)
  }
})

test('same seed produces the same sequence', () => {
  const a = createRandom(42)
  const b = createRandom(42)
  const seqA = Array.from({ length: 20 }, () => a())
  const seqB = Array.from({ length: 20 }, () => b())
  assert.deepEqual(seqA, seqB)
})

test('different seeds produce different sequences', () => {
  const a = createRandom(1)
  const b = createRandom(2)
  const seqA = Array.from({ length: 10 }, () => a())
  const seqB = Array.from({ length: 10 }, () => b())
  assert.notDeepEqual(seqA, seqB)
})

test('rejects a non-numeric seed', () => {
  assert.throws(() => createRandom('42'), TypeError)
})

test('rejects a non-finite seed', () => {
  assert.throws(() => createRandom(NaN), TypeError)
  assert.throws(() => createRandom(Infinity), TypeError)
})

test('rejects a fractional seed, which would silently seed the same run as its floor', () => {
  assert.throws(() => createRandom(1.5), { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
  assert.deepEqual(
    Array.from({ length: 3 }, createRandom(1)),
    Array.from({ length: 3 }, createRandom(1)),
    'the floor still seeds what it always did'
  )
})
