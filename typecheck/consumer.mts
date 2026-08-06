// Typechecked by `npm run typecheck`. The public types are hand-written, so this
// is the only thing standing between an edit to types/index.d.mts and a broken
// published surface. It imports faircount by name, through the exports map, the
// way a consumer does.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CVM, createEstimatorSink, estimateDistinct, estimateDistinctSync, computeThreshold, createRandom
} from 'faircount'
import type {
  CVMOptions, CVMResult, CVMSnapshot, CVMErrorCode, EstimateOptions, EstimateSyncOptions,
  EstimatorSink, EstimatorSinkOptions
} from 'faircount'

const options: CVMOptions = { expectedSize: 1_000_000, epsilon: 0.05, delta: 0.01, seed: 1 }
const estimator: CVM = new CVM(options)
estimator.add('a').addMany(['b', 'c'])

const result: CVMResult = estimator.result()
const snapshot: CVMSnapshot = estimator.toJSON()
const restored: CVM = CVM.fromJSON(snapshot)
const code: CVMErrorCode = 'CVM_INVALID_SOURCE'
const reading: number = estimator.distinct + estimator.sampleCount + estimator.threshold

const syncOptions: EstimateSyncOptions = { keyFn: (order: any) => String(order.user) }
const fromArray: CVMResult = estimateDistinctSync(estimator, [{ user: 'u1' }], syncOptions)
const fromSet: CVMResult = estimateDistinctSync(estimator, new Set(['a', 'b']))

const asyncOptions: EstimateOptions = { keyFn: (row: any) => String(row.id), signal: AbortSignal.timeout(10) }
const fromStream: CVMResult = await estimateDistinct(restored, Readable.from(['a']), asyncOptions)
const fromAsync: CVMResult = await estimateDistinct(restored, (async function * () { yield 'a' })())

const sinkOptions: EstimatorSinkOptions = { keyFn: (chunk: any) => chunk.toString(), objectMode: false }
const sink: EstimatorSink = createEstimatorSink(estimator, sinkOptions)
const back: CVM = sink.estimator
await pipeline(Readable.from(['a']), sink)

const capacity: number = computeThreshold(0.05, 0.01, 1000)
const random: () => number = createRandom(7)

void [result, code, reading, fromArray, fromSet, fromStream, fromAsync, back, capacity, random]
