# Kocpy v1.14.4 更新日志

**发布日期**: 2026-07-12

---

## 🐛 Bug 修复

### 修复项目管理中设备添加失败
- ✅ 修复 `settings:getDevices` 处理器中 `loadSettings().devices` 未 await 导致返回 `undefined` 的问题
- ✅ `settings:save` 处理器补充 `await`，确保设置写入完成后再返回
- ✅ 设备添加、删除、重命名操作现在能正确持久化并刷新列表

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.14.4-arm64.dmg`
   - Intel: `Kocpy-1.14.4-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹
