import { Readable, Writable } from 'node:stream'

/**
 * What a `keyFn` may return and what a snapshot may hold. A `Set` dedups these
 * by value, and JSON gives them back comparing equal. `bigint` and `symbol`
 * dedup too but cannot be saved; `undefined` would count every item that
 * produced it as the same value.
 */
type CountableValue = string | number | boolean | null

/**
 * The `code` on the errors this library raises about its own use, so a caller
 * can branch on it instead of matching messages. An aborted `signal` follows
 * Node instead, with `code: 'ABORT_ERR'`, and errors from a source or a `keyFn`
 * pass through untouched and keep their own.
 */
export type CVMErrorCode =
  /** An option is out of range or of the wrong type. */
  | 'CVM_INVALID_OPTION'
  /** `estimateDistinct` was handed something it cannot iterate. */
  | 'CVM_INVALID_SOURCE'
  /** A snapshot given to `fromJSON` contradicts itself. */
  | 'CVM_INVALID_SNAPSHOT'
  /** A held value would not survive `toJSON` unchanged. */
  | 'CVM_UNSERIALIZABLE_VALUE'

/** Parameters shared by the core, the stream, and `estimateDistinct`. */
export interface CVMOptions {
  /** How close the estimate should be, as a fraction (`0.05` = ±5%). Default `0.05`. */
  epsilon?: number
  /** How often a run may land outside ±`epsilon` (`0.01` = at most 1%). Default `0.01`. */
  delta?: number
  /**
   * Expected/upper-bound stream length `m` (logarithmic effect). Optional, but
   * omitting it sizes the threshold for a length-1 stream and emits a one-time
   * `CVM_NO_EXPECTED_SIZE` process warning.
   */
  expectedSize?: number
  /**
   * Integer seed for the built-in generator: with the same seed and data, the
   * estimate is identical on every run. The trade-off: repeated runs share one
   * fixed draw, so the error repeats instead of averaging out.
   */
  seed?: number
  /** Randomness source returning a float in `[0, 1)`. Defaults to `Math.random`; overrides `seed`. */
  random?: () => number
}

/** The estimate and the state it came from. */
export interface CVMResult {
  /** The estimated number of distinct values. */
  estimate: number
  /** How many values are held. */
  samples: number
  /** The maximum number of values the sample can hold. */
  threshold: number
  /** The current sampling rate: `estimate` equals `samples` / `p`. */
  p: number
}

/** Saved state of a `CVM`, as returned by {@link CVM.toJSON}. */
export interface CVMSnapshot {
  /** Format of this snapshot; only `1` is currently understood. */
  version: 1
  epsilon: number
  delta: number
  expectedSize: number
  /** The maximum number of values the sample can hold. */
  threshold: number
  /** The sampling rate reached when the snapshot was taken. */
  p: number
  /** The sampled values themselves, fewer than `threshold` of them. */
  values: CountableValue[]
}

export interface EstimateOptions extends CVMOptions {
  /**
   * Maps each item to the value to count: a string, number, boolean or `null`.
   * The estimator dedups with a `Set`, so an object or array would be compared
   * by reference and never dedup. A field that may be missing has to be given a
   * value of your choosing first, since `undefined` would count every item
   * lacking it as one and the same. Default: identity.
   */
  keyFn?: (item: any) => CountableValue
  /**
   * Stops the count: the promise rejects with an `AbortError` that has
   * `code: 'ABORT_ERR'`, and the signal's own reason as its `cause`. An array or
   * other synchronous source can only be stopped before it starts, since nothing
   * else runs until the loop finishes. You lose the partial estimate; the stream
   * API keeps it.
   */
  signal?: AbortSignal
}

export interface DistinctEstimateStreamOptions extends CVMOptions {
  /**
   * Maps each chunk to the value to count: a string, number, boolean or `null`.
   * The estimator dedups with a `Set`, so an object or array would be compared
   * by reference and never dedup. A field that may be missing has to be given a
   * value of your choosing first, since `undefined` would count every chunk
   * lacking it as one and the same. Default: identity.
   */
  keyFn?: (chunk: any) => CountableValue
  /**
   * Treats each write as one opaque value when `true` (the default, accepts any
   * type), or as bytes when `false`: a string, `Buffer`, `TypedArray` or
   * `DataView`, anything else throws. In `false` mode every chunk arrives as a
   * `Buffer`, which the default `keyFn` cannot dedup, so pass one that calls
   * `.toString()` on it.
   */
  objectMode?: boolean
  /**
   * Backpressure threshold, passed through to the underlying `Writable`.
   * Counts chunks when `objectMode` is `true`, or bytes when `false`; when
   * omitted, Node's own default for that mode applies.
   */
  highWaterMark?: number
  /**
   * Stops the count: the stream emits an `AbortError` that has
   * `code: 'ABORT_ERR'`, which also rejects `pipeline()`. Whatever was counted
   * before the stop stays readable through {@link DistinctEstimateStream.result}.
   */
  signal?: AbortSignal
}

/**
 * Total, unbiased CVM distinct-values (F0) estimator (Karayel et al., ITP 2025,
 * Algorithm 3; building on arXiv:2301.10191). Never fails, and `E[estimate]` is
 * exactly the true distinct count. Feed values with {@link CVM.add} and read
 * {@link CVM.result}. Values are deduped by `Set` equality, so an object counts
 * by reference.
 */
export class CVM {
  constructor(options?: CVMOptions)
  readonly epsilon: number
  readonly delta: number
  readonly expectedSize: number
  readonly threshold: number
  /** Records one occurrence of `value`. */
  add(value: unknown): this
  /** Records one occurrence of each value in `values`. */
  addMany(values: Iterable<unknown>): this
  /** The estimated number of distinct values. */
  get distinct(): number
  /** How many values are held. */
  get sampleCount(): number
  result(): CVMResult
  /**
   * The state to save, also used by `JSON.stringify`. Every held value must be a
   * string, a finite number, a boolean or `null`; `TypeError` otherwise.
   */
  toJSON(): CVMSnapshot
  /**
   * Rebuild an estimator from {@link CVM.toJSON}, ready to keep counting. The
   * snapshot carries the parameters, so it is the only argument. Counting
   * resumes with fresh randomness: a `seed` used before the snapshot does not
   * carry across it. Throws if the snapshot contradicts itself.
   */
  static fromJSON(snapshot: CVMSnapshot): CVM
  /** Clear samples and restart from `p = 1`, keeping parameters and RNG. */
  reset(): this
}

/**
 * A `Writable` sink that estimates distinct values written to it (object mode:
 * one value per write). Read {@link DistinctEstimateStream.result} once it has
 * finished. Errors surface once via the `'error'` event.
 */
export class DistinctEstimateStream extends Writable {
  constructor(options?: DistinctEstimateStreamOptions)
  result(): CVMResult
  /** The estimated number of distinct values. */
  get distinct(): number
  /** The maximum number of values the sample can hold. */
  get threshold(): number
}

/**
 * Estimate the number of distinct values in a source, returning a promise.
 * Accepts a sync iterable, an async iterable, or a Node `Readable`.
 */
export function estimateDistinct(
  source: Iterable<any> | AsyncIterable<any> | Readable,
  options?: EstimateOptions
): Promise<CVMResult>

/**
 * The maximum number of values that can be held: `⌈(12/ε²)·ln(3m/δ)⌉`, rounded
 * up to an even number. Throws `RangeError` on a parameter that is out of range
 * or not a number.
 */
export function computeThreshold(epsilon: number, delta: number, expectedSize: number): number

/** Create a uniform `[0, 1)` generator; with a `seed` it is deterministic. */
export function createRandom(seed?: number): () => number
