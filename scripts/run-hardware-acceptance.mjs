import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const confirmation = "I_UNDERSTAND_THIS_WRITES_AND_REMOVES_SYNTHETIC_TEST_DATA";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Kocpy mounted-volume acceptance (generated data only)

Usage:
  npm run test:hardware -- \\
    --destination /Volumes/DISPOSABLE_APFS \\
    --destination /Volumes/DISPOSABLE_EXFAT \\
    --result /absolute/path/kocpy-hardware-result.json \\
    --confirm-write-test

Options:
  --destination PATH   Mounted disposable volume root; repeat for each volume.
  --result PATH        New JSON result file outside every tested volume.
  --plan               Validate arguments and print the write scope without running.
  --confirm-write-test Required for execution; authorizes generated test data only.
  --help               Show this help.

The test writes one 256 MiB file and 1,500 small files into a unique hidden
directory on each destination, verifies them through Kocpy, and removes only
those unique test directories. Each target should have at least 600 MiB free
for the final data and atomic-publication allowance. Existing result files are
never overwritten.`;

function fail(message) {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const destinations = [];
let resultPath = "";
let planOnly = false;
let confirmed = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--destination") destinations.push(args[++index] || "");
  else if (argument === "--result") resultPath = args[++index] || "";
  else if (argument === "--plan") planOnly = true;
  else if (argument === "--confirm-write-test") confirmed = true;
  else fail(`Unknown argument: ${argument}`);
}

if (!destinations.length) fail("At least one --destination is required.");
const normalizedDestinations = destinations.map((destination) => path.resolve(destination));
for (const destination of normalizedDestinations) {
  const relative = path.relative("/Volumes", destination);
  if (!path.isAbsolute(destination) || !relative || relative.startsWith("..") || relative.split(path.sep).length !== 1)
    fail(`Destination must be an exact mounted volume root under /Volumes: ${destination}`);
}
if (new Set(normalizedDestinations).size !== normalizedDestinations.length)
  fail("Each destination must be listed once.");
if (!resultPath || !path.isAbsolute(resultPath)) fail("--result must be an absolute path.");
const normalizedResult = path.resolve(resultPath);
if (normalizedDestinations.some((destination) => isInside(destination, normalizedResult)))
  fail("The result file must be outside every tested destination.");
if (existsSync(normalizedResult)) fail(`Result file already exists and will not be overwritten: ${normalizedResult}`);

const plan = {
  destinations: normalizedDestinations,
  result: normalizedResult,
  generatedLargeFileBytes: 256 * 1024 * 1024,
  generatedSmallFiles: 1500,
  recommendedFreeBytesPerDestination: 600 * 1024 * 1024,
  existingFilesTouched: false,
};
console.log(JSON.stringify(plan, null, 2));
if (planOnly) process.exit(0);
if (!confirmed) fail("Review the plan, then add --confirm-write-test to execute it.");

const vitest = path.join(repo, "node_modules", "vitest", "vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", "tests/hardware.integration.test.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    KOCPY_HARDWARE_DESTINATIONS: JSON.stringify(normalizedDestinations),
    KOCPY_HARDWARE_CONFIRM: confirmation,
    KOCPY_HARDWARE_RESULT: normalizedResult,
  },
  stdio: "inherit",
});
process.exit(run.status ?? 1);
