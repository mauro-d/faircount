import { pipeline } from 'node:stream/promises'
import { CVM, fail } from './cvm.mjs'
import { DistinctEstimateStream } from './stream.mjs'

const identity = (x) => x

const isReadable = (source) =>
  source != null && typeof source.pipe === 'function' && typeof source.on === 'function'

// The shape Node's own promise APIs reject with, so one `err.code` covers every
// source kind. The signal's reason is kept as `cause` rather than replacing it.
function abortError (signal) {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

// Promise API. The returned promise is the single error channel.
export async function estimateDistinct (source, options = {}) {
  const { keyFn = identity, ...cvmOptions } = options
  if (typeof keyFn !== 'function') throw fail(TypeError, 'CVM_INVALID_OPTION', 'keyFn must be a function')

  // Piped, never iterated: with a Readable that hands over one value per read,
  // `Readable.from` included, `for await` piles up a nextTick callback per value
  // until the heap runs out.
  if (isReadable(source)) {
    const sink = new DistinctEstimateStream({ ...cvmOptions, keyFn })
    await pipeline(source, sink)
    return sink.result()
  }

  const { signal } = options
  if (signal != null && typeof signal.aborted !== 'boolean') {
    throw fail(TypeError, 'CVM_INVALID_OPTION', 'signal must be an AbortSignal')
  }
  if (signal?.aborted) throw abortError(signal)

  const cvm = new CVM(cvmOptions)

  if (source != null && typeof source[Symbol.asyncIterator] === 'function') {
    for await (const chunk of source) {
      // Only here: a synchronous loop below cannot be interrupted anyway.
      if (signal?.aborted) throw abortError(signal)
      cvm.add(keyFn(chunk))
    }
  } else if (Array.isArray(source) && source[Symbol.iterator] === Array.prototype[Symbol.iterator]) {
    // Fast path for plain arrays, as in addMany.
    for (let i = 0; i < source.length; i++) cvm.add(keyFn(source[i]))
  } else if (source != null && typeof source[Symbol.iterator] === 'function') {
    for (const chunk of source) cvm.add(keyFn(chunk))
  } else {
    throw fail(TypeError, 'CVM_INVALID_SOURCE', 'source must be iterable, async-iterable, or a Readable stream')
  }

  return cvm.result()
}
