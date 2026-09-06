module.exports = async function beforePack() {
  const { verifySourceTree } = await import('./verify-source-tree.mjs');
  await verifySourceTree();
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  await verifyMediaRuntime();
};
