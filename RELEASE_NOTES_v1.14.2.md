# Kocpy v1.14.2 更新日志

**发布日期**: 2026-07-12

---

## 🐛 Bug 修复

### 修复设备推出功能
- ✅ 修复 `diskutil eject` 因传入挂载路径（如 `/Volumes/SD_CARD`）而非 disk 标识符导致静默失败的问题
- ✅ 新增两步推出流程：先 `diskutil unmount` 卷，再通过 `diskutil info` 获取 Device Node 后 `diskutil eject` 整个磁盘
- ✅ 前端现在检查推出返回值，失败时保留设备在 UI 上，不再显示假成功
- ✅ 补上 `pages/Dashboard.tsx` 中缺失的 `onVolumeEject` 回调，点击推出按钮现在真正生效

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.14.2-arm64.dmg`
   - Intel: `Kocpy-1.14.2-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹

---

## 📊 版本统计

- **修复文件**: 4 个
- **测试通过**: 79/79 (100%)
