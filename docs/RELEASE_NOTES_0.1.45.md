# Kocpy 0.1.45

## 维护与发布门禁

- Electron 从 44.0.0 更新并锁定到同主版本稳定版 44.5.1，纳入 Chromium／V8 等上游修复。不混入 React、Vite、TypeScript 或 Vitest 的跨主版本迁移。
- 发布前验证签名配置完整性：没有凭据明确走 ad-hoc，部分凭据阻断，不默默降级或输出秘密值。
- 未来身份签名分支要求真实 Developer ID Application、匹配 TeamIdentifier、stapler 公证票据和 Gatekeeper 检查；继续单流水线、草稿准确附件核验后再公开。
- 继承 0.1.44 的高级转代理、滚动边界修复与专项验证工具；源哈希、排他输出及交付门禁不放宽。

## 诚实边界

本版未配置 Developer ID／Apple 公证凭据，实际发布仍为 ad-hoc；流程就绪不等于身份签名已完成。新增高级 NLE 组合和真实 NAS／拔盘测试未执行，按专项协议保留为未验证。

[Electron 44.5.1 官方说明](https://releases.electronjs.org/release/v44.5.1) · [签名准备](https://github.com/sexyfeifan/Kocpy/blob/main/docs/SIGNING.md)
