import { describe, expect, it } from "vitest";
import {
  constrainMainWindowBounds,
  mainWindowLayout,
  MAIN_WINDOW_ASPECT,
} from "../src/main/window-layout";

describe("main window layout", () => {
  it("opens at the full design size on a large display", () => {
    expect(mainWindowLayout({ width: 1728, height: 1080 })).toEqual({
      width: 1480,
      height: 960,
      minWidth: 1080,
      minHeight: 720,
    });
  });

  it("never opens outside a smaller usable display", () => {
    expect(mainWindowLayout({ width: 1280, height: 800 })).toEqual({
      width: 1280,
      height: 800,
      minWidth: 1080,
      minHeight: 720,
    });
  });

  it("reduces the minimum together with an unusually small work area", () => {
    expect(mainWindowLayout({ width: 1024, height: 680 })).toEqual({
      width: 1024,
      height: 680,
      minWidth: 1024,
      minHeight: 680,
    });
  });

  const area = { x: 0, y: 25, width: 2560, height: 1400 };
  it("stops a horizontal drag at both ratio limits without changing height", () => {
    expect(
      constrainMainWindowBounds(
        { x: 30, y: 40, width: 2400, height: 800 },
        area,
        "right",
      ),
    ).toEqual({ x: 30, y: 40, width: 1600, height: 800 });
    expect(
      constrainMainWindowBounds(
        { x: 30, y: 40, width: 1080, height: 900 },
        area,
        "right",
      ).width,
    ).toBe(1260);
  });

  it("stops vertical resizing without changing width", () => {
    const tall = constrainMainWindowBounds(
      { x: 30, y: 40, width: 1400, height: 1380 },
      area,
      "bottom",
    );
    expect(tall).toEqual({ x: 30, y: 40, width: 1400, height: 1000 });
    const wide = constrainMainWindowBounds(
      { x: 30, y: 40, width: 2000, height: 720 },
      area,
      "bottom",
    );
    expect(wide.height).toBe(1000);
  });

  it("keeps the opposite edge anchored, including macOS left/top drags", () => {
    const previous = { x: 400, y: 200, width: 1400, height: 800 };
    const left = { x: 100, y: 200, width: 1700, height: 800 };
    expect(constrainMainWindowBounds(left, area, "left")).toEqual({
      x: 200,
      y: 200,
      width: 1600,
      height: 800,
    });
    expect(constrainMainWindowBounds(left, area, "right", previous)).toEqual({
      x: 200,
      y: 200,
      width: 1600,
      height: 800,
    });
    expect(
      constrainMainWindowBounds(
        { x: 400, y: 25, width: 1400, height: 1075 },
        area,
        "bottom",
        previous,
      ),
    ).toEqual({ x: 400, y: 100, width: 1400, height: 1000 });
  });

  it("preserves ordinary sizes, handles negative display coordinates, and is idempotent", () => {
    const display = { x: -1920, y: 25, width: 1920, height: 1055 };
    const input = { x: -1800, y: 80, width: 1200, height: 800 };
    expect(constrainMainWindowBounds(input, display)).toEqual(input);
    const fitted = constrainMainWindowBounds(
      { x: -2500, y: 0, width: 2500, height: 1800 },
      display,
    );
    expect(constrainMainWindowBounds(fitted, display)).toEqual(fitted);
    expect(fitted.x).toBeGreaterThanOrEqual(display.x);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(
      display.y + display.height,
    );
  });

  it("keeps startup and resize geometry feasible on small, portrait and ultrawide work areas", () => {
    for (const width of [640, 800, 1024, 1080, 1280, 1728, 2560, 3440]) {
      for (const height of [480, 680, 720, 800, 1055, 1400, 2560]) {
        const workArea = { x: -100, y: 25, width, height };
        const initial = mainWindowLayout(workArea);
        expect(initial.width).toBeLessThanOrEqual(width);
        expect(initial.height).toBeLessThanOrEqual(height);
        for (const edge of [
          "left",
          "right",
          "top",
          "bottom",
          "top-left",
          "bottom-right",
        ]) {
          for (const size of [
            { width: 200, height: 3000 },
            { width: 3500, height: 100 },
            initial,
          ]) {
            const bounds = constrainMainWindowBounds(
              { x: 0, y: 0, ...size },
              workArea,
              edge,
            );
            expect(bounds.width / bounds.height).toBeGreaterThanOrEqual(
              MAIN_WINDOW_ASPECT.min,
            );
            expect(bounds.width / bounds.height).toBeLessThanOrEqual(
              MAIN_WINDOW_ASPECT.max,
            );
            expect(bounds.width).toBeGreaterThanOrEqual(initial.minWidth);
            expect(bounds.height).toBeGreaterThanOrEqual(initial.minHeight);
            expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
            expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(
              workArea.x + width,
            );
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(
              workArea.y + height,
            );
          }
        }
      }
    }
  });
});
