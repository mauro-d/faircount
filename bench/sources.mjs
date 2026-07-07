import { Readable } from 'node:stream'

/**
 * A deterministic Readable that emits `total` string tokens drawn from an id
 * space of size `unique`. With 'uniform' the true F0 is ≈ `unique`; with
 * 'zipf' ids are drawn log-uniformly (P(id k) ∝ 1/k, the shape of user/IP/URL
 * frequencies in real logs), so a few hot ids dominate and the realized F0 is
 * lower — the exact baseline reports it.
 *
 * @param {number} total Number of tokens to emit.
 * @param {number} unique Size of the id space to draw from.
 * @param {number} seed LCG seed.
 * @param {'uniform' | 'zipf'} distribution Shape of the id draw.
 * @returns {Readable}
 */
export function createTokenStream (total, unique, seed, distribution) {
  if (distribution !== 'uniform' && distribution !== 'zipf') {
    throw new RangeError(`unknown distribution: ${distribution}`)
  }
  let produced = 0
  let state = seed
  const logUnique = Math.log(unique)

  return new Readable({
    objectMode: true,
    read () {
      if (produced >= total) {
        this.push(null)
        return
      }
      // Park–Miller LCG, used only to generate the synthetic workload.
      state = (state * 48271) % 2147483647
      const u = state / 2147483647
      const id = distribution === 'zipf'
        ? Math.floor(Math.exp(u * logUnique)) - 1
        : Math.floor(u * unique)
      this.push(`id_token_log_${id}`)
      produced++
    }
  })
}
