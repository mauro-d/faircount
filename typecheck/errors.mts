// Every line here must fail to compile. `@ts-expect-error` inverts the check, so
// the day one of these starts compiling, `npm run typecheck` fails and says so.
import { Readable } from 'node:stream'
import { CVM, createEstimatorSink, estimateDistinct, estimateDistinctSync } from 'faircount'

const estimator = new CVM({ expectedSize: 10 })

// @ts-expect-error expectedSize is required
new CVM({ epsilon: 0.05 })
// @ts-expect-error the constructor takes no empty call
new CVM()
// @ts-expect-error the estimator comes first, and is mandatory
estimateDistinctSync(['a'])
// @ts-expect-error an array is not an async source
await estimateDistinct(estimator, ['a'])
// @ts-expect-error a Readable is not a sync source
estimateDistinctSync(estimator, Readable.from(['a']))
// @ts-expect-error the synchronous pass cannot be aborted
estimateDistinctSync(estimator, ['a'], { signal: AbortSignal.timeout(1) })
// @ts-expect-error the estimator's parameters do not belong to the counting functions
estimateDistinctSync(estimator, ['a'], { epsilon: 0.1 })
// @ts-expect-error nor to the sink
createEstimatorSink(estimator, { delta: 0.1 })
// @ts-expect-error keyFn has to return something a Set can dedup
estimateDistinctSync(estimator, ['a'], { keyFn: (value: any) => ({ value }) })
// @ts-expect-error the parameters are read-only
estimator.threshold = 1

interface Order { user: string, total: number }
const orders: Order[] = [{ user: 'a', total: 1 }]
// @ts-expect-error the keyFn parameter follows the source, so a missing field is caught
estimateDistinctSync(estimator, orders, { keyFn: (o) => o.usr })
async function * typedRows (): AsyncGenerator<Order> { yield { user: 'a', total: 1 } }
// @ts-expect-error same on the async path
await estimateDistinct(estimator, typedRows(), { keyFn: (r) => r.usr })
// @ts-expect-error the sink takes its element type explicitly
createEstimatorSink<Order>(estimator, { keyFn: (o) => o.usr })
