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

test('an array with its own iterator is iterated, not indexed', () => {
  // The fast path indexes the array directly, so it only applies while the
  // iterator is the stock one. A replaced iterator has to win.
  const values = ['a', 'b', 'c', 'd']
  values[Symbol.iterator] = function * () { yield 'x'; yield 'x'; yield 'y' }

  assert.equal(estimateDistinctSync(small(), values).estimate, 2)
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

test('a signal stops a source that is waiting, not just one that is delivering', async () => {
  // The check has to race `next()`: a source suspended on an await is the one
  // case anyone aborts, and it is the case a per-value check never sees.
  async function * stalls () {
    yield 'a'
    await new Promise((resolve) => setTimeout(resolve, 2000))
    yield 'b'
  }

  const estimator = small()
  const started = Date.now()
  const err = await estimateDistinct(estimator, stalls(), { signal: AbortSignal.timeout(50) }).catch((e) => e)
  const elapsed = Date.now() - started

  assert.equal(err.code, 'ABORT_ERR')
  assert.ok(elapsed < 1000, `abort took ${elapsed}ms, so it waited for the source instead of the signal`)
  assert.equal(estimator.sampleCount, 1, 'the value delivered before the stall was counted')
})

test('no value is counted after the signal has fired', async () => {
  // Aborting from inside keyFn fires the signal while a value is being handled,
  // between two reads of the source. The next one must not be counted.
  const controller = new AbortController()
  async function * three () { yield 'a'; yield 'b'; yield 'c' }

  const estimator = small()
  const err = await estimateDistinct(estimator, three(), {
    signal: controller.signal,
    keyFn: (value) => { controller.abort(); return value }
  }).catch((e) => e)

  assert.equal(err.code, 'ABORT_ERR')
  assert.equal(estimator.sampleCount, 1, 'only the value in flight when the signal fired')
})

test('a source that misbehaves on close cannot spoil the abort', async () => {
  // One value, then a `next()` that never settles, so the signal always wins the
  // race and the close path always runs. A missing `return` and a failing one
  // must both leave the caller with the abort: a rejection escaping here would
  // fail this run as an unhandled rejection.
  const stalling = (close) => ({
    [Symbol.asyncIterator] () {
      let sent = 0
      const iterator = {
        next: async () => (sent++ === 0 ? { value: 'a', done: false } : new Promise(() => {}))
      }
      if (close) iterator.return = close
      return iterator
    }
  })

  const closers = [
    undefined,
    () => undefined,
    () => ({ done: true }), // legal, and not a promise
    () => { throw new Error('sync close boom') }, // throws before returning anything
    async () => { throw new Error('close boom') }
  ]
  for (const close of closers) {
    const estimator = small()
    const err = await estimateDistinct(estimator, stalling(close), {
      signal: AbortSignal.timeout(20)
    }).catch((e) => e)
    assert.equal(err.code, 'ABORT_ERR')
    assert.equal(estimator.sampleCount, 1)
  }
})

test('a signal already aborted stops before the first value', async () => {
  const controller = new AbortController()
  controller.abort()

  for (const source of [(async function * () { yield 'a' })(), Readable.from(['a'])]) {
    const estimator = small()
    const err = await estimateDistinct(estimator, source, { signal: controller.signal }).catch((e) => e)
    assert.equal(err.code, 'ABORT_ERR')
    assert.equal(estimator.sampleCount, 0)
    // A signal that fires mid-stream leaves the source destroyed; one that fired
    // before the call has to end the same way.
    if (source instanceof Readable) assert.equal(source.destroyed, true)
  }
})

test('the synchronous pass refuses a signal instead of ignoring it', () => {
  // Ignoring it would leave a caller believing the count can be stopped.
  assert.throws(
    () => estimateDistinctSync(small(), ['a'], { signal: AbortSignal.timeout(1) }),
    { name: 'TypeError', code: 'CVM_INVALID_OPTION', message: /use estimateDistinct/ }
  )
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
