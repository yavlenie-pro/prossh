# ProSSH

> Современный кросс-платформенный SSH / SFTP-клиент с вкладками, split-панелями, встроенным файловым менеджером и хранением учётных данных в системном keychain.

[![CI](https://github.com/yavlenie-pro/prossh/actions/workflows/ci.yml/badge.svg)](https://github.com/yavlenie-pro/prossh/actions/workflows/ci.yml)
[![Release](https://github.com/yavlenie-pro/prossh/actions/workflows/release.yml/badge.svg)](https://github.com/yavlenie-pro/prossh/actions/workflows/release.yml)

[English](./README.md) · **Русский** · [中文](./README.zh.md)

ProSSH — десктопный SSH-клиент на Rust + React поверх [Tauri 2](https://tauri.app/). Быстрый WebGL-терминал ([xterm.js](https://xtermjs.org/)), SFTP-панель, прямое копирование между серверами, проброс портов и импорт сессий из PuTTY, MobaXterm и `~/.ssh/config` — всё это в нативном бинарнике ~15 МБ.

---

## Возможности

- **Терминал с вкладками** и split-панелями (горизонтальный / вертикальный сплит), WebGL-рендерер, Unicode 11, поиск и подсветка ссылок.
- **SFTP-менеджер** — двухпанельный, drag-and-drop загрузка/скачивание, rename, delete, `chmod`, создание файла/папки, редактирование в любом внешнем редакторе с авто-загрузкой при сохранении.
- **Server-to-server копирование** — прямой `rsync`/`scp` между двумя серверами через пошаговый мастер (устанавливает нужные утилиты, генерирует временный ключ, чистит за собой).
- **Port forwarding** — локальные (`-L`) и удалённые (`-R`) туннели на каждую сессию, активируются автоматически при подключении.
- **Управление сессиями** — сессии в папках-группах, индивидуальный цвет, сортировка по last-used, дублирование, переименование, массовая дедупликация.
- **Импорт** — `~/.ssh/config`, PuTTY (реестр Windows), MobaXterm (реестр или `.mxtsessions`-файл) с маппингом папок в группы.
- **Защищённые учётки** — пароли и passphrase ключей живут в OS keychain (Windows Credential Manager, macOS Keychain, libsecret в Linux). Ничего чувствительного не пишется на диск открытым текстом.
- **Known hosts** — TOFU (trust-on-first-use) с явным подтверждением fingerprint'а, отказом при несовпадении и UI для отзыва отдельных ключей.
- **Аутентификация** — пароль, приватный ключ (с prompt'ом на passphrase) или `ssh-agent`.
- **Цветовые профили** — встроенные темы в стиле Windows Terminal / iTerm / Solarized плюс пользовательские.
- **Command palette** (`Ctrl+Shift+P`) с fuzzy-поиском по сессиям, скриптам и действиям.
- **Скрипты** — переиспользуемые bash-сниппеты с глобальной областью или для конкретной сессии, выполняются прямо в терминале.
- **Виджеты удалённой системы** — опциональный просмотр CPU / RAM / диска / uptime для каждой сессии.
- **i18n** — английский, русский и упрощённый китайский UI из коробки.

Подробный гайд по фичам — в [**docs/USER_GUIDE.ru.md**](./docs/USER_GUIDE.ru.md).

## Скачать

Готовые инсталляторы под все платформы прикрепляются к каждому [релизу на GitHub](https://github.com/yavlenie-pro/prossh/releases):

| Платформа | Артефакты |
| --- | --- |
| Windows | `ProSSH_*_x64-setup.exe` (NSIS), `ProSSH_*_x64_en-US.msi` |
| macOS | `ProSSH_*_aarch64.dmg`, `ProSSH_*_x64.dmg` |
| Linux | `prossh_*_amd64.deb`, `prossh_*_amd64.AppImage` |

Стабильные релизы собираются автоматически из git-тегов `v*` [release-workflow'ом](./.github/workflows/release.yml).

## Быстрый старт

1. Поставьте пакет под свою ОС из последнего релиза.
2. Запустите **ProSSH**.
3. Нажмите **New session**, заполните host / user / auth, нажмите **Save**.
4. Нажмите **Connect** (или `Enter` на выделенной сессии) — ProSSH согласует host key, попросит подтвердить его при первом подключении, откроет вкладку терминала.
5. Переключите боковую панель на **Files**, чтобы получить SFTP-панель для того же соединения.

Горячие клавиши:

| Клавиши | Действие |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | Новая вкладка выбранной сессии |
| `Ctrl+W` | Закрыть активную вкладку |
| `Ctrl+Shift+D` | Split pane по горизонтали |
| `Ctrl+Shift+E` | Split pane по вертикали |
| `Ctrl+B` | Скрыть/показать sidebar |

## Сборка из исходников

```bash
# требования: Node.js 20+, Rust 1.80+, платформенные webview/build-зависимости (см. docs/DEVELOPMENT.md)
npm ci
npm run tauri dev      # dev-сборка с hot reload
npm run tauri build    # release-бандл в src-tauri/target/release/bundle/
```

Подробная матрица билдов (Windows MSVC, macOS Xcode, Linux `libwebkit2gtk-4.1`), код-стайл и архитектура описаны в [**docs/DEVELOPMENT.ru.md**](./docs/DEVELOPMENT.ru.md).

## Технологический стек

- **Backend** — Rust, [Tauri 2](https://tauri.app/), [Tokio](https://tokio.rs/), [russh](https://github.com/warp-tech/russh) (pure-Rust SSH), [russh-sftp](https://github.com/AspectUnk/russh-sftp), [rusqlite](https://github.com/rusqlite/rusqlite) (bundled SQLite), [keyring](https://github.com/hwchen/keyring-rs), [tracing](https://github.com/tokio-rs/tracing).
- **Frontend** — React 18, TypeScript, Tailwind CSS, [xterm.js](https://xtermjs.org/) (WebGL), [Radix UI](https://www.radix-ui.com/), [Zustand](https://github.com/pmndrs/zustand), [cmdk](https://cmdk.paco.me/), [i18next](https://www.i18next.com/).
- **Persistence** — SQLite (метаданные сессий, скрипты, port forwards, цветовые профили, KV-настройки) в `%APPDATA%/prossh/` (Windows) / `~/Library/Application Support/prossh/` (macOS) / `~/.local/share/prossh/` (Linux). Секреты в OS keychain, не в базе.

## Статус проекта

Версия 0.1.x — **MVP**. Терминал, SFTP, port forwarding, импорты, цветовые профили и скрипты работают. Виджеты мониторинга и plugin API запланированы на 0.2.

## Лицензия

ProSSH распространяется по лицензии [PolyForm Noncommercial 1.0.0](./LICENSE) — **бесплатно для персонального и некоммерческого использования**.

**Для коммерческого использования** (включая внутреннее использование в компании, консалтинг, хостинг-сервис или встраивание в продукт) требуется отдельная лицензия. Свяжитесь с [mail@yavlenie.pro](mailto:mail@yavlenie.pro) для получения условий.

## Участие в разработке

Issue и PR приветствуются. Перед тем как открывать PR, прочтите [гайд разработчика](./docs/DEVELOPMENT.ru.md) и прогоните локально `npm run lint` + `cargo clippy -- -D warnings`.
