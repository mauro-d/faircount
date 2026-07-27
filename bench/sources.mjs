import { Readable } from 'node:stream'

/**
 * The workload itself, as a pull function: call it for the next token, `null`
 * once `total` have been produced. Defined once and shared by the stream below
 * and by the accuracy run, so every engine sees the identical sequence.
 *
 * With 'uniform' the true F0 is ≈ `unique`; with 'zipf' ids are drawn
 * log-uniformly (P(id k) ∝ 1/k, the shape reported for user, IP and URL
 * frequencies in real logs), so a few hot ids dominate and the realized F0 is
 * lower. The exact baseline reports it.
 *
 * @param {number} total Number of tokens to emit.
 * @param {number} unique Size of the id space to draw from.
 * @param {number} seed LCG seed.
 * @param {'uniform' | 'zipf'} distribution Shape of the id draw.
 * @returns {() => string | null}
 */
export function createTokenSource (total, unique, seed, distribution) {
  if (distribution !== 'uniform' && distribution !== 'zipf') {
    throw new RangeError(`unknown distribution: ${distribution}`)
  }
  let produced = 0
  let state = seed
  const logUnique = Math.log(unique)

  return function next () {
    if (produced >= total) return null
    // Park–Miller LCG, used only to generate the synthetic workload.
    state = (state * 48271) % 2147483647
    const u = state / 2147483647
    const id = distribution === 'zipf'
      ? Math.floor(Math.exp(u * logUnique)) - 1
      : Math.floor(u * unique)
    produced++
    return `id_token_log_${id}`
  }
}

/**
 * The same workload as a Readable, for the runs that measure the estimator
 * through a real pipeline.
 *
 * @param {number} total
 * @param {number} unique
 * @param {number} seed
 * @param {'uniform' | 'zipf'} distribution
 * @returns {Readable}
 */
export function createTokenStream (total, unique, seed, distribution) {
  const next = createTokenSource(total, unique, seed, distribution)

  return new Readable({
    objectMode: true,
    read () {
      const token = next()
      if (token === null) this.push(null)
      else this.push(token)
    }
  })
}
