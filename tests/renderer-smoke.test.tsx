import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
describe("renderer initial render (not a substitute for desktop acceptance)", () => {
  it("renders the app and independent workflow forms without crashing", async () => {
    vi.stubGlobal("window", { api: {} });
    const { App } = await import("../src/renderer/src/App");
    const { LifecycleControls } = await import(
      "../src/renderer/src/LifecycleControls"
    );
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
