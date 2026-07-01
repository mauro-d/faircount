import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DistinctEstimateStream } from '../src/index.mjs'

test('counts distinct values piped through it (exact for small input)', async () => {
  const values = ['a', 'b', 'a', 'c', 'b', 'a']
  const counter = new DistinctEstimateStream({ epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  await pipeline(Readable.from(values), counter)
  assert.equal(counter.result().estimate, 3)
  assert.equal(counter.distinct, 3)
})

test('keyFn maps objects to their distinct key', async () => {
  const orders = [
    { user: 'u1' }, { user: 'u2' }, { user: 'u1' }, { user: 'u3' }
  ]
  const counter = new DistinctEstimateStream({
    epsilon: 0.5,
    delta: 0.1,
    expectedSize: 100,
    seed: 1,
    keyFn: (o) => o.user
  })
  await pipeline(Readable.from(orders), counter)
  assert.equal(counter.result().estimate, 3)
})

test('estimates accurately at scale, with real sub-sampling', async () => {
  // Large enough to engage sub-sampling, unlike the small examples above.
  const total = 100_000
  const unique = 30_000
  const data = []
  const trueDistinct = new Set()
  let s = 11
  for (let i = 0; i < total; i++) {
    s = (s * 48271) % 2147483647
    const v = `v${Math.floor((s / 2147483647) * unique)}`
    data.push(v)
    trueDistinct.add(v)
  }

  const epsilon = 0.1
  const counter = new DistinctEstimateStream({ epsilon, delta: 0.05, expectedSize: total, seed: 5 })
  await pipeline(Readable.from(data), counter)

  const { estimate, p, threshold } = counter.result()
  assert.equal(threshold, counter.threshold)
  assert.ok(p < 1, 'sub-sampling should have engaged')
  assert.ok(Math.abs(estimate - trueDistinct.size) / trueDistinct.size <= epsilon)
})

test('rejects keyFn that is not a function', () => {
  assert.throws(() => new DistinctEstimateStream({ keyFn: 5 }), TypeError)
})

test('propagates a source error through pipeline (single channel)', async () => {
  const boom = new Error('source boom')
  const source = new Readable({
    objectMode: true,
    read () { this.destroy(boom) }
  })
  const counter = new DistinctEstimateStream({ epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  await assert.rejects(pipeline(source, counter), /source boom/)
})

test('objectMode: false delivers Buffers, so the default keyFn cannot dedup them', async () => {
  // Simulates values already framed upstream (e.g. by a line-splitting
  // transform) and handed off as plain strings, with objectMode: false.
  const lines = ['apple', 'banana', 'apple', 'cherry']

  const undecoded = new DistinctEstimateStream({
    epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1, objectMode: false
  })
  await pipeline(Readable.from(lines, { objectMode: false }), undecoded)
  // Node converts each string to a Buffer before _write sees it; identical
  // content becomes different Buffer objects, so identity keyFn can't dedup.
  assert.equal(undecoded.result().estimate, 4)

  const decoded = new DistinctEstimateStream({
    epsilon: 0.5,
    delta: 0.1,
    expectedSize: 100,
    seed: 1,
    objectMode: false,
    keyFn: (chunk) => chunk.toString()
  })
  await pipeline(Readable.from(lines, { objectMode: false }), decoded)
  assert.equal(decoded.result().estimate, 3)
})

test('objectMode: false rejects values that are not strings or Buffers', () => {
  const counter = new DistinctEstimateStream({ epsilon: 0.5, expectedSize: 100, objectMode: false })
  assert.throws(() => counter.write(42), TypeError)
})

test('propagates a keyFn error exactly once (no double reporting)', async () => {
  const counter = new DistinctEstimateStream({
    epsilon: 0.5,
    delta: 0.1,
    expectedSize: 100,
    keyFn: (x) => { if (x === 'bad') throw new Error('keyFn boom'); return x }
  })
  const errors = []
  counter.on('error', (e) => errors.push(e))

  await assert.rejects(pipeline(Readable.from(['a', 'bad', 'c']), counter), /keyFn boom/)
  assert.equal(errors.length, 1, 'error must be emitted exactly once')
  assert.equal(counter.destroyed, true)
})
