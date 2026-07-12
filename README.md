# Kocpy

**Kocpy**（原名 KocardPro）是一款专为影视制作现场 DIT（Digital Imaging Technician）设计的专业媒体备份软件。支持摄影机卡到多目的地的高速备份、哈希校验、PDF 报告生成，以及基于项目管理的智能化工作流。

<p align="center">
  <a href="https://github.com/sexyfeifan/Kocpy/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/sexyfeifan/Kocpy?style=flat-square&color=1c1c1e"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/sexyfeifan/Kocpy?style=flat-square&color=1c1c1e&cacheSeconds=1"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-333?style=flat-square">
</p>

---

## 软件功能

### 核心备份能力

- **三种备份模式**：备卡模式（Card）、镜像模式（Mirror）、项目模式（Project），适配不同现场工作流
- **并行多目的地**：同时备份至最多 4 个目的地，复制与校验并行执行
- **哈希完整性校验**：支持 MD5 / SHA-1 / SHA-256，逐文件校验，确保数据 100% 一致
- **重复文件处理**：可选「跳过」（默认）或「重命名（_copy_N）」两种策略，避免目的地文件被意外覆盖
- **实时进度监控**：显示传输速度、已完成文件数、ETA 剩余时间
- **跳过文件统计**：备份完成后透明展示跳过的系统隐藏文件数量及体积
- **任务持久化**：应用重启后自动恢复任务状态，异常退出自动标记中断任务
- **优先执行**：可为单个任务设置优先级，优先任务排在其他等待任务之前启动，支持在待机任务卡片上实时切换
- **保存为默认设置**：哈希算法、重复策略、缩略图开关可一键持久化，下次新建任务时自动加载
- **Webhook 推送**：备份完成后可自动推送通知到钉钉/飞书/企业微信

### 智能设备识别

- **摄影机卡自动识别**：通过多维度评分模型（协议类型、文件系统、分区方案、块大小、容量、卷名等）区分数据卡与备份硬盘，自动填入素材源
- **支持卡型**：SD · CFexpress Type A/B · CFast · CF · SxS · XQD
- **磁盘状态实时监控**：5 秒轮询已连接存储设备，显示容量、剩余空间、设备类型
- **接入介质显示**：主页实时展示所有已连接存储设备（素材卡/备份盘/系统盘），容量进度条、安全弹出
- **设备安全弹出**：支持在界面内直接安全弹出外接设备（unmount + eject 两步流程）

### 项目管理

- **项目模板**：预设拍摄日期范围、参与机器（A机/B机/DIT 等）、机位子标签、目的地路径
- **文件目录预创建**：按拍摄计划自动批量创建 `项目名/日期/机器/机位` 层级目录结构
- **智能路径解析**：新建任务时自动关联项目，根据选定的日期、机器、机位自动解析完整目的地路径
- **项目归档**：支持将已完成项目归档，与活跃项目区分管理
- **备份热力图**：可视化展示项目备份活动分布

### 报告与缩略图

- **视频首帧缩略图**：备份完成后可一键提取 MXF / MOV / MP4 / R3D / BRAW 视频文件首帧，ffmpeg 已内置，无需额外安装
- **PDF 备份报告**：包含任务摘要、源信息、每个目的地的文件校验列表，支持内嵌视频首帧缩略图，可导出存档

### 行业标准与元数据

- **ASC MHL 合规**：实现 ASC MHL V1 标准，生成和验证 MHL 文件，支持 XML/JSON 格式导出，满足 Netflix 等平台要求
- **xxHash 算法**：新增 xxHash64 / xxHash3-64 / xxHash3-128 / C4 四种高性能哈希算法（WASM 实现），连同原有 MD5/SHA-1/SHA-256 共 7 种可选
- **元数据提取**：支持 ARRI / RED / Sony / Blackmagic / Canon 主流摄影机格式，基于 ExifTool 的通用提取器

### 转码与调色

- **代理文件生成**：支持 ProRes / H.264 / H.265，多种分辨率（4K/1080p/720p/480p）和质量，硬件加速（Apple Silicon VideoToolbox / Intel QSV / NVIDIA NVENC）
- **LUT/CDL 管理**：LUT 导入（.cube/.3dl/.csp）、CDL 创建/导出（XML/CCC），可在备份时应用 LUT/CDL 到代理文件
- **DaVinci Resolve 集成**：导出 ALE / FCP XML / EDL / CDL 文件，创建 Resolve 项目结构

### NAS 归档与生命周期

- **NAS 设备发现**：自动扫描局域网 NAS（SMB/NFS/AFP 协议），健康监控（SMART/容量/RAID 状态）
- **增量同步**：智能增量备份，仅同步修改的文件，断点续传，并行传输
- **媒体生命周期管理**：素材从拍摄到归档的完整追踪，状态历史记录，归档策略管理，自动化归档执行

---

## 安装

### 系统要求

- macOS 11.0（Big Sur）及以上
- 支持 Apple Silicon（arm64）和 Intel（x64）

### 下载安装

前往 [Releases](https://github.com/sexyfeifan/Kocpy/releases/latest) 页面下载最新版本：

| 架构 | 安装包 |
|------|--------|
| Apple Silicon（M1/M2/M3/M4） | `Kocpy-1.14.4-arm64.dmg` |
| Intel | `Kocpy-1.14.4-x64.dmg` |

下载 `.dmg` 后，双击打开，将 Kocpy 拖入 Applications 文件夹即可。

> **首次启动提示**：macOS 可能提示「无法打开，因为开发者未验证」。请打开「系统设置 → 隐私与安全性」，点击「仍然打开」，或运行 DMG 内附带的 `安装 Kocpy.command` 脚本自动完成授权。

---

## 使用指南

### 备卡模式（Card Mode）

将素材卡中的文件备份到指定目的地，备份目录以「卷名_时间戳」命名，确保每次备份可唯一追溯。

1. 打开软件，点击「新建备份任务」，选择「备卡模式」
2. 在「素材卡」标签页选择已识别的摄影机卡（或切换「自定义」手动选择文件夹）
3. 添加一个或多个目的地目录
4. 按需配置哈希算法、重复文件策略、是否生成缩略图
5. 点击「开始备份」，完成后自动逐文件哈希校验

### 镜像模式（Mirror Mode）

完整镜像素材源的目录结构与文件名，目的地内容与素材源完全一致（A = B），适用于需要制作完全相同副本的场景。

1. 选择「镜像模式」
2. 选择素材来源
3. 添加多个目的地（最多 4 个）
4. 开始备份，所有目的地并行接收数据并独立校验

### 项目模式（Project Mode）

关联已创建的项目，实现智能化工作流：自动识别素材卡、自动填充目的地路径，按「项目 / 日期 / 机位 / 卷名_时间戳」层级归档。

1. 在「项目管理」中提前创建项目，填写拍摄日期范围、机器与子机位，添加目的地，点击「创建文件结构」预建目录树
2. 新建任务时选择「项目模式」，关联对应项目（目的地路径自动填入）
3. 选择拍摄日期、机器、机位，软件自动解析完整备份路径并实时预览
4. 确认卷名后开始备份，结果按层级自动归档

### 查看报告

任务完成后，点击任务卡片上的「导出报告」按钮，选择保存路径，生成 PDF 备份报告。若任务开启了「视频首帧缩略图」，导出时可选择是否在报告中内嵌首帧图片。

---

## 项目架构

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 应用入口、窗口创建、备份进度监听与 Webhook 触发
│   ├── ipc-handlers.ts            # 所有 IPC 通信处理器（对话框、备份、设置、项目、系统）
│   ├── backup/
│   │   ├── BackupEngine.ts        # 核心备份引擎：文件枚举、并行拷贝、哈希校验、缩略图生成
│   │   └── ReportGenerator.ts     # HTML 报告生成器（用于 PDF 导出）
│   ├── hash.ts                    # xxHash 算法集成（WASM）
│   ├── mhl.ts                     # ASC MHL V1 标准实现
│   ├── metadata.ts                # 摄影机元数据提取（ExifTool）
│   ├── transcode.ts               # 代理文件转码（ProRes/H.264/H.265）
│   ├── lut.ts                     # LUT/CDL 管理
│   ├── resolve.ts                 # DaVinci Resolve 集成（ALE/XML/EDL/CDL 导出）
│   ├── nas.ts                     # NAS 设备发现与增量同步
│   ├── lifecycle.ts               # 媒体生命周期管理
│   ├── webhook.ts                 # Webhook 推送（飞书/钉钉/企微/Discord/Slack）
│   ├── report-builder.ts          # Webhook 纯文本报告构建器
│   ├── storage.ts                 # 数据持久化：原子写入 + 写前备份（.bak）
│   ├── types.ts                   # 主进程类型定义
│   ├── utils.ts                   # 工具函数
│   ├── logger.ts                  # 文件日志系统（按日滚动，保留 7 天）
│   └── preload.ts                 # contextBridge API 暴露层
├── renderer/
│   └── src/
│       ├── App.tsx                # 根组件：路由分发、进度事件监听
│       ├── main.tsx               # React 入口
│       ├── locales.ts             # 国际化文案
│       ├── store/
│       │   └── taskStore.ts       # Zustand 全局状态
│       ├── pages/
│       │   ├── Dashboard.tsx      # 任务总览：统计卡片、已连接设备面板、任务列表
│       │   ├── NewTask.tsx        # 新建任务：备卡/镜像/项目三种模式
│       │   ├── History.tsx        # 历史记录：热力图 + 按日期筛选
│       │   ├── Settings.tsx       # 设置：哈希、Webhook、LUT/CDL、NAS 配置
│       │   ├── ProjectManager.tsx # 项目管理：创建/编辑/归档项目
│       │   ├── NASManager.tsx     # NAS 设备管理与同步任务
│       │   └── LifecycleManager.tsx # 媒体生命周期管理
│       ├── components/
│       │   ├── ConnectedDrives.tsx # 接入介质显示组件（设备卡片、安全弹出）
│       │   ├── TaskCard.tsx       # 任务卡片：进度条、校验日志、操作按钮
│       │   ├── Header.tsx         # 顶部栏
│       │   ├── Sidebar.tsx        # 侧边导航栏
│       │   ├── BackupHeatmap.tsx  # GitHub 风格备份热力图
│       │   ├── MediaBrowser.tsx   # 素材浏览器（网格/列表视图、搜索筛选）
│       │   └── ErrorBoundary.tsx  # React 错误边界
│       ├── types/
│       │   └── index.ts           # 渲染进程类型定义
│       └── utils.ts               # 渲染进程工具函数
└── __tests__/                     # 单元测试（79 个用例，100% 通过）
```

---

## 更新日志

### v1.14.4（2026-07-12）

- **设备管理修复** — 修复 `settings:getDevices` 中 `loadSettings().devices` 未 await 导致返回 `undefined`；`settings:save` 补充 `await`；设备增删改现在能正确持久化

### v1.14.3（2026-07-12）

- **推出后 UI 自动刷新** — `ConnectedDrives` 组件新增 5 秒定时轮询；推出操作后从系统重新拉取设备列表，不再依赖本地 state 过滤；无论成功失败都刷新 UI

### v1.14.2（2026-07-12）

- **设备推出修复** — 修复 `diskutil eject` 因传入挂载路径而非 disk 标识符导致静默失败；改为先 unmount 卷再 eject 整个磁盘
- **前端状态修正** — 推出失败时不再假成功地从 UI 移除设备；`pages/Dashboard.tsx` 补上缺失的 `onVolumeEject` 回调

### v1.14.1（2026-07-12）

- **本地硬盘显示修复** — Macintosh HD 现在正确显示完整容量信息，添加 `deviceType: 'system'` 标识
- **设备去重** — 前端基于 path 去重，避免同一设备重复显示

### v1.14.0（2026-07-12）

- **接入介质显示** — 参考 DiskHop 设计，在主页实时显示已连接存储设备，包含设备类型标签（素材卡/备份盘/系统盘）、容量进度条、安全弹出按钮
- **设备自动识别** — 多维度评分模型区分摄影机卡与备份硬盘，支持 SD/CFexpress/CFast/CF/SxS/XQD

### v1.13.0（2026-07-12）

- **Dashboard 增强** — 素材浏览器集成、批量操作（全选/删除/导出 JSON）、统计分析标签页
- **高级选项** — 新建任务时可选生成 ASC MHL 文件、转码代理文件、导出到 DaVinci Resolve
- **NAS 管理页面** — NAS 设备列表、健康监控、同步任务管理
- **生命周期管理页面** — 素材从拍摄到归档的完整追踪、搜索筛选、状态历史记录
- **Settings 完善** — LUT/CDL 管理、NAS 扫描设置、归档策略配置

### v1.12.0（2026-07-12）

- **ASC MHL 合规** — 实现 ASC MHL V1 标准，支持 XML/JSON 格式导出，满足 Netflix 等平台要求
- **xxHash 算法** — 新增 xxHash64/xxHash3-64/xxHash3-128/C4 四种高性能哈希算法（WASM 实现）
- **元数据提取** — 支持 ARRI/RED/Sony/Blackmagic/Canon 主流摄影机格式，基于 ExifTool
- **代理文件生成** — 支持 ProRes/H.264/H.265，多种分辨率和质量，硬件加速（Apple Silicon VideoToolbox）
- **LUT/CDL 管理** — LUT 导入、CDL 创建/导出（XML/CCC），支持 .cube/.3dl/.csp 格式
- **DaVinci Resolve 集成** — 导出 ALE/FCP XML/EDL/CDL 文件，创建 Resolve 项目结构
- **NAS 归档** — 自动扫描局域网 NAS（SMB/NFS/AFP）、健康监控、智能增量同步、断点续传
- **媒体生命周期** — 素材从拍摄到归档的完整追踪、归档策略管理、自动化执行

### v1.11.0（2026-07-10）

- **Astryx UI 设计系统** — 集成 @astryxdesign/core 组件库，深色/浅色主题切换，响应式布局
- **任务队列系统** — 正确的队列管理、优先级排序、顺序执行
- **FX3 文件重命名** — Sony FX3 摄影机文件自动重命名（.mp4/.mov/.mxf）
- **增量备份后端** — 文件比较逻辑（大小 + 修改时间），后端就绪，UI 集成待后续版本

### v1.10.1（2026-06）

- **检查更新** — 设置页面新增「检查更新」按钮，通过 GitHub API 检测最新版本
- **代码质量改进** — 消除重复代码、类型安全修复、代码重构
- **数据安全加固** — 原子写入、写前备份、磁盘空间预检、断点续传支持
- **安全加固** — execFile 替代 exec 防止命令注入

### v1.10.0（2026-06）

- **并行拷贝死锁修复** — Deferred Promise 替换忙等待循环
- **skip 策略校验修复** — 跳过的文件标记为 verified + skipped
- **React ErrorBoundary** — 防止渲染错误导致白屏
- **Webhook 重试** — 推送增加 3 次指数退避重试

### v1.9.2（2026-05）

- 项目正式更名为 **Kocpy**（原 KocardPro）
- 新增 Webhook 推送功能（钉钉/飞书/企业微信通知）
- 新增备份热力图可视化

### v1.8.0（2026-04）

- 跳过文件统计展示
- 重复文件处理策略（跳过 / 重命名）
- 保存为默认设置、优先执行
- 视频首帧缩略图

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 28 + electron-vite |
| 前端 | React 19 + TypeScript 5 + Tailwind CSS 3 |
| 状态管理 | Zustand 4 |
| 图标 | Lucide React |
| 视频处理 | ffmpeg-static（内置，用于首帧缩略图提取） |
| 构建打包 | electron-builder（DMG + ZIP，支持 arm64 / x64） |
| 报告导出 | HTML 模板 → Electron printToPDF |
| 数据持久化 | JSON 文件（atomicWrite + .bak 写前备份） |
| 日志 | 按日文件日志，自动滚动保留 7 天 |
| 通信 | Electron IPC（contextBridge + ipcMain.handle） |

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 打包发布（macOS arm64 + x64）
npm run dist
```

### 开发环境要求

- Node.js 18+
- npm 9+
- macOS（其他平台未测试，部分功能如 diskutil / volume 检测仅限 macOS）

### 项目结构说明

- `src/main/` — Electron 主进程，负责文件系统操作、备份引擎、Webhook 推送、数据持久化
- `src/renderer/` — React 渲染进程，负责 UI 展示和用户交互
- `src/main/preload.ts` — 安全桥接层，通过 `contextBridge.exposeInMainWorld` 暴露 API
- 主进程与渲染进程通过 `ipcMain.handle` / `ipcRenderer.invoke` 通信
- 所有备份操作在主进程执行，渲染进程通过 `onProgress` 事件监听实时进度

---

## 许可证

MIT License
