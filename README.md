# Kocpy

<p align="center"><img src="resources/icon-256.png" width="112" alt="Kocpy icon"></p>

<p align="center"><strong>为片场与工作室设计的 macOS 素材备份工作台。</strong><br>多目的地安全拷贝、独立哈希校验、项目归档、可追溯报告与剪辑代理，全部留在本机。</p>

![Kocpy 工作台](docs/screenshots/dashboard.png)

## 为什么做 Kocpy

拍摄素材的第一份拷贝常常发生在时间紧、介质多、目标盘复杂的现场。Kocpy 把 DiskHop 式的轻量传输流程与项目化素材管理结合起来，围绕“来源只读、目标不覆盖、每份副本独立回读校验”建立清晰工作流。界面与代码为本项目重新设计，原 Kocpy 图标风格得以保留。

## 0.0.1 功能

- 同时写入 1–4 个目的地，支持普通归档与镜像目录模式。
- 单次源读取向多目的地扇出，降低多副本任务对素材卡的重复读取。
- SHA-256、SHA-1、MD5 逐文件源哈希；拷贝阶段完成后，对每个目的地独立回读校验。
- 断点文件保留并校验前缀后续传；损坏的断点自动重建。
- 暂停、继续、取消、失败任务重试、已完成任务独立重新校验。
- 紫色拷贝与绿色校验同轨双阶段进度；显示百分比、实时物理写入速度和“时/分/秒”剩余时间。
- 每个目的地分别显示拷贝、校验、实际写入量和错误状态。
- 任务运行期间定时持久化检查点；异常退出后可从已有完整文件与有效断点继续。
- 识别同一物理卷上的多个目的地并提示风险；按物理卷汇总空间需求。
- 项目、拍摄日期、机位和目的地预设；素材库集中查看已校验文件。
- 视频首帧缩略图与基础媒体参数；H.264 / ProRes Proxy 代理生成，带实时进度和取消。
- 现代化 PDF 报告、完整 JSON 记录与 MHL 1.1 XML 哈希清单。
- 首次启动会无损导入旧 `New Kocpy` 的任务、项目与设置，旧数据保持原样。
- 深色/浅色主题、磁盘容量与安全推出、完全本地的数据存储。

![传输队列](docs/screenshots/transfers.png)

![任务校验详情](docs/screenshots/verification-detail.png)

## 进度和速度如何计算

Kocpy 不生成模拟速度。

- **实时物理写入**：统计实际完成写入所有目的地的总字节，用约 2 秒滑动窗口平滑。两个目标盘各写入 100 MB/s 时，界面显示约 200 MB/s。
- **源等效速度**：引擎内部同时保留按目的地数折算的源数据吞吐，用于估算当前文件与剩余任务时间。
- **拷贝百分比**：按源数据逻辑字节计算，不会因目的地数量翻倍。
- **校验百分比**：按所有目的地实际需要回读的总字节计算。

短文件、文件切换、磁盘缓存落盘和不同目标盘背压仍会造成正常波动；滑动窗口避免了旧版 0.3 秒瞬时采样产生的剧烈跳动。

## 数据安全策略

1. 规范化真实路径，拒绝来源与目的地相同、嵌套或通过符号链接互相指向。
2. 写入任务专属 `.partial` 文件，完成同步后才以排他方式发布；不覆盖已有文件。
3. 同名文件先校验：一致则复用，不一致则报错或按选项创建带序号副本。
4. 发布后从每个目的地独立读取并与源哈希比对。
5. 所有目标全部通过才显示“校验通过”；部分成功会保留安全副本并明确列出失败目标。

详细实现见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 安装

在 [Releases](https://github.com/sexyfeifan/Kocpy/releases) 下载对应处理器的 DMG：

- `Kocpy-0.0.1-arm64.dmg`：Apple Silicon（M1/M2/M3/M4/M5）
- `Kocpy-0.0.1-x64.dmg`：Intel Mac

0.0.1 的本地验收包未使用 Apple Developer ID 签名。首次打开如被 Gatekeeper 阻止，请在 Finder 中按住 Control 点击应用并选择“打开”。GitHub Actions 已支持在仓库 Secrets 配置证书后自动签名与公证。

## 本地开发

要求 Node.js 20+ 与 macOS。

```bash
npm ci
npm run dev
```

验证和构建：

```bash
npm run typecheck
npm test
npm run dist:arm64
npm run dist:x64
# 或一次生成两个架构
npm run dist
```

构建产物位于 `release/`。应用内 FFmpeg 按架构选择独立原生二进制，因此 Intel 包不会误带仅能在 Apple Silicon 运行的转码器。

## 报告与 MHL

PDF 报告包含任务状态、时间、来源、目的地、文件大小、源校验值和逐目标结果。JSON 保存 Kocpy 的完整任务记录。当前 `.mhl` 导出为可读的 legacy MHL 1.1 清单；ASC MHL 的链文件、集合文件与嵌套结构应使用 ASC 官方参考实现生成或验证，Kocpy 0.0.1 不冒充完整 ASC MHL 合规实现。

## 数据位置与隐私

任务、项目、设置和缩略图位于：

```text
~/Library/Application Support/Kocpy/
```

Kocpy 不要求账号，不上传素材。首次启动只复制旧版 `~/Library/Application Support/New Kocpy/` 中可识别的 JSON 文件，不删除或改写旧目录。

## 版本策略

项目从 `0.0.1` 重新开始。后续常规版本按用户约定以 `0.0.1` 递增，例如 `0.0.2`、`0.0.3`；只有明确指定时才改变版本规则。

## 开源与第三方组件

Kocpy 源码使用 MIT License。内置 FFmpeg 采用其随附的 GPL 许可，许可证文件位于 `resources/ffmpeg/`。项目参考了 [Kocard](https://www.kocard.net/) 的产品方向与公开仓库 [fdgjut797/kocard](https://github.com/fdgjut797/kocard)，但界面、流程和实现均在本仓库重新构建。
