const path = require('node:path');
const { rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Arch } = require('builder-util');

module.exports = async function afterPack(context) {
  const { verifyMediaRuntime } = await import('./verify-media-runtime.mjs');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Resources', 'ffmpeg');
  await verifyMediaRuntime(resources);

  // Ship only the native runtime for this package. Keeping the opposite-CPU
  // executable in an otherwise native app makes macOS warn that the app still
  // contains Intel-only components even though Kocpy never executes it.
  const targetArch = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : undefined;
  if (!targetArch) throw new Error(`Unsupported macOS package architecture: ${context.arch}`);
  const unusedArch = targetArch === 'arm64' ? 'x64' : 'arm64';
  rmSync(path.join(resources, `ffmpeg-darwin-${unusedArch}`), { force: true });
  rmSync(path.join(resources, `build-info-${unusedArch}.json`), { force: true });
  const packagedRuntimes = await verifyMediaRuntime(resources);
  if (packagedRuntimes.length !== 1 || packagedRuntimes[0].arch !== targetArch)
    throw new Error(`Packaged media runtime architecture mismatch: expected ${targetArch}`);

  // iCloud and Finder can attach resource-fork metadata while the bundle is
  // assembled locally. Apple codesign rejects that metadata, so clean only the
  // generated app bundle immediately before electron-builder signs it.
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-cr', app]);
};
