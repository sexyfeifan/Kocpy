import { useEffect, useState } from "react";
import { api, bytes } from "./api";
import type { OperationRecord } from "../../main/operations";
import { readableOperationError } from "../../common/interaction";

export function useModalStack() {
  useEffect(() => {
    const previous = new WeakMap<Element, Element | null>();
    const dirty = new WeakSet<Element>();
    let top: HTMLElement | undefined;
    const dialogs = () =>
      [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
        (node) => node.getClientRects().length > 0,
      );
    const sync = () => {
      const next = dialogs().at(-1);
      if (next === top) return;
      if (top && !top.isConnected)
        (previous.get(top) as HTMLElement | null)?.focus?.();
      top = next;
      if (top && !previous.has(top)) {
        previous.set(top, document.activeElement);
        if (!top.hasAttribute("tabindex")) top.tabIndex = -1;
        top.focus();
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    const input = (event: Event) => {
      const dialog = (event.target as Element).closest?.('[role="dialog"]');
      if (dialog) dirty.add(dialog);
    };
    const closeAllowed = (dialog: HTMLElement) =>
      !dirty.has(dialog) ||
      dialog.getAttribute("aria-busy") === "true" ||
      window.confirm(
        "关闭此窗口会放弃尚未提交的输入。后台已开始的操作不会取消，确认关闭？",
      );
    const click = (event: MouseEvent) => {
      const button = (event.target as Element).closest?.("button");
      const dialog = button?.closest<HTMLElement>('[role="dialog"]');
      if (
        button &&
        dialog &&
        /^(关闭.*|取消|稍后|后台继续)$/.test(
          button.textContent?.trim() || button.title,
        ) &&
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
        ].find(
          (button) =>
            /^(关闭.*|取消|稍后|后台继续)$/.test(
              button.textContent?.trim() || button.title,
            ) || button.title === "关闭",
        );
        close?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
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

export function OperationCenter() {
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      api
        .getOperations()
        .then((values) => {
          if (!stopped) {
            setRecords(values);
            setError("");
          }
        })
        .catch((reason) => {
          if (!stopped) setError(readableOperationError(reason));
        });
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  if (!records.length && !error) return null;
  const running = records.find((record) => record.status === "running");
  return (
    <details className="operation-center" open={running ? true : undefined}>
      <summary>
        {running ? "后台正在执行：" + running.name : "本次运行操作记录"} ·{" "}
        {records.length} 项
      </summary>
      <p className="muted small">
        可切换页面；关闭详情不停止后台操作。写入提交阶段不可强行中断，完成前不允许退出软件或开始冲突任务。
      </p>
      {error && <p role="alert">{error}</p>}
      {[...records].reverse().map((record) => (
        <div key={record.id} className="operation-item">
          <strong>
            {record.name} ·{" "}
            {
              {
                running: "进行中",
                completed: "执行结束 · 请查看结果",
                cancelled: "已取消",
                failed: "未完成",
              }[record.status]
            }
          </strong>
          {record.progress && (
            <span>
              {record.progress.message} ·{" "}
              {record.progress.totalBytes
                ? bytes(record.progress.completedBytes || 0) +
                  " / " +
                  bytes(record.progress.totalBytes)
                : "准备 / 扫描中"}
              {record.progress.speedBps
                ? " · " + bytes(record.progress.speedBps) + "/s"
                : ""}
            </span>
          )}
          {record.status === "running" && (
            <progress
              aria-label={record.name}
              max={record.progress?.totalBytes || undefined}
              value={
                record.progress?.totalBytes
                  ? Math.min(
                      record.progress.completedBytes,
                      record.progress.totalBytes * 0.99,
                    )
                  : undefined
              }
            />
          )}
          {record.result && <span>{record.result}</span>}
          {record.error && <span role="alert">{record.error}</span>}
          <small>{new Date(record.startedAt).toLocaleString()}</small>
        </div>
      ))}
    </details>
  );
}
