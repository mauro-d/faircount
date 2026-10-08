# faircount

[![CI](https://github.com/mauro-d/faircount/actions/workflows/ci.yml/badge.svg)](https://github.com/mauro-d/faircount/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/faircount)](https://www.npmjs.com/package/faircount)

Count the distinct values in a stream using only a small, bounded amount of
memory. The result is an **estimate**, and a *fair* one: unbiased, so it is right
on average, with proven bounds on how far off a single run may land and on how
often that can happen.

Counting every value exactly means remembering each one you see, so memory grows
with how many distinct values appear. This library keeps a bounded random sample
instead and extrapolates from it: the sample never grows past a capacity you fix
in advance, whether the stream holds a thousand distinct values or a billion. You
choose how close the estimate should be (`epsilon`) and how often it may miss
that target (`delta`).

**Whether it pays off depends on how many distinct values you expect.** The line
is the sample's capacity, its *threshold*. Below it nothing is sampled away, so
the count is exact and a `Set` does the same job more simply; above it the sample
stops growing while a `Set` keeps going. The threshold depends only on the
parameters, not on what the stream contains: with `epsilon` 0.05, `delta` 0.01
and an expected length of a million items it is 93 694 values.
`computeThreshold(epsilon, delta, expectedSize)` gives it for your own
parameters, before you count anything.

This library implements the CVM algorithm (Chakraborty, Vinodchandran & Meel,
[2022](https://arxiv.org/abs/2301.10191)) in the variant by Karayel et al.
([ITP 2025](https://doi.org/10.4230/LIPIcs.ITP.2025.34)) that never fails and is
unbiased: the estimate's expected value is exactly the true count. Unbiasedness
and the `(ε, δ)` bound are both machine-checked theorems in Isabelle/HOL.

## Contents

- [Install](#install)
- [The estimator — `CVM`](#the-estimator--cvm)
- [Sync sources — `estimateDistinctSync`](#sync-sources--estimatedistinctsync)
- [Async sources — `estimateDistinct`](#async-sources--estimatedistinct)
- [Stream API — `createEstimatorSink`](#stream-api--createestimatorsink)
- [Cancelling](#cancelling)
- [Key concepts](#key-concepts)
- [faircount and HyperLogLog](#faircount-and-hyperloglog)
- [Counting by a key (`keyFn`)](#counting-by-a-key-keyfn)
- [Result](#result)
- [Reproducible randomness](#reproducible-randomness)
- [Saving and resuming](#saving-and-resuming)
- [Errors](#errors)
- [Benchmarks](#benchmarks)
- [References](#references)
- [How it was built](#how-it-was-built)
- [License](#license)

## Install

```sh
npm install faircount
```

Requires Node 20.19+ or 22.12+. The package is ESM-only, has no runtime
dependencies, and includes TypeScript types. On those versions a CommonJS
project can `require()` it as well.

## The estimator — `CVM`

```ts
new CVM(options: CVMOptions)
```

Everything starts with an estimator. It holds the parameters, the sample and the
count, and you feed it values:

```js
import { CVM } from 'faircount'

const estimator = new CVM({
  expectedSize: 1_000_000, // how many items you expect; an upper bound is fine
  epsilon: 0.05,           // accuracy: within ±5% of the true count
  delta: 0.01              // reliability: may land outside ±5% at most 1% of the time
})

for (const value of values) estimator.add(value)

console.log(`≈ ${estimator.distinct} distinct values`)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `expectedSize` | required, ≥ 1 | How many items the estimator will see in total, duplicates included. An upper bound is fine: it enters through a logarithm, so declaring a billion instead of a million costs about a third more memory and nothing in accuracy. |
| `epsilon` | `0.05` | How close the estimate should be, as a fraction: `0.05` = ±5%. Smaller is more accurate but uses more memory. |
| `delta` | `0.01` | How often a run may land outside ±`epsilon`: `0.01` = at most 1% of the time. |
| `seed` | — | Integer seed for the built-in generator; set it for [reproducible runs](#reproducible-randomness). Leave unset for fresh randomness each run. |
| `random` | `Math.random` | The randomness source: a function returning a float in `[0, 1)`. Overrides `seed`. |

`add()` takes the value itself: there's no `keyFn` at this level, you pass
whatever you want counted. `addMany()` takes an iterable of those values, an
array, a `Set`, a generator. `distinct` and `sampleCount` read the current
estimate and the number of values held at any point, without building a full
result object; `result()` bundles both (as `estimate` and `samples`) with
`threshold` and `p`.

The estimator is yours to keep: it can be saved and resumed, carried across
several sources, and read at any moment. Every count you read covers everything
it has seen, not just the last source you handed it. What it can't do is merge:
two estimators, or two snapshots, never combine into a single count.

The three functions below don't replace the estimator, they feed it.

## Sync sources — `estimateDistinctSync`

```ts
estimateDistinctSync(estimator: CVM, source: Iterable<any>, options?: EstimateSyncOptions): CVMResult
```

Counts an iterable you already hold and returns the result:

```js
import { CVM, estimateDistinctSync } from 'faircount'

const estimator = new CVM({ epsilon: 0.05, expectedSize: orders.length })
const { estimate } = estimateDistinctSync(estimator, orders, { keyFn: (o) => o.user })

console.log(`≈ ${estimate} distinct users`)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `keyFn` | identity | Maps each item to the value to count. See [Counting by a key](#counting-by-a-key-keyfn). |

`estimator.addMany(values)` does the same for values already in the shape you
want counted. `estimateDistinctSync` adds the `keyFn`, so the mapping happens as
the values are read.

The pass is synchronous and runs to the end, so there is no `signal`.

## Async sources — `estimateDistinct`

```ts
estimateDistinct(estimator: CVM, source: AsyncIterable<any> | Readable, options?: EstimateOptions): Promise<CVMResult>
```

Counts a source that arrives over time and resolves to the result. It takes an
async iterable or a `Readable`:

```js
import { CVM, estimateDistinct } from 'faircount'

const estimator = new CVM({ epsilon: 0.05, expectedSize: 1_000_000 })

async function * rows () { /* yield one row at a time */ }
const { estimate } = await estimateDistinct(estimator, rows(), { keyFn: (r) => r.userId })
```

| Option | Default | Meaning |
| --- | --- | --- |
| `keyFn` | identity | Maps each item to the value to count. See [Counting by a key](#counting-by-a-key-keyfn). |
| `signal` | — | An `AbortSignal` that stops the count. See [Cancelling](#cancelling). |

Hand the same estimator to a second call and the count carries on.

## Stream API — `createEstimatorSink`

```ts
createEstimatorSink(estimator: CVM, options?: EstimatorSinkOptions): EstimatorSink
```

A `Writable` sink you pipe into. The count is read from the estimator, once the
pipe has finished:

```js
import { pipeline } from 'node:stream/promises'
import { CVM, createEstimatorSink } from 'faircount'

const estimator = new CVM({ epsilon: 0.05, expectedSize: 1_000_000 })
await pipeline(values, createEstimatorSink(estimator)) // values: your source stream

console.log(estimator.result()) // { estimate, samples, threshold, p }
```

The sink exposes the estimator as `sink.estimator`.

The sink counts one value per write, so whatever decides where one value ends and
the next begins belongs upstream of it:

```js
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const lines = createInterface({ input: createReadStream('access.log'), crlfDelay: Infinity })
await pipeline(lines, createEstimatorSink(estimator))
```

| Option | Default | Meaning |
| --- | --- | --- |
| `keyFn` | identity | Maps each chunk to the value to count. See [Counting by a key](#counting-by-a-key-keyfn). |
| `objectMode` | `true` | Counts each write as one value. With `false` a write must be a string or bytes and arrives as a Buffer, so without a `keyFn` that decodes it every chunk counts as a new value. |
| `highWaterMark` | Node's own | Passed to the underlying `Writable`. Counts values in object mode, bytes otherwise. |
| `signal` | — | An `AbortSignal` that stops the count. See [Cancelling](#cancelling). |

## Cancelling

`estimateDistinct` and `createEstimatorSink` take a `signal`, and fail on abort
the way the rest of Node does: an `AbortError` with `code: 'ABORT_ERR'`, and the
signal's own reason as its `cause`.

```js
await estimateDistinct(estimator, rows(), { signal: AbortSignal.timeout(50) })
```

Whatever was counted before the stop stays in your estimator, so a cancelled run
can still be read, or saved and resumed.

## Key concepts

The quantity being estimated is `F0`, the number of distinct values in a stream.

- **Bounded memory.** Instead of remembering every distinct value, the algorithm
  keeps a random sample capped at `n = ⌈(12/ε²)·ln(3m/δ)⌉` entries, rounded up to
  an even number, however many distinct values appear. `m` is `expectedSize`, and
  since it enters only through a logarithm a rough upper bound is enough.
- **`(ε, δ)` guarantee.** As long as the stream is no longer than `expectedSize`,
  the estimate is within `ε·F0` of `F0` with probability at least `1 − δ`. The
  bound is a proved worst case, and the errors measured in
  [Benchmarks](#benchmarks) sit well inside it.
- **Total and unbiased.** The algorithm never fails (no `⊥`, the rare give-up
  outcome the original algorithm can return), and the expected value of its
  result is exactly `F0`: no systematic over- or under-counting.

**What if the stream turns out longer than `expectedSize`?** Nothing breaks and
nothing warns you: the estimate stays unbiased, and only the `±epsilon` bound
loosens, with the square root of a logarithm. Declaring a million items and
receiving a billion, a thousandfold overshoot, moves the real epsilon from 0.0500
to 0.0582.
That is why over-estimating is the safe direction, and why `expectedSize` counts
the whole life of an estimator, across every source and every resumed session,
not one run.

**How much memory will this cost?** `computeThreshold(epsilon, delta,
expectedSize)` takes the same three parameters as [the
estimator](#the-estimator--cvm) and returns that capacity, a **count of values
held**, so you can size a run before starting it:

```js
import { computeThreshold } from 'faircount'

computeThreshold(0.05, 0.01, 1_000_000)  // 93694 values held at most
computeThreshold(0.025, 0.01, 1_000_000) // 374772, about 4x: the threshold scales as 1/epsilon²
```

This is the same number you'd see as `threshold` in the `result()` of a `CVM`
constructed with the same parameters. What those entries weigh in bytes depends
on the values themselves, so it can't be derived from the parameters alone: a
held value costs around 60 bytes as a short id and around 190 as a long
composite key, so those 93 694 entries take about 5 MB in one case and about 17
in the other. For end-to-end measurements, see the [Benchmarks](#benchmarks).

## faircount and HyperLogLog

Both count distinct values in bounded memory, and they give up different things
to do it.

- **What is kept.** faircount keeps a sample of the values themselves, so its
  memory is a number of values, and what that weighs depends on what you count.
  HyperLogLog keeps registers of hashed values: the same bytes whether the values
  are short ids or long composite keys.
- **Combining counts.** Two HyperLogLog sketches merge into a sketch of their
  union, so machines that counted separately can have their results put together
  afterwards. Two faircount estimators cannot.
- **The estimate.** faircount's is unbiased: its expected value is exactly `F0`.
  HyperLogLog's is biased, and implementations correct for it.
- **Hashing.** faircount compares values with `Set` equality, so there is no hash
  function to choose and no collisions to account for. HyperLogLog's accuracy
  rests on its hash.
- **Reading the state.** faircount's sample holds real values, which you can read
  and save. A HyperLogLog sketch holds none.

## Counting by a key (`keyFn`)

`estimateDistinctSync`, `estimateDistinct` and `createEstimatorSink` accept a
`keyFn` that maps each item to the value whose distinctness you want counted. It
must return a **string, number, boolean or `null`**, the values a `Set` compares
by value and a snapshot can save. The estimator itself takes no `keyFn`: `add()`
counts what you hand it.

Watch out for fields that may be missing. `keyFn: (o) => o.user` returns
`undefined` for every record without a user, and the estimator counts all of
them as a single distinct value, with nothing to warn you. Give those records a
value instead: `o.user ?? 'anonymous'` groups them together, `o.user ?? o.id`
keeps them apart.

```js
// distinct users
estimateDistinctSync(estimator, orders, { keyFn: (o) => o.user })

// composite key
estimateDistinctSync(estimator, orders, { keyFn: (o) => makeYourKey(o.user, o.product) })
```

You write `makeYourKey` yourself: combine whatever fields define distinctness
for your data into one value that never collides for two genuinely different
inputs. Naive concatenation and `JSON.stringify` can both map different inputs
to the same value: in a JSON array, `null`, `undefined`, and `NaN` all serialize
to `null`.

## Result

- `estimate`: the estimated number of distinct values the estimator has seen.
- `samples`: how many values the sample holds right now.
- `threshold`: the most values the sample can hold, fixed by the parameters.
- `p`: the sampling rate, with `estimate = samples / p`. While it is 1 nothing
  has been sampled away, and the estimate is the exact count.

## Reproducible randomness

By default the estimator draws fresh randomness on each run, so repeated runs
over the same input give different estimates, spread around the true count. Set
a `seed` when you want a run to be repeatable instead: the same seed, the same
parameters and the same values in the same order always produce the same
estimate. The trade-off is that the `(ε, δ)` guarantee describes the odds of a
fresh draw, while a seeded run repeats one fixed draw. Repeating it returns the
same error instead of averaging it out.

That determinism ends at a snapshot: see [Saving and resuming](#saving-and-resuming).

`createRandom` is the generator factory behind `seed`, exported separately so
you can use the same kind of generator yourself: pass a seed for a deterministic
`[0, 1)` sequence, or call it with no arguments to get `Math.random` itself.

```js
import { createRandom } from 'faircount'

const a = createRandom(42)
const b = createRandom(42)
a() === b() // true: same seed, same sequence

createRandom() === Math.random // true: no seed, the real thing
```

## Saving and resuming

A `CVM` can hand over its state as a plain object and be rebuilt from it later,
so a long count survives a restart:

```js
import { writeFile, readFile } from 'node:fs/promises'
import { CVM } from 'faircount'

const estimator = new CVM({ epsilon: 0.05, expectedSize: 1_000_000 })
estimator.addMany(firstBatch)
await writeFile('checkpoint.json', JSON.stringify(estimator)) // calls toJSON()

// later, in another process
const resumed = CVM.fromJSON(JSON.parse(await readFile('checkpoint.json', 'utf8')))
resumed.addMany(nextBatch)
console.log(resumed.result())
```

The snapshot carries the parameters along with the sampled values, so `fromJSON`
takes nothing else. Its size is bounded by `threshold`, the same bound that keeps
the sample from growing, and `fromJSON` rejects a snapshot whose parts don't agree.

It makes no difference which function fed the estimator: `estimateDistinctSync`,
`estimateDistinct` and `createEstimatorSink` all count into it, so
`JSON.stringify(estimator)` saves what they counted.

Replaying values the estimator has already counted doesn't bias the result: the
estimate is unbiased for any stream, and repeats don't change how many distinct
values a stream holds. You won't get the same number as before, but it is drawn
around the same count. Values it never sees are a real loss, because the estimate
is then unbiased for the part it saw rather than for the whole.

Two things to know:

- Values have to come back from JSON unchanged, or a value arriving after the
  restore would no longer match its own earlier copy. `toJSON()` accepts
  strings, finite numbers, booleans and `null`, and throws on anything else
  (`bigint`, `symbol`, `NaN`, objects).
- Counting resumes with fresh randomness. A `seed` set before the snapshot does
  not carry across it, so a resumed run is not a replay of the original. The
  estimate stays unbiased either way; the `±epsilon` bound holds as long as
  `expectedSize` still covers the total.

## Errors

Counting itself never fails: the algorithm has no failure path. The errors the
library raises all carry a `code`:

| `code` | Raised when |
| --- | --- |
| `CVM_INVALID_OPTION` | an option is out of range or of the wrong type, or the estimator handed to a function is not a `CVM` |
| `CVM_INVALID_SOURCE` | a source went to the wrong function, or is not iterable at all |
| `CVM_INVALID_SNAPSHOT` | a snapshot given to `fromJSON` contradicts itself |
| `CVM_UNSERIALIZABLE_VALUE` | `toJSON` holds a value JSON would alter |

An error from your data source or your `keyFn` reaches you unchanged, and only
once.

## Benchmarks

These numbers come from real runs and give a feel for the trade-off. They don't
prove the algorithm is correct: the paper does that.

Memory and time as scale grows, with epsilon=0.05 and delta=0.01 fixed:

| Items processed | Distinct values | `Set` memory | faircount memory | `Set` time | faircount time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| 2M | ~400K | ~30 MB | ~5 MB | <1 s | <1 s | 0.4% |
| 10M | ~2M | ~160 MB | ~6 MB | ~5 s | ~1.5 s | 0.2% |
| 50M | ~10M | ~900 MB | ~7 MB | ~30 s | ~7 s | 0.2% |

Memory stays nearly flat as distinct values grow; an exact `Set` grows with
them.

`epsilon` trades accuracy for memory directly, holding scale fixed at the 10M
row above (~2 million distinct, delta=0.01):

| epsilon | faircount memory | Observed error |
| --- | --- | --- |
| 0.05 | ~6 MB | 0.2% |
| 0.10 | ~1.7 MB | 0.7% |
| 0.20 | ~0.6 MB | 1.1% |

Scale and epsilon aren't the whole story: the shape of the stream matters too.
Same scale (10M items, epsilon=0.05), three shapes:

| Stream shape | Distinct values | `Set` memory | faircount memory | `Set` time | faircount time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| uniform | ~2M | ~160 MB | ~6 MB | ~5 s | ~1.5 s | 0.2% |
| zipf-like (skewed) | ~1.1M | ~105 MB | ~6.6 MB | ~3 s | ~6.5 s | 0.2% |
| uniform, below threshold | ~50K | ~4 MB | ~4 MB | ~1.7 s | ~1.8 s | 0% (exact) |

Each observed error is the median of five runs; at epsilon 0.20 the five ranged
from 0.4% to 3.0%. Memory and time vary by machine, Node
version, and data shape. From a clone of the repository, `npm run bench`
measures your own setup and prints the median and the range; the scenarios are
in `bench/scenarios.mjs`.

## References

- S. Chakraborty, N. V. Vinodchandran, K. S. Meel. *Distinct Elements in Streams:
  An Algorithm for the (Text) Book.* ESA 2022. [arXiv:2301.10191](https://arxiv.org/abs/2301.10191)
- E. Karayel, S. J. Watt, D. Khu, K. S. Meel, Y. K. Tan. *Verification of the CVM
  Algorithm with a Functional Probabilistic Invariant.* ITP 2025.
  [doi:10.4230/LIPIcs.ITP.2025.34](https://doi.org/10.4230/LIPIcs.ITP.2025.34).
  Its Algorithm 3 is the total, unbiased variant implemented here.

## How it was built

Designed, written, and reviewed by me and Claude Code.

## License

ISC
