import { pipeline } from 'node:stream/promises'
import { CVM, DistinctEstimateStream } from '../src/index.mjs'
import { createTokenSource, createTokenStream } from './sources.mjs'
import { ExactDistinctStream } from './baseline.mjs'

const kind = process.argv[2]
const scenario = JSON.parse(process.argv[3] ?? 'null')

if (kind !== 'cvm' && kind !== 'exact' && kind !== 'accuracy') {
  console.error('usage: worker.mjs <cvm|exact|accuracy> <scenarioJSON>')
  process.exit(1)
}
if (!scenario) {
  console.error('usage: worker.mjs <cvm|exact|accuracy> <scenarioJSON>')
  process.exit(1)
}

/**
 * Estimate the same stream `scenario.accuracyRuns` times in one pass and print
 * every estimate. A single estimate says little: the spread between runs at one
 * epsilon is wide enough to invert the ordering between two epsilons, so the
 * error column is only meaningful as a median over runs. Memory is not measured
 * here, since several estimators are alive at once; that is the `cvm` run's job.
 *
 * @returns {Promise<void>}
 */
function runAccuracy () {
  // Pulled straight from the source rather than through a stream: this one hands
  // over a value per read, so iterating it leaves a nextTick callback pending for
  // each and the heap runs out at tens of millions of items. The run measures the
  // estimator's statistics anyway, not the pipeline.
  const next = createTokenSource(scenario.total, scenario.unique, scenario.seed, scenario.distribution)
  const estimators = Array.from({ length: scenario.accuracyRuns }, () =>
    new CVM({ epsilon: scenario.epsilon, delta: scenario.delta, expectedSize: scenario.total }))

  const start = performance.now()
  for (let value = next(); value !== null; value = next()) {
    for (let i = 0; i < estimators.length; i++) estimators[i].add(value)
  }
  const ms = performance.now() - start

  const estimates = estimators.map((c) => c.distinct.toFixed(0)).join(',')
  console.log(`RESULT|accuracy|${estimates}|0|${ms.toFixed(0)}`)
}

/**
 * Run a single engine in this (isolated) process and print one RESULT line:
 * `RESULT|<name>|<estimate>|<ramMB>|<ms>`. Always invoked by bench/index.mjs,
 * which is the only source of the scenario's parameters. This file has no
 * defaults of its own, so there is exactly one place (bench/scenarios.mjs) to
 * change what gets measured.
 */
async function run () {
  if (kind === 'accuracy') return runAccuracy()

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
