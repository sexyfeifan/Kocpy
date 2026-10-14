const { verifySignedMediaApp } = require('./media-signing-policy.cjs');

module.exports = async function afterSign(context) {
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  return verifySignedMediaApp(context, { verifyMediaRuntime });
};
