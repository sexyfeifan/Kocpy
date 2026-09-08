# Kocpy 0.1.36

本版修复项目规则保存引导与大型 PDF 报告生成问题，不改变素材复制、哈希或逐目的地独立回读校验要求。

## 本版修复

### 项目保存与缺失目录

- 保存前逐项显示安全规则的“原值 → 新值”。真实规则变化必须填写实际修改人，避免提交后才出现难以理解的远程调用错误。
- “保存新规则并创建缺失目录”与“仅保存新规则”明确区分是否创建目录。
- “只补齐原项目目录”仅按已保存规则操作，不采纳表单中尚未保存的新目的地或其他修改。
- 创建前检查全部目的地，遇到目录冲突或离线时停止；补齐只创建缺失文件夹，不移动、覆盖或删除现有素材。

使用时请先核对规则差异：只需补目录就选择补齐原目录；确实要改规则，再填写修改人并保存。修改人和追加式规则快照继续保留。

### 大型 PDF 报告

- 单任务、拍摄日、项目、归档包及完成动作报告统一使用权限受限的唯一临时 HTML 文件，不再把完整明细和缩略图编码为超长 `data:` URL，修复 `ERR_INVALID_URL (-300)`。
- 页面加载后立即清理临时 HTML；异常路径同样执行清理。
- 错误提示限制长度，不再把整份编码报告显示在界面中。报告失败不改变已完成的复制、哈希、回读或任务状态。

升级后可重新导出此前失败的报告，不必仅因 PDF 失败而重新复制素材。

## 下载与升级

- [Apple Silicon：Kocpy-0.1.36-arm64.dmg](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/Kocpy-0.1.36-arm64.dmg)
- [Intel：Kocpy-0.1.36-x64.dmg](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/Kocpy-0.1.36-x64.dmg)
- [SHA256SUMS.txt](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/SHA256SUMS.txt)
- [FFmpeg／x264 对应源码包](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/Kocpy-0.1.36-media-corresponding-source.tar.gz)

先结束当前操作、导出本地数据备份并正常退出，再替换“应用程序”中的 Kocpy。完整步骤见[安装与升级](https://github.com/sexyfeifan/Kocpy/blob/main/docs/INSTALLATION.md)。

## 验证与已知限制

原生 Apple Silicon／Intel CI 均完成 332 项回归、8.4 MB HTML 的实际 PDF 渲染、构建、严格签名结构和包内运行时检查。4 项硬件或压力条件测试跳过，未计为通过。正式附件已回下载核对摘要，并完成隔离 arm64 界面验收；详细证据见[验证记录](https://github.com/sexyfeifan/Kocpy/blob/main/docs/VERIFICATION.md#0136-正式发布验收已完成2026-09-08)。

当前仍**没有 Developer ID 签名或 Apple 公证**；ad-hoc 签名不等于 Apple 来源认证。真实外置物理双盘、NAS、拔盘、睡眠和空间耗尽未因本次修复被重新宣称为已验收。回归测试使用隔离合成数据，不迁移生产记录，不修改真实素材或原始清单。

[完整使用手册](https://github.com/sexyfeifan/Kocpy/blob/main/docs/USER_GUIDE.md) · [文档导航](https://github.com/sexyfeifan/Kocpy/blob/main/docs/README.md)

本文的文档整理不替换已经发布的安装包，不改变本版标签或附件摘要。
