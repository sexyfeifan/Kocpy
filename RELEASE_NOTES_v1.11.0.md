# Kocpy v1.11.0 更新日志

**发布日期**: 2026-07-10

---

## 🎨 重大更新：Astryx UI 设计系统

### 全面 UI 重构
- ✅ 集成 `@astryxdesign/core` 组件库
- ✅ 统一的设计系统和主题变量
- ✅ 深色/浅色主题切换支持
- ✅ 响应式布局改进

### 组件标准化
- Card, Button, Switch, Badge, VStack/HStack 等组件
- SegmentedControl 模式选择器
- EmptyState 空状态处理

### 代码优化
- NewTask.tsx: 500 行 → 240 行（-52%）
- 提取子组件: SourceSelector, DestinationSelector, ProjectMode
- 移除重复代码，统一从 utils.ts 导入

---

## 🚀 新增功能

### 增量备份（后端就绪）
- 新增 `incremental` 标志
- 追踪 `unchangedFiles` 和 `unchangedBytes`
- 文件比较逻辑：大小 + 修改时间
- **状态**: 后端完成，UI 集成待后续版本

### 任务队列系统
- ✅ 正确的任务队列管理
- ✅ 优先级排序（priority 高的任务优先执行）
- ✅ 顺序执行（MAX_CONCURRENT_TASKS = 1）
- ✅ 队列操作：入队、取消、重新排序

### FX3 文件重命名
- ✅ Sony FX3 摄影机文件重命名逻辑
- ✅ 在目的地备份后执行
- 支持 .mp4, .mov, .mxf 格式

---

## 🔧 技术改进

### 性能优化
- 文件并发控制（runWithConcurrency）
- 任务队列管理系统
- 内存使用优化

### 类型安全
- 完善 BackupTask 接口定义
- 新增 incremental/unchangedFiles/unchangedBytes 字段
- 修复 DriveInfo 类型定义

### 测试覆盖
- 46 个单元测试全部通过
- 新增 vitest 配置
- 测试 resolveDeviceRoot 逻辑
- 测试增量备份比较逻辑

### 本地化支持
- 新增 locales.ts 国际化文件
- 支持中文界面

---

## 📁 版本管理

### 文件结构
```
legacy/versions/
├── v1.0.0/
├── v1.1.0/
├── v1.11.0/          # 新增
└── v1.12.0/
```

### 版本号调整
- 从 1.12.0 调整为 1.11.0
- 遵循语义化版本规范
- 1.10.2 → 1.11.0（新功能版本）

---

## 🐛 已知问题

1. 增量备份 UI 集成未完成（后端就绪）
2. 任务队列 UI 可视化待完善
3. FX3 重命名需要真实素材测试

---

## 📦 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 框架 | Electron | 28 |
| 前端 | React | 19.2.7 |
| UI 库 | @astryxdesign/core | 0.1.4 |
| 状态管理 | Zustand | 4.5.0 |
| 构建 | electron-vite | 2.0.0 |
| 测试 | Vitest | 4.1.10 |

---

## 🎯 下一步计划

### v1.12.0（计划中）
- [ ] 增量备份 UI 集成
- [ ] 任务队列可视化
- [ ] FX3 重命名测试和优化
- [ ] 性能测试和优化
- [ ] 更多单元测试

---

## 📝 升级指南

### 从 v1.10.2 升级
1. 备份当前配置
2. 下载 v1.11.0 安装包
3. 安装新版本
4. 配置文件自动迁移

### 开发者
```bash
git pull origin main
npm install
npm run dev
```

---

## 🙏 致谢

感谢所有测试人员和贡献者的支持！

---

**完整更新日志**: [CHANGELOG.md](./CHANGELOG.md)
**发布包**: [GitHub Releases](https://github.com/sexyfeifan/Kocpy/releases)
