import { pipeline } from 'node:stream/promises'
import { CVM } from './cvm.mjs'
import { fail } from './fail.mjs'
import { createEstimatorSink } from './stream.mjs'

const identity = (x) => x

const isReadable = (source) =>
  source != null && typeof source.pipe === 'function' && typeof source.on === 'function'

// The shape Node's own promise APIs reject with, so one `err.code` covers every
// source kind.
function abortError (signal) {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

const ABORTED = Symbol('aborted')

// Resolves instead of rejecting, so a signal that fires after the loop is over
// leaves no unhandled rejection behind. One listener for the whole run.
function watchAbort (signal) {
  let onAbort
  const fired = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return { fired, release: () => signal.removeEventListener('abort', onAbort) }
}

// `return()` may be absent, may return a plain result object rather than a
// promise, and may throw either way: `for await` tolerates all three, so this
// has to as well. Whatever it does, the error already on its way out is the one
// the caller should see.
function closeQuietly (iterator) {
  try {
    Promise.resolve(iterator.return?.()).catch(() => {})
  } catch { /* nothing left to do about it */ }
}

function checkArguments (estimator, keyFn) {
  if (!(estimator instanceof CVM)) {
    throw fail(TypeError, 'CVM_INVALID_OPTION', 'estimator must be a CVM instance: it is the first argument')
  }
  if (typeof keyFn !== 'function') {
    throw fail(TypeError, 'CVM_INVALID_OPTION', 'keyFn must be a function')
  }
}

// No `signal` here: a synchronous loop runs to its end whatever happens, and
// Node's own *Sync functions take no signal either.
export function estimateDistinctSync (estimator, source, options = {}) {
  const { keyFn = identity } = options
  checkArguments(estimator, keyFn)

  if (Array.isArray(source) && source[Symbol.iterator] === Array.prototype[Symbol.iterator]) {
    // Fast path for plain arrays, as in addMany.
    for (let i = 0; i < source.length; i++) estimator.add(keyFn(source[i]))
  } else if (source != null && typeof source[Symbol.iterator] === 'function') {
    for (const item of source) estimator.add(keyFn(item))
  } else {
    throw fail(TypeError, 'CVM_INVALID_SOURCE',
      'source must be iterable; for an async iterable or a Readable use estimateDistinct')
  }

  return estimator.result()
}

// The returned promise is the single error channel.
export async function estimateDistinct (estimator, source, options = {}) {
  const { keyFn = identity, signal } = options
  checkArguments(estimator, keyFn)
  if (signal != null && typeof signal.aborted !== 'boolean') {
    throw fail(TypeError, 'CVM_INVALID_OPTION', 'signal must be an AbortSignal')
  }

  // Piped, never iterated: with a Readable that hands over one value per read,
  // `Readable.from` included, `for await` piles up a nextTick callback per value
  // until the heap runs out. Reaching `pipeline` also lets it destroy the source
  // when the signal fires, which is why the abort check below sits after it.
  if (isReadable(source)) {
    await pipeline(source, createEstimatorSink(estimator, { keyFn, signal }))
    return estimator.result()
  }

  if (source == null || typeof source[Symbol.asyncIterator] !== 'function') {
    throw fail(TypeError, 'CVM_INVALID_SOURCE',
      'source must be async-iterable or a Readable; for values already in memory use estimateDistinctSync')
  }

  if (signal?.aborted) throw abortError(signal)

  // Driven by hand rather than with `for await` so each `next()` can be raced
  // against the signal. Testing `aborted` between values only looks at it while
  // the source is delivering, never while it is waiting, which is the one moment
  // anyone aborts.
  const iterator = source[Symbol.asyncIterator]()
  const watch = signal ? watchAbort(signal) : null
  let exhausted = false
  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal)
      const step = watch ? await Promise.race([iterator.next(), watch.fired]) : await iterator.next()
      if (step === ABORTED) throw abortError(signal)
      if (step.done) {
        exhausted = true
        break
      }
      estimator.add(keyFn(step.value))
    }
  } finally {
    watch?.release()
    // Asks the source to close so its own cleanup runs, without waiting for it:
    // `return()` queues behind the `next()` still in flight, so awaiting it
    // would hand back the delay the abort just avoided. The caller is released
    // now, the source finishes closing when its pending step settles.
    if (!exhausted) closeQuietly(iterator)
  }

  return estimator.result()
}
