const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('builder-util');
const { signingMode } = require('./release-signing.cjs');

// The already signed media bytes are immutable. This exception is exact and
// usable only by the explicitly supported ad-hoc candidate signing branch.
const MEDIA_SIGN_IGNORE = '/Contents/Resources/ffmpeg/ffmpeg-darwin-(?:arm64|x64)$';

function requireCandidateMediaSigning(context, environment = process.env) {
  assert.equal(signingMode(environment), 'ad-hoc', 'Unsupported application signing mode');
  const config = context?.packager?.config?.mac;
  assert(config, 'Missing resolved macOS signing configuration');
  assert.equal(config.identity, '-', 'Fixed ad-hoc media runtimes require an explicit ad-hoc application identity');
  assert.equal(config.notarize, false, 'Developer ID and notarization are unsupported for fixed ad-hoc media runtimes');
  const ignore = typeof config.signIgnore === 'string' ? [config.signIgnore] : config.signIgnore;
  assert.deepEqual(ignore, [MEDIA_SIGN_IGNORE], 'Media signing exclusion must match only the exact frozen FFmpeg paths');
  const active = context.packager.platformSpecificBuildOptions;
  if (active) {
    assert.equal(active.identity, config.identity, 'Active application identity differs from resolved candidate policy');
    assert.equal(active.notarize, config.notarize, 'Active notarization setting differs from resolved candidate policy');
    const activeIgnore = typeof active.signIgnore === 'string' ? [active.signIgnore] : active.signIgnore;
    assert.deepEqual(activeIgnore, ignore, 'Active signing exclusions differ from resolved candidate policy');
  }
}

function targetArchitecture(context) {
  if (context.arch === Arch.arm64) return 'arm64';
  if (context.arch === Arch.x64) return 'x64';
  throw new Error(`Unsupported macOS package architecture: ${context.arch}`);
}

async function verifySignedMediaApp(context, dependencies, environment = process.env) {
  requireCandidateMediaSigning(context, environment);
  const arch = targetArchitecture(context);
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Resources', 'ffmpeg');
  // Full-file digests, source archives, build recipe, signatures and license
  // checks run after outer signing; this hook never changes a signed artifact.
  const runtimes = await dependencies.verifyMediaRuntime(resources);
  assert.equal(runtimes.length, 1, 'Signed application must contain exactly one media architecture');
  assert.equal(runtimes[0].arch, arch, 'Signed media architecture differs from application target');
  const run = dependencies.execFileSync || execFileSync;
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(resources, `ffmpeg-darwin-${arch}`)], { stdio: 'pipe' });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' });
  return runtimes;
}

module.exports = { MEDIA_SIGN_IGNORE, requireCandidateMediaSigning, targetArchitecture, verifySignedMediaApp };
