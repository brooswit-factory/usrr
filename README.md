# usrr

USRR gives one Linux user a durable, addressable Gemini agent. A Bun daemon owns one Antigravity conversation and exposes status, message, wait-until-idle, and interactive attach through HTTP over a user-scoped Unix socket. The `usrr` command is a thin client of that API.

## Requirements

- Bun 1.3.11 or newer
- Antigravity CLI (`agy`) installed and authenticated

## Install

```bash
bun install
./scripts/install.sh
systemctl --user start usrr.service
```

The agent works in the user's home directory by default. Set `USRR_AGENT_CWD` in the service environment to change it. Antigravity runs in `accept-edits` mode by default; set `USRR_AGY_PERMISSION_MODE` to `plan` or `yolo` when that better matches the user environment.

## Use

```bash
usrr status
usrr message "Think through the next factory project with me"
usrr message --no-wait "Keep this idea in mind"
usrr wait 300
usrr attach
```

Running `usrr` with no arguments attaches to the resident conversation. State lives at `$XDG_STATE_HOME/usrr/state.json` (normally `~/.local/state/usrr/state.json`). The API socket lives at `$XDG_RUNTIME_DIR/usrr/api.sock`.

The first `message` creates the durable Antigravity conversation. `attach` resumes that conversation through the public `agy` CLI with inherited terminal input and output.
