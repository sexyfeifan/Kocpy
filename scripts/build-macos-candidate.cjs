const { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('macOS candidate packages must be built on macOS.');

const projectDir = path.resolve(__dirname, '..');
const finalOutput = path.join(projectDir, 'release');
const temporaryOutput = mkdtempSync(path.join(tmpdir(), 'kocpy-macos-candidate-'));
const builder = path.join(projectDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const builderArgs = [
  builder,
  '--mac',
  ...process.argv.slice(2),
  '--publish',
  'never',
  `-c.directories.output=${temporaryOutput}`,
  '-c.mac.notarize=false',
  '-c.mac.identity=-'
];

const result = spawnSync(process.execPath, builderArgs, {
  cwd: projectDir,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  stdio: 'inherit'
});

if (result.status !== 0) {
  console.error(`Candidate output retained for inspection: ${temporaryOutput}`);
  process.exit(result.status ?? 1);
}

mkdirSync(finalOutput, { recursive: true });
const copiedAppBundles = [];
for (const entry of readdirSync(temporaryOutput, { withFileTypes: true })) {
  const source = path.join(temporaryOutput, entry.name);
  const destination = path.join(finalOutput, entry.name);
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
  const copiedApp = path.join(destination, 'Kocpy.app');
  if (entry.isDirectory() && existsSync(copiedApp)) copiedAppBundles.push(copiedApp);
}

for (const app of copiedAppBundles) {
  const verification = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    stdio: 'inherit'
  });
  if (verification.status !== 0) {
    console.error(`Copied candidate signature verification failed. Temporary output retained: ${temporaryOutput}`);
    process.exit(verification.status ?? 1);
  }
}

rmSync(temporaryOutput, { recursive: true, force: true });
