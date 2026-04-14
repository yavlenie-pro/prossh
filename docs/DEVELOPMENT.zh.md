# ProSSH — 开发指南

[English](./DEVELOPMENT.md) · [Русский](./DEVELOPMENT.ru.md) · **中文**

贡献者构建、运行、测试和扩展 ProSSH 所需的一切。

---

## 目录

1. [仓库布局](#仓库布局)
2. [先决条件](#先决条件)
3. [构建和运行](#构建和运行)
4. [架构](#架构)
5. [IPC 契约](#ipc-契约)
6. [数据模型和迁移](#数据模型和迁移)
7. [SSH 和 SFTP 内部](#ssh-和-sftp-内部)
8. [版本与发布流程](#版本与发布流程)
9. [代码风格](#代码风格)
10. [添加新功能：清单](#添加新功能清单)
11. [添加新语言](#添加新语言)
12. [调试技巧](#调试技巧)
13. [CI](#ci)

---

## 仓库布局

```
prossh/
├── .github/workflows/       # CI + release
├── docs/                    # 本文件夹
├── public/                  # 静态资源(如果有)
├── src/                     # React 前端
│   ├── api/                 # 按后端领域划分的薄 `invoke` 包装器
│   ├── components/          # React UI,按功能区域分组
│   │   ├── dialogs/         # 模态对话框(连接、凭据、导入 ……)
│   │   ├── layout/          # AppShell、StatusBar、TitleBar、SystemWidgets
│   │   ├── palette/         # 命令面板(cmdk)
│   │   ├── panes/           # 分屏视图 + 叶节点视图
│   │   ├── sessions/        # 会话列表 + 详情面板
│   │   ├── sftp/            # SFTP 浏览器
│   │   ├── sidebar/         # 侧边栏根、FilesBrowser、TransferQueue
│   │   ├── settings/        # 设置对话框
│   │   ├── tabs/            # 标签栏
│   │   ├── terminal/        # xterm 包装(TerminalView)
│   │   └── ui/              # 通用基础组件(Button、Input、Select ……)
│   ├── hooks/               # 可复用 hook(例如 useXterm)
│   ├── i18n/                # i18next 配置 + 每种语言的 JSON
│   ├── lib/                 # 工具辅助函数
│   ├── stores/              # Zustand stores
│   ├── styles/              # Tailwind 全局样式 + CSS 变量
│   ├── App.tsx              # 顶层组件(加载主题,挂载 AppShell)
│   └── main.tsx             # React 入口 + 全局 CSS 导入
├── src-tauri/               # Rust 后端(Tauri app)
│   ├── build.rs             # tauri-build + 版本注入
│   ├── Cargo.toml
│   ├── capabilities/        # Tauri 2 权限能力
│   ├── examples/            # 独立二进制(`ssh_probe` ……)
│   ├── icons/               # 打进安装包的平台图标
│   ├── src/
│   │   ├── commands/        # #[tauri::command] 处理器,按领域分组
│   │   ├── db/              # rusqlite 连接 + 迁移
│   │   ├── known_hosts/     # known_hosts.json 存储 + TOFU 策略
│   │   ├── secrets/         # OS 密钥链封装
│   │   ├── sessions/        # 会话仓、导入(ssh-config、PuTTY、Moba)
│   │   ├── sftp/            # SFTP 客户端 + 传输队列
│   │   ├── ssh/             # russh 会话、PTY、身份验证、gates、端口转发
│   │   ├── util/            # 杂项辅助
│   │   ├── error.rs         # AppError + IntoResponse
│   │   ├── lib.rs           # tauri::Builder、命令接线、事件监听器
│   │   ├── main.rs          # 简短的 `fn main() { prossh_lib::run() }`
│   │   ├── state.rs         # AppState(路径、db、maps、gates)
│   │   └── themes.rs        # BUILTIN_PROFILES(配色主题)
│   └── tauri.conf.json      # Tauri 应用配置(title、bundle、csp ……)
├── index.html
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## 先决条件

| 工具 | 版本 | 备注 |
| --- | --- | --- |
| Node.js | 20 LTS 或更新 | `npm ci` 使用 `package-lock.json`。 |
| Rust | 1.80+(stable) | 通过 [rustup](https://rustup.rs/) 安装。`cargo`、`rustc`、`clippy`、`rustfmt`。 |
| 平台工具链 | 见下文 | 原生依赖的 C 链接器。 |

**Windows**:MSVC Build Tools 2019+(即带有 "Desktop development with C++" 工作负载的 Visual Studio Build Tools)。Windows 11 已预装 WebView2 运行时。不需要 NASM——`russh` 被配置为使用纯 Rust 的 `ring` 加密后端。

**macOS**:Xcode Command Line Tools(`xcode-select --install`)。要构建通用二进制,添加两个目标:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**Linux**(Debian/Ubuntu;请根据你的发行版调整):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libdbus-1-dev \
  pkg-config \
  build-essential
```

> **Windows 上的 Git Bash**——`cargo` 不会自动出现在 `PATH` 上。命令前加 `PATH="/c/Users/$USER/.cargo/bin:$PATH"` 或使用 PowerShell。

## 构建和运行

```bash
npm ci                       # 安装 JS 依赖(首次)
npm run tauri dev            # 热重载开发版
npm run tauri build          # 发行包 → src-tauri/target/release/bundle/
```

其他有用的脚本:

```bash
npm run dev                  # 不带 Tauri 的 Vite 开发服务器(仅 UI,mock invoke)
npm run build                # tsc + vite build(不打 Tauri 包)
npm run lint                 # ESLint
npm run format               # Prettier

# 在 src-tauri/ 里:
cargo check                  # 快速类型检查(增量 ≈ 30 s)
cargo clippy -- -D warnings  # 对 Rust 端进行 lint
cargo test                   # 运行 Rust 单元测试
cargo fmt --all              # 格式化 Rust 源码
```

**Windows 提示**——运行中的 `prossh.exe` 会锁住二进制。在 `npm run tauri build` 之前,请结束所有运行实例:

```bash
powershell -Command "Stop-Process -Name prossh -Force -ErrorAction SilentlyContinue"
```

**首次 release 构建**——在快机上预计需要 3-5 分钟。后续使用 [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache)(CI 中使用)的构建大约需要 1 分钟。

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  渲染端 (WebView / Vite / React)                                    │
│                                                                      │
│   TerminalView   SftpExplorer   Sidebar    Dialogs    Palette        │
│        │              │            │          │          │          │
│        └──────────────┴────────────┼──────────┴──────────┘           │
│                                    ▼                                 │
│                             Zustand stores                          │
│                                    │                                 │
│                            @tauri-apps/api invoke                   │
└────────────────────────────────────┼────────────────────────────────┘
                                     │   IPC (JSON)
┌────────────────────────────────────▼────────────────────────────────┐
│  Rust 后端 (Tauri 2 运行时)                                         │
│                                                                      │
│   commands::*  ─►  domain modules                                   │
│                    ├─ ssh::pty      (russh 会话 + PTY)              │
│                    ├─ ssh::forward  (-L / -R 隧道)                  │
│                    ├─ sftp::client  (russh-sftp)                    │
│                    ├─ sessions::repo  (SQLite CRUD)                 │
│                    ├─ known_hosts    (JSON 存储 + TOFU)             │
│                    └─ secrets        (keyring crate)                │
│                                                                      │
│           AppState  { db, ssh_sessions, sftp_sessions,               │
│                       passphrase_gate, host_key_gate,                │
│                       credentials_gate, known_hosts, ... }          │
│                             ▲           ▲                            │
│                             │           │                            │
│  OS 密钥链 ◄──────────┘     │      ┌────▼────┐                       │
│  (Credential Manager /      │      │ SQLite  │  prossh.sqlite        │
│   Keychain / libsecret)     │      └─────────┘                       │
│                             │                                        │
│                      Tauri events ─►  host-key / passphrase /         │
│                                       credentials 提示对话框          │
└────────────────────────────────────────────────────────────────────┘
```

**为什么 `AppState` 通过 `tauri::State` 持有**——每个命令都接收 `State<'_, AppState>`,只克隆由 `Arc` 包裹的廉价子字段。`Database` 是 `Arc<Mutex<Connection>>`,ssh/sftp maps 是 `Arc<RwLock<HashMap<_, Arc<…>>>>`,因此命令处理器彼此不会阻塞,只有真正的 SQLite 串行化时才会等待。

**为什么围绕 rusqlite 使用 `tokio::task::spawn_blocking`**——SQLite 是同步的;把每个查询包在 `spawn_blocking` 里可以保持 async 运行时响应性。吞吐量在这里不是问题(我们是 SSH 客户端,不是数据库服务器)。

**Prompt gates**——host-key / 口令 / 凭据提示不能走常规的 `invoke` 返回路径:WebView2 会串行化 IPC 调用,一个尚未完成的 `open_session` invoke 会阻塞提示对话框 invoke 的响应,造成死锁。相反,后端触发一个 Tauri 事件,对话框返回 `resolve-*` 事件,后端的异步 gate `oneshot` 通道就解除阻塞。参见 [`ssh/gate.rs`](../src-tauri/src/ssh/gate.rs) 以及 [`lib.rs`](../src-tauri/src/lib.rs) 中的监听器设置。

## IPC 契约

所有命令位于 `src-tauri/src/commands/`,并在 [`lib.rs`](../src-tauri/src/lib.rs) 的 `invoke_handler!` 宏中注册。TypeScript 包装器在 `src/api/*.ts` 中镜像它们。

**命名约定**——Rust 命令使用 `snake_case`(`sftp_list`、`open_session`、`known_hosts_remove`)。TS 包装器以相同名字重新导出。

**Serde**——与前端共享的所有类型都使用 `#[serde(rename_all = "camelCase")]`。共享的类型定义位于 `src/api/types.ts`,必须手动与 Rust structs 保持同步。

**错误**——每个命令都返回 `Result<T, AppError>`。`AppError` 序列化为 `{ kind, message }`(见 `src-tauri/src/error.rs`)。在前端,调用点将 rejection 视为 `AppError`(见 `src/api/types.ts`)。

**事件**——用于单向通知和 prompt gate 模式:

| 事件 | 方向 | 负载 |
| --- | --- | --- |
| `pty://data/<runtime_id>` | Rust → JS | stdout/stderr 块为 `Uint8Array` |
| `pty://exit/<runtime_id>` | Rust → JS | 退出信息,关闭终端 |
| `pty://connected/<runtime_id>` | Rust → JS | 身份验证成功后发出 |
| `pty://error/<runtime_id>` | Rust → JS | 结构化错误对象 |
| `resolve-host-key` | JS → Rust | `{ prompt_id, accept: bool }` |
| `resolve-passphrase` | JS → Rust | `{ prompt_id, passphrase: string }` |
| `resolve-credentials` | JS → Rust | `{ prompt_id, username, password }` |
| `transfer://progress/<transfer_id>` | Rust → JS | SFTP 传输进度 |

## 数据模型和迁移

模式迁移位于 [`src-tauri/src/db/migrations.rs`](../src-tauri/src/db/migrations.rs)。版本保存在 SQLite 的内置 `PRAGMA user_version` 中,没有额外的簿记表。

添加迁移:

1. 将 `CURRENT_VERSION` 加 1。
2. 添加一个新的 `apply_vN` 函数,包含模式变更。
3. 在 `apply()` 中加入 match 分支。
4. **永远不要编辑已发布的迁移**——它在用户机器上只运行一次。

当前表:

| 表 | 用途 |
| --- | --- |
| `groups` | 会话文件夹(通过 `parent_id` 构成树)。 |
| `sessions` | 已保存的连接(host、port、user、auth_method ……)。 |
| `color_profiles` | 内置和自定义终端主题。 |
| `settings` | 应用偏好的 key/value 对。 |
| `scripts` | 全局(`session_id IS NULL`)和按会话的脚本。 |
| `port_forwards` | 每会话的本地/远程隧道。 |

敏感信息永远不会进入 SQLite。密码保存在 keyring service `prossh` 下,account 名为 `session_id`;密钥口令在 `prossh-keypass` 下。

## SSH 和 SFTP 内部

**Crate 选型**——[`russh`](https://github.com/warp-tech/russh)(纯 Rust)。我们明确禁用 `aws-lc-rs`(Windows 上需要 NASM),而使用 `ring` 后端加上 `flate2` + `rsa` 特性。见 `src-tauri/Cargo.toml`。

**会话生命周期**:

1. `commands::pty::open_session` 解析 DNS、打开 TCP,把 socket 交给 `russh::client::connect_stream`。
2. 主机密钥检查首先通过 `KnownHostsStore::check` 运行,如果需要提示,会走 `host_key_gate`。
3. 身份验证尝试先 `publickey`(agent → 密钥文件)再 `password`,如果服务器拒绝 pubkey 或没有保存密码,则通过 `credentials_gate` 提示。
4. 成功后,请求 PTY,spawn 一个 Tokio 任务把 `ChannelMsg::Data` 泵入 `pty://data/<id>` 事件。
5. `port_forwards` 表中的端口转发被注册到同一个 client handle 上。
6. `close_session` 发送 `disconnect` 并清理 map 条目。

**SFTP** 从同一个 `russh::client::Handle` 上通过 `russh_sftp::client::SftpSession::new` 创建独立通道。传输按块进行,每个 `transfer_id` 都有一个存放在 `AppState::transfer_cancellations` 里的取消 token。

**优雅关闭**——在 `RunEvent::ExitRequested` 中,`ssh::pty::close_all` 会以 3 秒超时被调用,以便在进程退出前 flush 未完成的数据。见 `lib.rs` 的 `run()` 尾部。

## 版本与发布流程

二进制通过 `app_version` IPC 命令暴露其版本,该命令读取构建期常量 `PROSSH_VERSION`(由 [`src-tauri/build.rs`](../src-tauri/build.rs) 设置)。

**版本解析顺序**(在 `build.rs` 中):

1. 如果设置了环境变量 `PROSSH_BUILD_VERSION`——原样使用。
2. 否则使用 `Cargo.toml` 中的 `CARGO_PKG_VERSION`,如果构建发生在 git checkout 内,可选地附加 `+sha.<shortSHA>` 后缀。

前端在挂载时调用一次 `app_version`,并在状态栏(右下角)和关于面板中显示该值。**不要**在 UI 中硬编码版本。

**CI 接线**:

- [`ci.yml`](../.github/workflows/ci.yml)——`main` / `prod` 上的推送和 PR。设置 `PROSSH_BUILD_VERSION=<Cargo>-dev.<run_number>+sha.<shortSHA>`。
- [`release.yml`](../.github/workflows/release.yml)——在 tag `v*` 上运行。设置 `PROSSH_BUILD_VERSION=<去掉前导 "v" 的 ref_name>`。

**切分发布**:

1. 在 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `package.json` 中升级 `version`(三处值保持一致)。
2. 以 `chore: release vX.Y.Z` 提交。
3. 打 tag:`git tag vX.Y.Z && git push --tags`。
4. GitHub Actions 会起草一个带有所有平台安装包的 release。
5. 编辑起草的 release notes,然后发布。

## 代码风格

**Rust**:

- `rustfmt` 默认设置(4 空格缩进,100 列宽)。推送前运行 `cargo fmt --all`。
- `cargo clippy -- -D warnings` 必须通过——CI 会强制。
- 错误传播:在命令边界优先使用领域特定的 `AppError` 变体(`Io`、`Database`、`Ssh`、`Secret`、`NotFound`、`InvalidArgument` ……)而不是 `anyhow::Error`。在模块内部 `anyhow` 是可以的。
- 注释:**写为什么,而不是什么。** 优先在公共项上用简短的 `///` 文档注释,而不是解释 Rust 语法的内联注释。
- Async:全程使用 `tokio`。不要混合 `async-std` 或 `smol`。
- 日志:`tracing::{debug,info,warn,error}` 带结构化字段——例如 `tracing::info!(session_id = %id, "connected");`。

**TypeScript / React**:

- Prettier + ESLint(TS + React 插件)。`npm run lint` 必须通过。
- 首选函数组件和 hook。不要使用类组件。
- 状态:共享应用状态用 Zustand stores,局部 UI 状态用 `useState`。不要引入 Redux。
- 数据获取:直接从 stores 或组件调用 `invoke`;在 `src/api/*.ts` 里写薄包装。目前不用 React Query(Tauri IPC 很快,很少需要重试/缓存逻辑)。
- CSS:Tailwind + 少量在 `styles/globals.css` 中定义的 CSS 自定义属性用于主题颜色(`--prossh-bg`、`--prossh-fg`、`--prossh-accent` ……)。
- 导入:通过 `@/` 别名进行绝对导入(见 `tsconfig.json` + `vite.config.ts`)。

**代码中的品牌**:

- UI 字符串:`ProSSH`(大写 P,大写 SSH)。
- 技术标识符:`prossh`(snake_case 风格)。适用于 npm 名字、cargo crate 名字、bundle id 段、路径、环境变量、keyring service 名字、SQL 标识符。

## 添加新功能:清单

假设你要添加"会话标签"(会话上的自由文本标签)。

1. **数据库迁移**——添加 `apply_v6`,创建 `session_tags` 并建立到 `sessions` 的 FK。
2. **Rust 领域模块**——扩展 `src-tauri/src/sessions/repo.rs`(或新建模块)加入 CRUD 函数。
3. **IPC 命令**——在 `src-tauri/src/commands/sessions.rs` 中添加 `tags_list`、`tags_set`。在 `lib.rs` 的 `invoke_handler!` 中接线。
4. **TypeScript 类型**——在 `src/api/types.ts` 中镜像 structs,并在 `src/api/sessions.ts` 中添加薄 `invoke` 包装。
5. **Store**——如果你需要标签的响应式状态,扩展 `src/stores/sessions.ts`。
6. **UI**——添加一个 `TagsEditor` 组件,把它嵌入 `SessionDetails` 和/或会话编辑器对话框。
7. **i18n**——在 `en.json` 中添加翻译 key,在 `ru.json` 和 `zh.json` 中同步镜像。**不要只发布英文 key。**
8. **测试**——repo 函数的 Rust 单元测试。UI 测试目前还没接入;手动点击是当前基线。
9. **文档**——在 `docs/USER_GUIDE.md` 中记录此功能(三种语言都要)。
10. **Changelog**——追加到 `CHANGELOG.md`(如不存在就创建)。

## 添加新语言

1. 把 `src/i18n/en.json` 复制为 `src/i18n/<code>.json`。
2. 翻译每个 key。注意占位符语法(`{{count}}`、`{{name}}`)——请保持完整。
3. 在 `src/i18n/index.ts` 中注册新语言:

   ```ts
   import fr from "./fr.json";
   // resources: { en: …, ru: …, zh: …, fr: { translation: fr } },
   ```

4. 在 `src/components/settings/SettingsDialog.tsx`(语言下拉)中添加语言选项,并在每种语言文件中加入 `settings.lang<Code>` key。
5. 翻译文档:`README.<code>.md`、`docs/USER_GUIDE.<code>.md`、`docs/DEVELOPMENT.<code>.md`,并更新所有现有文档中的语言切换器链接。

## 调试技巧

- **前端**——WebView2 DevTools:在任意位置右键(启用上下文菜单时)或按 `F12`。Release 版会剥离 DevTools;用 `npm run tauri dev` 构建以进行检查。
- **后端日志**——`tracing_subscriber` 通过 `RUST_LOG` 环境变量过滤:

  ```bash
  RUST_LOG=prossh=debug,russh=info npm run tauri dev
  ```

- **桌面日志文件**——`prossh-debug.log` 位于用户桌面,收集早期启动诊断和 prompt-gate 事件。在 DevTools 不可用时很有用。
- **Rust 堆栈跟踪**——设置 `RUST_BACKTRACE=1`;`RUST_BACKTRACE=full` 显示所有帧。
- **独立 SSH 探针**——`src-tauri/examples/ssh_probe.rs` 和 `ssh_probe_mismatch.rs` 可独立运行以测试 host-key 行为:`cargo run --example ssh_probe -- <host> <user>`。

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 在每个 PR 和推送到 `main` / `prod` 时运行:

- 矩阵:`windows-latest`、`macos-latest`、`ubuntu-22.04`。
- 步骤:安装系统依赖(仅 Linux)→ `npm ci` → `tsc --noEmit` → `cargo check` → `cargo clippy -- -D warnings`。
- 通过 `Swatinem/rust-cache@v2` 缓存 Rust 构建。

[`.github/workflows/release.yml`](../.github/workflows/release.yml) 在 `v*` tag 推送和通过 `workflow_dispatch` 时运行:

- 矩阵:`windows-latest`、`macos-latest`(aarch64 + x86_64)、`ubuntu-22.04`。
- 使用 `tauri-apps/tauri-action@v0` 产出平台安装包,并附加到一个 **草稿** GitHub release。
- 准备好后手动编辑 release notes 并发布。

两个工作流都会设置 `PROSSH_BUILD_VERSION`,以保证状态栏和关于面板中看到的版本与打包的内容完全一致。
