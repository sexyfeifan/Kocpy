# Kocpy v1.14.3 更新日志

**发布日期**: 2026-07-12

---

## 🐛 Bug 修复

### 修复接入介质推出后 UI 不刷新
- ✅ `ConnectedDrives` 组件新增 5 秒定时轮询，设备列表与系统实时同步
- ✅ 推出操作后改为从系统重新拉取设备列表，不再依赖本地 state 过滤
- ✅ 推出后无论成功失败都刷新 UI，确保与实际挂载状态一致

---

## 📦 安装说明

### 系统要求
- macOS 11.0 (Big Sur) 或更高版本
- 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel

### 下载安装
1. 下载对应架构的 DMG 文件
   - Apple Silicon: `Kocpy-1.14.3-arm64.dmg`
   - Intel: `Kocpy-1.14.3-x64.dmg`
2. 双击打开 DMG
3. 将 Kocpy 拖入 Applications 文件夹
