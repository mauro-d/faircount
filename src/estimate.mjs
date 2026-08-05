import { pipeline } from 'node:stream/promises'
import { CVM, fail } from './cvm.mjs'
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

function checkArguments (estimator, keyFn) {
  if (!(estimator instanceof CVM)) {
    throw fail(TypeError, 'CVM_INVALID_OPTION', 'estimator must be a CVM instance')
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

  for await (const item of source) {
    if (signal?.aborted) throw abortError(signal)
    estimator.add(keyFn(item))
  }

  return estimator.result()
}
