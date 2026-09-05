const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Resources', 'ffmpeg');
  await verifyMediaRuntime(resources);

  // iCloud and Finder can attach resource-fork metadata while the bundle is
  // assembled locally. Apple codesign rejects that metadata, so clean only the
  // generated app bundle immediately before electron-builder signs it.
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-cr', app]);
};
