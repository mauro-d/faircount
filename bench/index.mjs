import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { scenarios } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Run one engine in a forked process (with `--expose-gc`) so heap measurements
 * are clean and isolated from each other. The scenario's parameters are passed
 * as a JSON argument to the child, which has no defaults of its own. This is
 * the only path that configures a benchmark run.
 *
 * @param {'cvm' | 'exact'} kind
 * @param {{ total: number, unique: number, epsilon: number, delta: number, seed: number }} scenario
 * @returns {Promise<{ name: string, estimate: string, ram: number, ms: number }>}
 */
function runIsolated (kind, scenario) {
  return new Promise((resolve, reject) => {
    const child = fork(join(here, 'worker.mjs'), [kind, JSON.stringify(scenario)], {
      execArgv: ['--expose-gc'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker '${kind}' exited with ${code}: ${err}`))
        return
      }
      const last = out.trim().split('\n').at(-1) ?? ''
      if (!last.startsWith('RESULT')) {
        reject(new Error(`unexpected worker output: ${out}`))
        return
      }
      const [, name, estimate, ram, ms] = last.split('|')
      resolve({ name, estimate, ram: parseFloat(ram), ms: parseInt(ms, 10) })
    })
  })
}

async function runScenario (scenario) {
  console.log(`\n=== ${scenario.name}: ${scenario.total.toLocaleString()} items, ~${scenario.unique.toLocaleString()} unique (ε=${scenario.epsilon}, δ=${scenario.delta}) ===`)
  // exact and cvm always run one after the other, never concurrently, so
  // neither run's measurement is skewed by the other contending for resources.
  const estimates = {}
  for (const kind of /** @type {const} */(['exact', 'cvm'])) {
    try {
      const r = await runIsolated(kind, scenario)
      estimates[kind] = Number(r.estimate)
      const label = kind === 'exact' ? 'EXACT (Set) ' : 'faircount   '
      console.log(`[${label}] distinct: ${r.estimate} | RAM: ${r.ram} MB | time: ${r.ms} ms`)
    } catch (e) {
      console.error(`error running '${kind}' for scenario '${scenario.name}':`, e instanceof Error ? e.message : e)
    }
  }
  if (estimates.exact && estimates.cvm) {
    const pct = (Math.abs(estimates.cvm - estimates.exact) / estimates.exact) * 100
    console.log(`[observed err ] ${pct.toFixed(2)}% (faircount vs exact)`)
  }
}

async function main () {
  console.log('=== faircount benchmark (isolated processes) ===')
  // Scenarios also run strictly one after another for the same reason.
  for (const scenario of scenarios) {
    await runScenario(scenario)
  }
}

main()
