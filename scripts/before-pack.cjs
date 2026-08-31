module.exports = async function beforePack() {
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  await verifyMediaRuntime();
};
