# 发布签名与公证准备

当前官方包仍为 ad-hoc 签名，未通过 Developer ID 身份认证和 Apple 公证。配置支持不等于执行成功；不得根据“签名结构通过”声称已公证。

CI 在构建前检查五项秘密名称：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。全部缺失时明确构建 ad-hoc；部分配置时失败，不默默降级。全部存在时使用既有身份签名／公证分支，再要求实际 Developer ID Application 签名、匹配 TeamIdentifier、stapler 票据校验与 Gatekeeper assessment。检查不会输出秘密值。

维护者需要自有有效 Developer ID Application 证书和 Apple 公证凭据，通过 GitHub 仓库 Secrets 的安全界面配置；不要提交证书、密码到仓库或在聊天中粘贴。未配置时不尝试购买资格、创建凭据或修改安全策略。正式安装包仍由同一 CI 流水线生成，先草稿、核验准确附件与桌面界面，再人工公开；不替换已经发布的文件。

[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing) · [安装与安全边界](INSTALLATION.md)
