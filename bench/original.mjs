// ⚠ Pre-release comparison: ORIGINAL CVM (Algorithm 1) vs the new total/unbiased
// variant. Run with `node bench/original.mjs`. Delete this file together with
// src/cvm-original.mjs, src/errors.mjs and test/cvm-original.test.mjs once the new
// variant is adopted. The surviving benchmark (index.mjs/worker.mjs) uses only
// the new variant.
import { CVM } from '../src/cvm.mjs'
import { OriginalCVM } from '../src/cvm-original.mjs'

const EPSILON = 0.05
const DELTA = 0.01

function genData (total, unique, seed) {
  const data = []
  const set = new Set()
  let s = seed
  for (let i = 0; i < total; i++) {
    s = (s * 48271) % 2147483647
    data.push(`id_${Math.floor((s / 2147483647) * unique)}`)
    set.add(data[i])
  }
  return { data, f0: set.size }
}

const pct = (est, f0) => `${(((est - f0) / f0) * 100).toFixed(2)}%`

// 1) One pass: memory (threshold/retained samples) + accuracy + totality.
{
  const TOTAL = Number(process.env.BENCH_TOTAL ?? 3_000_000)
  const UNIQUE = Number(process.env.BENCH_UNIQUE ?? 800_000)
  const { data, f0 } = genData(TOTAL, UNIQUE, 42)

  const nw = new CVM({ epsilon: EPSILON, delta: DELTA, expectedSize: TOTAL })
  nw.addMany(data)

  let old = '⊥ (failed)'
  let oldThresh = '-'
  let oldSamples = '-'
  try {
    const o = new OriginalCVM({ epsilon: EPSILON, delta: DELTA, expectedSize: TOTAL })
    o.addMany(data)
    old = `${Math.round(o.distinct)} (${pct(o.distinct, f0)})`
    oldThresh = o.threshold
    oldSamples = o.sampleCount
  } catch {}

  console.log(`=== one pass: ${TOTAL.toLocaleString()} elements, F0 = ${f0.toLocaleString()} ===`)
  console.log(`exact Set   | stores ${f0.toLocaleString()} keys`)
  console.log(`NEW         | threshold ${nw.threshold} | samples ${nw.sampleCount} | estimate ${Math.round(nw.distinct)} (${pct(nw.distinct, f0)})`)
  console.log(`ORIGINAL    | threshold ${oldThresh} | samples ${oldSamples} | estimate ${old}`)
}

// 2) Bias: mean estimate over many seeds on a smaller dataset.
{
  const { data, f0 } = genData(200_000, 60_000, 7)
  const trials = 100
  let sumNew = 0
  let sumOld = 0
  for (let t = 1; t <= trials; t++) {
    sumNew += new CVM({ epsilon: 0.1, delta: DELTA, expectedSize: data.length, seed: t }).addMany(data).distinct
    sumOld += new OriginalCVM({ epsilon: 0.1, delta: DELTA, expectedSize: data.length, seed: t }).addMany(data).distinct
  }
  console.log(`\n=== bias over ${trials} seeds, F0 = ${f0.toLocaleString()} ===`)
  console.log(`NEW      mean ${(sumNew / trials).toFixed(1)} | bias ${pct(sumNew / trials, f0)}`)
  console.log(`ORIGINAL mean ${(sumOld / trials).toFixed(1)} | bias ${pct(sumOld / trials, f0)}`)
}
