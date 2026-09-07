// Explicitly synthetic, isolated fixture for project rule-preview desktop QA.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-rule-ui-")),
    data = path.join(root, "data"),
    savedDestination = path.join(root, "已保存目的地"),
    candidateDestination = path.join(root, "新目的地");
  await Promise.all(
    [data, savedDestination, candidateDestination].map((item) =>
      fs.mkdir(item),
    ),
  );
  const project = {
    id: "synthetic-rule-project",
    name: "合成规则确认项目",
    devices: ["FX3"],
    volumePrefix: "FX3_",
    volumePrefixByDevice: { FX3: "FX3_" },
    projectFolderName: "20260908_合成规则确认项目",
    shootingDateStart: "2026-09-08",
    shootingDateEnd: "2026-09-08",
    devicePositions: {},
    destinationPaths: [savedDestination],
    requiredCopies: 1,
    namingRule: "{date}_{project}/{shootingDate}/{device}/{card}",
    completionActions: ["report"],
    checklists: [],
    status: "active",
    createdAt: Date.now(),
  };
  await fs.writeFile(path.join(data, "projects.json"), JSON.stringify([project]));
  await fs.writeFile(path.join(data, "tasks.json"), "[]");
  console.log(
    JSON.stringify({ root, data, savedDestination, candidateDestination }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
