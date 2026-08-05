import { Writable } from 'node:stream'
import { CVM, fail } from './cvm.mjs'

const identity = (x) => x

// A Writable sink (object mode, one value per write). The caller owns the
// estimator it feeds, and reads the count from there.
class EstimatorSink extends Writable {
  #estimator
  #keyFn

  constructor (estimator, options = {}) {
    if (!(estimator instanceof CVM)) {
      throw fail(TypeError, 'CVM_INVALID_OPTION', 'estimator must be a CVM instance')
    }
    const { keyFn = identity, ...rest } = options
    if (typeof keyFn !== 'function') throw fail(TypeError, 'CVM_INVALID_OPTION', 'keyFn must be a function')

    super({ objectMode: true, ...rest })
    this.#estimator = estimator
    this.#keyFn = keyFn
  }

  get estimator () {
    return this.#estimator
  }

  _write (chunk, _encoding, callback) {
    try {
      this.#estimator.add(this.#keyFn(chunk))
    } catch (err) {
      callback(err)
      return
    }
    callback()
  }
}

export function createEstimatorSink (estimator, options) {
  return new EstimatorSink(estimator, options)
}
