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
- 记录卷 UUID，防止同名磁盘替换后误写；按物理卷合并预检空间和临时发布余量。
- 慢盘可以从快速分发中分离，健康目标继续完成。
- 素材卡自动扫描并显示本次实际待备份容量、文件数量、磁盘总容量和可用空间。
- 设置目的地时可直接点击外接磁盘，并从该磁盘继续选择目标文件夹。
- 紫色进度表示拷贝，绿色覆盖表示校验；显示真实有效传输速度、回读速度、百分比与时分秒剩余时间。
- 速度按操作系统确认完成的字节以 1 秒间隔采样和平滑处理；多目标速度不会重复累加。
- 校验结束后立即结算任务并弹出完成通知，媒体缩略图随后在后台生成。

![传输队列](docs/screenshots/transfers.png)

![任务校验详情](docs/screenshots/verification-detail.png)

### 项目全周期看板

项目页按“拍摄日期 × 设备/机位”展示整个执行周期：每一天每台设备是否已经备份、素材卷数量、文件数量、素材容量、已校验数量，以及项目总任务、总文件和总素材量。每个素材卷可继续查看日期、设备、机位、大小与任务结论。

项目完成后可导出：

- 项目完整 PDF：项目总览、日期与设备矩阵、全部素材卷、目的地、校验结论和完整文件明细。
- 项目完整 JSON：项目配置与所有任务、目标、文件、哈希和校验记录，便于长期归档或二次处理。
- 单任务 PDF / JSON / MHL / ASC MHL。
- 拍摄日汇总 PDF 与 Resolve 媒体池 CSV。

![拍摄项目](docs/screenshots/project-editor.png)

### 素材、代理与报告

- 素材库展示已校验副本、首帧缩略图、摄影机型号、拍摄时间、分辨率、帧率、时长、编码与时间码。
- 可批量生成 H.264 或 ProRes Proxy，支持进度、取消、重试和定位输出。
- PDF 报告使用与应用一致的版式，并在素材条目中嵌入可用缩略图。
- 报告与清单可镜像到用户指定的同步文件夹；素材文件不会被上传。
- 本地快照、隐藏挂载目录与系统备份卷不会被识别为可选存储设备。

![素材库](docs/screenshots/library.png)

![代理队列](docs/screenshots/proxy-queue.png)

![报告中心](docs/screenshots/reports.png)

### 外观、隐私与更新

Kocpy 支持真实深色与浅色外观，任务、项目、偏好、缩略图和代理记录保存在 `~/Library/Application Support/Kocpy/`。软件无需账号，不上传素材。左下角可检查 GitHub Release 更新，并提供作者 [@sexyfeifan](https://github.com/sexyfeifan) 的 GitHub 与[小红书](https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97)入口。

![存储设备](docs/screenshots/storage.png)

![偏好设置](docs/screenshots/settings.png)

### 安装

从 [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases) 下载对应架构：

- `Kocpy-0.0.9-arm64.dmg`：Apple Silicon Mac
- `Kocpy-0.0.9-x64.dmg`：Intel Mac

打开 DMG，将 Kocpy 拖入“应用程序”。当前公开包尚未使用 Apple Developer ID 签名和公证。若 macOS 明确提示应用“已损坏”，请先确认文件来自本仓库官方 Release，再执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Kocpy.app"
```

不要全局关闭 Gatekeeper。

## English

Kocpy is a local-first macOS workspace for verified media offload and production archiving. It copies one source to up to four destinations, reads every copy back for checksum verification, resumes interrupted large files, tracks physical volumes, and produces task, shooting-day, and full-project reports.

Project mode organizes media by project, shooting date, camera, optional A–E camera position, and timestamped card volume. The project dashboard shows files, media size, card count, and verification status for every date and camera across the production period. Complete project records can be exported as PDF or JSON.

Kocpy also includes media thumbnails and metadata, H.264/ProRes proxy queues, Resolve CSV export, light/dark appearance, update checks, and architecture-specific DMGs for Apple Silicon and Intel Macs. Media and records stay on the Mac unless the user explicitly selects a report mirror folder.

## 日本語

Kocpy は、macOS 向けのローカル優先メディアバックアップ／プロジェクト管理アプリです。1つの素材ソースを最大4つの保存先へコピーし、各コピーを独立して読み戻してチェックサム検証します。大容量ファイルの再開、物理ボリューム識別、容量事前確認、失敗した保存先の再試行にも対応します。

プロジェクトモードでは、プロジェクト、撮影日、カメラ、任意の A–E カメラ位置、タイムスタンプ付き素材巻の階層で整理します。全期間の「撮影日 × カメラ」ごとに、素材巻数、ファイル数、容量、検証状態を確認でき、詳細なプロジェクト PDF／JSON を書き出せます。

素材サムネイルとメタデータ、H.264／ProRes プロキシキュー、Resolve CSV、ライト／ダーク表示、更新確認、Apple Silicon／Intel 用 DMG も備えています。素材と記録は、ユーザーが明示的にレポート同期先を選ばない限り Mac 内に保持されます。

## License

Kocpy source code is available under the MIT License. Bundled FFmpeg binaries retain their respective licenses.
