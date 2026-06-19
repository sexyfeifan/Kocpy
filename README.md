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
- **设备弹出**：支持在界面内直接安全弹出外接设备

### 项目管理

- **项目模板**：预设拍摄日期范围、参与机器（A机/B机/DIT 等）、机位子标签、目的地路径
- **文件目录预创建**：按拍摄计划自动批量创建 `项目名/日期/机器/机位` 层级目录结构
- **智能路径解析**：新建任务时自动关联项目，根据选定的日期、机器、机位自动解析完整目的地路径
- **项目归档**：支持将已完成项目归档，与活跃项目区分管理
- **备份热力图**：可视化展示项目备份活动分布

### 报告与缩略图

- **视频首帧缩略图**：备份完成后可一键提取 MXF / MOV / MP4 / R3D / BRAW 视频文件首帧，ffmpeg 已内置，无需额外安装
- **PDF 备份报告**：包含任务摘要、源信息、每个目的地的文件校验列表，支持内嵌视频首帧缩略图，可导出存档

---

## 安装

### 系统要求

- macOS 11.0（Big Sur）及以上
- 支持 Apple Silicon（arm64）和 Intel（x64）

### 下载安装

前往 [Releases](https://github.com/sexyfeifan/Kocpy/releases/latest) 页面下载最新版本：

| 架构 | 安装包 |
|------|--------|
| Apple Silicon（M1/M2/M3/M4） | `Kocpy-1.10.1-arm64.dmg` |
| Intel | `Kocpy-1.10.1-x64.dmg` |

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
│   ├── webhook.ts                 # Webhook 推送：平台检测（飞书/钉钉/企微/Discord/Slack）、payload 构建、重试逻辑
│   ├── report-builder.ts          # Webhook 纯文本报告构建器（任务摘要、路径、校验结果、目录树）
│   ├── storage.ts                 # 数据持久化：原子写入（atomicWrite）+ 写前备份（.bak）
│   ├── types.ts                   # 主进程类型定义（BackupTask、FileRecord、TaskConfig 等）
│   ├── utils.ts                   # 工具函数（formatSpeed、formatEta）+ 从 report-builder 重导出
│   ├── logger.ts                  # 文件日志系统（按日滚动，自动保留 7 天）
│   └── preload.ts                 # contextBridge API 暴露层
├── renderer/
│   └── src/
│       ├── App.tsx                # 根组件：路由分发、进度事件监听
│       ├── main.tsx               # React 入口
│       ├── store/
│       │   └── taskStore.ts       # Zustand 全局状态（任务列表、项目、设备、页面路由）
│       ├── pages/
│       │   ├── Dashboard.tsx      # 任务总览：统计卡片、已连接设备面板、任务列表
│       │   ├── NewTask.tsx        # 新建任务：备卡/镜像/项目三种模式、素材卡自动识别
│       │   ├── History.tsx        # 历史记录：热力图 + 按日期筛选
│       │   ├── Settings.tsx       # 设置：哈希算法、校验开关、Webhook 配置、检查更新
│       │   └── ProjectManager.tsx # 项目管理：创建/编辑/归档项目、目录结构预创建
│       ├── components/
│       │   ├── TaskCard.tsx       # 任务卡片：进度条、校验日志、操作按钮
│       │   ├── Header.tsx         # 顶部栏：页面标题、运行状态、版本号
│       │   ├── Sidebar.tsx        # 侧边导航栏
│       │   ├── BackupHeatmap.tsx  # GitHub 风格备份热力图（52 周）
│       │   └── ErrorBoundary.tsx  # React 错误边界
│       ├── types/
│       │   └── index.ts           # 渲染进程类型定义 + Window.api 全局类型声明
│       └── utils.ts               # 渲染进程工具函数（formatBytes、formatEta、formatDuration 等）
```

---

## 更新日志

### v1.10.1（2026-06）

- **检查更新** — 设置页面新增「检查更新」按钮，通过 GitHub API 检测最新版本，显示更新日志并提供直接下载链接
- **代码质量改进** — 消除 formatBytes 等 6 处重复，统一从 utils.ts 导入
- **类型安全修复** — 补充 renderer 类型缺失字段、修复模板字符串 bug、Header 补充 projects 页面标题
- **代码重构** — 拆分 index.ts（IPC 处理移至独立模块）、持久化日志系统、移除免费限制残留代码
- **数据安全加固** — .tmp 临时文件写入后原子性 rename、写前 .bak 备份、磁盘空间预检、断点续传支持
- **安全加固** — execFile 替代 exec 防止命令注入、.tmp 文件清理
- **UI 清理** — 删除 Dashboard 无用 settings 状态、NewTask 空 useEffect

### v1.10.0（2026-06）

- **并行拷贝死锁修复** — 用 Deferred Promise 替换忙等待循环，首个目标失败时不再挂起
- **双重 Promise 解析修复** — copyFileAndHash / copyFile 添加 settled 标志，确保只 resolve 一次
- **skip 策略校验误报修复** — 跳过的文件标记为 verified + skipped，不再显示校验失败
- **verifyAfterCopy 设置生效** — startTask 现在接受 options 参数
- **resolveBackupPath 修复** — 改为返回所有目标路径数组
- **Header/Settings 版本号修复** — 移除硬编码过期 fallback
- **共享 utils.ts** — 消除 formatBytes 等重复代码
- **React ErrorBoundary** — 防止渲染错误导致白屏
- **Webhook 重试** — 推送增加 3 次指数退避重试
- **Renderer 类型同步** — TaskConfig / ProgressPayload 补充缺失字段
- **项目名称统一** — 所有产物名称统一为 Kocpy

### v1.9.2（2026-05）

- 项目正式更名为 **Kocpy**（原 KocardPro）
- 新增 Webhook 推送功能（钉钉/飞书/企业微信通知）
- 新增备份热力图可视化
- 其他稳定性改进

### v1.8.1（2026-04）

- 项目模式机位子位置校验：当项目中某机器配置了子位置时，新建任务必须选择子位置才能开始备份

### v1.8.0（2026-04）

- 跳过文件统计展示
- 重复文件处理策略（跳过 / 重命名）
- 保存为默认设置
- 优先执行
- 视频首帧缩略图

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 28 + electron-vite |
| 前端 | React 18 + TypeScript 5 + Tailwind CSS 3 |
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
