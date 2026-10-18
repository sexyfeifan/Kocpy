import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureTimeContext, calendarDateInZone, mediaCalendarDate, formatEvidenceTime, overnightHint, assertProjectTimeRules, validTimeContext, assertSelectionTimeContext } from "../src/common/time-context";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { generateReport } from "../src/main/backup/ReportGenerator";
import { archiveTransferReportContract } from "../src/main/archive-transfer-report";
import { analyzeBackupSelection, finalizeBackupSelection, validateBackupSelectionPlan } from "../src/main/backup-selection";
import { projectRuleDefinition, appendProjectRuleSnapshot, projectRuleChanges } from "../src/main/project-evidence";
import { normalizeProject } from "../src/main/project-normalization";
import { authorizeProjectTaskConfig } from "../src/main/project-task-authority";
import type { ProjectConfig, TaskConfig } from "../src/main/types";
import type { ArchiveTransferReportSnapshot } from "../src/main/archive-transfer";

const at = Date.parse("2026-10-15T18:30:00Z"); // Shanghai 16th 02:30, belongs to explicit 15th session.
const rules = { projectTimeZone: "Asia/Shanghai", shootingDayBoundaryHour: 6 };
const context = captureTimeContext(rules, "2026-10-15", at);
const project: ProjectConfig = { id: "tz-project", name: "Synthetic", volumePrefix: "CARD_", devices: ["FX3"], shootingDateStart: "2026-10-15", shootingDateEnd: "2026-10-16", projectFolderName: "20261015_Synthetic", ...rules };
const config: TaskConfig = { projectId: project.id, projectName: project.name, projectStartDate: project.shootingDateStart, projectFolderName: project.projectFolderName, projectNamingRule: undefined, name: "CARD", namingTemplate: "CARD", sourcePath: "/tmp/time-source", destinationPaths: ["/tmp/time-copy"], devices: ["FX3"], shootingDate: "2026-10-15", hashAlgorithm: "sha256", ...rules, shootingTimeZone: "Asia/Shanghai" };

describe("explicit shooting time context", () => {
  it.each(["Bad/Zone", "", "../Asia/Shanghai", "Asia/Shanghai\n"])("rejects invalid time zone %s", zone => expect(() => assertProjectTimeRules({ projectTimeZone: zone })).toThrow());
  it("validates override dates and advisory hour, never normalizes impossible days", () => {
    expect(() => assertProjectTimeRules({ shootingDayTimeZones: { "2026-02-30": "UTC" } })).toThrow();
    expect(() => assertProjectTimeRules({ shootingDayBoundaryHour: 13 })).toThrow();
    expect(validTimeContext({ ...context, workstationOffsetMinutes: 999 })).toBe(false);
  });
  it("converts offset-bearing media only, preserving unzoned camera calendar dates", () => {
    expect(mediaCalendarDate("2026-10-15T18:30:00Z", "Asia/Shanghai")).toBe("2026-10-16");
    expect(mediaCalendarDate("2026-10-15T18:30:00", "Asia/Shanghai")).toBe("2026-10-15");
    expect(mediaCalendarDate("2026:10:15 18:30:00", "Asia/Shanghai")).toBe("2026-10-15");
    expect(mediaCalendarDate("2026-10-15T18:30:00Z")).toBe("2026-10-15");
  });
  it("keeps previous shooting day across midnight and international date line", () => {
    expect(context.shootingDate).toBe("2026-10-15");
    expect(calendarDateInZone(at, "Pacific/Kiritimati")).toBe("2026-10-16");
    expect(calendarDateInZone(at, "America/Los_Angeles")).toBe("2026-10-15");
    expect(overnightHint("2026-10-15T18:30:00Z", context)).toContain("可能归属 2026-10-15");
    expect(overnightHint("2026-10-16T02:30:00", context)).toBeUndefined();
  });
  it("distinguishes repeated daylight-saving times by offset without changing their date", () => {
    const c = { ...context, workstationTimeZone: "America/New_York" };
    const first = formatEvidenceTime(Date.parse("2026-11-01T05:30:00Z"), c), second = formatEvidenceTime(Date.parse("2026-11-01T06:30:00Z"), c);
    expect(first).toContain("01:30:00"); expect(second).toContain("01:30:00");
    expect(first).toContain("GMT-04:00"); expect(second).toContain("GMT-05:00");
  });
  it("freezes operation zone and labels legacy UTC explicitly rather than guessing Beijing", () => {
    const c = { ...context, workstationTimeZone: "Europe/Paris" };
    expect(formatEvidenceTime(at, c)).toContain("Europe/Paris");
    expect(formatEvidenceTime(at)).toContain("[UTC]（原时区未记录）");
    expect(formatEvidenceTime(at, captureTimeContext(), "shooting")).toContain("[UTC]（拍摄时区未记录）");
    expect(formatEvidenceTime(1e300)).toBe("时间未记录或无效");
    expect(mediaCalendarDate("2026:10:15 18:30:00+00:00", "Asia/Shanghai")).toBe("2026-10-16");
  });
  it("rejects frozen selection reuse after day, timezone or boundary changes", () => {
    expect(() => assertSelectionTimeContext(context, rules, "20261015")).not.toThrow();
    expect(() => assertSelectionTimeContext(context, rules, "2026-10-16")).toThrow("重新分析");
    expect(() => assertSelectionTimeContext(context, { ...rules, projectTimeZone: "Europe/Paris" }, "2026-10-15")).toThrow("重新分析");
    expect(() => assertSelectionTimeContext(context, { ...rules, shootingDayBoundaryHour: 7 }, "2026-10-15")).toThrow("重新分析");
  });
  it("keeps legacy rule hash content unchanged and requires audit for new time rules", () => {
    const { projectTimeZone: _, shootingDayBoundaryHour: __, ...legacy } = project;
    expect(normalizeProject(legacy).projectTimeZone).toBeUndefined();
    expect(projectRuleDefinition(legacy)).not.toHaveProperty("projectTimeZone");
    const old = appendProjectRuleSnapshot(undefined, legacy, { at, operator: "Fixture" });
    const saved = appendProjectRuleSnapshot(old, { ...old, ...rules }, { at: at + 1, operator: "Fixture" });
    expect(saved.ruleSnapshots![0]).toEqual(old.ruleSnapshots![0]);
    expect(projectRuleChanges(old, saved).map(c => c.field)).toContain("projectTimeZone");
  });
  it("rejects a stale composer and snapshots task time without altering shooting-day paths", async () => {
    expect(() => authorizeProjectTaskConfig(project, [], { ...config, shootingTimeZone: "UTC" })).toThrow("时区");
    const task = new BackupEngine().createTask(authorizeProjectTaskConfig(project, [], config));
    expect(task.timeContext?.shootingDate).toBe("2026-10-15");
    expect(task.shootingDateFolder).toContain("20261015/FX3");
    const before = JSON.stringify(task.timeContext);
    project.projectTimeZone = "Europe/Paris";
    expect(JSON.stringify(task.timeContext)).toBe(before);
    project.projectTimeZone = "Asia/Shanghai";
    const html = (await generateReport(task, { generatedAt: at })).toString();
    expect(html).toContain("Asia/Shanghai"); expect(html).toContain("操作时区");
  });
  it("uses the same labeled formatter for archive reports and task reports", () => {
    const snapshot = { timeContext: { ...context, workstationTimeZone: "Europe/Paris" }, startedAt: at, completedAt: at + 1000, payloadFileCount: 1, payloadBytes: 3, payloadEmptyDirectories: 0, historicalEvidence: [], evidenceBoundary: "Fixture" } as unknown as ArchiveTransferReportSnapshot;
    expect(archiveTransferReportContract(snapshot, "fixture").startedAt).toBe(formatEvidenceTime(at, snapshot.timeContext));
    expect(archiveTransferReportContract({ ...snapshot, timeContext: undefined }, "fixture").startedAt).toContain("原时区未记录");
  });
  it("keeps whole-card coverage through night-date hints, restart and explicit attribution, without source changes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-tz-"));
    try {
      const root = await fs.realpath(temp), clip = path.join(root, "night.mp4"), sidecar = path.join(root, "night.xml");
      await fs.writeFile(clip, "generated media"); await fs.writeFile(sidecar, "associated data");
      const before = await fs.stat(clip);
      const deps = { identifyVolume: async () => ({ id: "fixture-volume", uuid: "fixture", name: "fixture", device: "synthetic" }), readEmbeddedDate: async () => "2026-10-15T18:30:00Z" };
      const preview = await analyzeBackupSelection({ sourcePath: root, timeContext: context }, deps);
      expect(preview.groups).toHaveLength(1); expect(preview.groups[0].suggestedDate).toBe("2026-10-16");
      expect(preview.groups[0].evidence.join(" ")).toContain("大夜");
      const plan = await finalizeBackupSelection(preview, { selectedDates: ["2026-10-15"], assignedDates: { [preview.groups[0].id]: "2026-10-15" }, operator: "Fixture" }, deps);
      expect(plan.wholeCardCovered).toBe(true); expect(plan.includedPaths.sort()).toEqual(["night.mp4", "night.xml"]);
      await validateBackupSelectionPlan(JSON.parse(JSON.stringify(plan)), deps);
      expect((await fs.stat(clip)).mtimeMs).toBe(before.mtimeMs);
      expect(await fs.readFile(sidecar, "utf8")).toBe("associated data");
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
});
