import { afterEach, describe, expect, it, vi } from "vitest";
import { modalDialogSelector } from "../src/common/dialog";
const lifecycle = vi.hoisted(() => ({ cleanup: undefined as undefined | (() => void) }));
vi.mock("react", () => ({ useEffect: (setup: () => (() => void)) => { lifecycle.cleanup = setup(); } }));
import { useModalStack } from "../src/renderer/src/Interaction";

afterEach(() => { lifecycle.cleanup?.(); lifecycle.cleanup = undefined; vi.unstubAllGlobals(); });

/** Runs the actual document-capture handlers installed by useModalStack.
 * Native React/portal layout and focus behavior also have an isolated Electron check. */
function install() {
  const handlers = new Map<string, (event: any) => void>(), keys = new Map<string, (event: any) => void>();
  const confirm = vi.fn(() => false), body = {}, noticeRoot = {}, buttons: any[] = [];
  const document: any = { body, activeElement: body,
    querySelectorAll: () => [dialog],
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    removeEventListener: vi.fn(),
  };
  const dialog: any = { dataset: {}, tabIndex: -1, isConnected: true,
    getClientRects: () => [{}], getAttribute: (key: string) => key === "role" ? "dialog" : null,
    hasAttribute: () => true, setAttribute: vi.fn(), querySelector: () => null,
    querySelectorAll: () => buttons, focus: () => { document.activeElement = dialog; },
  };
  const button = (name: string, notice: boolean) => {
    const node: any = { textContent: name, isConnected: true, dataset: {}, classList: { contains: () => false },
      closest: (selector: string) => selector === "button" ? node : selector === ".modal-notices" ? (notice ? noticeRoot : null) : selector === modalDialogSelector ? dialog : null,
      getAttribute: () => null, hasAttribute: () => false, getClientRects: () => [{}],
      matches: () => false, click: vi.fn(), focus: () => { document.activeElement = node; },
    }; buttons.push(node); return node;
  };
  const closeNotice = button("关闭提示", true), viewNotice = button("查看详情", true), closeDialog = button("关闭窗口", false);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { confirm, addEventListener: (name: string, handler: (event: any) => void) => keys.set(name, handler), removeEventListener: vi.fn() });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  useModalStack();
  const click = (target: any) => { const event = { target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }; handlers.get("click")!(event); return event; };
  return { confirm, closeNotice, viewNotice, closeDialog, click, dialog, button,
    dirty: () => handlers.get("input")!({ target: { closest: () => dialog } }),
    escape: () => keys.get("keydown")!({ key: "Escape", preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }),
  };
}

describe("notice actions inside dirty dialogs", () => {
  it("does not mark read-only detail actions dirty but still protects actual typed input", () => {
    const state = install(); state.dialog.dataset.dirtyTracking = "inputs";
    state.click(state.button("重新校验", false));
    state.click(state.closeDialog);
    expect(state.confirm).not.toHaveBeenCalled();
    state.dirty(); state.click(state.closeDialog);
    expect(state.confirm).toHaveBeenCalledTimes(1);
  });
  it("still protects button-driven wizard draft choices by default", () => {
    const state = install(); state.click(state.button("选择拍摄日", false));
    state.click(state.closeDialog); expect(state.confirm).toHaveBeenCalledTimes(1);
  });
  it("dismisses a notice without asking to discard form edits, while preserving true close protection", () => {
    const state = install(); state.dirty();
    const notice = state.click(state.closeNotice);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(notice.preventDefault).not.toHaveBeenCalled();
    expect(notice.stopImmediatePropagation).not.toHaveBeenCalled();
    const realClose = state.click(state.closeDialog);
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(realClose.preventDefault).toHaveBeenCalledTimes(1);
    expect(realClose.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("does not mark a clean form dirty merely by clicking a notice action", () => {
    const state = install(); state.click(state.viewNotice); state.click(state.closeNotice);
    expect(state.click(state.closeDialog).preventDefault).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("Escape selects the real window close action, never the portal notice close", () => {
    const state = install(); state.escape();
    expect(state.closeDialog.click).toHaveBeenCalledTimes(1);
    expect(state.closeNotice.click).not.toHaveBeenCalled();
  });
});
