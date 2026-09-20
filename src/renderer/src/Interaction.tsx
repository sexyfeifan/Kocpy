import { useEffect } from "react";
import {
  isDialogCloseControl,
  modalDialogSelector,
} from "../../common/dialog";

const focusableControls = (dialog: HTMLElement) =>
  [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[contenteditable="true"],[tabindex="0"]',
    ),
  ].filter(
    (node) =>
      node.getClientRects().length > 0 &&
      node.getAttribute("aria-hidden") !== "true",
  );

export function useModalStack() {
  useEffect(() => {
    const previous = new WeakMap<Element, Element | null>();
    const dirty = new WeakSet<Element>();
    let top: HTMLElement | undefined;
    const dialogs = () =>
      [...document.querySelectorAll<HTMLElement>(modalDialogSelector)].filter(
        (node) => node.getClientRects().length > 0,
      );
    const sync = () => {
      const next = dialogs().at(-1);
      if (next === top) return;
      const nextIsNew = Boolean(next && !previous.has(next));
      if (top && !nextIsNew)
        (previous.get(top) as HTMLElement | null)?.focus?.();
      top = next;
      if (top && !previous.has(top)) {
        const explicitReturnId = top.dataset.returnFocusId;
        const explicitReturn = explicitReturnId
          ? [...document.querySelectorAll<HTMLElement>("[data-focus-id]")].find(
              (node) => node.dataset.focusId === explicitReturnId,
            )
          : undefined;
        previous.set(top, explicitReturn || document.activeElement);
        top.setAttribute("aria-modal", "true");
        if (!top.hasAttribute("tabindex")) top.tabIndex = -1;
        const target =
          top.querySelector<HTMLElement>("[data-initial-focus]") ||
          focusableControls(top).find(
            (node) =>
              !node.matches('[data-dialog-close="true"]') &&
              !node.classList.contains("danger"),
          ) ||
          focusableControls(top)[0] ||
          top;
        requestAnimationFrame(() => {
          if (top === next && target.isConnected) target.focus();
        });
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    const input = (event: Event) => {
      const dialog = (event.target as Element).closest?.(modalDialogSelector);
      if (dialog) dirty.add(dialog);
    };
    const closeAllowed = (dialog: HTMLElement) =>
      dialog.getAttribute("role") === "alertdialog" ||
      !dirty.has(dialog) ||
      dialog.getAttribute("aria-busy") === "true" ||
      window.confirm(
        "关闭此窗口会放弃尚未提交的输入。后台已开始的操作不会取消，确认关闭？",
      );
    const click = (event: MouseEvent) => {
      const button = (event.target as Element).closest?.("button");
      const dialog = button?.closest<HTMLElement>(modalDialogSelector);
      if (
        button &&
        dialog &&
        !button.hasAttribute("disabled") &&
        !isDialogCloseControl(button)
      )
        dirty.add(dialog);
      if (
        button &&
        dialog &&
        isDialogCloseControl(button) &&
        !closeAllowed(dialog)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const key = (event: KeyboardEvent) => {
      const dialog = dialogs().at(-1);
      if (!dialog) return;
      if (event.metaKey && ["n", "N"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const close = [
          ...dialog.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ].find(isDialogCloseControl);
        close?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableControls(dialog);
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === dialog)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("input", input, true);
    document.addEventListener("click", click, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("input", input, true);
      document.removeEventListener("click", click, true);
    };
  }, []);
}
