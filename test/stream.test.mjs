import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CVM, createEstimatorSink } from '../src/index.mjs'

const small = () => new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })

test('counts distinct values piped through it (exact for small input)', async () => {
  const values = ['a', 'b', 'a', 'c', 'b', 'a']
  const estimator = small()
  const sink = createEstimatorSink(estimator)
  await pipeline(Readable.from(values), sink)
  assert.equal(estimator.result().estimate, 3)
  assert.equal(sink.estimator, estimator, 'the sink hands back the estimator it was given')
})

test('keyFn maps objects to their distinct key', async () => {
  const orders = [
    { user: 'u1' }, { user: 'u2' }, { user: 'u1' }, { user: 'u3' }
  ]
  const estimator = small()
  await pipeline(Readable.from(orders), createEstimatorSink(estimator, { keyFn: (o) => o.user }))
  assert.equal(estimator.result().estimate, 3)
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
  const estimator = new CVM({ epsilon, delta: 0.05, expectedSize: total, seed: 5 })
  await pipeline(Readable.from(data), createEstimatorSink(estimator))

  const { estimate, p } = estimator.result()
  assert.ok(p < 1, 'sub-sampling should have engaged')
  assert.ok(Math.abs(estimate - trueDistinct.size) / trueDistinct.size <= epsilon)
})

test('rejects anything that is not a CVM as the estimator', () => {
  for (const bad of [undefined, null, {}, new Set(), small().toJSON()]) {
    assert.throws(() => createEstimatorSink(bad), { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
  }
})

test('rejects keyFn that is not a function', () => {
  assert.throws(() => createEstimatorSink(small(), { keyFn: 5 }), TypeError)
})

test('propagates a source error through pipeline (single channel)', async () => {
  const boom = new Error('source boom')
  const source = new Readable({
    objectMode: true,
    read () { this.destroy(boom) }
  })
  await assert.rejects(pipeline(source, createEstimatorSink(small())), /source boom/)
})

test('objectMode: false delivers Buffers, so the default keyFn cannot dedup them', async () => {
  // Simulates values already framed upstream (e.g. by a line-splitting
  // transform) and handed off as plain strings, with objectMode: false.
  const lines = ['apple', 'banana', 'apple', 'cherry']

  const undecoded = small()
  await pipeline(
    Readable.from(lines, { objectMode: false }),
    createEstimatorSink(undecoded, { objectMode: false })
  )
  // Node converts each string to a Buffer before _write sees it.
  assert.equal(undecoded.result().estimate, 4)

  const decoded = small()
  await pipeline(
    Readable.from(lines, { objectMode: false }),
    createEstimatorSink(decoded, { objectMode: false, keyFn: (chunk) => chunk.toString() })
  )
  assert.equal(decoded.result().estimate, 3)
})

test('objectMode: false rejects a chunk that is not a string, Buffer, TypedArray, or DataView', () => {
  const sink = createEstimatorSink(small(), { objectMode: false })
  assert.throws(() => sink.write(42), TypeError)
})

test('an abort stops the sink and leaves the partial count in the estimator', async () => {
  const controller = new AbortController()
  const estimator = small()
  const sink = createEstimatorSink(estimator, { signal: controller.signal })
  const failed = new Promise((resolve) => sink.on('error', resolve))

  sink.write('a')
  sink.write('b')
  controller.abort()

  assert.equal((await failed).code, 'ABORT_ERR')
  assert.equal(estimator.result().estimate, 2, 'what was counted before the stop survives')
})

test('propagates a keyFn error exactly once (no double reporting)', async () => {
  const sink = createEstimatorSink(small(), {
    keyFn: (x) => { if (x === 'bad') throw new Error('keyFn boom'); return x }
  })
  const errors = []
  sink.on('error', (e) => errors.push(e))

  await assert.rejects(pipeline(Readable.from(['a', 'bad', 'c']), sink), /keyFn boom/)
  assert.equal(errors.length, 1, 'error must be emitted exactly once')
  assert.equal(sink.destroyed, true)
})
