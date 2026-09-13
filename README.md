# usrr

USRR gives one Linux user a durable, addressable agent conversation. A Bun daemon exposes status, message, transcript history, live transcript follow, wait-until-idle, and interactive attach through HTTP over a user-scoped Unix socket. The `usrr` command is a thin client of that API.

## Requirements

- Bun 1.3.11 or newer
- Antigravity CLI (`agy`) installed and authenticated
- Codex and Claude CLIs installed and authenticated to use those destinations

## Install

```bash
bun install
./scripts/install.sh
systemctl --user start usrr.service
```

The agent works in the user's home directory by default. Set `USRR_AGENT_CWD` in the service environment to change it. The legacy `USRR_AGY_PERMISSION_MODE` setting is passed to Drovr for the selected provider, defaulting to `accept-edits`; `plan` and `yolo` remain supported. Drovr owns each provider's mapping, which does not imply identical permission policies across providers.

## Provider Order And Continuity

USRR's independent preference is Antigravity, OpenAI, then Claude, represented
by `agy,codex,claude`. Override it with `USRR_AGENT_PROVIDERS`, a comma-separated
list of distinct provider IDs. Selection and bounded attempts use
Drovr's shared in-process availability registry. Existing conversations remain pinned to
their provider even when the preference changes; legacy state without a provider
belongs to AGY. Preference changes alone never move a healthy conversation,
even if its provider is removed from the configured list.

Fallback happens only when Drovr has verified account-unavailability state.
USRR uses the `usrr-personal` account key for each provider; integrations must
record verified state on the same shared registry. There is no built-in quota
poller or quota inference from CLI errors, tool output, or JSON strings.
Automatic structured-run Claude quota fallback is not proven. No AGY or Codex
quota classifier is claimed. Unclassified failures propagate, preserve the
current native conversation, and do not try another provider. Known resets
expire through Drovr; unknown resets stay blocked until explicitly cleared.
Registry state is in-memory and does not survive daemon restarts.

A provider change starts a fresh native conversation in the same workspace.
The old native ID is never sent to the new provider. The new prompt explicitly
labels the handoff and includes up to 20 prior user/assistant events, capped at
12,000 history characters, followed by the current message. This is a partial
persisted-history handoff, not native conversation migration. Files remain in
place; provider-private state and direct interactive work are not transferred.
History/follow records a `handoff` attempt with the old provider/ID and the
excerpt sent. The old conversation remains current if the attempt fails. On
success, state records the new provider and ID, and attach uses that provider.

## Rollout

Message/resume and interactive attach delegate to Drovr's
`ManagedConversationRunner({ provider, cwd, permissionMode })`; USRR has no local
provider argv builder or response parser. The source integration needs the new
structured-runner release and parent-managed dependency install (0.3.2 lacks
this export). Updated CLI invocations also require that dependency. Do not
restart until published-package integration checks pass. No live service or
user settings are changed by source edits/tests.
No Butchr bridge, factory MCP isolation, or automatic trust settings are used;
providers retain their personal configuration. AGY's exact-path trust helper
rejects USRR's default home cwd and is deliberately not applied here.

Restart only when idle and after direct interactive sessions finish: the service
kills child processes on restart, and an in-flight first response may not yet
have persisted its conversation ID. Preserve state and transcript before
rollout. Older USRR versions cannot parse `handoff` transcript events or attach
non-AGY conversations correctly; rollback after a switch requires retaining the
new logs and explicitly restoring an appropriate native conversation/state.

## Commands

```bash
usrr status
usrr message "Think through the next factory project with me"
usrr message --no-wait "Keep this idea in mind"
usrr wait 300
usrr history
usrr history 50
usrr history 50 --json
usrr follow
usrr follow --json
usrr attach
```

Running `usrr` with no arguments attaches to the resident conversation. State lives at `$XDG_STATE_HOME/usrr/state.json` (normally `~/.local/state/usrr/state.json`). The API socket lives at `$XDG_RUNTIME_DIR/usrr/api.sock`.

The first `message` creates a durable conversation in the selected provider. `attach` resumes the native conversation with inherited terminal input and output; legacy attach responses default to AGY.

Every message submitted through the daemon and its eventual response are appended to `$XDG_STATE_HOME/usrr/transcript.jsonl` with private permissions. `history` shows the 20 most recent events by default and accepts a limit from 1 to 1000. Its `--json` form emits one JSON array. `follow` waits for new events until interrupted; its `--json` form emits newline-delimited JSON, one event per line. Direct interactive work inside a provider CLI is outside the daemon boundary and is not added to this transcript.
