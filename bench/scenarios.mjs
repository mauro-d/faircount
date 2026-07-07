// Benchmark scenarios for `npm run bench`. Each entry runs the exact Set
// baseline and the faircount estimator through the same pipeline, in its own
// isolated forked process. Add or edit entries here only.
export const scenarios = [
  // Scale series (epsilon fixed at 0.05): shows how the gap changes with cardinality.
  { name: 'small (2M / ~400K unique)', total: 2_000_000, unique: 400_000, epsilon: 0.05, delta: 0.01, seed: 42, distribution: 'uniform' },
  { name: 'medium (10M / ~2M unique)', total: 10_000_000, unique: 2_000_000, epsilon: 0.05, delta: 0.01, seed: 42, distribution: 'uniform' },
  { name: 'large (50M / ~10M unique)', total: 50_000_000, unique: 10_000_000, epsilon: 0.05, delta: 0.01, seed: 42, distribution: 'uniform' },
  // Epsilon series (scale fixed at medium): isolates the accuracy/memory trade-off.
  { name: 'medium, epsilon=0.10', total: 10_000_000, unique: 2_000_000, epsilon: 0.10, delta: 0.01, seed: 42, distribution: 'uniform' },
  { name: 'medium, epsilon=0.20', total: 10_000_000, unique: 2_000_000, epsilon: 0.20, delta: 0.01, seed: 42, distribution: 'uniform' },
  // Skew series: same scale as `medium`, but ids drawn zipf-like (P(k) ∝ 1/k,
  // the shape of user/IP/URL frequencies in real logs — YCSB's "zipfian" is the
  // same family). A few hot ids dominate, so the estimator's delete branch
  // churns on them: this row keeps that pathology, and the Set-compaction guard
  // that answers it, measurable release after release. `unique` is the id
  // space; the realized distinct count is lower (the exact baseline prints it).
  { name: 'medium skewed (10M / ~1.1M realized unique, zipf-like)', total: 10_000_000, unique: 2_000_000, epsilon: 0.05, delta: 0.01, seed: 42, distribution: 'zipf' },
  // Regime series: same scale as `medium`, but the cardinality stays below the
  // threshold (~105k at this epsilon/size), so sub-sampling never engages: the
  // estimate is exact and the sample holds every distinct value. The row shows
  // where the estimator pays off — above the threshold — and that below it
  // memory sits at parity with a plain Set.
  { name: 'medium exact (10M / ~50K unique, below threshold)', total: 10_000_000, unique: 50_000, epsilon: 0.05, delta: 0.01, seed: 42, distribution: 'uniform' }
]
