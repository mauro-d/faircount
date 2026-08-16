// Every other test file imports `../src/index.mjs` by path, which never touches
// the exports map: a wrong path in package.json would ship a package nobody can
// import, and the whole suite would still be green. Importing by name goes
// through the map, the way a consumer does.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as faircount from 'faircount'

test('the package imports by name, through its own exports map', () => {
  assert.deepEqual(Object.keys(faircount), [
    'CVM', 'computeThreshold', 'createEstimatorSink', 'createRandom', 'estimateDistinct', 'estimateDistinctSync'
  ])

  const estimator = new faircount.CVM({ expectedSize: 10 })
  assert.equal(faircount.estimateDistinctSync(estimator, ['a', 'b', 'a']).estimate, 2)
})
