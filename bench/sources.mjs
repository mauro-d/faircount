import { Readable } from 'node:stream'

/**
 * A deterministic Readable that emits `total` string tokens drawn uniformly
 * from `unique` distinct values, so the true F0 is known (≈ `unique`).
 *
 * @param {number} total Number of tokens to emit.
 * @param {number} unique Number of distinct values to draw from.
 * @param {number} seed LCG seed.
 * @returns {Readable}
 */
export function createTokenStream (total, unique, seed) {
  let produced = 0
  let state = seed

  return new Readable({
    objectMode: true,
    read () {
      if (produced >= total) {
        this.push(null)
        return
      }
      // Park–Miller LCG, used only to generate the synthetic workload.
      state = (state * 48271) % 2147483647
      const id = Math.floor((state / 2147483647) * unique)
      this.push(`id_token_log_${id}`)
      produced++
    }
  })
}
