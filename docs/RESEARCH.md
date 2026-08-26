# 调研与设计决策

调研日期：2026-08-27。

## 本地参考

### DiskHop

Electron / React 应用；重点是轻量备份、设备槽位、项目、历史与 SHA-256 报告。阅读了 README、主进程、BackupEngine 及页面结构。原实现声明并行，但目标拷贝循环实际按目标顺序执行。新应用采用同文件多目标并行、任务串行的清晰策略。

### Kocpy 1.14.4

阅读了入口、IPC、存储、类型、核心备份引擎、转码、报告和测试。沿用原 `.icns` 图标、共享记录字段与报告模板基础；重新实现队列、拷贝及校验逻辑。原因包括原实现的重复文件校验与 checksum Promise 等待风险、取消状态不准确、重试计数和原子存储并发问题。

## 公开资料

- Kocard 官方：https://www.kocard.net/ 及 https://www.kocard.net/kocardDit/ 。理解备份、处理、归档的整体工作流。
- 用户给的 GitHub：https://github.com/fdgjut797/kocard 。仅含介绍文章，不是 Kocard 软件源码；不当作官方技术规格或许可证来源。
- Hedge OffShoot Verification：https://docs.hedge.video/offshoot/features/verification 。借鉴校验模式必须有明确含义、独立回读源与目的地的安全原则。
- Hedge Logging：https://docs.hedge.video/offshoot/features/logging 。借鉴可追溯日志与清单思路，未复制或宣称实现 ASC MHL 标准。
- Pomfort Silverstack copy process：https://kb.pomfort.com/silverstack/offloadandbackup/how-does-silverstacks-copy-process-work/ 。参考拷贝和校验状态分离、多目的地完整性验证，以及校验会增加读取耗时的说明。

## 本机 Kocard 操作观察

仅查看现有任务概览与新建任务弹窗，没有启动它的正式拷贝、删除记录、修改设置或读取其私有程序实现。观察到任务列表与目的地校验结果明确分离，新任务按数据源、目的地、同名策略、校验和转码组织。

## 设计取舍

- 保留简洁现场流程，分成三个步骤，不把所有高级开关堆在同一个长弹窗。
- 初始界面展示真实空状态与真实设备数量，无虚构任务、容量或健康分数。
- 深石墨底色、低饱和紫色操作强调、绿色专用于校验通过。
- 常用任务 / 项目 / 报告直接导航；复杂的标准认证和云功能不以空按钮占位。
- 新应用名称 New Kocpy，独立 Bundle ID 与数据目录，避免破坏旧工程和旧软件。
