import { useEffect, useState } from "react";
import {
  Check,
  Download,
  FolderOpen,
  RefreshCw,
  Save,
  ScanLine,
} from "lucide-react";
import {
  api,
  today,
  type ProjectConfig,
  type BackupTask,
  type ArchiveReminder,
  type NasPreset,
  type ArchiveChangeRecord,
} from "./api";
import { Button } from "./App";
import {
  validateArchiveScope,
  readableOperationError,
  type ArchiveScope,
} from "../../common/interaction";
export function LifecycleControls({
  initialProjectId,
  projects,
  tasks,
  notify,
  refreshProjects,
}: {
  initialProjectId?: string;
  projects: ProjectConfig[];
  tasks: BackupTask[];
  notify: (message: string, error?: boolean) => void;
  refreshProjects: () => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(
    projects.find((p) => p.id === initialProjectId)?.id ||
      projects[0]?.id ||
      "",
  );
  const [date, setDate] = useState(today()),
    [phase, setPhase] = useState<"start" | "close">("start");
  const [checked, setChecked] = useState<string[]>([]),
    [operator, setOperator] = useState("");
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  const [scope, setScope] = useState<ArchiveScope["kind"]>("project"),
    [taskId, setTaskId] = useState(""),
    [relative, setRelative] = useState(""),
    [root, setRoot] = useState("");
  const [reminders, setReminders] = useState<ArchiveReminder[]>([]),
    [interval, setIntervalDays] = useState(180);
  const [nas, setNas] = useState<NasPreset[]>([]),
    [nasEdit, setNasEdit] = useState<Partial<NasPreset>>({});
  const [changes, setChanges] = useState<ArchiveChangeRecord[]>([]);
  const [lan, setLan] = useState({
      active: false,
      port: 47821,
      addresses: [] as string[],
      token: "",
    }),
    [showToken, setShowToken] = useState(false);
  const [remoteAddress, setRemoteAddress] = useState(""),
    [remoteToken, setRemoteToken] = useState(""),
    [remote, setRemote] = useState<{
      projects: any[];
      tasks: any[];
      generatedAt: number;
    } | null>(null);
  const project = projects.find((item) => item.id === projectId);
  const items =
    project?.checklists?.filter((item) => item.phase === phase) || [];
  const reload = async () => {
    const [r, n, c, l] = await Promise.all([
      api.getArchiveReminders(),
      api.getNasPresets(),
      api.getArchiveChanges(),
      api.getLanIndexStatus(),
    ]);
    setReminders(r);
    setNas(n);
    setChanges(c);
    setLan(l);
  };
  useEffect(() => {
    void reload().catch((error) => notify(readableOperationError(error), true));
    void api
      .getSettings()
      .then((settings) => setOperator(settings.operator))
      .catch(() => {});
  }, []);
  useEffect(() => {
    setTaskId("");
    setRelative("");
    setChecked([]);
    setDate(project?.shootingDateStart || today());
  }, [projectId]);
  useEffect(() => {
    setChecked([]);
  }, [date, phase]);
  useEffect(() => {
    if (!projects.some((item) => item.id === projectId))
      setProjectId(projects[0]?.id || "");
  }, [projects, projectId]);
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return false;
    setBusy(true);
    setResult("");
    try {
      const value = await action();
      if (value === null || value === false) {
        setResult("已取消，未提交操作");
        return false;
      }
      await reload();
      await refreshProjects();
      const record = (value as any)?.record || value;
      const details =
        (record as any)?.taskCount !== undefined
          ? " · " +
            (record as any).healthyTasks +
            "/" +
            (record as any).taskCount +
            " 项健康"
          : "";
      const text = message + details;
      setResult(text);
      notify(text);
      return true;
    } catch (error) {
      const text = readableOperationError(error);
      setResult(text);
      notify(text, true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setReminder = (enabled = true) =>
    run(
      () =>
        api.saveArchiveReminder({
          id: "reminder-" + projectId,
          projectId,
          intervalDays: interval,
          nextAt: Date.now() + interval * 86400000,
          enabled,
        }),
      "提醒已保存",
    );
  return (
    <div className="lifecycle-controls">
      <section className="panel">
        <h2>检查表、提醒与变化审计</h2>
        <fieldset className="interaction-fieldset" disabled={busy}>
          <div className="lifecycle-tools checklist-fields">
            <label>
              当前项目
              <select
                aria-label="维护项目"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">请选择项目</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              拍摄日期
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label>
              检查阶段
              <select
                value={phase}
                onChange={(e) => setPhase(e.target.value as typeof phase)}
              >
                <option value="start">开工检查</option>
                <option value="close">收工检查</option>
              </select>
            </label>
            <label>
              签署人
              <input
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                placeholder="实际操作人姓名"
              />
            </label>
          </div>
          <div className="checklist-items">
            {items.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={checked.includes(item.id)}
                  onChange={(e) =>
                    setChecked((all) =>
                      e.target.checked
                        ? [...all, item.id]
                        : all.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  {item.label}
                  {item.required ? "（必选）" : "（可选）"}
                </span>
              </label>
            ))}
            {!items.length && (
              <p className="muted">
                该阶段没有检查项，请在项目设置或模板中配置后再签署。
              </p>
            )}
          </div>
          <div className="checklist-signoff">
            <Button
              kind="primary"
              disabled={
                !project ||
                !operator.trim() ||
                !items.length ||
                items.some(
                  (item) => item.required && !checked.includes(item.id),
                )
              }
              onClick={() =>
                void run(
                  () =>
                    api.signProjectChecklist(projectId, {
                      date,
                      phase,
                      completed: checked,
                      operator: operator.trim(),
                      signature: operator.trim(),
                    }),
                  "检查表已签署",
                ).then((ok) => {
                  if (ok) setChecked([]);
                })
              }
            >
              <Check size={14} />
              确认以上项目并签署
            </Button>
            <p className="muted small">
              逐项确认后才可签署；收工时后台还会检查素材副本。失败时保留填写内容。
            </p>
          </div>
          <details className="checklist-history">
            <summary>
              查看签署记录（{project?.checklistRuns?.length || 0}）
            </summary>
            {[...(project?.checklistRuns || [])].reverse().map((item) => (
              <p key={item.id}>
                {item.date} · {item.phase === "close" ? "收工" : "开工"} ·{" "}
                {item.operator} · {item.completed.length} 项 · 规则{" "}
                {project?.ruleSnapshots?.find(
                  (snapshot) => snapshot.id === item.ruleSnapshotId,
                )?.revision
                  ? "v" + project.ruleSnapshots.find(
                      (snapshot) => snapshot.id === item.ruleSnapshotId,
                    )!.revision
                  : "旧记录未快照"}
              </p>
            ))}
          </details>
          <div className="lifecycle-tools reminder-tools">
            <label>
              复校验间隔（天）
              <input
                type="number"
                min={1}
                max={3650}
                value={interval}
                onChange={(e) =>
                  setIntervalDays(
                    Math.max(1, Math.min(3650, Number(e.target.value))),
                  )
                }
              />
            </label>
            <Button disabled={!project} onClick={() => void setReminder()}>
              <Save size={14} />
              保存 / 更新提醒
            </Button>
            <Button
              disabled={!project}
              onClick={() =>
                void run(
                  () => api.exportArchiveChanges(projectId),
                  "变化报告已导出",
                )
              }
            >
              <Download size={14} />
              导出该项目变化报告
            </Button>
          </div>
          {reminders
            .filter((item) => item.projectId === projectId)
            .map((item) => (
              <div className="row" key={item.id}>
                <span>
                  {item.enabled ? "启用" : "停用"} · 每 {item.intervalDays} 天 ·
                  下次 {new Date(item.nextAt).toLocaleDateString()}
                </span>
                <Button onClick={() => setIntervalDays(item.intervalDays)}>
                  编辑间隔
                </Button>
                <Button
                  onClick={() =>
                    void run(
                      () =>
                        api.saveArchiveReminder({
                          ...item,
                          enabled: !item.enabled,
                        }),
                      "提醒状态已更新",
                    )
                  }
                >
                  {item.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  onClick={() => {
                    if (window.confirm("删除此复校验提醒？不删除素材和记录。"))
                      void run(
                        () => api.deleteArchiveReminder(item.id),
                        "提醒已删除",
                      );
                  }}
                >
                  删除
                </Button>
              </div>
            ))}
        </fieldset>
        {changes
          .filter((item) => item.projectId === projectId)
          .slice(-8)
          .reverse()
          .map((item) => (
            <p key={item.id} className="small">
              {new Date(item.at).toLocaleString()} · {item.note}
            </p>
          ))}
      </section>
      <section className="panel">
        <h2>分级归档复校验</h2>
        <p>
          当前项目：{project?.name || "未选择"}
          。先确认范围，再重新读取已有副本；不会把空选择扩大到整个项目。
        </p>
        <fieldset className="interaction-fieldset" disabled={busy}>
          <div className="lifecycle-tools archive-scope-fields">
            <label>
              范围
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setTaskId("");
                  setRelative("");
                }}
              >
                {[
                  ["project", "整个项目"],
                  ["day", "所选拍摄日"],
                  ["card", "单张素材卷"],
                  ["file", "单个文件"],
                  ["disk", "磁盘中的已记录副本"],
                ].map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {scope === "day" && (
              <label>
                拍摄日期
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            )}
            {["card", "file"].includes(scope) && (
              <label>
                素材卷
                <select
                  value={taskId}
                  onChange={(e) => {
                    setTaskId(e.target.value);
                    setRelative("");
                  }}
                >
                  <option value="">请选择素材卷</option>
                  {tasks
                    .filter((task) => task.projectId === projectId)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.shootingDate} · {task.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {scope === "file" && (
              <label>
                文件相对路径
                <input
                  value={relative}
                  onChange={(e) => setRelative(e.target.value)}
                  placeholder="必须属于所选素材卷"
                />
              </label>
            )}
            <div className="archive-root-field lifecycle-field">
              <label htmlFor="archive-root">磁盘 / 扫描根目录</label>
              <span className="directory-picker">
                <input
                  id="archive-root"
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder="/Volumes/归档盘"
                />
                <Button
                  onClick={() =>
                    void api
                      .selectDirectory()
                      .then((value) => value && setRoot(value))
                      .catch((error) =>
                        notify(readableOperationError(error), true),
                      )
                  }
                >
                  <FolderOpen size={14} />
                  选择目录
                </Button>
              </span>
            </div>
          </div>
          <div
            className="lifecycle-actions"
            role="group"
            aria-label="归档检查操作"
          >
            <Button
              kind="primary"
              disabled={
                (scope !== "disk" && !project) ||
                (["card", "file"].includes(scope) && !taskId) ||
                (scope === "file" && !relative.trim()) ||
                (scope === "disk" && !root.trim())
              }
              onClick={() =>
                void run(
                  () =>
                    api.verifyArchiveScope(
                      validateArchiveScope({
                        kind: scope,
                        projectId,
                        shootingDate: date,
                        taskId,
                        relativePath: relative,
                        volumePath: root,
                      }),
                    ),
                  "复校验已执行",
                )
              }
            >
              <RefreshCw size={14} />
              确认范围并复校验
            </Button>
            <Button
              disabled={!project || !root}
              onClick={() =>
                void run(
                  () => api.auditUntrackedArchive(projectId, root),
                  "未记录文件扫描已结束；见变化记录",
                )
              }
            >
              <ScanLine size={14} />
              扫描未记录文件
            </Button>
          </div>
        </fieldset>
        {result && (
          <p className="notice" role="status">
            {result}
          </p>
        )}
        {busy && (
          <p role="status">
            操作进行中；进度在上方“后台操作”中持续保留，可切换页面。
          </p>
        )}
      </section>
      <section className="panel">
        <h2>NAS 目标预设</h2>
        <p className="muted">
          先在 Finder 挂载网络共享，再保存路径。预设仅复用路径，不保存账号密码。
        </p>
        <fieldset className="interaction-fieldset" disabled={busy}>
          <div className="lifecycle-tools">
            <input
              aria-label="NAS 名称"
              placeholder="易识别的预设名称"
              value={nasEdit.name || ""}
              onChange={(e) =>
                setNasEdit((value) => ({ ...value, name: e.target.value }))
              }
            />
            <input
              aria-label="NAS 路径"
              placeholder="/Volumes/ProductionNAS"
              value={nasEdit.path || ""}
              onChange={(e) =>
                setNasEdit((value) => ({ ...value, path: e.target.value }))
              }
            />
            <Button
              onClick={() =>
                void api
                  .selectDirectory()
                  .then(
                    (path) =>
                      path && setNasEdit((value) => ({ ...value, path })),
                  )
                  .catch((error) => notify(readableOperationError(error), true))
              }
            >
              选择已挂载目录
            </Button>
            <Button
              disabled={!nasEdit.path?.startsWith("/") || !nasEdit.name?.trim()}
              onClick={() =>
                void run(
                  () =>
                    api.saveNasPreset({
                      id: nasEdit.id || crypto.randomUUID(),
                      name: nasEdit.name!.trim(),
                      path: nasEdit.path!,
                      protocol: nasEdit.protocol || "network",
                      createdAt: nasEdit.createdAt || Date.now(),
                    }),
                  "NAS 预设已保存",
                ).then((ok) => {
                  if (ok) setNasEdit({});
                })
              }
            >
              保存预设
            </Button>
          </div>
          {nas.map((item) => (
            <div className="nas-preset-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p className="mono">{item.path}</p>
                <small>
                  {item.online === undefined
                    ? "尚未检查"
                    : item.online
                      ? "上次检查在线"
                      : "上次检查离线"}
                </small>
              </div>
              <div className="row">
                <Button onClick={() => setNasEdit(item)}>编辑</Button>
                <Button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(item.path)
                      .then(() => notify("路径已复制，可粘贴为备份目的地"))
                      .catch((error) =>
                        notify(readableOperationError(error), true),
                      )
                  }
                >
                  复制路径
                </Button>
                <Button
                  onClick={() =>
                    void run(
                      () => api.testNasPreset(item.id),
                      "网络读写检查已执行",
                    )
                  }
                >
                  读写检查
                </Button>
                <Button
                  onClick={() =>
                    void run(() => api.deleteNasPreset(item.id), "预设已删除")
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </fieldset>
      </section>
      <section className="panel">
        <h2>局域网只读项目索引</h2>
        <p>只共享脱敏元数据，不传输素材。仅在可信局域网使用。</p>
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              async () => {
                const value = lan.active
                  ? await api.stopLanIndex()
                  : await api.startLanIndex();
                setLan(value);
                setShowToken(false);
                return value;
              },
              lan.active ? "共享已停止" : "只读索引已启动",
            )
          }
        >
          {lan.active ? "停止共享" : "开始共享"}
        </Button>
        {lan.active && (
          <div>
            <p className="mono">
              {lan.addresses
                .map(
                  (address) => "http://" + address + ":" + lan.port + "/index",
                )
                .join(" · ")}
            </p>
            <Button onClick={() => setShowToken((value) => !value)}>
              {showToken ? "隐藏令牌" : "显示访问令牌"}
            </Button>
            {showToken && (
              <p className="mono">Authorization: Bearer {lan.token}</p>
            )}
            <p className="small muted">
              另一台 Mac 须位于同一网络。访问上述地址时添加 Authorization:
              Bearer
              请求头；普通浏览器直接打开不会携带令牌。也可以在下方“查看另一台工作站”填写地址和令牌，直接读取，无需命令行。令牌重启共享后失效，请勿发到公共渠道。
            </p>
          </div>
        )}
        <details>
          <summary>查看另一台工作站（只读，不合并记录）</summary>
          <div className="lifecycle-tools">
            <input
              aria-label="另一工作站地址"
              placeholder="http://192.168.1.10:47821/index"
              value={remoteAddress}
              onChange={(e) => setRemoteAddress(e.target.value)}
            />
            <input
              aria-label="访问令牌"
              type="password"
              autoComplete="off"
              value={remoteToken}
              onChange={(e) => setRemoteToken(e.target.value)}
              placeholder="对方提供的令牌"
            />
            <Button
              disabled={busy || !remoteAddress || !remoteToken}
              onClick={() =>
                void run(async () => {
                  const data = await api.readLanIndex(
                    remoteAddress,
                    remoteToken,
                  );
                  setRemote(data);
                  return data;
                }, "只读索引已加载")
              }
            >
              读取共享索引
            </Button>
          </div>
          {remote && (
            <div>
              <p>
                {remote.projects.length} 个项目 / {remote.tasks.length}{" "}
                个任务（不含素材内容）
              </p>
              {remote.projects.slice(0, 100).map((item) => (
                <p key={item.id}>
                  {String(item.name)} ·{" "}
                  {
                    remote.tasks.filter((task) => task.projectId === item.id)
                      .length
                  }{" "}
                  个任务
                </p>
              ))}
            </div>
          )}
        </details>
      </section>
    </div>
  );
}
