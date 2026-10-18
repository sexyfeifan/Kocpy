import { ChevronRight, RefreshCw } from "lucide-react";
import { APP_VERSION } from "../../common/version";

// Keep this summary specific to the installed build. Historical release notes
// remain in GitHub, not in the working guide or the application's bundle.
export function LatestReleaseNote() {
  return (
    <section className="help-release-note" aria-label="当前版本更新">
      <RefreshCw size={20} aria-hidden="true" />
      <div className="help-release-list">
        <strong>本次更新</strong>
        <small>只显示当前安装版本的更新摘要</small>
        <details className="help-release-item">
          <summary>
            <span><b>{APP_VERSION}</b><strong>说明精简与宽屏布局优化</strong></span>
            <ChevronRight size={15} aria-hidden="true" />
          </summary>
          <div>
            <p>使用说明只保留当前版本更新摘要；功能章节按操作流程阅读，不再标注功能产生的版本号。章节仍默认收起，点击后展开。</p>
            <p>恢复中心与诊断中心的内层卡片增加统一留白，长名称与操作区可换行，避免贴边和粘连。仅做只读检查后关闭恢复窗口，不再误报未提交输入；真正输入的离开确认仍保留。</p>
            <p>设置页在宽屏下居中分为两列，窄窗口回到单列；保存操作与作者平台底栏保持完整可达。备份、校验与恢复规则不变。</p>
          </div>
        </details>
      </div>
    </section>
  );
}
