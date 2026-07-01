import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { estimateDistinct } from '../src/index.mjs'

const VALUES = ['a', 'b', 'a', 'c', 'b', 'a', 'd', 'c']

test('estimateDistinct accepts a sync iterable (Array)', async () => {
  const { estimate } = await estimateDistinct(VALUES, { epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1 })
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

test('keyFn is applied to each item', async () => {
  const orders = [{ user: 'u1' }, { user: 'u2' }, { user: 'u1' }]
  const { estimate } = await estimateDistinct(orders, {
    epsilon: 0.5, delta: 0.1, expectedSize: 100, seed: 1, keyFn: (o) => o.user
  })
  assert.equal(estimate, 2)
})

test('rejects when the source is not iterable', async () => {
  await assert.rejects(estimateDistinct(42, { expectedSize: 1 }), TypeError)
  await assert.rejects(estimateDistinct(null, { expectedSize: 1 }), TypeError)
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
