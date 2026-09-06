import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = [".github", "docs", "resources", "scripts", "src", "tests"];
const ignoredDirectories = new Set([".git", "node_modules", "out", "release", "coverage", "work"]);

export function sourceTreeIssue(name) {
  if (name === ".DS_Store") return "macOS Finder metadata";
  if (name.startsWith("._")) return "AppleDouble metadata";
  if (/\.icloud$/i.test(name)) return "incomplete iCloud placeholder";
  if (/\((?:conflicted copy|冲突副本)[^)]*\)(?=\.[^.]+$|$)/i.test(name))
    return "sync conflict copy";
  if (/ \d+(?=\.[^.]+$|$)/.test(name)) return "numbered duplicate filename";
  return null;
}

async function walk(directory, root, findings) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    const issue = sourceTreeIssue(entry.name);
    if (issue) findings.push({ path: relative, issue });
    if (entry.isDirectory() && !entry.isSymbolicLink() && !ignoredDirectories.has(entry.name))
      await walk(absolute, root, findings);
  }
}

export async function findSourceTreeIssues(root = defaultRoot) {
  const findings = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const issue = sourceTreeIssue(entry.name);
    if (issue) findings.push({ path: entry.name, issue });
  }
  for (const relative of sourceDirectories) {
    const entry = entries.find((candidate) => candidate.name === relative);
    if (entry?.isDirectory()) await walk(path.join(root, relative), root, findings);
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

export async function verifySourceTree(root = defaultRoot) {
  const findings = await findSourceTreeIssues(root);
  if (!findings.length) return findings;
  const detail = findings.map(({ path: file, issue }) => `- ${file} (${issue})`).join("\n");
  throw new Error(
    `Source tree hygiene check failed. Move these generated or conflict files out of the repository; no file was changed:\n${detail}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1] || "") : defaultRoot;
  try {
    await verifySourceTree(root);
    console.log(`Source tree hygiene check passed: ${root}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
