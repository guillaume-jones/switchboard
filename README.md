# Switchboard

An app to ingest any local data, serve personalized UI, and trigger any shell command.

Everything it shows and does lives in `~/.switchboard`, which can be re-written by agents at any time and hot reloads.

## Install

### Download

Requires git.

- **MacOS**: [Switchboard.dmg](https://github.com/guillaume-jones/switchboard/releases/latest/download/Switchboard.dmg)
  - macOS will refuse to open the app at first. Go to System Settings → Privacy & Security and click Open Anyway.
- **Linux**: [Switchboard.deb](https://github.com/guillaume-jones/switchboard/releases/latest/download/Switchboard.deb) or [Switchboard.rpm](https://github.com/guillaume-jones/switchboard/releases/latest/download/Switchboard.rpm)
  - `sudo apt install ./Switchboard.deb`  or  `sudo dnf install ./Switchboard.rpm`

Other notes:
- On first start the app creates `~/.switchboard` from [`template/`](template) as a git repo. This is the repo your agents can freely edit to add data or UI. To start from another template instead, quit the app and run `swb init <git url>` to keep pulling its updates, or `swb init <git url> --copy` for a repo of your own; `swb init` alone restores the built-in one.
- The default template assumes Claude Code, but can be replaced by any agent harness. Its terminals need `tmux` and `ttyd`.
- To track every agent session, not just those launched from Switchboard, merge the `hooks` from `~/.switchboard/sources/sessions/files/claude-hooks.json` into your agent config.


### Use from your phone

The app can serve a mobile web app over Tailscale, with notifications & offline caching when the desktop disconnects.

1. Install Tailscale on your desktop and phone, logged into the same account. In the admin console, enable MagicDNS and HTTPS certificates. 
2. (Linux only) Let the app run `tailscale serve` without root: `sudo tailscale set --operator=$USER`.
3. Add `"remote": 8443` to `~/.switchboard/settings.json`, then restart the app. 
4. On the phone, open `https://<desktop>.<tailnet>.ts.net:8443` and add it to the home screen. 
5. (Mac only) To keep the app online, enable "Prevent automatic sleeping on power adapter when the display is off" in Battery settings.


### Build from source

Requires Rust & Node 24.

Linux also requires [Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/#linux), plus `zsh`, `dash` and `jq` for the template.

```sh
make install
open /Applications/Switchboard.app # MacOS
switchboard & # Linux
```

## Develop

```sh
SWITCHBOARD_HOME=/tmp/switchboard-dev make dev   # window with hot reload, against a temp folder
```

Note that `template/` is only copied when the folder doesn't exist. Delete the scratch folder to pick up template changes. 


See [Makefile](Makefile) for other commands, including `check` and `test`.

See [architecture.md](architecture.md) for a full architecture breakdown.

