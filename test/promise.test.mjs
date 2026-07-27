import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { estimateDistinct } from '../src/index.mjs'

const VALUES = ['a', 'b', 'a', 'c', 'b', 'a', 'd', 'c']

test('estimateDistinct accepts a sync iterable (Array)', async () => {
  const { estimate } = await estimateDistinct(VALUES, { epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  assert.equal(estimate, 4)
})

test('estimateDistinct accepts a sync non-array iterable (Set)', async () => {
  const { estimate } = await estimateDistinct(new Set(VALUES), { epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  assert.equal(estimate, 4)
})

test('estimateDistinct accepts an async iterable', async () => {
  async function * gen () {
    for (const v of VALUES) yield v
  }
  const { estimate } = await estimateDistinct(gen(), { epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  assert.equal(estimate, 4)
})

test('estimateDistinct accepts a Readable stream', async () => {
  const { estimate } = await estimateDistinct(Readable.from(VALUES), { epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
  assert.equal(estimate, 4)
})

test('the three source kinds agree given the same seed', async () => {
  // Enough distinct values to trigger sub-sampling, so the RNG actually matters.
  const data = []
  let s = 99
  for (let i = 0; i < 80_000; i++) {
    s = (s * 48271) % 2147483647
    data.push(`v${Math.floor((s / 2147483647) * 40_000)}`)
  }
  async function * gen () { for (const v of data) yield v }

  const opts = { epsilon: 0.1, delta: 0.05, expectedSize: data.length, seed: 7 }
  const fromArray = (await estimateDistinct(data, opts)).estimate
  const fromAsync = (await estimateDistinct(gen(), opts)).estimate
  const fromStream = (await estimateDistinct(Readable.from(data), opts)).estimate

  assert.equal(fromArray, fromAsync)
  assert.equal(fromArray, fromStream)
  assert.ok(fromArray < 80_000 && fromArray > 0)
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
    await estimateDistinct(Readable.from(tokens(), { objectMode: true }), {
      epsilon: 0.2, delta: 0.05, expectedSize: total
    })
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

  const err = await estimateDistinct(slowPages(), {
    expectedSize: 1_000_000, signal: AbortSignal.timeout(25)
  }).catch((e) => e)

  assert.equal(err.name, 'AbortError')
  assert.equal(err.code, 'ABORT_ERR')
  assert.equal(err.cause.name, 'TimeoutError', 'the signal reason is kept as cause')
})

test('a signal already aborted stops even a synchronous source', async () => {
  // Nothing else can run while an array is being iterated, so the only moment a
  // synchronous source can be stopped is before it starts.
  const controller = new AbortController()
  controller.abort()

  const err = await estimateDistinct(['a', 'b'], { expectedSize: 10, signal: controller.signal }).catch((e) => e)
  assert.equal(err.code, 'ABORT_ERR')

  await assert.rejects(
    estimateDistinct(['a'], { expectedSize: 10, signal: 'nope' }),
    TypeError
  )
})

test('keyFn is applied to each item', async () => {
  const orders = [{ user: 'u1' }, { user: 'u2' }, { user: 'u1' }]
  const { estimate } = await estimateDistinct(orders, {
    epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1, keyFn: (o) => o.user
  })
  assert.equal(estimate, 2)
})

test('rejects a keyFn that is not a function', async () => {
  await assert.rejects(
    estimateDistinct(['a'], { expectedSize: 10, keyFn: 5 }),
    { name: 'TypeError', code: 'CVM_INVALID_OPTION' }
  )
})

test('rejects when the source is not iterable', async () => {
  await assert.rejects(estimateDistinct(42, { expectedSize: 1 }), { name: 'TypeError', code: 'CVM_INVALID_SOURCE' })
  await assert.rejects(estimateDistinct(null, { expectedSize: 1 }), { name: 'TypeError', code: 'CVM_INVALID_SOURCE' })
})

test('rejects when an async source errors (single channel)', async () => {
  async function * boom () {
    yield 'a'
    throw new Error('async boom')
  }
  await assert.rejects(estimateDistinct(boom(), { expectedSize: 10 }), /async boom/)
})

test('rejects when keyFn throws (single channel)', async () => {
  await assert.rejects(
    estimateDistinct(['a', 'b'], { expectedSize: 100, keyFn: () => { throw new Error('keyFn boom') } }),
    /keyFn boom/
  )
})
