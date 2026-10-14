import { ArrowRight, Check, ClipboardCheck, Copy, FolderSearch, HardDrive, ShieldCheck, Unplug, TriangleAlert } from "lucide-react";
import type { BackupTask } from "./api";
import { transferEvidenceModel } from "./transfer-evidence-state";

/** Read-only view of recorded transfer evidence. It never starts or changes a task. */
export function TransferEvidence({ task, compact = false }: { task: BackupTask; compact?: boolean }) {
  const model = transferEvidenceModel(task);
  const phaseIcons = { scan: FolderSearch, copy: Copy, verify: ShieldCheck, record: ClipboardCheck };
  return (
    <section className={`transfer-evidence${compact ? " is-compact" : ""}`} aria-label="传输与副本证据">
      <div className="transfer-evidence-header">
        <strong>{model.imported ? "接管与校验证据" : "传输与副本证据"}</strong>
        <span className="transfer-evidence-caption">{model.caption}</span>
      </div>
      <ol className="transfer-evidence-phases" aria-label="任务阶段">
        {model.phases.map((phase) => {
          const Icon = phaseIcons[phase.key as keyof typeof phaseIcons];
          return (
            <li className="transfer-evidence-phase" data-state={phase.state} key={phase.key}>
              <span className="transfer-evidence-phase-icon" aria-hidden="true">
                {phase.state === "complete" ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <div><strong>{phase.label}</strong><span>{phase.detail}</span></div>
            </li>
          );
        })}
      </ol>
      <div className="transfer-evidence-flow">
        <div className="transfer-evidence-source">
          <div className="transfer-evidence-node-title"><FolderSearch size={20} aria-hidden="true" /><strong>{model.sourceLabel}</strong></div>
          <span className="transfer-evidence-node-path mono" title={task.sourcePath}>{task.sourcePath}</span>
          <span className="transfer-evidence-node-metrics">{model.scopeText}</span>
          <span className="transfer-evidence-node-metrics">{task.hashAlgorithm.toUpperCase()} · {model.imported ? "接管时读取证据" : "源与副本哈希比对"}</span>
        </div>
        <ArrowRight className="transfer-evidence-flow-arrow" size={20} aria-hidden="true" />
        <div className="transfer-evidence-targets">
          {model.targets.map((target) => (
            <div className="transfer-evidence-target" data-state={target.state} key={target.id}>
              <div className="transfer-evidence-node-title"><HardDrive size={16} aria-hidden="true" /><strong>{target.label}</strong><span>{target.speedText}</span></div>
              <span className="transfer-evidence-node-path mono" title={target.path}>{target.path}</span>
              <div className="transfer-evidence-progress">
                <span>{target.imported ? "来源" : "复制"}<strong>{target.copyText}</strong></span>
                {target.copyProgress !== undefined && <progress className="transfer-evidence-copy-progress" max={100} value={target.copyProgress} aria-label={`${target.label} 复制进度`} />}
                <span>回读<strong>{target.verifyText}</strong></span>
                {target.verifyProgress !== undefined && <progress className="transfer-evidence-verify-progress" max={100} value={target.verifyProgress} aria-label={`${target.label} 回读进度`} />}
              </div>
              <span className="transfer-evidence-node-metrics">{target.savedText} · {target.readText}</span>
              <span className="transfer-evidence-target-result">{target.result}</span>
            </div>
          ))}
          {!model.targets.length && <div className="transfer-evidence-target" data-state="attention"><Unplug size={16} aria-hidden="true" /><span>尚无目的地记录</span></div>}
        </div>
      </div>
      <div className="transfer-evidence-facts">
        {model.facts.map((fact) => (
          <div className="transfer-evidence-fact" data-state={fact.state} key={fact.key}>
            <span>{fact.label}</span><strong>{fact.value}</strong><span>{fact.detail}</span>
          </div>
        ))}
      </div>
      {model.permissionCount > 0 && <p className="transfer-evidence-scope-warning"><TriangleAlert size={16} aria-hidden="true" /><span>素材源有 {model.permissionCount} 项因权限未纳入。范围内校验不证明源范围完整，不计整卡达标副本。</span></p>}
      {task.status === "failed" && <p className="transfer-evidence-scope-warning"><TriangleAlert size={16} aria-hidden="true" /><span>{task.errorMessage || "本次任务失败。个别目标的历史通过记录不能代替完整任务结果。"}</span></p>}
    </section>
  );
}
