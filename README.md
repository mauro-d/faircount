# cvm-estimator

Count the distinct values in a stream using only a small, fixed amount of memory.
The result is an **estimate**, and you control how accurate it is.

Counting every value exactly means remembering each one you see, so memory grows
with how many distinct values appear. This library keeps a bounded random sample
instead and extrapolates from it: memory stays flat whether the stream holds a
thousand distinct values or a billion. You choose how close the estimate should be
(`epsilon`) and how often it may miss that target (`delta`). See
[Key concepts](#key-concepts) for the guarantees.

This library is a faithful implementation of the CVM algorithm (Chakraborty, Vinodchandran &
Meel, [2022](https://arxiv.org/abs/2301.10191)), specifically the total, unbiased
variant by Karayel et al. ([ITP 2025](https://doi.org/10.4230/LIPIcs.ITP.2025.34)):
it never fails, and its estimate is right on average.

## Install

```sh
npm install cvm-estimator
```

Requires Node 18 or newer. The library is published as ES modules only and has no
runtime dependencies. TypeScript types are included.

## Promise API — `estimateDistinct`

Accepts a single iterable (`Array`, `Set`, …), async iterable, or `Readable`
you already have, and resolves to the result:

```js
import { estimateDistinct } from 'cvm-estimator'

const values = ['apple', 'banana', 'apple', 'cherry', 'apple', 'pear']

const { estimate } = await estimateDistinct(values, {
  epsilon: 0.05,              // accuracy: within ±5% of the true count
  delta: 0.01,                // reliability: may land outside ±5% at most 1% of the time
  expectedSize: values.length // expected stream length; an upper bound is fine
})

console.log(`≈ ${estimate} distinct values`) // 4
```

Inputs this small are counted exactly; the result only becomes an estimate on
larger streams (see [Result](#result)).

## Stream API — `DistinctEstimateStream`

A `Writable` sink in object mode (write one value per chunk), for composing
multiple stream stages via `pipeline()` (parsing, decompression, other
transforms feeding it). Read the result once it has finished:

```js
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DistinctEstimateStream } from 'cvm-estimator'

const source = Readable.from(['apple', 'banana', 'apple', 'cherry'])
const counter = new DistinctEstimateStream({ epsilon: 0.05, expectedSize: 4 })
await pipeline(source, counter)

console.log(counter.result()) // { estimate, samples, threshold, p }
```

Counting distinct lines in a file:

```js
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const lines = createInterface({ input: createReadStream('access.log') })
await pipeline(lines, new DistinctEstimateStream({ expectedSize: 1e6 }))
```

By default the stream is in object mode: each write is one value of any type,
taken as-is. If your source is a byte stream of raw strings or Buffers, set
`objectMode: false` to feed it directly. Node then delivers each write as a
Buffer, and two Buffers with the same bytes are different objects, so duplicates
go undetected unless you decode them in `keyFn`:

```js
new DistinctEstimateStream({ objectMode: false, keyFn: (chunk) => chunk.toString() })
```

## Core engine — `CVM`

Drive the algorithm yourself, no I/O:

```js
import { CVM } from 'cvm-estimator'

const cvm = new CVM({ epsilon: 0.05, expectedSize: 1e6 })
for (const value of source) {
  cvm.add(value)
  console.log(cvm.distinct) // updates as values come in
}

console.log(cvm.result())  // estimate + internal state
```

There's no `keyFn` here: pass `add()` whatever value you want counted.

## Counting by a key (`keyFn`)

Your source doesn't have to emit plain values directly. When it emits objects,
both `estimateDistinct` and `DistinctEstimateStream` accept a `keyFn` that maps
each item to the value whose distinctness you actually want to count. It must
return a **primitive** (string/number): the engine dedups with a `Set`, so
objects/arrays would be compared by reference and never dedup.

```js
// distinct users
await estimateDistinct(orders, { keyFn: (o) => o.user })

// composite key: combine whatever fields define distinctness for you
await estimateDistinct(orders, { keyFn: (o) => makeYourKey(o.user, o.product) })
```

You write `makeYourKey` yourself: combine whatever fields define distinctness
for your data (two, three, or more) into one primitive that never collides for
two genuinely different inputs. Naive concatenation and `JSON.stringify` both
have sharp edges (e.g. `null`, `undefined`, and `NaN` all serialize the same
way). Test your own encoding against your actual data; don't assume a known
trick is automatically safe.

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
  threshold: number, // the maximum it can hold
  p: number          // current sampling rate: estimate = samples / p
}
```

If the stream has fewer distinct values than `threshold`, nothing is ever dropped
and the result is exact. Otherwise it's an estimate that varies slightly between
runs, because of randomness inside the algorithm.

**Reproducible randomness.** `createRandom` is the generator factory behind
`seed`, exported separately so you can use the same kind of generator yourself:
pass a seed for a deterministic `[0, 1)` sequence, or call it with no arguments
to get `Math.random` itself.

```js
import { createRandom } from 'cvm-estimator'

const a = createRandom(42)
const b = createRandom(42)
a() === b() // true: same seed, same sequence

createRandom() === Math.random // true: no seed, the real thing
```

## Errors

The algorithm never fails (it is total). Errors only come from your data source or
your `keyFn`, and travel on a single channel:

- **Promise API** — the promise rejects.
- **Stream API** — the `'error'` event fires, which also rejects `pipeline()` / `finished()`.

## Key concepts

The quantity being estimated is `F0`, the number of distinct values in a stream.

- **Bounded memory.** Instead of remembering every distinct value, the algorithm
  keeps a random sample capped at `n = ⌈(12/ε²)·ln(3m/δ)⌉` entries
  (`O((1/ε²)·log(m/δ))` space), however many distinct values appear. `m`
  (`expectedSize`) enters only through a logarithm, so a rough upper bound is enough.
- **`(ε, δ)` guarantee.** With probability at least `1 − δ`, the estimate is within
  `±ε` of `F0`. That bound is a formally proved worst case, so in practice the
  estimate is usually much closer than `ε`.
- **Total and unbiased.** The algorithm never fails (the rare `⊥` outcome some
  versions can return), and its average result over many runs is exactly `F0`,
  with no systematic over- or under-counting.

**How much memory will this cost?** `computeThreshold(epsilon, delta, expectedSize)`
takes the same three parameters from [Options](#options) and computes that
capacity directly, so you can check the cost before running anything:

```js
import { computeThreshold } from 'cvm-estimator'

computeThreshold(0.05, 0.01, 1_000_000)  // 93694
computeThreshold(0.025, 0.01, 1_000_000) // 374772, about 4x: the threshold scales as 1/epsilon²
```

This is the same number you'd see as `threshold` in a `CVM`'s `result()` after
actually running it on a stream of about that size.

## Benchmarks

These numbers come from real runs and are meant to give a feel for the
trade-off in practice. They don't prove the algorithm is correct: the paper
does that.

Memory and time at increasing scale (epsilon=0.05, delta=0.01 throughout):

| Items processed | Distinct values | `Set` memory | CVM memory | `Set` time | CVM time | Observed error |
| --- | --- | --- | --- | --- | --- | --- |
| 2M  | ~400K | ~30 MB  | ~5 MB  | <1 s | <1 s | 0.1% |
| 10M | ~2M   | ~160 MB | ~6 MB  | ~5 s | ~2 s | 0.7% |
| 50M | ~10M  | ~900 MB | ~10 MB | ~30 s | ~7 s | 0.5% |

Memory stays nearly flat as distinct values grow; an exact `Set` grows with
them.

`epsilon` trades accuracy for memory directly, holding scale fixed at the 10M
row above (~2 million distinct, delta=0.01):

| epsilon | CVM memory | Observed error |
| --- | --- | --- |
| 0.05 | ~6 MB   | 0.7% |
| 0.10 | ~1.7 MB | 0.3% |
| 0.20 | ~0.6 MB | 2.1% |

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
