# ProSSH — Руководство разработчика

[English](./DEVELOPMENT.md) · **Русский** · [中文](./DEVELOPMENT.zh.md)

Всё, что нужно контрибьютору чтобы собрать, запустить, протестировать и расширить ProSSH.

---

## Содержание

1. [Структура репозитория](#структура-репозитория)
2. [Требования](#требования)
3. [Сборка и запуск](#сборка-и-запуск)
4. [Архитектура](#архитектура)
5. [IPC-контракт](#ipc-контракт)
6. [Модель данных и миграции](#модель-данных-и-миграции)
7. [Внутренности SSH и SFTP](#внутренности-ssh-и-sftp)
8. [Версионирование и релизный flow](#версионирование-и-релизный-flow)
9. [Код-стайл](#код-стайл)
10. [Добавление фичи: чеклист](#добавление-фичи-чеклист)
11. [Добавление нового языка](#добавление-нового-языка)
12. [Советы по дебагу](#советы-по-дебагу)
13. [CI](#ci)

---

## Структура репозитория

```
prossh/
├── .github/workflows/       # CI + release
├── docs/                    # эта папка
├── public/                  # статические ассеты (если есть)
├── src/                     # React-фронтенд
│   ├── api/                 # тонкие обёртки над `invoke` по доменам
│   ├── components/          # React UI, сгруппировано по feature area
│   │   ├── dialogs/         # модальные диалоги (connection, credentials, import, ...)
│   │   ├── layout/          # AppShell, StatusBar, TitleBar, SystemWidgets
│   │   ├── palette/         # Command palette (cmdk)
│   │   ├── panes/           # Split-pane view + leaf view
│   │   ├── sessions/        # список сессий + панель деталей
│   │   ├── sftp/            # SFTP-менеджер
│   │   ├── sidebar/         # корень Sidebar, FilesBrowser, TransferQueue
│   │   ├── settings/        # диалог настроек
│   │   ├── tabs/            # вкладки
│   │   ├── terminal/        # обёртка xterm (TerminalView)
│   │   └── ui/              # примитивы (Button, Input, Select, ...)
│   ├── hooks/               # переиспользуемые хуки (e.g. useXterm)
│   ├── i18n/                # i18next-setup + JSON на локаль
│   ├── lib/                 # утилиты
│   ├── stores/              # Zustand-stores
│   ├── styles/              # Tailwind globals + CSS-переменные
│   ├── App.tsx              # корневой компонент (грузит тему, монтирует AppShell)
│   └── main.tsx             # React entry + глобальные CSS-импорты
├── src-tauri/               # Rust backend (Tauri-приложение)
│   ├── build.rs             # tauri-build + инжекция версии
│   ├── Cargo.toml
│   ├── capabilities/        # Tauri 2 permission capabilities
│   ├── examples/            # отдельные бинарники (`ssh_probe`, ...)
│   ├── icons/               # платформенные иконки для инсталляторов
│   ├── wix/                 # локализованные строки WiX для MSI (ru-RU.wxl, zh-CN.wxl)
│   ├── src/
│   │   ├── commands/        # обработчики #[tauri::command], по доменам
│   │   ├── db/              # rusqlite-соединение + миграции
│   │   ├── known_hosts/     # known_hosts.json store + TOFU-политика
│   │   ├── secrets/         # обёртки над OS keychain
│   │   ├── sessions/        # repo сессий, импорт (ssh-config, PuTTY, Moba)
│   │   ├── sftp/            # SFTP-клиент + очередь передач
│   │   ├── ssh/             # russh-сессия, PTY, auth, gates, port forwarding
│   │   ├── util/            # разные helpers
│   │   ├── error.rs         # AppError + IntoResponse
│   │   ├── lib.rs           # tauri::Builder, проводка команд, event listeners
│   │   ├── main.rs          # тонкий `fn main() { prossh_lib::run() }`
│   │   ├── state.rs         # AppState (paths, db, maps, gates)
│   │   └── themes.rs        # BUILTIN_PROFILES (цветовые темы)
│   └── tauri.conf.json      # конфиг Tauri-приложения (title, bundle, csp, ...)
├── index.html
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Требования

| Инструмент | Версия | Заметки |
| --- | --- | --- |
| Node.js | 20 LTS или новее | `npm ci` использует `package-lock.json`. |
| Rust | 1.80+ (stable) | Ставится через [rustup](https://rustup.rs/). `cargo`, `rustc`, `clippy`, `rustfmt`. |
| Платформенный toolchain | см. ниже | C-линкер для нативных зависимостей. |

**Windows**: MSVC Build Tools 2019+ (aka Visual Studio Build Tools с workload'ом "Desktop development with C++"). WebView2 runtime предустановлен на Windows 11. NASM **не нужен** — `russh` сконфигурирован на `ring` (pure Rust).

**macOS**: Xcode Command Line Tools (`xcode-select --install`). Для universal-бинарей добавьте оба таргета:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**Linux** (Debian/Ubuntu; подставьте команды для своего дистрибутива):

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

> **Git Bash на Windows** — `cargo` не попадает в `PATH` автоматически. Префиксуйте команды `PATH="/c/Users/$USER/.cargo/bin:$PATH"` или используйте PowerShell.

## Сборка и запуск

```bash
npm ci                       # JS-зависимости (первый раз)
npm run tauri dev            # dev-сборка с hot reload
npm run tauri build          # release-бандл → src-tauri/target/release/bundle/
```

Другие полезные скрипты:

```bash
npm run dev                  # Vite dev server без Tauri (только UI, mock invoke)
npm run build                # tsc + vite build (без Tauri-бандлинга)
npm run lint                 # ESLint
npm run format               # Prettier

# Внутри src-tauri/:
cargo check                  # быстрая type-проверка (~30 с инкремент)
cargo clippy -- -D warnings  # линт Rust-стороны
cargo test                   # Rust unit-тесты
cargo fmt --all              # форматирование Rust-исходников
```

**Windows tip** — запущенный `prossh.exe` держит lock на бинаре. Перед `npm run tauri build` прибейте инстанс:

```bash
powershell -Command "Stop-Process -Name prossh -Force -ErrorAction SilentlyContinue"
```

**Первый release-билд** — 3-5 минут на быстрой машине. Повторные с кешем [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache) (используется в CI) — ~1 минута.

## Архитектура

```
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer (WebView / Vite / React)                                  │
│                                                                      │
│   TerminalView   SftpExplorer   Sidebar    Dialogs    Palette        │
│        │              │            │          │          │          │
│        └──────────────┴────────────┼──────────┴──────────┘           │
│                                    ▼                                 │
│                             Zustand-stores                          │
│                                    │                                 │
│                            @tauri-apps/api invoke                   │
└────────────────────────────────────┼────────────────────────────────┘
                                     │   IPC (JSON)
┌────────────────────────────────────▼────────────────────────────────┐
│  Rust backend (Tauri 2 runtime)                                    │
│                                                                      │
│   commands::*  ─►  доменные модули                                  │
│                    ├─ ssh::pty      (russh-сессии + PTY)            │
│                    ├─ ssh::forward  (-L / -R туннели)               │
│                    ├─ sftp::client  (russh-sftp)                    │
│                    ├─ sessions::repo  (CRUD в SQLite)               │
│                    ├─ known_hosts    (JSON store + TOFU)            │
│                    └─ secrets        (keyring crate)                │
│                                                                      │
│           AppState  { db, ssh_sessions, sftp_sessions,               │
│                       passphrase_gate, host_key_gate,                │
│                       credentials_gate, known_hosts, ... }          │
│                             ▲           ▲                            │
│                             │           │                            │
│  OS keychain ◄──────┘       │      ┌────▼────┐                       │
│  (Credential Manager /      │      │ SQLite  │  prossh.sqlite        │
│   Keychain / libsecret)     │      └─────────┘                       │
│                             │                                        │
│                     Tauri-события ─►  host-key / passphrase /        │
│                                       credentials промпты             │
└────────────────────────────────────────────────────────────────────┘
```

**Почему `AppState` держится через `tauri::State`** — каждая команда принимает `State<'_, AppState>` и клонирует только дешёвые `Arc`-обёрнутые подполя. `Database` — `Arc<Mutex<Connection>>`, ssh/sftp-карты — `Arc<RwLock<HashMap<_, Arc<…>>>>`, так что обработчики команд не блокируют друг друга кроме реальной сериализации SQLite.

**Почему `tokio::task::spawn_blocking` вокруг rusqlite** — SQLite синхронный; обёртка в `spawn_blocking` держит async-runtime отзывчивым. Нагрузка здесь не проблема (это SSH-клиент, не БД-сервер).

**Prompt gates** — диалоги host-key / passphrase / credentials не могут вернуть результат обычным `invoke`-путём: WebView2 сериализует IPC-вызовы, поэтому висящий `open_session`-invoke заблокировал бы ответ от invoke-диалога → deadlock. Вместо этого бэкенд эмитит Tauri-событие, диалог шлёт обратно `resolve-*`, и async-gate `oneshot`-канал резолвится. См. [`ssh/gate.rs`](../src-tauri/src/ssh/gate.rs) и listener'ы в [`lib.rs`](../src-tauri/src/lib.rs).

## IPC-контракт

Все команды — в `src-tauri/src/commands/` и регистрируются в макросе `invoke_handler!` в [`lib.rs`](../src-tauri/src/lib.rs). TypeScript-обёртки — в `src/api/*.ts`.

**Naming** — Rust-команды используют `snake_case` (`sftp_list`, `open_session`, `known_hosts_remove`). TS-обёртки ре-экспортят под тем же именем.

**Serde** — все типы, шарящиеся с фронтом, имеют `#[serde(rename_all = "camelCase")]`. Общие определения — в `src/api/types.ts`, синхронизируются с Rust-структурами руками.

**Ошибки** — каждая команда возвращает `Result<T, AppError>`. `AppError` сериализуется в `{ kind, message }` (см. `src-tauri/src/error.rs`). На фронте rejections трактуются как `AppError` (см. `src/api/types.ts`).

**События** — для one-way уведомлений и prompt-gate паттерна:

| Событие | Направление | Payload |
| --- | --- | --- |
| `pty://data/<runtime_id>` | Rust → JS | stdout/stderr чанки как `Uint8Array` |
| `pty://exit/<runtime_id>` | Rust → JS | exit info, закрывает терминал |
| `pty://connected/<runtime_id>` | Rust → JS | эмитится после успешной auth |
| `pty://error/<runtime_id>` | Rust → JS | структурированный error-объект |
| `resolve-host-key` | JS → Rust | `{ prompt_id, accept: bool }` |
| `resolve-passphrase` | JS → Rust | `{ prompt_id, passphrase: string }` |
| `resolve-credentials` | JS → Rust | `{ prompt_id, username, password }` |
| `transfer://progress/<transfer_id>` | Rust → JS | прогресс SFTP-передачи |

## Модель данных и миграции

Миграции — в [`src-tauri/src/db/migrations.rs`](../src-tauri/src/db/migrations.rs). Версия хранится во встроенном `PRAGMA user_version`, bookkeeping-таблицы нет.

Добавление миграции:

1. Увеличьте `CURRENT_VERSION` на 1.
2. Добавьте функцию `apply_vN` с изменениями схемы.
3. Разветвите match в `apply()`.
4. **Никогда не редактируйте уже выпущенную миграцию** — она выполняется на машине пользователя один раз.

Текущие таблицы:

| Таблица | Назначение |
| --- | --- |
| `groups` | Папки сессий (дерево через `parent_id`). |
| `sessions` | Сохранённые подключения (host, port, user, auth_method, ...). |
| `color_profiles` | Встроенные и пользовательские темы терминала. |
| `settings` | Key/value для настроек. |
| `scripts` | Глобальные (`session_id IS NULL`) и per-session скрипты. |
| `port_forwards` | Local/remote туннели на сессию. |

Секреты не попадают в SQLite. Пароли живут под keyring-сервисом `prossh` с `session_id` как имя аккаунта; passphrase ключей — под `prossh-keypass`.

## Внутренности SSH и SFTP

**Выбор крейта** — [`russh`](https://github.com/warp-tech/russh) (pure Rust). `aws-lc-rs` явно отключён (нужен NASM на Windows), используется `ring`-backend + `flate2` + `rsa`. См. `src-tauri/Cargo.toml`.

**Жизненный цикл сессии**:

1. `commands::pty::open_session` резолвит DNS, открывает TCP, передаёт сокет в `russh::client::connect_stream`.
2. Проверка host key — через `KnownHostsStore::check`, которая направляет в `host_key_gate` если нужен prompt.
3. Auth-попытки: сначала `publickey` (agent → key file), потом `password`, с prompt'ом через `credentials_gate` если сервер отверг pubkey или пароль не сохранён.
4. При успехе — запрос PTY, spawn Tokio-таски, которая качает `ChannelMsg::Data` в события `pty://data/<id>`.
5. Port-forwards из таблицы `port_forwards` регистрируются на том же client handle.
6. `close_session` шлёт `disconnect` и чистит map.

**SFTP** идёт по отдельному каналу того же `russh::client::Handle`, создаётся через `russh_sftp::client::SftpSession::new`. Передачи чанкаются с cancellation-токеном на `transfer_id`, живущим в `AppState::transfer_cancellations`.

**Graceful shutdown** — в `RunEvent::ExitRequested` вызывается `ssh::pty::close_all` с 3-сек таймаутом, чтобы дослать pending data до выхода процесса. См. хвост `run()` в `lib.rs`.

## Версионирование и релизный flow

Бинарник отдаёт свою версию через IPC-команду `app_version`, которая читает build-time константу `PROSSH_VERSION` (устанавливается в [`src-tauri/build.rs`](../src-tauri/build.rs)).

**Порядок резолвинга версии** (в `build.rs`):

1. Env var `PROSSH_BUILD_VERSION` — берётся as-is.
2. Иначе `CARGO_PKG_VERSION` из `Cargo.toml`, опционально с суффиксом `+sha.<shortSHA>` если сборка в git-checkout'е.

Фронтенд вызывает `app_version` один раз при монтировании и показывает значение в status bar (правый нижний угол) и на About-панели. **Не хардкодьте версию в UI**.

**CI-проводка**:

- [`ci.yml`](../.github/workflows/ci.yml) — push'ы в `main` / `prod` и PR'ы. Ставит `PROSSH_BUILD_VERSION=<Cargo>-dev.<run_number>+sha.<shortSHA>`.
- [`release.yml`](../.github/workflows/release.yml) — запускается на тегах `v*`. Ставит `PROSSH_BUILD_VERSION=<ref_name без ведущего "v">`.

**Выпуск релиза**:

1. Увеличьте `version` в `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` и `package.json` (одно и то же значение во всех трёх).
2. Закоммитьте `chore: release vX.Y.Z`.
3. Тег: `git tag vX.Y.Z && git push --tags`.
4. GitHub Actions создаст draft-релиз с инсталляторами под все платформы.
5. Отредактируйте release notes, опубликуйте.

## Код-стайл

**Rust**:

- `rustfmt` defaults (4-space indent, 100-col width). Перед push — `cargo fmt --all`.
- `cargo clippy -- -D warnings` обязан проходить — CI это проверяет.
- Обработка ошибок: domain-specific варианты `AppError` (`Io`, `Database`, `Ssh`, `Secret`, `NotFound`, `InvalidArgument`, …) вместо `anyhow::Error` на границах команд. `anyhow` ок внутри модулей.
- Комментарии: **пишите "почему", а не "что"**. Короткий `///` doc-коммент на публичном элементе лучше inline-комментария, объясняющего синтаксис Rust.
- Async: везде `tokio`. Не мешайте `async-std` или `smol`.
- Логирование: `tracing::{debug,info,warn,error}` со структурированными полями — например `tracing::info!(session_id = %id, "connected");`.

**TypeScript / React**:

- Prettier + ESLint (TS + React plugins). `npm run lint` обязан пройти.
- Предпочитайте функциональные компоненты и хуки. Никаких class components.
- State: Zustand-stores для shared app state, `useState` для локального UI. Не тащите Redux.
- Data fetching: вызывайте `invoke` напрямую из stores или компонентов; тонкие обёртки в `src/api/*.ts`. React Query пока не нужен (Tauri IPC быстрый, retry/cache-логика редко нужна).
- CSS: Tailwind + небольшое число CSS custom properties в `styles/globals.css` для цветов темы (`--prossh-bg`, `--prossh-fg`, `--prossh-accent`, …).
- Импорты: абсолютные через alias `@/` (см. `tsconfig.json` + `vite.config.ts`).

**Брендинг в коде**:

- UI-строки: `ProSSH` (большая P, большие SSH).
- Технические идентификаторы: `prossh` (snake_case-ish). Касается npm-имени, cargo-крейта, сегментов bundle id, путей, env var, keyring-сервисов, SQL-идентификаторов.

## Добавление фичи: чеклист

Допустим, вы добавляете "session tags" (произвольные метки на сессиях).

1. **Миграция БД** — добавьте `apply_v6`, создающий `session_tags` с FK на `sessions`.
2. **Rust-доменный модуль** — расширьте `src-tauri/src/sessions/repo.rs` (или создайте новый модуль) CRUD-функциями.
3. **IPC-команды** — `src-tauri/src/commands/sessions.rs`, добавьте `tags_list`, `tags_set`. Проведите в `invoke_handler!` в `lib.rs`.
4. **TypeScript-типы** — зеркало структур в `src/api/types.ts` + тонкие `invoke`-обёртки в `src/api/sessions.ts`.
5. **Store** — расширьте `src/stores/sessions.ts` если нужно реактивное состояние для тегов.
6. **UI** — компонент `TagsEditor`, встройте в `SessionDetails` и/или редактор сессии.
7. **i18n** — ключи перевода в `en.json`, зеркала в `ru.json` и `zh.json`. **Не шипите English-only ключи.**
8. **Тесты** — Rust unit-тесты для repo-функций. UI-тесты пока не настроены; базовый уровень — ручной click-through.
9. **Доки** — задокументируйте фичу в `docs/USER_GUIDE.md` (все три языка).
10. **Changelog** — припишите в `CHANGELOG.md` (создайте если его ещё нет).

## Добавление нового языка

1. Скопируйте `src/i18n/en.json` в `src/i18n/<code>.json`.
2. Переведите каждый ключ. Осторожно с placeholder-синтаксисом (`{{count}}`, `{{name}}`) — оставьте как есть.
3. Зарегистрируйте локаль в `src/i18n/index.ts`:

   ```ts
   import fr from "./fr.json";
   // resources: { en: …, ru: …, zh: …, fr: { translation: fr } },
   ```

4. Добавьте опцию языка в `src/components/settings/SettingsDialog.tsx` (dropdown языка) и ключ `settings.lang<Code>` в каждый файл локали.
5. Переведите документацию: `README.<code>.md`, `docs/USER_GUIDE.<code>.md`, `docs/DEVELOPMENT.<code>.md`, обновите language-switcher во всех существующих доках.
6. **Windows-инсталлятор** — зарегистрируйте язык в `src-tauri/tauri.conf.json`, секция `bundle.windows`:
   - `nsis.languages`: добавьте идентификатор языка NSIS (например `French`, `German`, `Japanese`). См. [полный список языков NSIS](https://github.com/kichik/nsis/tree/9465c08046f00ccb6eda985abbdbf52c275c6c4d/Contrib/Language%20files). Для большинства из них у `tauri-bundler` уже есть встроенные переводы — проверьте `crates/tauri-bundler/src/bundle/windows/nsis/languages/` в репозитории tauri; для отсутствующих нужен `customLanguageFiles`.
   - `wix.language`: добавьте WiX-код локали (например `"fr-FR": { "localePath": "wix/fr-FR.wxl" }`) и создайте соответствующий `.wxl` рядом с `ru-RU.wxl` / `zh-CN.wxl`. Переводу подлежат только четыре строки (`LaunchApp`, `DowngradeErrorMessage`, `PathEnvVarFeature`, `InstallAppFeature`); `TauriLanguage` / `TauriCodepage` автоматически подставляются `tauri-bundler`'ом из его `languages.json`.

## Советы по дебагу

- **Фронтенд** — WebView2 DevTools: правый клик (если context-menu включён) или `F12`. В release-сборках DevTools вырезан; собирайте через `npm run tauri dev` для инспекции.
- **Бэкенд-логи** — `tracing_subscriber` фильтрует через env var `RUST_LOG`:

  ```bash
  RUST_LOG=prossh=debug,russh=info npm run tauri dev
  ```

- **Debug-лог на рабочем столе** — `prossh-debug.log` собирает early-boot диагностику и события prompt-gate. Удобно, когда DevTools недоступен.
- **Rust stack traces** — `RUST_BACKTRACE=1`; `RUST_BACKTRACE=full` для всех фреймов.
- **Standalone SSH-проберы** — `src-tauri/examples/ssh_probe.rs` и `ssh_probe_mismatch.rs` можно запустить отдельно для тестирования host-key поведения: `cargo run --example ssh_probe -- <host> <user>`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) запускается на каждый PR и push в `main` / `prod`:

- Матрица: `windows-latest`, `macos-latest`, `ubuntu-22.04`.
- Шаги: установка system deps (только Linux) → `npm ci` → `tsc --noEmit` → `cargo check` → `cargo clippy -- -D warnings`.
- Rust build cache через `Swatinem/rust-cache@v2`.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) запускается на push тегов `v*` и через `workflow_dispatch`:

- Матрица: `windows-latest`, `macos-latest` (aarch64 + x86_64), `ubuntu-22.04`.
- Использует `tauri-apps/tauri-action@v0` для производства платформенных инсталляторов и аттачит их в **draft** GitHub-релиз.
- Вы правите release notes и публикуете вручную, когда готовы.

Оба workflow'а выставляют `PROSSH_BUILD_VERSION`, так что версия в status bar и About-панели точно совпадает с тем, что лежит в бандле.
