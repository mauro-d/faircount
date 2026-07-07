import { pipeline } from 'node:stream/promises'
import { DistinctEstimateStream } from '../src/index.mjs'
import { createTokenStream } from './sources.mjs'
import { ExactDistinctStream } from './baseline.mjs'

const kind = process.argv[2]
const scenario = JSON.parse(process.argv[3] ?? 'null')

if (kind !== 'cvm' && kind !== 'exact') {
  console.error('usage: worker.mjs <cvm|exact> <scenarioJSON>')
  process.exit(1)
}
if (!scenario) {
  console.error('usage: worker.mjs <cvm|exact> <scenarioJSON>')
  process.exit(1)
}

/**
 * Run a single engine in this (isolated) process and print one RESULT line:
 * `RESULT|<name>|<estimate>|<ramMB>|<ms>`. Always invoked by bench/index.mjs,
 * which is the only source of the scenario's parameters. This file has no
 * defaults of its own, so there is exactly one place (bench/scenarios.mjs) to
 * change what gets measured.
 */
async function run () {
  // Both engines are driven through the same pipeline so transient allocation is
  // identical; the only difference measured is the *retained* set (sample set vs
  // the full distinct set). A GC right before measuring isolates retained memory.
  if (global.gc) global.gc()
  const source = createTokenStream(scenario.total, scenario.unique, scenario.seed, scenario.distribution)
  // No fixed seed for the estimator: use the production default (Math.random) so
  // the benchmark shows a freshly-drawn estimate each run rather than a single
  // repeated deterministic draw. The scenario's seed only fixes the synthetic
  // workload, so it is comparable across the exact and cvm runs.
  const sink = kind === 'cvm'
    ? new DistinctEstimateStream({ epsilon: scenario.epsilon, delta: scenario.delta, expectedSize: scenario.total })
    : new ExactDistinctStream()

  const memBefore = process.memoryUsage().heapUsed
  const start = performance.now()
  await pipeline(source, sink)
  const ms = performance.now() - start

  if (global.gc) global.gc()
  const ramMB = (process.memoryUsage().heapUsed - memBefore) / 1024 / 1024
  const estimate = sink.distinct
  console.log(`RESULT|${kind}|${estimate.toFixed(0)}|${ramMB.toFixed(2)}|${ms.toFixed(0)}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
