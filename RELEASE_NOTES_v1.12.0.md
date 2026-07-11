# Kocpy v1.12.0 更新日志

**发布日期**: 2026-07-12

---

## 🎉 重大功能更新

### 优先级 1: 行业标准合规 ✅

#### ASC MHL 支持
- ✅ 实现 ASC MHL V1 标准
- ✅ 生成和验证 MHL 文件
- ✅ 支持 XML/JSON 格式导出
- ✅ 满足 Netflix 等平台要求

#### xxHash 算法集成
- ✅ 支持 7 种哈希算法
  - MD5, SHA-1, SHA-256 (原有)
  - xxHash64, xxHash3-64, xxHash3-128, C4 (新增)
- ✅ 高性能 WASM 实现
- ✅ 批量并行计算

---

### 优先级 2: 元数据管理 ✅

#### 元数据提取功能
- ✅ 支持主流摄影机格式
  - ARRI (ALEXA 35, Mini LF, Mini)
  - RED (V-RAPTOR, KOMODO, DSMC2)
  - Sony (VENICE 2, FX9, FX6, FX3)
  - Blackmagic (URSA Mini Pro, BMPCC 6K)
  - Canon (C300 III, C500 II)
- ✅ 基于 ExifTool 的通用提取器
- ✅ 完整的元数据数据结构
- ✅ 批量提取支持

#### 素材浏览器
- ✅ 网格视图和列表视图切换
- ✅ 搜索和筛选功能
- ✅ 文件详情面板
- ✅ 预览功能（模态框）
- ✅ 响应式设计

---

### 优先级 3: 转码功能 ✅

#### 代理文件生成
- ✅ 支持多种格式
  - Apple ProRes (高质量，适合编辑)
  - H.264/AVC (兼容性好，文件小)
  - H.265/HEVC (最新标准，压缩率高)
- ✅ 支持多种分辨率
  - 4K (3840x2160)
  - 1080p (1920x1080)
  - 720p (1280x720)
  - 480p (854x480)
- ✅ 低、中、高质量选择
- ✅ LUT/CDL 应用
- ✅ 硬件加速支持
  - Apple Silicon (VideoToolbox)
  - Intel QSV
  - NVIDIA NVENC

#### LUT/CDL 管理
- ✅ LUT 导入、删除、列表
- ✅ CDL 创建、删除、列表
- ✅ CDL 导出为 XML/CCC 格式
- ✅ 支持 .cube、.3dl、.csp 格式

#### DaVinci Resolve 集成
- ✅ 导出 ALE 文件 (Avid Log Exchange)
- ✅ 导出 FCP XML 文件 (Final Cut Pro)
- ✅ 导出 EDL 文件 (Edit Decision List)
- ✅ 导出 CDL 文件 (Color Decision List)
- ✅ 创建 Resolve 项目结构
- ✅ 生成 Resolve 项目文件

---

### 优先级 4: NAS 归档 ✅

#### NAS 设备发现
- ✅ 自动扫描局域网 NAS 设备
- ✅ 支持 SMB/NFS/AFP 协议
- ✅ NAS 健康监控
  - SMART 状态
  - 容量使用率
  - RAID 状态
- ✅ 多 NAS 支持

#### 增量同步功能
- ✅ 智能增量备份
- ✅ 仅同步修改的文件
- ✅ 同步状态追踪
- ✅ 断点续传
- ✅ 并行传输

#### 媒体生命周期管理
- ✅ 素材从拍摄到归档的完整追踪
- ✅ 完整的状态历史记录
- ✅ 按状态/项目筛选
- ✅ 搜索功能
- ✅ 归档策略管理
- ✅ 自动化归档执行
- ✅ 统计信息

---

## 🔧 技术改进

### 性能优化
- ✅ 同步改异步，UI 更流畅
- ✅ 轮询间隔优化 (5秒 → 30秒)
- ✅ 批量并行处理
- ✅ 硬件加速支持

### 安全加固
- ✅ ASC MHL 标准合规
- ✅ 输入验证和路径安全
- ✅ Webhook URL 验证
- ✅ 文件名清理

### 测试覆盖
- ✅ 79 个测试用例
- ✅ 100% 通过率
- ✅ 核心模块完整覆盖

### 日志系统
- ✅ 统一使用文件日志
- ✅ 按日期自动滚动
- ✅ 自动保留 7 天日志
- ✅ 日志级别清晰

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.12.0-arm64.dmg`
   - Intel: `Kocpy-1.12.0-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹
4. 首次启动可能需要在"系统设置 → 隐私与安全性"中允许

---

## 🎯 核心优势

1. **行业标准合规** - ASC MHL 支持，进入专业市场
2. **差异化竞争** - NAS 归档功能，填补市场空白
3. **完整工作流** - 从备份到归档的完整解决方案
4. **专业级功能** - 元数据管理、转码、LUT/CDL、DaVinci 集成

---

## 📈 开发统计

- **新增文件**: 11 个
- **新增代码**: ~3000+ 行
- **新增依赖**: 3 个
- **构建时间**: ~850ms
- **测试通过**: 79/79 (100%)

---

## 🙏 致谢

感谢所有测试人员和贡献者的支持！

---

**完整更新日志**: [CHANGELOG.md](./CHANGELOG.md)
**发布包**: [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases)
