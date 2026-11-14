# Switchboard

A personal macOS app that allows agents to build personalized UI, backed by custom data sources.

Everything it shows and does lives as files in `~/.switchboard`, written mostly by agents and reloaded by the app in real time.

## Install

Requirements: macOS, Rust, Node 24 and git. The template's `sessions` source and edit box use [Claude Code](https://claude.com/claude-code), but can be replaced by any agent harness.

```sh
make install    # BIN=~/.local/bin make install if /usr/local/bin isn't writable
open /Applications/Switchboard.app
```

On first start the app creates `~/.switchboard` from [`template/`](template), makes it a git repo with a pre-commit hook that runs `swb check`, and commits it. An existing folder is never overwritten.

### Optional: track all agent sessions

Agent sessions launched from the app already report to it. To track every Claude Code session (terminal, Zed and other SDK hosts) and answer their permission prompts from the board, merge the `hooks` from `~/.switchboard/sources/sessions/files/claude-hooks.json` into `~/.claude/settings.json` as they are (or adapt them to your agent).

## Develop

```sh
SWITCHBOARD_HOME=/tmp/switchboard-dev make dev   # window with hot reload, against a scratch folder
make test                                    # cargo test, vitest, front-end build
make check                                   # clippy (whole workspace) and TypeScript, including template cards
make bench                                   # loader and engine benchmark
```

`template/` is only copied when the folder doesn't exist: delete the scratch folder to pick up template changes. `cd app && npm run dev` serves the shell in a browser against a mock backend.

### More information

See [architecture.md](architecture.md).
