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

export interface WindowBounds extends WorkAreaSize {
  x: number;
  y: number;
}

export const MAIN_WINDOW_ASPECT = { min: 1.4, max: 2 } as const;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function windowLimits(workArea: WorkAreaSize) {
  const availableWidth = Math.max(1, Math.floor(workArea.width));
  const availableHeight = Math.max(1, Math.floor(workArea.height));
  const maxWidth = Math.min(
    availableWidth,
    Math.floor(availableHeight * MAIN_WINDOW_ASPECT.max),
  );
  const maxHeight = Math.max(
    1,
    Math.min(
      availableHeight,
      Math.floor(availableWidth / MAIN_WINDOW_ASPECT.min),
    ),
  );
  return {
    maxWidth,
    maxHeight,
    minWidth: Math.min(1080, maxWidth),
    minHeight: Math.min(720, maxHeight),
  };
}

/** A ratio band (not a fixed ratio) preserves useful resizing freedom. Only
 * constrain normal windows; full-screen/maximized bounds belong to the OS. */
export function constrainMainWindowBounds(
  proposed: WindowBounds,
  workArea: WindowBounds,
  edge = "bottom",
  previous?: WindowBounds,
): WindowBounds {
  const { minWidth, minHeight, maxWidth, maxHeight } = windowLimits(workArea);
  let width = clamp(Math.round(proposed.width), minWidth, maxWidth);
  let height = clamp(Math.round(proposed.height), minHeight, maxHeight);
  if (edge.includes("left") || edge.includes("right")) {
    width = clamp(
      width,
      Math.max(minWidth, Math.ceil(height * MAIN_WINDOW_ASPECT.min)),
      Math.min(maxWidth, Math.floor(height * MAIN_WINDOW_ASPECT.max)),
    );
  } else {
    height = clamp(
      height,
      Math.max(minHeight, Math.ceil(width / MAIN_WINDOW_ASPECT.max)),
      Math.min(maxHeight, Math.floor(width / MAIN_WINDOW_ASPECT.min)),
    );
  }
  // macOS reports only right/bottom, including drags from left/top edges.
  const fromLeft =
    edge.includes("left") ||
    (edge === "right" && previous !== undefined && proposed.x !== previous.x);
  const fromTop =
    edge.includes("top") ||
    (edge === "bottom" && previous !== undefined && proposed.y !== previous.y);
  return {
    x: clamp(
      fromLeft ? proposed.x + proposed.width - width : proposed.x,
      workArea.x,
      workArea.x + workArea.width - width,
    ),
    y: clamp(
      fromTop ? proposed.y + proposed.height - height : proposed.y,
      workArea.y,
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

/** Keep the first window inside the usable display while preserving the
 * smallest layout covered by the renderer's compact breakpoints. */
export function mainWindowLayout(workArea: WorkAreaSize): MainWindowLayout {
  const { minWidth, minHeight } = windowLimits(workArea);
  const { width, height } = constrainMainWindowBounds(
    { x: 0, y: 0, width: 1480, height: 960 },
    { x: 0, y: 0, ...workArea },
  );
  return {
    width,
    height,
    minWidth,
    minHeight,
  };
}
