// Generates isolated, visibly synthetic acceptance data. Never imports user data.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { importExistingBackup } from "../src/main/production-lifecycle";
import type { ProjectConfig } from "../src/main/types";
async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "kocpy-trust-acceptance-"),
  );
  const data = path.join(root, "data"),
    source = path.join(root, "合成素材源");
  const targets = [
    path.join(root, "同盘目标一"),
    path.join(root, "同盘目标二"),
  ];
  for (const dir of [data, source, ...targets]) await fs.mkdir(dir);
  await fs.writeFile(
    path.join(source, "synthetic.txt"),
    "Generated Kocpy acceptance fixture. Not production media.\n",
  );
  const project: ProjectConfig = {
    id: "trust-synthetic",
    name: "合成验收·内容与副本证据",
    devices: ["A", "B", "C", "D"],
    volumePrefix: "CARD",
    requiredCopies: 2,
    shootingDateStart: "2026-09-01",
    shootingDateEnd: "2026-09-01",
  };
  const engine = new BackupEngine();
  const copied = engine.createTask({
    name: "同盘双目标",
    sourcePath: source,
    destinationPaths: targets,
    projectId: project.id,
    devices: ["A"],
    shootingDate: "20260901",
    namingTemplate: "synthetic",
    copyMode: "mirror",
    hashAlgorithm: "sha256",
    generateThumbnails: false,
  });
  await new Promise<void>((resolve, reject) => {
    engine.once("settled", (task) =>
      task.status === "completed"
        ? resolve()
        : reject(new Error(task.errorMessage || "Synthetic transfer failed")),
    );
    engine.startTask(copied.id);
  });
  copied.name = "01 同盘双目标·内容已核验";
  const records = [copied];
  for (const [index, mode] of [
    "external-baseline",
    "unverified-import",
    "manifest-import",
  ].entries()) {
    const folder = path.join(root, `合成接管_${index}`);
    await fs.mkdir(folder);
    await fs.copyFile(
      path.join(source, "synthetic.txt"),
      path.join(folder, "synthetic.txt"),
    );
    if (mode === "manifest-import") {
      const hash = createHash("sha256")
        .update(await fs.readFile(path.join(folder, "synthetic.txt")))
        .digest("hex");
      await fs.writeFile(
        path.join(folder, "SHA256SUMS.txt"),
        `${hash}  synthetic.txt\n${hash}  deliberately-missing.txt\n`,
      );
    }
    const task = await importExistingBackup(
      project,
      folder,
      mode as "external-baseline" | "unverified-import" | "manifest-import",
      {
        device: ["B", "C", "D"][index],
        shootingDate: "20260901",
        card: [
          "02 首次基线·不代表接管前完整",
          "03 仅导入结构·尚未校验",
          "04 清单缺失·应保留风险",
        ][index],
      },
    );
    records.push(task);
  }
  await fs.writeFile(
    path.join(data, "projects.json"),
    JSON.stringify([project]),
  );
  await fs.writeFile(path.join(data, "tasks.json"), JSON.stringify(records));
  console.log(
    JSON.stringify({ root, data, taskIds: records.map((t) => t.id) }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
