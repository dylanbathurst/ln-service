const {promisify} = require('util');

const {test} = require('tap');

const signMessage = require('./../../signMessage');
const {spawnLnd} = require('./../macros');

const expectedSignatureLength = 104;
const message = 'message';

// Sign message should return a signature for the message
test(`Sign message`, async ({end, equal}) => {
  const {kill, lnd} = await promisify(spawnLnd)({});

  const {signature} = await signMessage({lnd, message});

  equal(signature.length, expectedSignatureLength, 'Signature is returned');

  kill();

  return end();
});
