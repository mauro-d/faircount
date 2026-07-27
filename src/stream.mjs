import { Writable } from 'node:stream'
import { CVM, fail } from './cvm.mjs'

const identity = (x) => x

// Stream API: a Writable sink (object mode, one value per write) that estimates
// distinct values as you pipe into it. Read result() once it has finished. A
// keyFn error surfaces once, on the 'error' event.
export class DistinctEstimateStream extends Writable {
  constructor (options = {}) {
    const { keyFn = identity, ...rest } = options
    if (typeof keyFn !== 'function') throw fail(TypeError, 'CVM_INVALID_OPTION', 'keyFn must be a function')

    // Both take the whole set and ignore what they don't know: naming a couple
    // of options here would drop the rest in silence, `signal` included.
    super({ objectMode: true, ...rest })
    this._cvm = new CVM(rest)
    this._keyFn = keyFn
  }

  _write (chunk, _encoding, callback) {
    try {
      this._cvm.add(this._keyFn(chunk))
    } catch (err) {
      callback(err)
      return
    }
    callback()
  }

  result () {
    return this._cvm.result()
  }

  get distinct () {
    return this._cvm.distinct
  }

  get threshold () {
    return this._cvm.threshold
  }
}
