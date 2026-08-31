const path = require('node:path');
module.exports = async function afterPack(context) {
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'ffmpeg');
  await verifyMediaRuntime(resources);
};
