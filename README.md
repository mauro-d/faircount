# faircount

[![CI](https://github.com/mauro-d/faircount/actions/workflows/ci.yml/badge.svg)](https://github.com/mauro-d/faircount/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/faircount)](https://www.npmjs.com/package/faircount)

Count the distinct values in a stream using only a small, fixed amount of memory.
The result is an **estimate**, and a *fair* one: unbiased, so it is right on
average, with proven bounds on how far off a single run may land and on how
often that can happen.

Counting every value exactly means remembering each one you see, so memory grows
with how many distinct values appear. This library keeps a bounded random sample
instead and extrapolates from it: memory stays flat whether the stream holds a
thousand distinct values or a billion. You choose how close the estimate should be
(`epsilon`) and how often it may miss that target (`delta`). See
[Key concepts](#key-concepts) for the guarantees.

This library is a faithful implementation of the CVM algorithm (Chakraborty,
Vinodchandran & Meel, [2022](https://arxiv.org/abs/2301.10191)), specifically the
total, unbiased variant by Karayel et al.
([ITP 2025](https://doi.org/10.4230/LIPIcs.ITP.2025.34)): it never fails, and the
estimate's expected value is exactly the true count.

## Install

```sh
npm install faircount
```

Requires Node 18 or newer. The library is published as ES modules only and has no
runtime dependencies. TypeScript types are included.

## Promise API — `estimateDistinct`

Accepts a sync iterable (`Array`, `Set`, …), an async iterable, or a `Readable`
you already have, and resolves to the result:

```js
import { estimateDistinct } from 'faircount'

const { estimate } = await estimateDistinct(values, {
  epsilon: 0.05,          // accuracy: within ±5% of the true count
  delta: 0.01,            // reliability: may land outside ±5% at most 1% of the time
  expectedSize: 1_000_000 // expected stream length; an upper bound is fine
})

console.log(`≈ ${estimate} distinct values`)
```

## Stream API — `DistinctEstimateStream`

A `Writable` sink in object mode (write one value per chunk), for composing
multiple stream stages via `pipeline()` (parsing, decompression, other
transforms feeding it). Read the result once it has finished:

```js
import { pipeline } from 'node:stream/promises'
import { DistinctEstimateStream } from 'faircount'

const counter = new DistinctEstimateStream({ epsilon: 0.05, expectedSize: 1_000_000 })
await pipeline(values, counter) // values: your source stream

console.log(counter.result()) // { estimate, samples, threshold, p }
```

In the default object mode, each write is one value of any type, taken as-is.
If your source is a byte stream of raw strings or Buffers, set
`objectMode: false` to feed it directly. Node then delivers each write as a
Buffer, and two Buffers with the same bytes are different objects, so duplicates
go undetected unless you decode them in `keyFn`:

```js
new DistinctEstimateStream({ objectMode: false, keyFn: (chunk) => chunk.toString() })
```

## Core engine — `CVM`

Drive the algorithm yourself, no I/O:

```js
import { CVM } from 'faircount'

const cvm = new CVM({ epsilon: 0.05, expectedSize: 1_000_000 })
for (const value of values) {
  cvm.add(value)
  console.log(cvm.distinct) // updates as values come in
}

console.log(cvm.result())  // estimate + internal state
```

`cvm.distinct` and `cvm.sampleCount` read the current estimate and the number of
values held at any point, without building a full result object; `cvm.result()`
bundles both (as `estimate` and `samples`) with `threshold` and `p`.

There's no `keyFn` here: pass `add()` whatever value you want counted.

## Counting by a key (`keyFn`)

Your source doesn't have to emit plain values directly. When it emits objects,
both `estimateDistinct` and `DistinctEstimateStream` accept a `keyFn` that maps
each item to the value whose distinctness you actually want to count. It must
return a **primitive** (typically a string or number): the engine dedups with a
`Set`, so objects/arrays would be compared by reference and never dedup.

```js
// distinct users
await estimateDistinct(orders, { keyFn: (o) => o.user })

// composite key
await estimateDistinct(orders, { keyFn: (o) => makeYourKey(o.user, o.product) })
```

You write `makeYourKey` yourself: combine whatever fields define distinctness
for your data (two, three, or more) into one primitive that never collides for
two genuinely different inputs. Naive concatenation and `JSON.stringify` both
have sharp edges (e.g. in a JSON array `null`, `undefined`, and `NaN` all
serialize to `null`). Test your own encoding against your actual data; don't
assume a known trick is automatically safe.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `epsilon` | `0.05` | How close the estimate should be, as a fraction: `0.05` = ±5%. Smaller is more accurate but uses more memory. |
| `delta` | `0.01` | How often a run may land outside ±`epsilon`: `0.01` = at most 1% of the time. |
| `expectedSize` | `0` | About how many items the stream has (an upper bound is fine). Optional, but omitting it triggers a warning. |
| `seed` | — | Integer seed for the built-in generator; set it for reproducible runs. Leave unset for fresh randomness each run. |
| `random` | `Math.random` | The randomness source: a function returning a float in `[0, 1)`. Overrides `seed`. |
| `keyFn` | identity | (Promise & Stream APIs) Maps each item to the value to count. |

## Result

```ts
{
  estimate: number,  // the estimated number of distinct values
  samples: number,   // how many values are held
  threshold: number, // the cap on samples
  p: number          // current sampling rate: estimate = samples / p
}
```

If the stream has fewer distinct values than `threshold`, nothing is ever dropped
and the result is exact. Otherwise it's an estimate: randomness inside the
algorithm makes it vary slightly between runs, unless you set a `seed`.

**Reproducible randomness.** `createRandom` is the generator factory behind
`seed`, exported separately so you can use the same kind of generator yourself:
pass a seed for a deterministic `[0, 1)` sequence, or call it with no arguments
to get `Math.random` itself.

```js
import { createRandom } from 'faircount'

const a = createRandom(42)
const b = createRandom(42)
a() === b() // true: same seed, same sequence

createRandom() === Math.random // true: no seed, the real thing
```

A seeded run is deterministic: with the same seed and the same data, every run
returns the same estimate. Keep the trade-off in mind: the `(ε, δ)` guarantee
describes the odds of a fresh draw, while a seeded run repeats one fixed draw.
Repeating it returns the same error instead of averaging it out.

## Errors

The algorithm never fails (it is total). Invalid options throw a `RangeError` or a
`TypeError` as soon as the estimator is created (in the Promise API the returned
promise rejects instead). Past that point, errors only come from your data source
or your `keyFn`, and travel on a single channel:

- **Promise API** — the promise rejects.
- **Stream API** — the `'error'` event fires, which also rejects `pipeline()` / `finished()`.

## Key concepts

The quantity being estimated is `F0`, the number of distinct values in a stream.

- **Bounded memory.** Instead of remembering every distinct value, the algorithm
  keeps a random sample capped at `n = ⌈(12/ε²)·ln(3m/δ)⌉` entries (rounded up
  to an even number; `O((1/ε²)·log(m/δ))` space), however many distinct values
  appear. `m` (`expectedSize`) enters only through a logarithm, so a rough upper
  bound is enough.
- **`(ε, δ)` guarantee.** With probability at least `1 − δ`, the estimate differs
  from `F0` by at most `ε·F0` (a relative error of at most `ε`). That bound is a
  formally proved worst case; in practice the estimate is usually much closer.
- **Total and unbiased.** The algorithm never fails (no `⊥`, the rare give-up
  outcome the original algorithm can return), and the expected value of its
  result is exactly `F0`: no systematic over- or under-counting.

**How much memory will this cost?** `computeThreshold(epsilon, delta, expectedSize)`
takes the same three parameters from [Options](#options) and returns that
capacity, a **count of values held**, so you can size a run before starting it:

```js
import { computeThreshold } from 'faircount'

computeThreshold(0.05, 0.01, 1_000_000)  // 93694 values held at most
computeThreshold(0.025, 0.01, 1_000_000) // 374772, about 4x: the threshold scales as 1/epsilon²
```

This is the same number you'd see as `threshold` in the `result()` of a `CVM`
constructed with the same parameters. What those entries weigh in bytes depends
on the values themselves (a number, a short string, a long composite key…), so
it can't be derived from the parameters alone: for end-to-end measurements, see
the [Benchmarks](#benchmarks) below.

## Benchmarks

These numbers come from real runs and are meant to give a feel for the
trade-off in practice. They don't prove the algorithm is correct: the paper
does that.

Memory and time as scale grows, with epsilon=0.05 and delta=0.01 fixed:

| Items processed | Distinct values | `Set` memory | faircount memory | `Set` time | faircount time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| 2M  | ~400K | ~30 MB  | ~5 MB  | <1 s | <1 s | 0.4% |
| 10M | ~2M   | ~160 MB | ~6 MB  | ~5 s | ~1.5 s | <0.1% |
| 50M | ~10M  | ~900 MB | ~10 MB | ~30 s | ~7 s | 0.1% |

Memory stays nearly flat as distinct values grow; an exact `Set` grows with
them.

`epsilon` trades accuracy for memory directly, holding scale fixed at the 10M
row above (~2 million distinct, delta=0.01):

| epsilon | faircount memory | Observed error |
| --- | --- | --- |
| 0.05 | ~6 MB   | <0.1% |
| 0.10 | ~1.7 MB | 0.5% |
| 0.20 | ~0.6 MB | 2.4% |

Memory and time vary by machine, Node version, and data shape. The observed
error also varies from run to run, since the estimator isn't seeded by
default. Run `npm run bench` to measure on your own setup; scenarios are
defined in `bench/scenarios.mjs`.

## References

- S. Chakraborty, N. V. Vinodchandran, K. S. Meel. *Distinct Elements in Streams:
  An Algorithm for the (Text) Book.* ESA 2022. [arXiv:2301.10191](https://arxiv.org/abs/2301.10191)
- E. Karayel, S. J. Watt, D. Khu, K. S. Meel, Y. K. Tan. *Verification of the CVM
  Algorithm with a Functional Probabilistic Invariant.* ITP 2025. [doi:10.4230/LIPIcs.ITP.2025.34](https://doi.org/10.4230/LIPIcs.ITP.2025.34). Its Algorithm 3 is the total, unbiased variant implemented here.

## License

ISC
