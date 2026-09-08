# Kocpy 安装与升级

当前正式版：**0.1.36**。[返回首页](../README.md) · [文档导航](README.md) · [使用手册](USER_GUIDE.md)

## 1. 选择安装包

在 Mac 的“关于本机”中确认芯片类型，并从 [Kocpy 官方 GitHub Release](https://github.com/sexyfeifan/Kocpy/releases/latest) 下载：

| Mac 类型 | 安装文件 |
| --- | --- |
| Apple Silicon，M 系列芯片 | [Kocpy-0.1.36-arm64.dmg](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/Kocpy-0.1.36-arm64.dmg) |
| Intel 处理器 | [Kocpy-0.1.36-x64.dmg](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/Kocpy-0.1.36-x64.dmg) |

每个安装包只包含匹配架构的媒体运行时，无需另装 FFmpeg。Release 的媒体对应源码包用于许可与重建，不是安装器。GitHub 自动生成的 “Source code” ZIP／tar.gz 也不是可直接打开的应用。

## 2. 核对 SHA-256

同时下载本版 [SHA256SUMS.txt](https://github.com/sexyfeifan/Kocpy/releases/download/v0.1.36/SHA256SUMS.txt)。在终端输入 `shasum -a 256 `（末尾有空格），把下载的 DMG 拖入终端，再按回车。例如文件位于默认下载目录时：

```bash
shasum -a 256 "$HOME/Downloads/Kocpy-0.1.36-arm64.dmg"
```

Intel 包使用对应的 x64 文件名。输出的 64 位十六进制摘要须与同版清单中的对应行完全一致；不一致则不要安装，重新从官方 Release 下载。

摘要一致只证明文件与发布附件一致，不证明获得 Apple 认证。不要拿候选包、其他架构或旧版本的摘要与当前包比较。

## 3. 安装与系统安全提醒

打开 DMG，把 Kocpy 拖入“应用程序”，然后从“应用程序”打开；不要把 DMG 中的应用当作长期安装位置。

**当前没有 Developer ID 签名，也没有 Apple 公证。** 发布包使用 ad-hoc 签名并验证包结构，这不能替代开发者身份认证或 Apple 的公证检查。

- 如果只是“无法验证开发者／无法检查恶意软件”的提醒，只有在确认官方来源与文件完整性、并愿意接受未公证风险后，才按系统提供的“隐私与安全性 → 仍要打开”流程确认。具体以 [Apple 的安全打开 App 说明](https://support.apple.com/zh-cn/102445)和当前系统界面为准。
- 如果提示“已损坏”或“将损坏电脑”，不要直接把它当成普通未签名提示，也不要直接关闭 Gatekeeper 或递归清除下载隔离属性。先停止打开、核对架构与摘要、重新下载；仍有问题时保留完整提示、macOS 版本和包摘要用于排查。
- 签名检查通过、曾在另一台 Mac 成功打开，均不保证当前系统一定放行。受管理的 Mac 还可能有额外安全策略。

需要协助时，可在 [GitHub Issues](https://github.com/sexyfeifan/Kocpy/issues)提交脱敏后的问题信息。不要公开账号、私人路径或真实素材。

## 4. 升级前后

1. 等待备份、校验、接管、代理和归档维护操作安全结束，不要在写入过程中强制退出或更换应用。
2. 升级前在设置中导出本地数据备份，并保管好已有素材与独立副本。应用数据备份不包含全部素材内容，不能代替素材备份。
3. 正常退出 Kocpy，用新 DMG 中的应用替换“应用程序”中的 Kocpy。
4. 从“应用程序”启动，查看应用固定版本位置是否为 0.1.36，再检查项目与任务状态。
5. 正式拍摄前，用隔离的非生产素材完成一次复制与回读，确认自己的介质、权限和连接方式符合预期。

不要通过删除 `~/Library/Application Support/Kocpy/` 来修复升级提示；这里存有项目、任务与证据。新版权威记录与旧版兼容镜像的恢复边界见[工作区记录与安全升级](USER_GUIDE.md#工作区记录与安全升级)。回退旧版后写入记录再升级，可能需要额外恢复处理。

## 5. 为什么“检查更新”仍显示旧版本

“检查更新”比较**当前运行的应用版本**与 **GitHub 正式 Release**，不等于读取仓库里的 `package.json`。文档提交或源码版本变化不自动生成安装包；点击检查更新也不证明新应用已经替换成功。

依次核对：

1. [latest Release](https://github.com/sexyfeifan/Kocpy/releases/latest) 是否已经公开目标版本，而不是草稿、预发布或只有源码提交。
2. 正在运行的是“应用程序”里的新包，还是旧 DMG、下载文件夹、测试目录或 Dock 指向的旧副本。
3. 退出旧进程后，重新打开已安装的新包，查看固定版本位置。
4. 网络检查失败时保留具体提示，稍后重试；不要把失败误认为服务器确认“已是最新”。

本次 GitHub 文字整理不改变 0.1.36 安装包、标签或 SHA-256，也不会让已安装应用自动变成另一个版本。
