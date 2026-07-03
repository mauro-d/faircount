import { Readable, Writable } from 'node:stream'

/** The primitive types, which a `Set` dedups by value rather than by reference. */
type Primitive = string | number | bigint | boolean | symbol | null | undefined

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

/** Snapshot of the estimate and internal state. */
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

export interface EstimateOptions extends CVMOptions {
  /**
   * Maps each item to the value to count. Must return a primitive (typically a
   * string or number): the engine dedups with a `Set`, so objects or arrays
   * would be compared by reference and never dedup. Default: identity.
   */
  keyFn?: (item: any) => Primitive
}

export interface DistinctEstimateStreamOptions extends CVMOptions {
  /**
   * Maps each chunk to the value to count. Must return a primitive (typically a
   * string or number): the engine dedups with a `Set`, so objects or arrays
   * would be compared by reference and never dedup. Default: identity.
   */
  keyFn?: (chunk: any) => Primitive
  /**
   * Treats each write as one opaque value when `true` (the default, accepts
   * any type), or as bytes when `false`: a string, `Buffer`, `TypedArray`, or
   * `DataView` (anything else throws). In `false` mode, Node converts every
   * chunk to a `Buffer` before it arrives here, so the default `keyFn` won't
   * dedup matching content: provide a `keyFn` that calls `.toString()` on the
   * chunk. Either way, a raw byte stream still needs to be framed into values
   * upstream (e.g. by a line-splitting transform) before reaching this stream.
   */
  objectMode?: boolean
  /**
   * Backpressure threshold, passed through to the underlying `Writable`.
   * Counts chunks when `objectMode` is `true`, or bytes when `false`; when
   * omitted, Node's own default for that mode applies.
   */
  highWaterMark?: number
}

/**
 * Total, unbiased CVM distinct-values (F0) estimator (Karayel et al., ITP 2025,
 * Algorithm 3; building on arXiv:2301.10191). Never fails, and `E[estimate]` is
 * exactly the true distinct count. Feed values with {@link CVM.add} and read
 * {@link CVM.result}. Values must be usable as `Set` members.
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
 * up to an even number. Throws `RangeError` when a parameter is out of range.
 */
export function computeThreshold(epsilon: number, delta: number, expectedSize: number): number

/** Create a uniform `[0, 1)` generator; with a `seed` it is deterministic. */
export function createRandom(seed?: number): () => number
