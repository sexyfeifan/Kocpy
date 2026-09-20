# Kocpy

<p align="center"><img src="resources/icon-256.png" width="112" alt="Kocpy icon"></p>

<p align="center"><strong>面向片场与工作室的 macOS 素材备份与项目归档工作台。</strong><br>本地优先 · 多目的地备份 · 独立回读校验 · 可追溯的项目记录</p>

<p align="center"><a href="#中文">中文</a> · <a href="#english">English</a> · <a href="#日本語">日本語</a></p>

下一版：**0.1.37（安全补丁后候选，待标签构建与附件回下载验收）** · [当前正式版下载](https://github.com/sexyfeifan/Kocpy/releases/latest) · [使用手册](docs/USER_GUIDE.md) · [文档导航](docs/README.md) · [0.1.37 更新](docs/RELEASE_NOTES_0.1.37.md)

![Kocpy 工作台](docs/screenshots/dashboard.png)

> 截图用于展示主要界面，具体按钮与文案以当前安装版本为准。Kocpy 专注可靠接收与规范交付，不是剪辑软件，也不以历史绿色状态代替当前磁盘健康检查。

## 中文

### 下载与安装

| 你的 Mac | 0.1.37 正式发布后的安装包 |
| --- | --- |
| Apple Silicon（M 系列） | [下载 arm64 DMG](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.37/Kocpy-0.1.37-arm64.dmg) |
| Intel | [下载 x64 DMG](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.37/Kocpy-0.1.37-x64.dmg) |

正式发布后，先核对同一 Release 的 [SHA256SUMS.txt](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.37/SHA256SUMS.txt)，再打开 DMG，将 Kocpy 拖入“应用程序”。安全补丁前的 0.1.37 候选包不可发布，也不能用其摘要校验最终附件。

**当前没有 Developer ID 签名或 Apple 公证。** 安装包仅采用 ad-hoc 签名；同版 Release 提供的 SHA-256 用于下载完整性核对。两者都不构成 Apple 身份认证或 Apple 公证。遇到系统阻止、架构不符或“已损坏”提示，请按[安装、升级与排查说明](docs/INSTALLATION.md)处理，不要直接关闭系统安全防护。

### 先选择适合自己的工作方式

| 工作方式 | 适合谁 | 怎么开始 |
| --- | --- | --- |
| 普通备份 | 只想把素材安全备份，不需要项目管理 | 选择素材源 → 设置 1–4 个目的地 → 核对最终路径并开始 |
| 项目备份 | 需要按拍摄日、设备、机位管理并收工交接 | 创建项目与副本规则 → 按拍摄日接收 → 检查收工状态 → 导出与交接 |
| 接管既有备份 | 已有素材，希望中途纳入项目记录 | 选择已有目录 → 确认日期／设备／卷映射 → 选择清单校验、首次基线或仅导入结构 |

普通备份无需先创建项目。素材源和目的地均支持从 Finder 拖入文件夹；目的地选择的是**存放副本的父目录**，开始前会显示每个来源的实际最终路径。

普通备份有两种目录组织方式：

- **按次保存**：创建 `源文件夹名_时间戳`；无同名冲突时，内部文件名与子目录保持不变。
- **保留源文件夹（镜像备份）**：保留所选源文件夹这一层，不添加时间戳或随机码。它不是删除式同步，不删除目的地额外文件，也不静默覆盖冲突内容。

例如：源为 `/Volumes/CARD/拍摄素材`，目的地选择 `/Volumes/BACKUP/交付`，镜像备份落点就是 `/Volumes/BACKUP/交付/拍摄素材`。

项目模式按项目、拍摄日、设备、可选机位与素材卷管理目录；命名规则可配置，界面预览与实际写入使用相同规则。[查看完整操作步骤](docs/USER_GUIDE.md#2-新建备份与命名)。

### 当前主要功能

| 模块 | 已实现能力 |
| --- | --- |
| 备份与校验 | 1–4 个目的地；SHA-256／SHA-1／MD5；逐目标独立回读；新任务默认完整清单包含隐藏项与空目录；完整源与最终目的地路径；实时写入、回读速度与进度 |
| 暂停与恢复 | 暂停／继续、大文件断点恢复、异常退出恢复、只重试失败目标；离线、空间、权限与身份异常的检查引导 |
| 拍摄项目 | 按拍摄日分组的设备／机位矩阵和素材卷明细；逻辑素材卷去重统计；收工副本要求；按需创建目录、安全空脚手架整理；日计划、规则版本、检查表与交接 |
| 模板与项目记录 | 五个有差异说明的系统模板；自定义新建／编辑／导入导出／选择性应用；受保护的内部项目记录删除 |
| 既有备份接管 | 单张素材卡、单日所有机位、整个项目；映射预览与修正；MHL／SHA 清单比对、首次基线、旧接管记录刷新 |
| 清单差异处理 | 缺失／额外／大小／哈希差异明细；Finder 定位；健康副本修复；重要确认后的经审计 MHL 修订 |
| 素材库 | 缩略图与媒体信息、分页搜索、Finder／播放入口；移动目录后通过完整哈希重新定位或关联健康副本 |
| 代理与交付 | H.264／ProRes Proxy；预设与自定义参数；依赖、暂停、恢复、重试；源与输出哈希证据；交付前重新校验 |
| 报告与清单 | 新任务及全部目的地完成校验后，默认在每个备份目的地自动保存 PDF；任务／拍摄日／项目 PDF、JSON、CSV、MHL／ASC MHL；Resolve／Premiere／Final Cut 媒体清单；附 SHA-256 的项目归档包 |
| 完整卡与每日交付 | 完整素材卡保持不可变；素材日期建议与人工分配；从已校验完整卡生成、独立回读并报告的每日交付；SHA-256 链式恢复日志、全卷／目录身份绑定、终态全量复核与不覆盖发布；派生产物不增加独立副本计数 |
| NAS／已挂载目录归档转存 | 普通文件夹或项目文件夹独立转存到 NAS、网络共享、外置盘或其他已挂载目录；显示文件系统与挂载点，不把任意目录冒充为已确认 NAS；不覆盖、可恢复、逐文件 SHA-256 回读；最终目录内 PDF 与高清 PNG 事实报告 |
| 长期归档 | 按盘、项目、拍摄日、素材卷或单文件复校验；健康历史、位置变化、周期提醒、保留损坏原件的副本修复 |
| 工作站协作 | 元数据包导出、只读预检、逐项冲突决定、可恢复合并与审计；同包同决定重复导入不重复写入；可选只读局域网索引 |
| 安全自动化 | 历史素材卡与疑似重复建议；完成后报告／代理／交付／推出建议；用户逐项确认后执行并保留结果 |
| 诊断与界面 | 受控读写预检、故障时间线、脱敏诊断；深浅色外观、固定侧栏字图比例、独立滚动、减少动态效果支持、按需展开的使用说明 |

备份工作优先于后台代理；用户手动暂停的代理不会被自动恢复。工作站包交换记录与证据，不复制原始素材，也不证明另一台 Mac 上的素材当前健康。

### 如何理解“完成”和“安全”

- **复制完成 ≠ 校验完成。** 每个目标必须独立回读并与哈希基准比对，才有内容验证证据。
- **通过校验 ≠ 副本数量达标。** 同盘文件夹、分区、不同 UUID 不必然物理独立；未知 RAID／NAS 关系不会自动增加独立副本数。
- **首次基线 ≠ 接管前完整。** 它只记录接管时存在的内容，不能证明此前没有漏拷或被删文件。
- **没有文件夹 ≠ 当天未使用设备。** 项目空白单元保持待确认；休息或未使用标记不能掩盖已记录素材的风险。
- **刷新记录 ≠ 重新校验。** 刷新修正识别与重复统计，不重新读取全部内容哈希。
- **历史通过 ≠ 永久健康。** 长期保存需要重新读取归档盘校验；报告只代表其记录时点。
- **完整范围 ≠ 目的地目录集合绝对相等。** 新任务保证冻结源素材范围的每一项都有已记录的目标映射，目标内容、精确文件字节与冻结空目录经过核对；冲突后缀模式会记录改名后的真实映射。Kocpy 不删除或否定目的地既有额外项，校验完成后写入的 `Kocpy报告` 也是带独立摘要的管理产物，不属于源卡素材范围。文件系统分配、ACL、扩展属性和时间戳不在内容校验结论内；主动排除隐藏项时会留下明确排除清单。
- **每日交付 ≠ 新的完整备份。** 它从已校验完整卡派生并重新校验，但不增加素材卡、任务或物理独立副本数量。

普通备份按只读原则处理素材源。修复副本、修订 MHL 等维护写入必须经过明确确认；MHL 修订保留原始清单与审计，不删除素材，也不允许豁免大小或哈希异常。删除项目只清理 Kocpy 内部记录，不删除磁盘素材、报告或清单。

### 0.1.37 更新重点

1. **完整接收和每日交付分离**：整张卡先完整备份；混合日期仅给出建议并由操作人确认，可生成独立校验的当日交付，但不增加素材卡或物理独立副本计数。
2. **新任务默认完整素材范围**：隐藏项、AppleDouble、既有报告／清单和空目录纳入冻结清单；逐项记录源到目标的真实映射，主动关闭隐藏项时记录全部排除，旧任务继续沿用历史策略。
3. **项目日视图与目录治理**：项目详情按日分组；新项目默认按需创建目录，确认未使用／休息后只在逐路径预览、再次授权和安全证明全部通过时整理空脚手架。
4. **自动报告与独立归档**：任务及全部目的地完成校验后，每个备份目的地默认保存不可变的首次完成 PDF，可在设置改变新任务默认值、在开始前单独关闭或在失败后单独重试；新增 NAS／已挂载目录独立转存、逐文件回读和发布后重新核验的 PDF／PNG 报告流程。
5. **当日交付安全恢复**：隐藏链式日志有 128 MiB 硬上限；恢复必须同时通过完整卷身份、目录 `dev/ino` 和日志链校验。安全文件打开使用 `O_NOFOLLOW`，成品不覆盖排他发布；写入后再做终态全量 SHA-256、`Media` 清单、JSON／MHL 及报告摘要复核。

[完整更新说明](docs/RELEASE_NOTES_0.1.37.md) · [历史正式发布](https://github.com/sexyfeifan/Kocpy/releases)

### 验证范围与已知限制

0.1.37 的精确自动测试、架构、候选包与正式附件验收范围见[验证记录](docs/VERIFICATION.md)和同版 Release；任何未执行项目不会计作通过。当前安全补丁源码回归为 **511 项通过、4 项跳过**，其中混合日期／当日交付专项 **53/53**。

- 没有 Developer ID／Apple 公证，不宣称通过 App Store 审核。
- 工作流 [35481530272](https://github.com/sexyfeifan/Kocpy/actions/runs/35481530272) 在安全复审时主动取消，没有创建 Release，也不计作通过。安全补丁后的原生双架构候选流水线 [35487676154](https://github.com/sexyfeifan/Kocpy/actions/runs/35487676154) 已通过并完成附件回下载核验；标签构建与正式 Release 附件验收仍待完成。
- 历史硬件或双机结果不能泛化成当前版本在所有设备上通过；真实外置双盘、NAS／SMB 网络中断／重挂载、拔盘、睡眠与空间耗尽的本版复验边界仍明确保留；当前没有真实 NAS／SMB 真机结果。
- “10k”只是 10,000 条恢复元数据的结构与容量估算，不是 10,000 个真实文件的复制、哈希、恢复或性能测试；日志恢复解析还会产生额外内存占用。
- Resolve 有已记录的合成样本实际导入证据；Premiere Pro／Final Cut Pro 清单完成结构与生成检查，未宣称完成对应软件实机导入。
- 自动测试、磁盘映像和同盘多目录不代替真实现场介质验收。正式使用前请先用非生产数据验证自己的读卡器、连接方式与存储设备。

### 界面预览

<details>
<summary>展开查看传输、项目、素材库与帮助界面</summary>

![传输队列](docs/screenshots/transfers.png)

![任务校验详情](docs/screenshots/verification-detail.png)

![项目备份完整路径](docs/screenshots/project-backup-path.png)

![素材库](docs/screenshots/library.png)

![代理队列](docs/screenshots/proxy-queue.png)

![软件内使用说明](docs/screenshots/help.png)

</details>

### 文档与问题反馈

- [文档导航](docs/README.md)：按使用、排查、验证与开发分类。
- [完整使用手册](docs/USER_GUIDE.md)：从第一份备份到清单差异、交接和长期归档。
- [安装与升级](docs/INSTALLATION.md)：架构选择、SHA-256、签名限制、版本检查。
- [架构与安全边界](docs/ARCHITECTURE.md) · [UI 规范](docs/UI_SYSTEM.md) · [真实介质测试协议](docs/HARDWARE_TEST.md)。
- [反馈问题](https://github.com/sexyfeifan/Kocpy/issues)：请提供应用版本、Mac 架构、macOS 版本、复现步骤与预期／实际结果；截图和诊断附件先检查脱敏，不上传素材、完整私人路径、原始生产清单或账号信息。

Kocpy 无需账号。默认应用记录位于 `~/Library/Application Support/Kocpy/`；素材保留在用户选择的源与目的地。报告同步文件夹、工作站包或局域网索引只在用户主动配置或操作后使用。选择云同步文件夹时，实际上传行为由该同步服务决定。

### 从源码运行

在 macOS 上使用 Node.js 22 与 npm，进入仓库后：

```bash
npm ci
npm run verify:release
npm run typecheck
npm test
npm run dev
```

`verify:release` 检查源码树卫生与媒体运行时来源，不表示已经完成发布验收。`npm run build` 构建应用代码；架构候选包可使用 `npm run dist:arm64` 或 `npm run dist:x64`。真实介质测试有写入操作，只能按[测试协议](docs/HARDWARE_TEST.md)在可牺牲卷上显式执行。贡献前请阅读[工程与发布规则](AGENTS.md)。

## English

Kocpy is a local-first macOS workspace for verified media offload and production archiving. Ordinary backup needs no project setup: choose sources, choose up to four destination parent folders, review the final paths, then copy and independently read back each destination. Mirror layout preserves the selected source folder; it is not deletion-based synchronization.

Project mode adds shooting days, cameras and positions, logical card volumes, closeout requirements, versioned rules, editable templates and handoff records. Existing backups can be adopted against MHL/SHA manifests, read into a first baseline, or imported as unverified structure. A first baseline does not prove historical completeness, and different volume UUIDs alone do not prove physical independence.

Current features also include recovery, media relinking, evidence-backed H.264/ProRes proxies, delivery manifests, archive reverification, audited metadata exchange between workstations, opt-in completion actions, diagnostics, light/dark themes and reduced motion. Candidate **0.1.37** groups project detail by shooting day, freezes a complete inventory for new tasks, creates per-destination automatic PDFs after the task and all destinations are verified, keeps full mixed-day cards immutable while producing separately verified daily deliveries, and adds a standalone verified archive-transfer flow for NAS or other mounted directories with PDF/PNG reports. Kocpy displays mount evidence but does not label an arbitrary directory as a confirmed NAS. Daily deliveries are derivatives and never increase independent-copy counts.

[Download](https://github.com/sexyfeifan/Kocpy/releases/latest) · [Installation](docs/INSTALLATION.md) · [Guide (Chinese)](docs/USER_GUIDE.md) · [Verification scope](docs/VERIFICATION.md)

Separate arm64 and x64 installers are planned for the formal 0.1.37 release; final hashes remain pending tag-build artifact download and acceptance. They use ad-hoc signing, **not Developer ID signing or Apple notarization**. Automated tests and historical hardware results are not certification for every storage setup; this candidate has no real NAS/SMB device result and does not claim complete two-independent-external-disk coverage.

## 日本語

Kocpy は macOS 向けのローカル優先メディアバックアップ／プロジェクト管理アプリです。通常バックアップではプロジェクト作成は不要です。素材と最大4つの保存先親フォルダを選び、最終パスを確認してからコピーし、保存先ごとに独立して読み戻し検証します。ミラーレイアウトは選択したソースフォルダを保持し、削除型同期は行いません。

プロジェクトモードでは撮影日、カメラ／位置、素材巻、必要コピー数、ルール履歴、テンプレート、引き継ぎを管理できます。既存素材の取り込み、MHL／SHA 比較、復旧、プロキシ、納品リスト、長期再検証、監査付きメタデータ交換にも対応します。初回基準は取り込み以前の完全性を証明せず、異なる UUID だけでは物理的に独立したコピーと認定しません。

候補版 **0.1.37** は、撮影日ごとのプロジェクト表示、新規タスクの完全な対象スナップショット、タスクと全保存先の検証完了後に作成する保存先ごとの自動 PDF、完全カードを変更しない日別納品、NAS またはその他のマウント済みディレクトリへの独立アーカイブ転送と PDF／PNG レポートを追加します。Kocpy は任意のディレクトリを確認済み NAS とは表示しません。日別納品は派生成果物であり、独立コピー数には加算されません。

[ダウンロード](https://github.com/sexyfeifan/Kocpy/releases/latest) · [インストール（中国語）](docs/INSTALLATION.md) · [使用手冊（中国語）](docs/USER_GUIDE.md) · [検証範囲](docs/VERIFICATION.md)

Apple Silicon／Intel 用の正式 0.1.37 インストーラと最終ハッシュは、タグビルドと再ダウンロード検証の完了待ちです。現在は ad-hoc 署名のみで、**Developer ID 署名・Apple 公証はありません**。自動テストをあらゆる実機構成の検証とみなさないでください。実 NAS／SMB 機器での結果や、独立した外付け二台構成をすべて検証済みとは表明していません。

## License

Kocpy source code is available under the [MIT License](LICENSE). The separately invoked FFmpeg/x264 runtime has its own GPL-2.0-or-later license; it is not covered by Kocpy's MIT license. Full notices, pinned corresponding sources and build scripts are bundled in `Contents/Resources/ffmpeg` and supplied alongside installers in each current Release. See [media notices](resources/ffmpeg/NOTICE.md) and [third-party notices](THIRD_PARTY_NOTICES.md). These notices do not claim App Store approval or patent clearance.
