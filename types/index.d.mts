import { Writable } from 'node:stream'

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
  /** Integer seed for the built-in generator; set it for reproducible runs. */
  seed?: number
  /** Randomness source returning a float in `[0, 1)`. Defaults to `Math.random`; overrides `seed`. */
  random?: () => number
}

/** Snapshot of the estimate and internal state. */
export interface CVMResult {
  /** The estimated number of distinct values. */
  estimate: number
  /** How many elements are held. */
  samples: number
  /** The maximum it can hold. */
  threshold: number
  /** The current sampling rate: `estimate` equals `samples` / `p`. */
  p: number
}

export interface EstimateOptions extends CVMOptions {
  /**
   * Maps each item to the value to count. Must return a primitive (string or
   * number): the engine dedups with a `Set`, so objects or arrays would be
   * compared by reference and never dedup. Default: identity.
   */
  keyFn?: (chunk: any) => unknown
}

export interface DistinctEstimateStreamOptions extends CVMOptions {
  /**
   * Maps each chunk to the value to count. Must return a primitive (string or
   * number): the engine dedups with a `Set`, so objects or arrays would be
   * compared by reference and never dedup. Default: identity.
   */
  keyFn?: (chunk: any) => unknown
  objectMode?: boolean
  highWaterMark?: number
}

/**
 * Total, unbiased CVM distinct-elements (F0) estimator (Karayel et al., ITP 2025,
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
  /** Records one occurrence of `element`. */
  add(element: unknown): this
  /** Records one occurrence of each value in `elements`. */
  addMany(elements: Iterable<unknown>): this
  /** The estimated number of distinct values. */
  get distinct(): number
  /** How many elements are held. */
  get sampleCount(): number
  result(): CVMResult
  /** Clear samples and restart from `p = 1`, keeping parameters and RNG. */
  reset(): this
}

/**
 * A `Writable` sink that estimates distinct elements written to it (object mode:
 * one element per write). Read {@link DistinctEstimateStream.result} once it has
 * finished. Errors surface once via the `'error'` event.
 */
export class DistinctEstimateStream extends Writable {
  constructor(options?: DistinctEstimateStreamOptions)
  result(): CVMResult
  /** The estimated number of distinct values. */
  get distinct(): number
  /** The maximum it can hold. */
  get threshold(): number
}

/**
 * Estimate the number of distinct elements in a source, returning a promise.
 * Accepts a sync iterable, an async iterable, or a Node `Readable`.
 */
export function estimateDistinct(
  source: Iterable<any> | AsyncIterable<any>,
  options?: EstimateOptions
): Promise<CVMResult>

/** The maximum number of elements that can be held: `⌈(12/ε²)·ln(3m/δ)⌉`, rounded up to an even number. */
export function computeThreshold(epsilon: number, delta: number, expectedSize: number): number

/** Create a uniform `[0, 1)` generator; with a `seed` it is deterministic. */
export function createRandom(seed?: number): () => number
