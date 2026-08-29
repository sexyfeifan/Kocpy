# Kocpy

<p align="center"><img src="resources/icon-256.png" width="112" alt="Kocpy icon"></p>

<p align="center"><strong>面向片场与工作室的 macOS 素材备份与项目归档工作台。</strong><br>本地优先 · 多目的地安全拷贝 · 独立回读校验 · 项目全周期记录</p>

<p align="center"><a href="#中文">中文</a> · <a href="#english">English</a> · <a href="#日本語">日本語</a></p>

![Kocpy 工作台](docs/screenshots/dashboard.png)

## 中文

### 一套完整的素材工作流

Kocpy 将素材卡接收、多目标备份、逐目标回读校验、项目归档、媒体预览、代理生成和交付报告放在一个本地工作空间中。素材源按只读原则处理，文件先写入任务专属断点文件，同步完成后再发布为最终文件；每份副本随后独立回读并与源哈希比对。

素材卡模式适合快速接收一个或多个来源。项目模式绑定拍摄项目，保存拍摄周期、设备、机位、素材卷前缀与备份根目录，并采用：

```text
备份根目录 / 项目开始日期_项目名 / 拍摄日期 / 设备 / [同型号机位] / 设备_任务开始时间 /
```

例如：`20260827_山海之间/20260829/FX3/A/FX3_202608291430/`。未启用同型号多机位时不会产生 A–E 层级。

![项目备份完整路径](docs/screenshots/project-backup-path.png)

### 安全备份与真实状态

- 同时写入 1–4 个目的地，一次读取素材数据块并分发给多个目标。
- 支持 SHA-256、SHA-1 与 MD5；拷贝结束后逐目标独立回读校验。
- 支持暂停、继续、取消、异常恢复、大文件断点续传、失败目标单独重试与完成后复校验。
- 恢复中心集中列出异常退出、暂停任务、离线目标和未完成校验，并区分“当前位置继续”“扫描并复用断点”“仅重试失败目标”和“重新校验全部副本”。成功目标不会在单目标重试中重新读取或初始化。
- 记录卷 UUID，防止同名磁盘替换后误写；按物理卷合并预检空间和临时发布余量。
- 慢盘可以从快速分发中分离，健康目标继续完成。
- 素材卡自动扫描并显示本次实际待备份容量、文件数量、磁盘总容量和可用空间。
- 设置目的地时可直接点击外接磁盘，并从该磁盘继续选择目标文件夹。
- 紫色进度表示拷贝，绿色覆盖表示校验；显示真实有效传输速度、回读速度、百分比与时分秒剩余时间。
- 速度按操作系统确认完成的字节以 1 秒间隔采样和平滑处理；多目标速度不会重复累加。
- 任务详情分别显示源素材哈希读取、源素材分发读取、各目标写入和校验回读曲线；完整任务记录保留平均值、P50、P95、峰值与停顿次数，并指出持续最慢的目的地。
- 校验结束后立即结算任务并弹出完成通知，媒体缩略图随后在后台生成。

![传输队列](docs/screenshots/transfers.png)

![任务校验详情](docs/screenshots/verification-detail.png)

![恢复中心](docs/screenshots/recovery.png)

### 项目全周期看板

项目页按“拍摄日期 × 设备/机位”展示整个执行周期：每一天每台设备是否已经备份、素材卷数量、文件数量、素材容量、已校验数量，以及项目总任务、总文件和总素材量。项目可设置 1–4 份收工副本标准，并标记休息日或当天未使用的设备，避免空白单元格被误判为漏备份。副本按物理卷 UUID 去重，同一磁盘上的多个文件夹只计算为一份；工作台同时显示尚未完成的日期与设备。

项目完成后可导出：

- 项目完整 PDF：项目总览、日期与设备矩阵、全部素材卷、目的地、校验结论和完整文件明细。
- 项目完整 JSON：项目配置与所有任务、目标、文件、哈希和校验记录，便于长期归档或二次处理。
- 项目 CSV：按日期、设备、机位和素材卷整理的表格数据。
- 项目归档包：一次导出项目 PDF、完整 JSON、统计 CSV、每个素材卷的 MHL 清单和用于验证整个归档包的 `SHA256SUMS.txt`。
- 单任务 PDF / JSON / MHL / ASC MHL。
- 拍摄日汇总 PDF 与 Resolve 媒体池 CSV。

![拍摄项目](docs/screenshots/project-editor.png)

### 素材、代理与报告

- 素材库展示已校验副本、首帧缩略图、摄影机型号、拍摄时间、分辨率、帧率、时长、编码与时间码。
- 扫描来源时按视频、照片 / RAW、音频和其他文件分类显示数量与容量。
- 可批量生成 H.264 或 ProRes Proxy，支持进度、取消、重试和定位输出。
- 提供通用审片、剪辑代理和离线剪辑预设，支持自定义输出命名规则、暂停/继续，并保留原始任务与相对路径关联。
- 代理完成后检查帧率、时间码和音轨，并可导出 Resolve CSV、Premiere CSV、Final Cut XML 或完整 JSON 交付清单。
- 归档维护中心支持项目级长期复校验、健康历史、从健康副本修复失败副本，并保留原损坏文件以供检查。
- 项目模板可复用设备、副本标准、命名规则和完成动作；项目交接记录随工作站包保存与合并。
- 插入历史素材卡时会建议项目、设备和下一卷号；发现相同文件结构与容量时会明确提示重复接收风险，且不会自动开始写入。
- 支持完整本地数据备份，以及多台 Kocpy 工作站之间的项目、任务、模板与健康记录合并；内容指纹用于跳过重复素材并报告命名冲突。
- 大型素材库按批次加载，诊断、事件和健康历史均设有体积上限，避免长期项目拖慢界面与记录写入。
- PDF 报告使用与应用一致的版式，并在素材条目中嵌入可用缩略图。
- 报告与清单可镜像到用户指定的同步文件夹；素材文件不会被上传。
- 本地快照、隐藏挂载目录与系统备份卷不会被识别为可选存储设备。
- 存储设备页可批量安全推出所有已完成设备；仍被备份或代理任务使用、存在未被后续成功任务覆盖的失败记录时，磁盘会被保留并说明原因。
- 诊断中心可对选定磁盘执行受控的 64 MiB 写入与回读性能预检，自动清理临时文件，并导出不含素材内容、完整私人路径或账号信息的脱敏诊断包。
- 任务记录保留最近的暂停、继续、预检异常和完成事件，帮助判断素材源失联、目的地离线、断点可恢复及副本未校验等状态。

![素材库](docs/screenshots/library.png)

![代理队列](docs/screenshots/proxy-queue.png)

![报告中心](docs/screenshots/reports.png)

### 外观、隐私与更新

Kocpy 支持真实深色与浅色外观，任务、项目、偏好、缩略图和代理记录保存在 `~/Library/Application Support/Kocpy/`。软件无需账号，不上传素材。左下角可检查 GitHub Release 更新，并提供作者 [@sexyfeifan](https://github.com/sexyfeifan) 的 GitHub 与[小红书](https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97)入口。

![存储设备](docs/screenshots/storage.png)

![偏好设置](docs/screenshots/settings.png)

### 安装

从 [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases) 下载对应架构：

- `Kocpy-0.0.12-arm64.dmg`：Apple Silicon Mac
- `Kocpy-0.0.12-x64.dmg`：Intel Mac

打开 DMG，将 Kocpy 拖入“应用程序”。当前公开包尚未使用 Apple Developer ID 签名和公证。若 macOS 明确提示应用“已损坏”，请先确认文件来自本仓库官方 Release，再执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Kocpy.app"
```

不要全局关闭 Gatekeeper。

## English

Kocpy is a local-first macOS workspace for verified media offload and production archiving. It copies one source to up to four destinations, reads every copy back for checksum verification, resumes interrupted large files, tracks physical volumes, and produces task, shooting-day, and full-project reports. Its Recovery Center can retry only failed destinations while preserving successful copies and their verification records.

Project mode organizes media by project, shooting date, camera, optional A–E camera position, and timestamped card volume. The project dashboard applies a configurable closeout rule based on physically distinct volume identities, with explicit rest-day and unused-camera exceptions. Complete records can be exported as PDF, JSON, CSV, or a self-contained archive bundle with MHL manifests and SHA-256 checksums.

Kocpy also includes media thumbnails and metadata, H.264/ProRes proxy queues, Resolve CSV export, light/dark appearance, update checks, and architecture-specific DMGs for Apple Silicon and Intel Macs. Media and records stay on the Mac unless the user explicitly selects a report mirror folder.

## 日本語

Kocpy は、macOS 向けのローカル優先メディアバックアップ／プロジェクト管理アプリです。1つの素材ソースを最大4つの保存先へコピーし、各コピーを独立して読み戻してチェックサム検証します。大容量ファイルの再開、物理ボリューム識別、容量事前確認に加え、成功済みコピーを保持したまま失敗した保存先だけを再試行できます。

プロジェクトモードでは、プロジェクト、撮影日、カメラ、任意の A–E カメラ位置、タイムスタンプ付き素材巻の階層で整理します。必要コピー数は物理ボリューム UUID ごとに数え、同じディスク上の複数フォルダを重複カウントしません。詳細データは PDF／JSON／CSV、MHL と `SHA256SUMS.txt` を含む一括アーカイブとして書き出せます。

素材サムネイルとメタデータ、H.264／ProRes プロキシキュー、Resolve CSV、ライト／ダーク表示、更新確認、Apple Silicon／Intel 用 DMG も備えています。素材と記録は、ユーザーが明示的にレポート同期先を選ばない限り Mac 内に保持されます。

## License

Kocpy source code is available under the MIT License. Bundled FFmpeg binaries retain their respective licenses.
