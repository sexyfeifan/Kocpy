# Kocpy v1.12.2 更新日志

**发布日期**: 2026-07-12

---

## 🐛 Bug 修复

### 修复 devices undefined 错误
- ✅ 修复 NewTask.tsx 中 `devices` 为 undefined 时导致的崩溃
- ✅ 添加防御性检查，确保 `devices` 始终为数组
- ✅ 修复项目模式中设备列表显示问题

**问题**:
```
TypeError: Cannot read properties of undefined (reading 'length')
```

**修复**:
- 使用可选链操作符 `devices?.length ?? 0`
- 确保 `devices` 始终有默认值

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.12.2-arm64.dmg`
   - Intel: `Kocpy-1.12.2-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹

---

## 🎯 核心功能

所有 v1.12.0 和 v1.12.1 的功能都已包含：

1. ✅ ASC MHL V1 标准支持
2. ✅ xxHash 算法集成
3. ✅ 元数据提取
4. ✅ 代理文件生成
5. ✅ LUT/CDL 管理
6. ✅ DaVinci Resolve 集成
7. ✅ NAS 设备发现和同步
8. ✅ 媒体生命周期管理
9. ✅ 所有功能设置界面

---

**完整更新日志**: [CHANGELOG.md](./CHANGELOG.md)
**发布包**: [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases)
