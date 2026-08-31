import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
describe("renderer initial render (not a substitute for desktop acceptance)", () => {
  it("renders the app and independent workflow forms without crashing", async () => {
    vi.stubGlobal("window", { api: {} });
    const { App, ProxyQueue } = await import("../src/renderer/src/App");
    const { LifecycleControls } =
      await import("../src/renderer/src/LifecycleControls");
    const { Composer } = await import("../src/renderer/src/Composer");
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
  });
});
