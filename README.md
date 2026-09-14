# usrr

This version uses Drovr 0.6's shared managed-conversation lifecycle. Existing Slop
Lord tenants have private USRR copies and require `sloplord upgrade USER` while
their USRR service is stopped before using the updated implementation.

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
record verified state on the same shared registry. Drovr also recognizes the
measured Claude structured API 429 quota refusal and automatically performs
handoff before trying the next provider. Arbitrary CLI errors or tool output do
not qualify. No AGY or Codex quota classifier is claimed. Unclassified failures propagate, preserve the
current native conversation, and do not try another provider. Known resets
expire through Drovr; unknown resets stay blocked until explicitly cleared.
Registry state is in-memory and does not survive daemon restarts.

A provider change starts a fresh native conversation in the same workspace.
The old native ID is never sent to the new provider. Drovr's
`ManagedConversationLifecycle` owns selection, native identity, pinning, the
fallback loop, and serialization of messages and explicit switches. Every
provider transition automatically imports native disk history for AGY, Codex,
or Claude in acknowledged compaction chunks, including direct interactive work.
Only missing native history permits fallback to the saved user/assistant journal;
malformed, unsafe, incomplete, or oversized native history fails the operation.
It refuses oversized history instead of
silently truncating it. The pending task is excluded from this history and sent
separately on the acknowledged native ID after USRR persists it. Files remain
in place; provider-private state outside the native transcript is not transferred.
Before committing, history/follow records the previous and target identities
and switch reason, without embedding recursive handoff prompts. A handoff failure
retains the previous identity; a later task failure retains the committed target.

## Rollout

Messages and switches delegate to Drovr's `ManagedConversationLifecycle`;
USRR adapts persistence, transcript logging, and the API. Native execution and
interactive attach use `ManagedConversationRunner({ provider, cwd, permissionMode })`; USRR has no local
provider argv builder or response parser. Run `bun install` and `bun run check`
before restarting an installation with this dependency. No live service or
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
usrr switch codex
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

`usrr switch <agy|codex|claude>` explicitly imports context into the selected
provider without executing a task. Switching to the current provider is a no-op.
The API equivalent is `POST /v1/switch` with `{"provider":"codex"}`; success
returns `{"ok":true,"result":{"provider":"codex","conversationId":"..."}}`.
Switches and messages share the busy guard; conflicting requests return HTTP 409.

Every message submitted through the daemon and its eventual response are appended to `$XDG_STATE_HOME/usrr/transcript.jsonl` with private permissions. `history` prefers the complete native disk transcript, including interactive work, without truncation. Its `--json` form emits `{ "nativeTranscript": "..." }` when native history exists. Only when native history is missing does it show journal events: the 20 most recent by default, with a limit from 1 to 1000, and a JSON array for `--json`. Invalid or unreadable native history is reported as an error. `follow` streams new daemon journal events until interrupted; its `--json` form emits newline-delimited JSON, one event per line. Direct interactive work is available in native history but is not added to the daemon journal or live follow stream.
