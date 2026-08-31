import { EventEmitter } from "node:events";
import type { BrowserWindow, Screen } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installMainWindowConstraints } from "../src/main/window-constraints";

function fixture() {
  const window = Object.assign(new EventEmitter(), {
    bounds: { x: 30, y: 40, width: 1480, height: 960 },
    fullScreen: false,
    maximized: false,
    destroyed: false,
    isFullScreen() {
      return this.fullScreen;
    },
    isMaximized() {
      return this.maximized;
    },
    isDestroyed() {
      return this.destroyed;
    },
    getBounds() {
      return this.bounds;
    },
    setMinimumSize: vi.fn(),
    setBounds: vi.fn(function (this: { bounds: unknown }, value) {
      this.bounds = value;
    }),
  });
  const screen = Object.assign(new EventEmitter(), {
    area: { x: 0, y: 25, width: 2560, height: 1400 },
    getDisplayMatching() {
      return { workArea: this.area };
    },
  });
  installMainWindowConstraints(
    window as unknown as BrowserWindow,
    screen as unknown as Screen,
  );
  return { window, screen };
}

describe("main window native constraints", () => {
  it("allows normal manual resizing and intercepts extreme resizing only", () => {
    const { window } = fixture();
    const event = { preventDefault: vi.fn() };
    window.emit(
      "will-resize",
      event,
      { x: 30, y: 40, width: 1300, height: 800 },
      { edge: "right" },
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    window.emit(
      "will-resize",
      event,
      { x: 30, y: 40, width: 2300, height: 800 },
      { edge: "right" },
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.bounds).toEqual({ x: 30, y: 40, width: 1600, height: 800 });
  });

  it("leaves fullscreen/maximize to the OS and reapplies constraints on restore", () => {
    const { window } = fixture();
    for (const state of ["fullScreen", "maximized"] as const) {
      window[state] = true;
      const event = { preventDefault: vi.fn() };
      window.emit(
        "will-resize",
        event,
        { x: 0, y: 0, width: 2560, height: 1400 },
        { edge: "right" },
      );
      expect(event.preventDefault).not.toHaveBeenCalled();
      window[state] = false;
      window.bounds = { x: 0, y: 25, width: 2200, height: 720 };
      window.emit(state === "fullScreen" ? "leave-full-screen" : "unmaximize");
      expect(window.bounds.height).toBe(1100);
    }
  });

  it("fits a moved window or changed display, and removes screen listeners on close", () => {
    const { window, screen } = fixture();
    window.setBounds.mockClear();
    window.emit("moved");
    expect(window.setBounds).not.toHaveBeenCalled();
    screen.area = { x: -1024, y: 25, width: 1024, height: 680 };
    screen.emit("display-metrics-changed");
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(1024, 680);
    expect(window.bounds).toEqual({
      x: -1024,
      y: 25,
      width: 1024,
      height: 680,
    });
    expect(screen.listenerCount("display-removed")).toBe(1);
    window.emit("closed");
    expect(screen.listenerCount("display-removed")).toBe(0);
    expect(screen.listenerCount("display-metrics-changed")).toBe(0);
  });
});
