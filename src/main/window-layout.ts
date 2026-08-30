export interface WorkAreaSize {
  width: number;
  height: number;
}

export interface MainWindowLayout {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/** Keep the first window inside the usable display while preserving the
 * smallest layout covered by the renderer's compact breakpoints. */
export function mainWindowLayout(workArea: WorkAreaSize): MainWindowLayout {
  const availableWidth = Math.max(900, Math.floor(workArea.width)),
    availableHeight = Math.max(640, Math.floor(workArea.height)),
    minWidth = Math.min(1080, availableWidth),
    minHeight = Math.min(720, availableHeight);
  return {
    width: Math.max(minWidth, Math.min(1480, availableWidth)),
    height: Math.max(minHeight, Math.min(960, availableHeight)),
    minWidth,
    minHeight,
  };
}
