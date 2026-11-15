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

### Optional: use it from your phone

The template's `settings.json` sets `"remote": 8443`, which serves the board to your other devices over [Tailscale](https://tailscale.com) while everything keeps running on the desktop.

1. Install Tailscale on the desktop and the phone, logged into the same account. In the admin console, enable MagicDNS and HTTPS certificates.
2. Start the app: it runs `tailscale serve --bg --https=8443` itself. Problems show on the Health card as `remote` errors.
3. On the phone, open `https://<desktop>.<tailnet>.ts.net:8443` in Safari and add it to the home screen. In iOS Settings → VPN → Tailscale, turn on Connect On Demand.
4. Open the installed app and tap Enable when it offers notifications. Desktop notifications are then also sent to the phone while the desktop is locked or idle (see `push` in `settings.json`).

Offline, the phone shows the board as of its last contact and queues writes and runs until the desktop is back. A desktop that sleeps stops serving: on a MacBook, enable "Prevent automatic sleeping on power adapter when the display is off".

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
