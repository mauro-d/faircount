import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { CVM, estimateDistinct, estimateDistinctSync } from '../src/index.mjs'

const VALUES = ['a', 'b', 'a', 'c', 'b', 'a', 'd', 'c']
const small = () => new CVM({ epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })

test('estimateDistinctSync accepts an Array', () => {
  assert.equal(estimateDistinctSync(small(), VALUES).estimate, 4)
})

test('estimateDistinctSync accepts a non-array iterable (Set)', () => {
  assert.equal(estimateDistinctSync(small(), new Set(VALUES)).estimate, 4)
})

test('estimateDistinct accepts an async iterable', async () => {
  async function * gen () {
    for (const v of VALUES) yield v
  }
  const { estimate } = await estimateDistinct(small(), gen())
  assert.equal(estimate, 4)
})

test('estimateDistinct accepts a Readable stream', async () => {
  const { estimate } = await estimateDistinct(small(), Readable.from(VALUES))
  assert.equal(estimate, 4)
})

test('each refuses the other one\'s sources, and names the one to use', async () => {
  await assert.rejects(estimateDistinct(small(), VALUES), {
    name: 'TypeError',
    code: 'CVM_INVALID_SOURCE',
    message: /estimateDistinctSync/
  })
  await assert.rejects(estimateDistinct(small(), new Set(VALUES)), { code: 'CVM_INVALID_SOURCE' })

  assert.throws(() => estimateDistinctSync(small(), Readable.from(VALUES)), {
    name: 'TypeError',
    code: 'CVM_INVALID_SOURCE',
    message: /use estimateDistinct/
  })
  assert.throws(() => estimateDistinctSync(small(), (async function * () { yield 'a' })()), {
    code: 'CVM_INVALID_SOURCE'
  })
})

test('the same estimator carries a count across both APIs', async () => {
  const estimator = small()
  estimateDistinctSync(estimator, ['a', 'b'])
  const { estimate } = await estimateDistinct(estimator, Readable.from(['b', 'c']))
  assert.equal(estimate, 3, 'the result covers everything the estimator has seen')
})

test('a long Readable does not pile up pending callbacks', async () => {
  // `Readable.from` hands over one value per read, so iterating it with
  // `for await` leaves a nextTick callback pending for each and the heap runs
  // out. Counting those beats watching the heap, which also holds garbage the
  // collector has not got to yet.
  const total = 200_000
  function * tokens () {
    for (let i = 0; i < total; i++) yield `v${i % 40_000}`
  }

  const realNextTick = process.nextTick
  let pending = 0
  let peak = 0
  process.nextTick = function (task, ...args) {
    pending++
    if (pending > peak) peak = pending
    return realNextTick.call(process, (...inner) => {
      pending--
      return task(...inner)
    }, ...args)
  }

  try {
    const estimator = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: total })
    await estimateDistinct(estimator, Readable.from(tokens(), { objectMode: true }))
  } finally {
    process.nextTick = realNextTick
  }

  assert.ok(peak < 1000, `${peak} callbacks were pending at once over ${total} values`)
})

test('a signal stops an async source and rejects like the rest of Node', async () => {
  async function * slowPages () {
    for (let page = 0; ; page++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (let i = 0; i < 50; i++) yield `v${page * 50 + i}`
    }
  }

  const estimator = new CVM({ expectedSize: 1_000_000 })
  const err = await estimateDistinct(estimator, slowPages(), {
    signal: AbortSignal.timeout(25)
  }).catch((e) => e)

  assert.equal(err.name, 'AbortError')
  assert.equal(err.code, 'ABORT_ERR')
  assert.equal(err.cause.name, 'TimeoutError', 'the signal reason is kept as cause')
  assert.ok(estimator.result().estimate > 0, 'the partial count stays in the estimator')
})

test('a signal already aborted stops before the first value', async () => {
  const controller = new AbortController()
  controller.abort()

  for (const source of [(async function * () { yield 'a' })(), Readable.from(['a'])]) {
    const estimator = small()
    const err = await estimateDistinct(estimator, source, { signal: controller.signal }).catch((e) => e)
    assert.equal(err.code, 'ABORT_ERR')
    assert.equal(estimator.sampleCount, 0)
  }
})

test('an invalid signal is rejected the same way for every source kind', async () => {
  for (const source of [(async function * () { yield 'a' })(), Readable.from(['a'])]) {
    await assert.rejects(
      estimateDistinct(small(), source, { signal: 'nope' }),
      { name: 'TypeError', code: 'CVM_INVALID_OPTION' }
    )
  }
})

test('keyFn is applied to each item', async () => {
  const orders = [{ user: 'u1' }, { user: 'u2' }, { user: 'u1' }]
  assert.equal(estimateDistinctSync(small(), orders, { keyFn: (o) => o.user }).estimate, 2)

  const { estimate } = await estimateDistinct(small(), Readable.from(orders), { keyFn: (o) => o.user })
  assert.equal(estimate, 2)
})

test('rejects a keyFn that is not a function', async () => {
  assert.throws(() => estimateDistinctSync(small(), ['a'], { keyFn: 5 }),
    { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
  await assert.rejects(estimateDistinct(small(), Readable.from(['a']), { keyFn: 5 }),
    { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
})

test('rejects anything that is not a CVM as the estimator', async () => {
  for (const bad of [undefined, null, {}, new Set(), small().toJSON()]) {
    assert.throws(() => estimateDistinctSync(bad, ['a']), { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
    await assert.rejects(estimateDistinct(bad, Readable.from(['a'])), { name: 'TypeError', code: 'CVM_INVALID_OPTION' })
  }
})

test('rejects a source neither of them can read', async () => {
  assert.throws(() => estimateDistinctSync(small(), 42), { name: 'TypeError', code: 'CVM_INVALID_SOURCE' })
  await assert.rejects(estimateDistinct(small(), 42), { name: 'TypeError', code: 'CVM_INVALID_SOURCE' })
  await assert.rejects(estimateDistinct(small(), null), { name: 'TypeError', code: 'CVM_INVALID_SOURCE' })
})

test('rejects when an async source errors (single channel)', async () => {
  async function * boom () {
    yield 'a'
    throw new Error('async boom')
  }
  await assert.rejects(estimateDistinct(small(), boom()), /async boom/)
})

test('propagates a keyFn error (single channel)', async () => {
  assert.throws(
    () => estimateDistinctSync(small(), ['a', 'b'], { keyFn: () => { throw new Error('keyFn boom') } }),
    /keyFn boom/
  )
  await assert.rejects(
    estimateDistinct(small(), Readable.from(['a', 'b']), { keyFn: () => { throw new Error('keyFn boom') } }),
    /keyFn boom/
  )
})
