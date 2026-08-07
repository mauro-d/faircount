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

**Whether it pays off depends on how many distinct values you expect**, and the
line is the sample's capacity, its *threshold*. Below it nothing is ever sampled
away: the sample holds every distinct value, so the count is exact and there is
nothing to save: a `Set` does the same job more simply. Above it the sample stops
growing while a `Set` keeps going.
`computeThreshold(epsilon, delta, expectedSize)` gives you that crossover for
your own parameters, before counting anything: with the defaults over a stream
of a million items it lands at 93 694 distinct values.

This library is a faithful implementation of the CVM algorithm (Chakraborty,
Vinodchandran & Meel, [2022](https://arxiv.org/abs/2301.10191)), specifically the
total, unbiased variant by Karayel et al.
([ITP 2025](https://doi.org/10.4230/LIPIcs.ITP.2025.34)): it never fails, and the
estimate's expected value is exactly the true count.

## Contents

- [Install](#install)
- [The estimator — `CVM`](#the-estimator--cvm)
- [Sync sources — `estimateDistinctSync`](#sync-sources--estimatedistinctsync)
- [Async sources — `estimateDistinct`](#async-sources--estimatedistinct)
- [Stream API — `createEstimatorSink`](#stream-api--createestimatorsink)
- [Cancelling](#cancelling)
- [Key concepts](#key-concepts)
- [Counting by a key (`keyFn`)](#counting-by-a-key-keyfn)
- [Result](#result)
- [Reproducible randomness](#reproducible-randomness)
- [Saving and resuming](#saving-and-resuming)
- [Errors](#errors)
- [Benchmarks](#benchmarks)
- [References](#references)
- [License](#license)

## Install

```sh
npm install faircount
```

Requires Node 20 or newer. The package is ESM-only, has no runtime dependencies,
and includes TypeScript types.

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
| `expectedSize` | required, ≥ 1 | About how many items the stream has. An upper bound is fine, and safe: it enters through a logarithm, so over-estimating a thousandfold costs about a third more memory and nothing in accuracy. |
| `epsilon` | `0.05` | How close the estimate should be, as a fraction: `0.05` = ±5%. Smaller is more accurate but uses more memory. |
| `delta` | `0.01` | How often a run may land outside ±`epsilon`: `0.01` = at most 1% of the time. |
| `seed` | — | Integer seed for the built-in generator; set it for [reproducible runs](#reproducible-randomness). Leave unset for fresh randomness each run. |
| `random` | `Math.random` | The randomness source: a function returning a float in `[0, 1)`. Overrides `seed`. |

`add()` takes the value itself: there's no `keyFn` at this level, you pass
whatever you want counted. `addMany()` takes an iterable of them. `distinct` and
`sampleCount` read the current estimate and the number of values held at any
point, without building a full result object; `result()` bundles both (as
`estimate` and `samples`) with `threshold` and `p`.

The estimator is yours to keep: it can be saved and resumed, carried across
several sources, and read at any moment. Every count you read covers everything
it has seen, not just the last source you handed it.

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

The pass is synchronous and runs to the end, so there is no `signal`: nothing
else can run while it does.

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

Hand the same estimator to a second call and the count carries on: the result
always covers everything that estimator has seen.

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

The sink carries it as `sink.estimator`, for code that receives the sink without
having built it.

The sink counts one value per write, so whatever decides where one value ends and
the next begins belongs upstream of it:

```js
import { createInterface } from 'node:readline'

const lines = createInterface({ input: createReadStream('access.log'), crlfDelay: Infinity })
await pipeline(lines, createEstimatorSink(estimator))
```

| Option | Default | Meaning |
| --- | --- | --- |
| `keyFn` | identity | Maps each chunk to the value to count. See [Counting by a key](#counting-by-a-key-keyfn). |
| `objectMode` | `true` | Counts each write as one value. With `false` a write must be a string or a Buffer, and arrives as a Buffer. |
| `highWaterMark` | Node's own | Passed to the underlying `Writable`. Counts values in object mode, bytes otherwise. |
| `signal` | — | An `AbortSignal` that stops the count. See [Cancelling](#cancelling). |

A Buffer won't dedup against an identical one, so with `objectMode: false` decode
it in `keyFn`:

```js
createEstimatorSink(estimator, { objectMode: false, keyFn: (chunk) => chunk.toString() })
```

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
  keeps a random sample capped at `n = ⌈(12/ε²)·ln(3m/δ)⌉` entries (rounded up
  to an even number; `O((1/ε²)·log(m/δ))` space), however many distinct values
  appear. `m` (`expectedSize`) enters only through a logarithm, so a rough upper
  bound is enough.
- **`(ε, δ)` guarantee.** With probability at least `1 − δ`, the estimate differs
  from `F0` by at most `ε·F0` (a relative error of at most `ε`). That bound is a
  formally proved worst case, and the errors measured in
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

**How much memory will this cost?** `computeThreshold(epsilon, delta, expectedSize)`
takes the same three parameters as [the estimator](#the-estimator--cvm) and returns that
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

## Counting by a key (`keyFn`)

All three counting functions accept a `keyFn` that maps each item to the value
whose distinctness you want counted. It must return a **string, number, boolean
or `null`**: the estimator dedups with a `Set`, so an object or an array would
never dedup, and those four are also the values a snapshot can carry.

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
inputs. Naive concatenation and `JSON.stringify` both have sharp edges (e.g. in
a JSON array `null`, `undefined`, and `NaN` all serialize to `null`), so test
your encoding against your actual data.

## Result

```ts
{
  estimate: number,  // the estimated number of distinct values
  samples: number,   // how many values are held
  threshold: number, // the cap on samples
  p: number          // current sampling rate: estimate = samples / p
}
```

`estimate` is the answer; the other three say how it was reached, and you can
ignore them until you need to know. If the stream has fewer distinct values than
`threshold`, nothing is ever dropped, `p` stays at 1 and the count is exact.
Otherwise it's an estimate: randomness inside the algorithm makes it vary
slightly between runs, unless you set a `seed`.

## Reproducible randomness

By default the estimator draws fresh randomness on each run, so repeated runs
over the same input give slightly different estimates, spread around the true
count. Set a `seed` when you want a run to be repeatable instead: the same seed,
the same parameters and the same values in the same order always produce the
same estimate. The trade-off is that the `(ε, δ)` guarantee describes the odds
of a fresh draw, while a seeded run repeats one fixed draw. Repeating it returns
the same error instead of averaging it out.

That determinism ends at a snapshot. An estimator rebuilt with `fromJSON`
resumes with fresh randomness whether or not the original was seeded, so a
resumed count is not a replay of the one you saved (see
[Saving and resuming](#saving-and-resuming)).

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

The other three count into that same estimator, so they save the same way:

```js
estimateDistinctSync(estimator, firstBatch)
await estimateDistinct(estimator, rows(), { keyFn: (r) => r.userId })
await pipeline(nextBatch, createEstimatorSink(estimator))
await writeFile('checkpoint.json', JSON.stringify(estimator))
```

Replaying values the estimator has already counted doesn't bias the result: the
estimate is unbiased for any stream, and repeats don't change how many distinct
values a stream holds. You won't get the same number as before, but it is drawn
around the same count. Values it never sees are a real loss, because the estimate
is then unbiased for the part it saw rather than for the whole. So after a
restart, overlapping is safer than leaving a gap.

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

The algorithm never fails (it is total), so counting itself never throws.
Invalid options throw a `RangeError` or a `TypeError` when the estimator is
created (`estimateDistinct` rejects instead, being async), and so do `toJSON` on
a value JSON would alter and `fromJSON` on a snapshot whose parts don't agree.
Each of those carries a `code`, so you can branch on it rather than on the
message:

| `code` | Raised when |
| --- | --- |
| `CVM_INVALID_OPTION` | an option is out of range or of the wrong type, or the estimator handed to a function is not a `CVM` |
| `CVM_INVALID_SOURCE` | a source went to the wrong function, or is not iterable at all |
| `CVM_INVALID_SNAPSHOT` | a snapshot given to `fromJSON` contradicts itself |
| `CVM_UNSERIALIZABLE_VALUE` | `toJSON` holds a value JSON would alter |

While counting, errors only come from your data source or your `keyFn`, and each
travels on a single channel, the one that matches how you called it:
`estimateDistinctSync` throws, `estimateDistinct` rejects, and a sink emits
`'error'`, which also rejects `pipeline()` and `finished()`.

## Benchmarks

These numbers come from real runs and give a feel for the trade-off. They don't
prove the algorithm is correct: the paper does that.

Memory and time as scale grows, with epsilon=0.05 and delta=0.01 fixed:

| Items processed | Distinct values | `Set` memory | faircount memory | `Set` time | faircount time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| 2M  | ~400K | ~30 MB  | ~5 MB  | <1 s | <1 s | 0.4% |
| 10M | ~2M   | ~160 MB | ~6 MB  | ~5 s | ~1.5 s | 0.2% |
| 50M | ~10M  | ~900 MB | ~7 MB  | ~30 s | ~7 s | 0.2% |

Memory stays nearly flat as distinct values grow; an exact `Set` grows with
them.

`epsilon` trades accuracy for memory directly, holding scale fixed at the 10M
row above (~2 million distinct, delta=0.01):

| epsilon | faircount memory | Observed error |
| --- | --- | --- |
| 0.05 | ~6 MB   | 0.2% |
| 0.10 | ~1.7 MB | 0.7% |
| 0.20 | ~0.6 MB | 1.1% |

Scale and epsilon aren't the whole story: the shape of the stream matters too.
Same scale (10M items, epsilon=0.05), three shapes:

| Stream shape | Distinct values | `Set` memory | faircount memory | `Set` time | faircount time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| uniform | ~2M | ~160 MB | ~6 MB | ~5 s | ~1.5 s | 0.2% |
| zipf-like (skewed) | ~1.1M | ~105 MB | ~6.6 MB | ~3 s | ~6.5 s | 0.2% |
| uniform, below threshold | ~50K | ~4 MB | ~4 MB | ~1.7 s | ~1.8 s | 0% (exact) |

On skewed streams the exact `Set` is faster (it only ever inserts, while the
estimator also deletes), but uses 16x the memory. Below the threshold nothing
is ever sampled away: the result is exact, the sample holds every distinct
value, and memory sits at parity with a plain `Set`. The estimator pays off
above the threshold.

Each observed error is the median of five runs. Single runs vary a lot: at
epsilon 0.20 the five ranged from 0.4% to 3.0%, enough for one draw to put a
larger epsilon ahead of a smaller one. Memory and time vary by machine, Node
version, and data shape. Run `npm run bench` to measure on your own setup, which
prints the median and the range; scenarios are defined in `bench/scenarios.mjs`.

## References

- S. Chakraborty, N. V. Vinodchandran, K. S. Meel. *Distinct Elements in Streams:
  An Algorithm for the (Text) Book.* ESA 2022. [arXiv:2301.10191](https://arxiv.org/abs/2301.10191)
- E. Karayel, S. J. Watt, D. Khu, K. S. Meel, Y. K. Tan. *Verification of the CVM
  Algorithm with a Functional Probabilistic Invariant.* ITP 2025. [doi:10.4230/LIPIcs.ITP.2025.34](https://doi.org/10.4230/LIPIcs.ITP.2025.34). Its Algorithm 3 is the total, unbiased variant implemented here.

## License

ISC
