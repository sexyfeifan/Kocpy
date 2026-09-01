import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import {
  appendProjectRuleSnapshot,
  appendProjectHandoffEvidence,
  appendTemplateApplicationEvidence,
  attachTaskEvidence,
  groupLogicalVolumes,
  recordDailyPlanDecision,
} from "../src/main/project-evidence";
import type { ProjectConfig } from "../src/main/types";

const project = (): ProjectConfig => ({
  id: "synthetic-project",
  name: "Synthetic",
  devices: ["A Cam"],
  volumePrefix: "A_",
  volumePrefixByDevice: { "A Cam": "A_" },
  destinationPaths: ["/tmp/synthetic-master"],
  requiredCopies: 1,
  namingRule: "{shootingDate}/{device}/{card}",
});

describe("append-only project evidence", () => {
  it("keeps old rules immutable and appends a new revision", () => {
    const created = appendProjectRuleSnapshot(undefined, project(), { at: 10 });
    const oldSnapshot = structuredClone(created.ruleSnapshots![0]);
    const updated = appendProjectRuleSnapshot(created, { ...created, requiredCopies: 2 }, { at: 20 });
    expect(updated.ruleSnapshots).toHaveLength(2);
    expect(updated.ruleSnapshots![0]).toEqual(oldSnapshot);
    expect(updated.ruleSnapshots![1]).toMatchObject({ revision: 2, createdAt: 20, reason: "project-updated" });
    expect(updated.activeRuleSnapshotId).toBe(updated.ruleSnapshots![1].id);
  });

  it("does not create a revision when rule material is unchanged", () => {
    const created = appendProjectRuleSnapshot(undefined, project(), { at: 10 });
    const savedAgain = appendProjectRuleSnapshot(created, { ...created, name: "Renamed metadata only" }, { at: 20 });
    expect(savedAgain.ruleSnapshots).toHaveLength(1);
    expect(savedAgain.activeRuleSnapshotId).toBe(created.activeRuleSnapshotId);
  });

  it("does not let project editing rewrite operational evidence", () => {
    const created = appendProjectRuleSnapshot(undefined, {
      ...project(),
      expectedDevicesByDate: { "2026-08-25": ["A Cam"] },
      dailyPlanDecisions: [{
        id: "injected-on-create",
        date: "2026-08-25",
        scheduleKey: "A Cam",
        decision: "expected",
        operator: "Injected",
        at: 1,
      }],
    });
    expect(created.dailyPlanDecisions).toEqual([]);
    const planned = recordDailyPlanDecision(created, {
      date: "2026-08-25",
      scheduleKey: "A Cam",
      decision: "expected",
      operator: "DIT Li",
      at: 10,
    });
    planned.handoffNotes = [{
      id: "handoff-a",
      at: 11,
      operator: "DIT Li",
      note: "Recorded handoff",
    }];
    const edited = appendProjectRuleSnapshot(planned, {
      ...planned,
      name: "Renamed",
      dailyPlanDecisions: [],
      handoffNotes: [],
      expectedDevicesByDate: {},
    });
    expect(edited.dailyPlanDecisions).toEqual(planned.dailyPlanDecisions);
    expect(edited.handoffNotes).toEqual(planned.handoffNotes);
    expect(edited.expectedDevicesByDate).toEqual(
      planned.expectedDevicesByDate,
    );
  });

  it("records who made each daily decision while keeping blank cells unknown", () => {
    const baseline = appendProjectRuleSnapshot(undefined, project(), { at: 5 });
    const expected = recordDailyPlanDecision(baseline, {
      date: "2026-08-25", scheduleKey: "A Cam", decision: "expected", operator: "DIT Li", at: 10,
    });
    expect(expected.expectedDevicesByDate?.["2026-08-25"]).toEqual(["A Cam"]);
    expect(expected.dailyPlanDecisions?.[0]).toMatchObject({
      operator: "DIT Li",
      decision: "expected",
      at: 10,
      ruleSnapshotId: baseline.activeRuleSnapshotId,
    });
    const cleared = recordDailyPlanDecision(expected, {
      date: "2026-08-25", scheduleKey: "A Cam", decision: "clear", operator: "DIT Li", at: 20,
    });
    expect(cleared.expectedDevicesByDate?.["2026-08-25"]).toEqual([]);
    expect(cleared.dailyPlanDecisions).toHaveLength(2);
    expect(project().expectedDevicesByDate).toBeUndefined();
  });
  it("rejects unaudited or path-like daily decisions", () => {
    expect(() =>
      recordDailyPlanDecision(project(), {
        date: "2026-08-25",
        scheduleKey: "../Camera",
        decision: "expected",
        operator: "DIT Li",
      }),
    ).toThrow(/设备或机位/);
    expect(() =>
      recordDailyPlanDecision(project(), {
        date: "2026-08-25",
        scheduleKey: "A Cam",
        decision: "expected",
        operator: " ",
      }),
    ).toThrow(/操作人/);
    expect(() =>
      recordDailyPlanDecision(project(), {
        date: "2026-02-30",
        scheduleKey: "A Cam",
        decision: "expected",
        operator: "DIT Li",
      }),
    ).toThrow(/日期/);
    expect(() =>
      recordDailyPlanDecision(project(), {
        date: "2026-08-25",
        scheduleKey: "A Cam::A::unexpected",
        decision: "expected",
        operator: "DIT Li",
      }),
    ).toThrow(/设备或机位/);
  });

  it("counts attempts with one logical id as one media volume", () => {
    const engine = new BackupEngine();
    const makeTask = (name: string) => engine.createTask({
      name, sourcePath: "/tmp/synthetic-source", destinationPaths: ["/tmp/synthetic-target"],
      devices: ["A Cam"], shootingDate: "2026-08-25", hashAlgorithm: "sha256", namingTemplate: name,
    });
    const first = attachTaskEvidence(makeTask("A001"));
    const retryRecord = attachTaskEvidence(makeTask("A001 retry"));
    retryRecord.logicalVolumeId = first.logicalVolumeId;
    first.status = "failed";
    retryRecord.status = "completed";
    retryRecord.destinations[0].verified = true;
    expect(groupLogicalVolumes([first, retryRecord], 1)).toMatchObject([
      { id: first.logicalVolumeId, compliant: true, attempts: [{ id: first.id }, { id: retryRecord.id }] },
    ]);
  });
  it("stores the exact template revision and selected fields that produced rules", () => {
    const configured = appendProjectRuleSnapshot(undefined, project(), { at: 10 });
    const evidenced = appendTemplateApplicationEvidence(
      configured,
      {
        id: "template-a",
        name: "Commercial A",
        kind: "custom",
        devices: ["A Cam"],
        volumePrefix: "A_",
        requiredCopies: 1,
        namingRule: "{card}",
        completionActions: ["report"],
        createdAt: 1,
        updatedAt: 2,
        revision: 4,
      },
      ["requiredCopies"],
      [{ field: "requiredCopies", label: "物理独立副本", before: "2", after: "1" }],
      configured.activeRuleSnapshotId!,
      "DIT Li",
      20,
    );
    expect(evidenced.templateApplications?.[0]).toMatchObject({
      templateId: "template-a",
      templateRevision: 4,
      selectedFields: ["requiredCopies"],
      resultingRuleSnapshotId: configured.activeRuleSnapshotId,
      operator: "DIT Li",
      at: 20,
    });
  });
  it("freezes the rule and closeout summary into a handoff record", () => {
    const configured = recordDailyPlanDecision(
      appendProjectRuleSnapshot(undefined, {
        ...project(),
        shootingDateStart: "2026-08-25",
        shootingDateEnd: "2026-08-25",
      }, { at: 10 }),
      {
        date: "2026-08-25",
        scheduleKey: "A Cam",
        decision: "expected",
        operator: "DIT Li",
        at: 15,
      },
    );
    const handedOff = appendProjectHandoffEvidence(configured, [], {
      operator: "DIT Li",
      note: "Night handoff",
      scope: "day",
      shootingDate: "2026-08-25",
      at: 20,
    });
    expect(handedOff.handoffNotes?.[0]).toMatchObject({
      operator: "DIT Li",
      scope: "day",
      shootingDate: "2026-08-25",
      ruleSnapshotId: configured.activeRuleSnapshotId,
      closeoutEvidence: {
        logicalVolumes: 0,
        compliantVolumes: 0,
        pendingCells: 1,
        unconfirmedCells: 0,
        requiredCopies: 1,
      },
    });
    const changed = appendProjectRuleSnapshot(handedOff, {
      ...handedOff,
      requiredCopies: 2,
    }, { at: 30 });
    expect(changed.handoffNotes?.[0]).toEqual(handedOff.handoffNotes?.[0]);
  });

  it("limits a day handoff evidence summary to that shooting date", () => {
    const configured = appendProjectRuleSnapshot(undefined, {
      ...project(),
      shootingDateStart: "2026-08-25",
      shootingDateEnd: "2026-08-26",
    }, { at: 10 });
    const engine = new BackupEngine();
    const tasks = ["2026-08-25", "2026-08-26"].map((shootingDate) => {
      const task = engine.createTask({
        name: `A001-${shootingDate}`,
        sourcePath: `/tmp/synthetic-source-${shootingDate}`,
        destinationPaths: [`/tmp/synthetic-target-${shootingDate}`],
        devices: ["A Cam"],
        shootingDate,
        hashAlgorithm: "sha256",
        namingTemplate: "{card}",
      });
      task.status = "completed";
      task.destinations[0].verified = true;
      return task;
    });
    const handedOff = appendProjectHandoffEvidence(configured, tasks, {
      operator: "DIT Li",
      note: "First day only",
      scope: "day",
      shootingDate: "2026-08-25",
      at: 20,
    });
    expect(handedOff.handoffNotes?.[0].closeoutEvidence).toMatchObject({
      logicalVolumes: 1,
      compliantVolumes: 1,
    });
    expect(() =>
      appendProjectHandoffEvidence(configured, tasks, {
        operator: "DIT Li",
        note: "Outside the project",
        scope: "day",
        shootingDate: "2026-08-27",
      }),
    ).toThrow(/拍摄周期/);
  });
});
