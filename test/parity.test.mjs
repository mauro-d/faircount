import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CVM, createEstimatorSink, estimateDistinct, estimateDistinctSync } from '../src/index.mjs'

// Enough distinct values to trigger sub-sampling, so the randomness actually
// matters and two runs can only agree by taking the same path through it.
function sample (n = 80_000, unique = 40_000) {
  const data = []
  let s = 99
  for (let i = 0; i < n; i++) {
    s = (s * 48271) % 2147483647
    data.push(`v${Math.floor((s / 2147483647) * unique)}`)
  }
  return data
}

const options = (data) => ({ epsilon: 0.1, delta: 0.05, expectedSize: data.length, seed: 7 })

test('every API agrees given the same seed', async () => {
  const data = sample()
  async function * gen () { for (const v of data) yield v }

  const core = new CVM(options(data))
  core.addMany(data)

  const sync = new CVM(options(data))
  estimateDistinctSync(sync, data)

  const async = new CVM(options(data))
  await estimateDistinct(async, gen())

  const stream = new CVM(options(data))
  await estimateDistinct(stream, Readable.from(data))

  const sink = new CVM(options(data))
  await pipeline(Readable.from(data), createEstimatorSink(sink))

  const expected = core.result()
  assert.ok(expected.estimate > 0 && expected.estimate < data.length)
  for (const [label, estimator] of [['sync', sync], ['async iterable', async], ['Readable', stream], ['sink', sink]]) {
    assert.deepEqual(estimator.result(), expected, `${label} differs from the core`)
  }
})

test('one estimator fed by two sinks at once counts the union', async () => {
  // Values overlap, so summing two separate counts would be wrong; a shared
  // estimator sees one interleaved sequence and estimates the union.
  function * range (from, to) { for (let i = from; i < to; i++) yield `user${i}` }
  const trueDistinct = 90_000

  const estimator = new CVM({ epsilon: 0.1, delta: 0.05, expectedSize: 200_000, seed: 3 })
  await Promise.all([
    pipeline(Readable.from(range(0, 60_000)), createEstimatorSink(estimator)),
    pipeline(Readable.from(range(30_000, 90_000)), createEstimatorSink(estimator))
  ])

  const { estimate } = estimator.result()
  assert.ok(
    Math.abs(estimate - trueDistinct) / trueDistinct <= 0.1,
    `estimate ${estimate} is not within 10% of ${trueDistinct}`
  )
})

test('a restored estimator keeps counting through either API', async () => {
  const estimator = new CVM({ epsilon: 0.2, delta: 0.05, expectedSize: 1000, seed: 4 })
  estimateDistinctSync(estimator, ['a', 'b', 'c'])

  const resumed = CVM.fromJSON(JSON.parse(JSON.stringify(estimator)))
  await pipeline(Readable.from(['c', 'd']), createEstimatorSink(resumed))
  await estimateDistinct(resumed, Readable.from(['e']))

  assert.equal(resumed.result().estimate, 5)
})
