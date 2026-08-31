import type { BrowserWindow, Screen } from "electron";
import { constrainMainWindowBounds, mainWindowLayout } from "./window-layout";

const dimensions = ["x", "y", "width", "height"] as const;

/** Main workspace only: never constrain print/report windows or OS full screen. */
export function installMainWindowConstraints(
  window: BrowserWindow,
  screen: Screen,
) {
  const isNormal = () =>
    !window.isDestroyed() && !window.isFullScreen() && !window.isMaximized();
  let lastWorkArea = "";
  const fitDisplay = (force = false) => {
    if (!isNormal()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const key = JSON.stringify(area);
    if (!force && key === lastWorkArea) return;
    lastWorkArea = key;
    const { minWidth, minHeight } = mainWindowLayout(area);
    window.setMinimumSize(minWidth, minHeight);
    const fitted = constrainMainWindowBounds(bounds, area);
    if (dimensions.some((key) => fitted[key] !== bounds[key]))
      window.setBounds(fitted);
  };
  window.on("will-resize", (event, proposed, details) => {
    if (!isNormal()) return;
    const fitted = constrainMainWindowBounds(
      proposed,
      screen.getDisplayMatching(proposed).workArea,
      details.edge,
      window.getBounds(),
    );
    if (dimensions.some((key) => fitted[key] !== proposed[key])) {
      event.preventDefault();
      // Programmatic setBounds does not emit will-resize.
      window.setBounds(fitted);
    }
  });
  const displayChanged = () => fitDisplay();
  const restored = () => fitDisplay(true);
  window.on("moved", displayChanged);
  window.on("leave-full-screen", restored);
  window.on("unmaximize", restored);
  screen.on("display-metrics-changed", displayChanged);
  screen.on("display-removed", displayChanged);
  window.once("closed", () => {
    screen.removeListener("display-metrics-changed", displayChanged);
    screen.removeListener("display-removed", displayChanged);
  });
  fitDisplay();
}
