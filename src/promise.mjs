import { pipeline } from 'node:stream/promises'
import { CVM } from './cvm.mjs'
import { DistinctEstimateStream } from './stream.mjs'

const identity = (x) => x

const isReadable = (source) =>
  source != null && typeof source.pipe === 'function' && typeof source.on === 'function'

// Promise API: estimate distinct values in any sync iterable, async iterable,
// or Readable. Readables go through the stream sink; other async sources use
// `for await` (which also destroys them on early exit); sync iterables avoid
// per-item await. The returned promise is the single error channel: it rejects
// on a source, keyFn, or invalid-options error (the algorithm itself never fails).
export async function estimateDistinct (source, options = {}) {
  const { keyFn = identity, ...cvmOptions } = options
  if (typeof keyFn !== 'function') throw new TypeError('keyFn must be a function')

  // Piped, never iterated: with a Readable that hands over one value per read,
  // `Readable.from` included, `for await` piles up a nextTick callback per value
  // until the heap runs out.
  if (isReadable(source)) {
    const sink = new DistinctEstimateStream({ ...cvmOptions, keyFn })
    await pipeline(source, sink)
    return sink.result()
  }

  const cvm = new CVM(cvmOptions)

  if (source != null && typeof source[Symbol.asyncIterator] === 'function') {
    for await (const chunk of source) cvm.add(keyFn(chunk))
  } else if (Array.isArray(source) && source[Symbol.iterator] === Array.prototype[Symbol.iterator]) {
    // Plain arrays skip the iterator protocol: measured consistently faster, as in addMany.
    for (let i = 0; i < source.length; i++) cvm.add(keyFn(source[i]))
  } else if (source != null && typeof source[Symbol.iterator] === 'function') {
    for (const chunk of source) cvm.add(keyFn(chunk))
  } else {
    throw new TypeError('source must be iterable, async-iterable, or a Readable stream')
  }

  return cvm.result()
}
