# Kocpy v1.14.0 更新日志

**发布日期**: 2026-07-12

---

## 🎨 新增功能：接入介质显示

### ConnectedDrives 组件
参考 Kocard 设计理念，在主页面添加接入介质显示功能。

**功能特点**:
- ✅ 实时显示已连接设备
- ✅ 设备类型标签（素材卡/备份盘/系统盘）
- ✅ 颜色编码（琥珀色/蓝色/灰色）
- ✅ 容量使用率进度条
- ✅ 存储空间警告（>90%显示红色）
- ✅ 安全弹出功能
- ✅ 30秒自动刷新
- ✅ 响应式网格布局

**设备类型**:
- 🟠 素材卡 (source) - 琥珀色标识
- 🔵 备份盘 (destination) - 蓝色标识
- ⚫ 系统盘 (system) - 灰色标识

**使用场景**:
- 快速查看已连接的存储设备
- 监控存储空间使用情况
- 安全弹出外接设备
- 选择设备作为备份源/目标

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.14.0-arm64.dmg`
   - Intel: `Kocpy-1.14.0-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹

---

## 🎯 核心功能

包含之前所有版本的功能：
- ✅ 三种备份模式（备卡/镜像/项目）
- ✅ ASC MHL 标准支持
- ✅ xxHash 算法集成
- ✅ 元数据提取
- ✅ 代理文件生成
- ✅ LUT/CDL 管理
- ✅ DaVinci Resolve 集成
- ✅ NAS 设备发现和同步
- ✅ 媒体生命周期管理
- ✅ **接入介质显示** ✨ 新增

---

**完整更新日志**: [CHANGELOG.md](./CHANGELOG.md)
**发布包**: [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases)
