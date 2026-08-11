import { Readable } from 'node:stream'
import { CVM, estimateDistinct, estimateDistinctSync } from 'faircount'

interface Order { user: string, total: number }
const orders: Order[] = [{ user: 'a', total: 1 }]
const est = new CVM({ expectedSize: 10 })

// 1. il parametro della keyFn deve essere Order, non any
estimateDistinctSync(est, orders, { keyFn: (o) => { const check: Order = o; return check.user } })

// 2. un campo inesistente deve essere un errore
// @ts-expect-error campo che non esiste su Order
estimateDistinctSync(est, orders, { keyFn: (o) => o.usr })

// 3. senza keyFn deve continuare a compilare
estimateDistinctSync(est, orders)

// 4. Readable: la keyFn deve restare utilizzabile
await estimateDistinct(est, Readable.from(['a']), { keyFn: (c) => String(c) })

// 5. async iterable tipizzato
async function * rows (): AsyncGenerator<Order> { yield { user: 'a', total: 1 } }
await estimateDistinct(est, rows(), { keyFn: (r) => { const check: Order = r; return check.user } })

// 6. async iterable: campo inesistente
// @ts-expect-error campo che non esiste su Order
await estimateDistinct(est, rows(), { keyFn: (r) => r.usr })
