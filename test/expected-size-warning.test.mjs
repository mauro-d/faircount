import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CVM } from '../src/index.mjs'

// Alone in this file on purpose: the warning fires once per process, so any
// other test that built an estimator without `expectedSize` would consume it
// first and leave this one waiting. `node --test` gives each file its own
// process, which keeps that from happening.
test('warns once when expectedSize is omitted', async () => {
  const seen = new Promise((resolve) => process.once('warning', resolve))
  new CVM({ epsilon: 0.5, delta: 0.1 }) // eslint-disable-line no-new
  const warning = await seen
  assert.equal(warning.code, 'CVM_NO_EXPECTED_SIZE')

  let warnedAgain = false
  const listener = () => { warnedAgain = true }
  process.on('warning', listener)
  new CVM({ epsilon: 0.5, delta: 0.1 }) // eslint-disable-line no-new
  await new Promise((resolve) => setImmediate(resolve))
  process.removeListener('warning', listener)
  assert.equal(warnedAgain, false, 'the warning must fire only once per process')
})
