import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
describe("renderer initial render (not a substitute for desktop acceptance)", () => {
  it("renders the app and independent workflow forms without crashing", async () => {
    vi.stubGlobal("window", { api: {} });
    const { App, ProxyQueue, canReverifyTask } =
      await import("../src/renderer/src/App");
    const { LifecycleControls } =
      await import("../src/renderer/src/LifecycleControls");
    const { Composer } = await import("../src/renderer/src/Composer");
    const { BackgroundActivityOverview, BackgroundTasksPage } = await import(
      "../src/renderer/src/BackgroundTasks"
    );
    expect(renderToStaticMarkup(<App />)).toContain("拍摄项目");
    const lifecycle = renderToStaticMarkup(
      <LifecycleControls
        projects={[]}
        tasks={[]}
        notify={() => {}}
        refreshProjects={async () => {}}
      />,
    );
    expect(lifecycle).toContain("检查表");
    expect(lifecycle).toContain("当前项目：");
    expect(lifecycle).toContain("读取共享索引");
    expect(lifecycle).toContain('class="checklist-signoff"');
    expect(lifecycle).toContain('class="lifecycle-tools reminder-tools"');
    expect(lifecycle).toContain('aria-label="归档检查操作"');
    expect(lifecycle).toContain('for="archive-root"');
    expect(lifecycle).toContain('id="archive-root"');
    const proxy = renderToStaticMarkup(
      <ProxyQueue jobs={[]} act={async () => {}} refresh={async () => {}} />,
    );
    expect(proxy).toContain('class="proxy-scope-toolbar"');
    expect(proxy).toContain('aria-describedby="proxy-scope-help"');
    expect(proxy).toContain('aria-label="交付导出"');
    for (const action of [
      "生成交付目录",
      "Resolve CSV",
      "Premiere CSV",
      "Final Cut XML",
    ])
      expect(proxy).toContain(action);
    const composer = renderToStaticMarkup(
      <Composer
        initial={{}}
        volumes={[]}
        projects={[]}
        settings={{
          defaultHash: "sha256",
          defaultDuplicateStrategy: "skip",
          includeHidden: true,
          automaticPdf: true,
          operator: "",
          theme: "dark",
          reportSyncPath: "",
          thumbnailCacheGiB: 2,
          notificationSound: true,
        }}
        onClose={() => {}}
        onCreated={async () => {}}
        onCreateProject={() => {}}
      />,
    );
    expect(composer).toContain("选择素材源");
    expect(composer).toContain("fieldset");
    expect(composer).toMatch(/class="mode-card selected"[^>]*>[\s\S]*?<strong>普通备份<\/strong>/);
    expect(composer).toContain("无需创建项目");
    const policy = {
        version: "complete-v2",
        mode: "complete",
        createdAt: 1,
        includeHidden: true,
        includeAppleDouble: true,
        includeSystemMetadata: true,
        includeEmptyDirectories: true,
        symlinkPolicy: "fail",
        specialFilePolicy: "fail",
      },
      completeEmpty = {
        totalFiles: 0,
        fileRecords: [],
        inventoryPolicy: policy,
        inventoryScope: {
          policy: { ...policy },
          includedFiles: 0,
          includedBytes: 0,
          includedDirectories: 0,
          includedDirectoryPaths: [],
          fingerprint: "a".repeat(64),
        },
      };
    expect(canReverifyTask(completeEmpty as never)).toBe(true);
    expect(
      canReverifyTask({
        ...completeEmpty,
        inventoryScope: undefined,
      } as never),
    ).toBe(false);
    const backgroundActivity = {
      id: "archive-transfer:a",
      sourceId: "a",
      kind: "archive-transfer",
      name: "项目归档",
      state: "running",
      status: "running",
      phase: "copying",
      progress: 0.5,
      completedBytes: 500,
      totalBytes: 1000,
      completedFiles: 2,
      totalFiles: 4,
      currentFile: "Media/clip.mov",
      currentFileBytes: 250,
      currentFileTotalBytes: 500,
      speedBps: 100,
      averageSpeedBps: 90,
      etaSeconds: 5,
      elapsedMs: 5000,
      sourcePath: "/source",
      destinationPath: "/nas/project",
      startedAt: 1,
      route: "maintenance",
    } as const;
    const overview = renderToStaticMarkup(
      <BackgroundActivityOverview
        activities={[backgroundActivity]}
        onOpen={() => {}}
      />,
    );
    expect(overview).toContain("后台活动");
    expect(overview).toContain("Media/clip.mov");
    expect(overview).toContain("当前文件");
    const backgroundPage = renderToStaticMarkup(
      <BackgroundTasksPage
        activities={[backgroundActivity]}
        notices={[]}
        projects={[]}
        onOpenRoute={() => {}}
      />,
    );
    expect(backgroundPage).toContain("后台任务状态");
    expect(backgroundPage).toContain("/nas/project");
  });
});
