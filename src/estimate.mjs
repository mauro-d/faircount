import { pipeline } from 'node:stream/promises'
import { CVM } from './cvm.mjs'
import { fail } from './fail.mjs'
import { createEstimatorSink } from './stream.mjs'

const identity = (x) => x

const isReadable = (source) =>
  source != null && typeof source.pipe === 'function' && typeof source.on === 'function'

// Node's own shape, so one `err.code` covers every source kind.
function abortError (signal) {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

const ABORTED = Symbol('aborted')

// Resolves rather than rejects: a signal firing after the loop would otherwise
// leave an unhandled rejection.
function watchAbort (signal) {
  let onAbort
  const fired = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return { fired, release: () => signal.removeEventListener('abort', onAbort) }
}

// `return()` may be missing, may not return a promise, and may throw either way.
// Whatever it does, the error already on its way out is the one to keep.
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

// No `signal`: a synchronous pass runs to its end, and accepting one would leave
// the caller believing the count can be stopped.
export function estimateDistinctSync (estimator, source, options = {}) {
  const { keyFn = identity, signal } = options
  checkArguments(estimator, keyFn)
  if (signal !== undefined) {
    throw fail(TypeError, 'CVM_INVALID_OPTION',
      'estimateDistinctSync takes no signal: a synchronous pass runs to the end, use estimateDistinct for a source that can be stopped')
  }

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

  // Piped, never iterated: over a Readable that hands over one value per read,
  // `for await` piles up a nextTick callback for each until the heap runs out.
  // The signal goes to pipeline, not to the sink, so one mechanism covers an
  // abort whenever it fires.
  if (isReadable(source)) {
    await pipeline(source, createEstimatorSink(estimator, { keyFn }), { signal })
    return estimator.result()
  }

  if (source == null || typeof source[Symbol.asyncIterator] !== 'function') {
    throw fail(TypeError, 'CVM_INVALID_SOURCE',
      'source must be async-iterable or a Readable; for values already in memory use estimateDistinctSync')
  }

  // Only this path needs the check: pipeline covers the Readable one.
  if (signal?.aborted) throw abortError(signal)

  // Driven by hand, not with `for await`, so each `next()` is raced against the
  // signal: a source suspended on an await is the one anyone aborts.
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
    // Asked to close, not awaited: `return()` queues behind the `next()` still in
    // flight, so waiting would hand back the delay the abort just avoided.
    if (!exhausted) closeQuietly(iterator)
  }

  return estimator.result()
}
