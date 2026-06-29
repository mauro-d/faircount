# cvm-estimator

Count the distinct values in a stream using only a small, fixed amount of memory.
The result is an estimate, and you control how accurate it is.

Counting them exactly means remembering every value you see, so memory grows with
the number of distinct values. This library keeps a bounded random sample instead
and extrapolates from it: memory stays flat whether the stream holds a thousand
distinct values or a billion. You choose how close the estimate should be
(`epsilon`) and how often it may miss that target (`delta`).

It's a faithful implementation of the CVM algorithm (Chakraborty, Vinodchandran &
Meel, [2022](https://arxiv.org/abs/2301.10191)), specifically the total, unbiased
variant by Karayel et al. ([ITP 2025](https://doi.org/10.4230/LIPIcs.ITP.2025.34)):
it never fails, and its estimate is right on average. See
[Key concepts](#key-concepts) for the guarantees.

## Install

```sh
npm install cvm-estimator
```

Requires Node 18 or newer. The library is published as ES modules only and has no
runtime dependencies. TypeScript types are included.

## Promise API — `estimateDistinct`

Accepts any iterable (`Array`, `Set`, …), async iterable, or `Readable` stream,
and resolves to the result:

```js
import { estimateDistinct } from 'cvm-estimator'

const { estimate } = await estimateDistinct(source, {
  epsilon: 0.05,            // accuracy: within ±5%
  delta: 0.01,              // reliability: may miss ±5% at most 1% of the time
  expectedSize: 50_000_000  // about how many items the stream has (upper bound is fine)
})

console.log(`≈ ${estimate} distinct values`)
```

## Stream API — `DistinctEstimateStream`

A `Writable` sink in object mode (write one *element* per chunk). Read the result
once it has finished:

```js
import { pipeline } from 'node:stream/promises'
import { DistinctEstimateStream } from 'cvm-estimator'

const counter = new DistinctEstimateStream({ epsilon: 0.05, expectedSize: 1e6 })
await pipeline(source, counter)

console.log(counter.result()) // { estimate, samples, threshold, p }
```

To count distinct lines/tokens from a byte stream, split it into elements upstream
(e.g. with a line-splitting transform) before piping in.

## Core engine — `CVM`

Drive the algorithm yourself, no I/O:

```js
import { CVM } from 'cvm-estimator'

const cvm = new CVM({ epsilon: 0.05, expectedSize: 1e6 })
for (const value of source) cvm.add(value)

console.log(cvm.distinct)  // the estimate, as a number
console.log(cvm.result())  // estimate + internal state
```

`cvm.distinct` and `cvm.result()` can be read at any point, not just at the end, so
you can watch the estimate converge while the data is still arriving.

## Counting by a key (`keyFn`)

Both APIs take a `keyFn` that maps each item to the value whose distinctness you
want to count. It must return a **primitive** (string/number): the engine dedups
with a `Set`, so objects/arrays would be compared by reference and never dedup.

```js
// distinct users
await estimateDistinct(orders, { keyFn: (o) => o.user })

// composite key: distinct (user, product) pairs.
// Use JSON.stringify or a safe separator to avoid collisions.
await estimateDistinct(orders, { keyFn: (o) => JSON.stringify([o.user, o.product]) })
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `epsilon` | `0.05` | How close the estimate should be, as a fraction: `0.05` = ±5%. Smaller is more accurate but uses more memory. |
| `delta` | `0.01` | How often a run may land outside ±`epsilon`: `0.01` = at most 1% of the time. |
| `expectedSize` | `0` | About how many items the stream has (an upper bound is fine); it sizes how many elements can be held. Optional, but omitting it triggers a warning. |
| `seed` | — | Integer seed for the built-in generator; set it for reproducible runs. Leave unset for fresh randomness each run. |
| `random` | `Math.random` | The randomness source: a function returning a float in `[0, 1)`. Overrides `seed`. |
| `keyFn` | identity | (Promise & Stream APIs) Maps each item to the value to count. |

## Result

```ts
{
  estimate: number,  // the estimated number of distinct values
  samples: number,   // how many elements are held
  threshold: number, // the maximum it can hold
  p: number          // current sampling rate: estimate = samples / p
}
```

If the stream has fewer distinct values than `threshold`, nothing is ever dropped
and the result is exact. Otherwise it's an estimate that varies slightly between
runs. Pass a `seed` to make it reproducible.

## Errors

The estimator never fails (it is total). Errors only come from your data source or
your `keyFn`, and travel on a single channel:

- **Promise API** — the promise rejects.
- **Stream API** — the `'error'` event fires, which also rejects `pipeline()` / `finished()`.

## Key concepts

The quantity being estimated is `F0`, the number of distinct elements in a stream.

- **Bounded memory.** Instead of remembering every distinct value, the algorithm
  keeps a random sample capped at `n = ⌈(12/ε²)·ln(3m/δ)⌉` entries
  (`O((1/ε²)·log(m/δ))` space), however many distinct values appear. `m`
  (`expectedSize`) enters only through a logarithm, so a rough upper bound is enough.
- **`(ε, δ)` guarantee.** With probability at least `1 − δ`, the estimate is within
  `±ε` of `F0`. This is a proven, machine-verified worst case, so in practice it is
  usually much closer than `ε`.
- **Total and unbiased.** It never fails (no `⊥` outcome), and `E[estimate] = F0`
  exactly, with no systematic over- or under-counting.

## References

- S. Chakraborty, N. V. Vinodchandran, K. S. Meel. *Distinct Elements in Streams:
  An Algorithm for the (Text) Book.* ESA 2022. [arXiv:2301.10191](https://arxiv.org/abs/2301.10191)
- E. Karayel, S. J. Watt, D. Khu, K. S. Meel, Y. K. Tan. *Verification of the CVM
  Algorithm with a Functional Probabilistic Invariant.* ITP 2025. [doi:10.4230/LIPIcs.ITP.2025.34](https://doi.org/10.4230/LIPIcs.ITP.2025.34). Its Algorithm 3 is the total, unbiased variant implemented here.

## License

ISC
