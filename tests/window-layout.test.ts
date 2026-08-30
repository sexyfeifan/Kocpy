import { describe, expect, it } from "vitest";
import { mainWindowLayout } from "../src/main/window-layout";

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
});
