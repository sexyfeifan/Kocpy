const assert = require('node:assert/strict');
const { requireCandidateMediaSigning } = require('./media-signing-policy.cjs');

module.exports = async function beforePack(context) {
  requireCandidateMediaSigning(context);
  const { verifySourceTree } = await import('./verify-source-tree.mjs');
  await verifySourceTree();
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  const runtimes = await verifyMediaRuntime();
  assert.deepEqual(runtimes.map((runtime) => runtime.arch).sort(), ['arm64', 'x64'], 'Source media runtimes must cover both supported architectures');
};
