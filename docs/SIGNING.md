# 发布签名与公证准备

当前官方包仍为 ad-hoc 签名，未通过 Developer ID 身份认证和 Apple 公证。配置支持不等于执行成功；不得根据“签名结构通过”声称已公证。

CI 在构建前检查五项秘密名称：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。全部缺失时明确构建 ad-hoc；部分配置时失败，不默默降级。检查不会输出秘密值。

0.1.47 的媒体构建在锁定来源编译后，以固定标识执行 ad-hoc 与 hardened runtime 签名，保留签名前摘要并冻结最终完整文件摘要。App 打包只跳过这份已严格验证媒体文件的二次签名，App 及其他代码继续签名；签名后与准确 DMG 都再次核对完整媒体摘要、来源、许可、架构及严格签名结构。

当前流程明确只支持 ad-hoc 发布。完整 Developer ID／公证凭据不能让该媒体策略默默放行；需先实现并实测对应身份签名的媒体来源流程，才可启用身份发布。随后仍须证明 Developer ID Application 签名、匹配 TeamIdentifier、stapler 票据校验与 Gatekeeper assessment。源码配置或自动回归不等于已经完成这些验收。

维护者需要自有有效 Developer ID Application 证书和 Apple 公证凭据，通过 GitHub 仓库 Secrets 的安全界面配置；不要提交证书、密码到仓库或在聊天中粘贴。未配置时不尝试购买资格、创建凭据或修改安全策略。正式安装包仍由同一 CI 流水线生成，先草稿、核验准确附件与桌面界面，再人工公开；不替换已经发布的文件。

[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing) · [安装与安全边界](INSTALLATION.md)

`unsignedSha256` 表示 Kocpy 固定签名步骤之前的编译输出摘要；Apple Silicon 编译输出可能已带链接器 ad-hoc 签名，并不据此宣称该字段对应完全无签名文件。
