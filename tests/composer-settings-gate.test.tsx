import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("backup composer settings gate", () => {
  it("does not open a composer before persisted settings are ready", async () => {
    vi.stubGlobal("window", { api: {} });
    const { requestComposerWhenSettingsReady } = await import(
      "../src/renderer/src/App"
    );
    const opened: Array<{ source?: string }> = [];

    expect(
      requestComposerWhenSettingsReady(false, { source: "/card" }, (value) =>
        opened.push(value),
      ),
    ).toBe(false);
    expect(opened).toEqual([]);

    expect(
      requestComposerWhenSettingsReady(true, { source: "/card" }, (value) =>
        opened.push(value),
      ),
    ).toBe(true);
    expect(opened).toEqual([{ source: "/card" }]);
  });

  it("renders the primary new-backup entry disabled during initial loading", async () => {
    vi.stubGlobal("window", { api: {} });
    const { App } = await import("../src/renderer/src/App");
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toMatch(
      /<button[^>]*class="btn primary new-button"[^>]*disabled=""/,
    );
    expect(markup).toContain("正在读取偏好设置，请稍候");
  });

  it("captures automatic-PDF false as an editable draft default", async () => {
    vi.stubGlobal("window", { api: {} });
    const { composerDefaultsFromSettings } = await import(
      "../src/renderer/src/Composer"
    );
    const saved = {
      defaultHash: "sha256" as const,
      defaultDuplicateStrategy: "skip" as const,
      includeHidden: true,
      automaticPdf: false,
      operator: "",
      theme: "dark" as const,
      reportSyncPath: "",
      thumbnailCacheGiB: 2,
      notificationSound: true,
    };
    const draftDefaults = composerDefaultsFromSettings(saved);

    saved.automaticPdf = true;
    expect(draftDefaults.automaticPdf).toBe(false);
  });
});
