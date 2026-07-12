# Kocpy v1.14.1 更新日志

**发布日期**: 2026-07-12

---

## 🐛 Bug 修复

### 修复本地硬盘显示问题
- ✅ 本地硬盘（Macintosh HD）现在正确显示
- ✅ 显示完整的容量信息（已用/剩余/总容量）
- ✅ 修复设备类型字段缺失问题
- ✅ 添加 deviceType: 'system' 标识

### 修复接入介质显示
- ✅ 添加前端去重逻辑（基于 path）
- ✅ 确保每个设备只显示一次
- ✅ 移除重复的 ConnectedDrives 组件

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.14.1-arm64.dmg`
   - Intel: `Kocpy-1.14.1-x64.dmg`
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
- ✅ 接入介质显示（参考 DiskHop）

---

## 📊 版本统计

- **修复文件**: 2 个
- **测试通过**: 79/79 (100%)
- **构建时间**: ~971ms

---

**完整更新日志**: [CHANGELOG.md](./CHANGELOG.md)
**发布包**: [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases)
