import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modalDialogSelector } from "../../common/dialog";
import "./modal-notices.css";

/** React owns all notice content. Only empty portal hosts are attached to dialogs. */
export function ModalNotices({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement>();
  const focusedNotice = useRef<{ control: HTMLElement; dialog: HTMLElement } | undefined>(undefined);
  const restoreNoticeFocus = () => {
    const remembered = focusedNotice.current;
    if (!remembered || remembered.control.isConnected) return;
    focusedNotice.current = undefined;
    const top = [...document.querySelectorAll<HTMLElement>(modalDialogSelector)]
      .filter(node => node.getClientRects().length > 0).at(-1);
    if (top === remembered.dialog &&
        (document.activeElement === document.body || !document.activeElement?.isConnected)) top.focus();
  };
  // Includes timer-driven toast removal, not only a user's click on dismiss.
  useLayoutEffect(restoreNoticeFocus);
  useLayoutEffect(() => {
    const hosts = new Map<HTMLElement, HTMLElement>();
    let current: HTMLElement | undefined;
    const sync = () => {
      for (const [dialog, node] of hosts) {
        if (!dialog.isConnected) { node.remove(); hosts.delete(dialog); }
      }
      const dialog = [...document.querySelectorAll<HTMLElement>(modalDialogSelector)]
        .filter(node => node.getClientRects().length > 0).at(-1);
      let next = dialog && hosts.get(dialog);
      if (dialog && !next) {
        next = document.createElement("div");
        next.className = "modal-notices-host";
        // All app dialogs have a header or a first content element. An empty
        // host after the header participates in layout, never overlays a footer.
        const header = dialog.querySelector(":scope > .modal-header");
        dialog.insertBefore(next, header ? header.nextSibling : dialog.firstChild);
        hosts.set(dialog, next);
      }
      if (next !== current) { current = next; setHost(next); }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      const remembered = focusedNotice.current;
      if (remembered && hosts.get(remembered.dialog)?.contains(document.activeElement)) {
        const top = [...document.querySelectorAll<HTMLElement>(modalDialogSelector)]
          .filter(node => node.getClientRects().length > 0).at(-1);
        if (top === remembered.dialog) top.focus();
      }
      for (const node of hosts.values()) node.remove();
    };
  }, []);
  const notices = <div className={`modal-notices ${host ? "is-dialog" : "is-floating"}`} aria-label="操作提示" onFocusCapture={event => {
    const dialog = host?.parentElement;
    if (dialog) focusedNotice.current = { control: event.target as HTMLElement, dialog };
  }}>{children}</div>;
  return host ? createPortal(notices, host) : notices;
}
