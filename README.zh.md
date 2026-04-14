# ProSSH

> 现代化的跨平台 SSH / SFTP 客户端：支持标签页、分屏、内置文件管理器，凭据安全存储在系统密钥链中。

[![CI](https://github.com/yavlenie-pro/prossh/actions/workflows/ci.yml/badge.svg)](https://github.com/yavlenie-pro/prossh/actions/workflows/ci.yml)
[![Release](https://github.com/yavlenie-pro/prossh/actions/workflows/release.yml/badge.svg)](https://github.com/yavlenie-pro/prossh/actions/workflows/release.yml)

[English](./README.md) · [Русский](./README.ru.md) · **中文**

ProSSH 是一个使用 Rust + React 在 [Tauri 2](https://tauri.app/) 之上构建的桌面 SSH 客户端。它集成了高性能的 WebGL 终端（[xterm.js](https://xtermjs.org/)）、SFTP 面板、服务器间直接拷贝、端口转发，以及从 PuTTY、MobaXterm 和 `~/.ssh/config` 一键导入的功能——全部打包在约 15 MB 的原生二进制中。

---

## 功能

- **标签式终端**——支持横向 / 纵向分屏、WebGL 渲染器、Unicode 11、搜索和 URL 识别。
- **SFTP 文件浏览器**——双栏布局，支持拖放上传/下载、重命名、删除、`chmod`、新建文件/目录，并可在外部编辑器中编辑，保存后自动上传。
- **服务器间拷贝**——通过引导向导在两台服务器之间直接使用 `rsync` / `scp`（自动安装缺失工具、生成一次性密钥、完成后清理）。
- **端口转发**——每个会话的本地（`-L`）和远程（`-R`）隧道，连接时自动激活。
- **会话管理**——按文件夹分组，每个会话可配色，按最近使用排序，支持复制、重命名、批量去重。
- **导入**——`~/.ssh/config`、PuTTY（Windows 注册表）、MobaXterm（注册表或 `.mxtsessions` 文件），并将文件夹映射为分组。
- **凭据安全**——密码和密钥口令保存在操作系统密钥链中（Windows 凭据管理器、macOS 钥匙串、Linux libsecret）。磁盘上不会以明文保存任何敏感信息。
- **Known hosts**——TOFU（首次使用即信任）模式，需明确确认指纹，指纹不匹配时拒绝连接，并提供撤销单个密钥的 UI。
- **身份验证**——密码、私钥（支持口令提示）或 `ssh-agent`。
- **配色方案**——内置 Windows Terminal / iTerm / Solarized 等主题以及自定义配色。
- **命令面板**（`Ctrl+Shift+P`）——模糊搜索会话、脚本和操作。
- **脚本**——可复用的 bash 片段，全局或按会话作用，一键注入终端。
- **远程系统小组件**——可选显示每个会话的 CPU / 内存 / 磁盘 / 运行时间。
- **国际化**——开箱即用的英语、俄语、简体中文 UI。

完整功能介绍请参阅 [**docs/USER_GUIDE.zh.md**](./docs/USER_GUIDE.zh.md)。

## 下载

所有平台的签名安装包都可以在每个 [GitHub Release](https://github.com/yavlenie-pro/prossh/releases) 中找到：

| 平台 | 构件 |
| --- | --- |
| Windows | `ProSSH_*_x64-setup.exe`（NSIS）、`ProSSH_*_x64_en-US.msi` |
| macOS | `ProSSH_*_aarch64.dmg`、`ProSSH_*_x64.dmg` |
| Linux | `prossh_*_amd64.deb`、`prossh_*_amd64.AppImage` |

正式版由 [release workflow](./.github/workflows/release.yml) 根据 git 标签 `v*` 自动构建。

## 快速开始

1. 根据你的操作系统从最新 release 中安装对应的包。
2. 启动 **ProSSH**。
3. 点击 **新建会话**，填写主机 / 用户名 / 身份验证，点击 **保存**。
4. 按下 **连接**（或在所选会话上按 `Enter`）——ProSSH 将协商主机密钥，首次使用时会提示你确认，然后打开终端标签页。
5. 将侧边栏切换到 **文件**，即可获得同一连接的 SFTP 面板。

键盘快捷键：

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+Shift+P` | 命令面板 |
| `Ctrl+Shift+T` | 为所选会话新建标签页 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Shift+D` | 水平分屏 |
| `Ctrl+Shift+E` | 垂直分屏 |
| `Ctrl+B` | 切换侧边栏 |

## 从源码构建

```bash
# 先决条件：Node.js 20+、Rust 1.80+、平台的 webview / 构建依赖（见 docs/DEVELOPMENT.zh.md）
npm ci
npm run tauri dev      # 热重载开发版
npm run tauri build    # 发行包，位于 src-tauri/target/release/bundle/
```

详细的构建矩阵（Windows MSVC、macOS Xcode、Linux `libwebkit2gtk-4.1`）、代码风格约定和架构概览见 [**docs/DEVELOPMENT.zh.md**](./docs/DEVELOPMENT.zh.md)。

## 技术栈

- **后端**——Rust、[Tauri 2](https://tauri.app/)、[Tokio](https://tokio.rs/)、[russh](https://github.com/warp-tech/russh)（纯 Rust SSH 实现）、[russh-sftp](https://github.com/AspectUnk/russh-sftp)、[rusqlite](https://github.com/rusqlite/rusqlite)（打包 SQLite）、[keyring](https://github.com/hwchen/keyring-rs)、[tracing](https://github.com/tokio-rs/tracing)。
- **前端**——React 18、TypeScript、Tailwind CSS、[xterm.js](https://xtermjs.org/)（WebGL）、[Radix UI](https://www.radix-ui.com/)、[Zustand](https://github.com/pmndrs/zustand)、[cmdk](https://cmdk.paco.me/)、[i18next](https://www.i18next.com/)。
- **持久化**——SQLite（会话元数据、脚本、端口转发、配色方案、KV 设置）位于 `%APPDATA%/prossh/`（Windows）/ `~/Library/Application Support/prossh/`（macOS）/ `~/.local/share/prossh/`（Linux）。敏感信息保存在系统密钥链中，不存入数据库。

## 项目状态

版本 0.1.x——**MVP**。终端、SFTP、端口转发、导入、配色方案和脚本功能均可使用。监控小组件和插件 API 计划在 0.2 版本发布。

## 许可

ProSSH 按 [PolyForm Noncommercial 1.0.0](./LICENSE) 许可发布。个人和非商业用途免费。

**商业使用**请联系 [mail@yavlenie.pro](mailto:mail@yavlenie.pro)。

## 贡献

欢迎 Issue 和 PR。在提交 PR 前请阅读 [开发指南](./docs/DEVELOPMENT.zh.md) 并在本地运行 `npm run lint` + `cargo clippy -- -D warnings`。
