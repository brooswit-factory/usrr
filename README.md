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

## agy MCP Provisioning And The Rocketr Relay

At startup, after the API server is listening, the daemon reads `.mcp.json`
(path configurable with `USRR_MCP_CONFIG`; defaults to `.mcp.json` at the repo
root, resolved from the daemon's own source location rather than its working
directory). Every server it names is written into agy's own MCP
configuration with `applyMcpAccess("agy", …)` — servers not named, and
servers for other providers, are left untouched. A running agy session picks
this up only on its next turn; nothing is restarted. Only a server named
`rocketr` also gets a live relay: `keepChannelSource` holds a reconnecting
MCP connection to it, and `InboxRelay` delivers each message as a turn
through this daemon's own `/v1/message` socket API, in order, retrying a busy
answer and dropping (and logging) a rejected or repeatedly-failing one.

**The relay holds a single long-lived channel source for the daemon's entire
lifetime**, created once at start and never torn down or re-created per turn,
per message, or on a provider switch — that stream must stay open, because
rocketr (thatch 0.7.0+) reaps a connection that never opens or holds its
notification stream as `stale`, and a reaped relay goes silent with no error
at all. On `SIGTERM`/`SIGINT` that same source and the relay are stopped
before the API server, so nothing is left delivering into a socket that is
going away, and no connection is leaked on an account that must end up
holding exactly one live connection.

**No host anyone has been able to check runs with `.mcp.json` present today**,
so the missing-file path below is not an edge case here — it is the only path
any current deployment actually exercises, and is treated as such in the
tests. A missing `.mcp.json` logs at info and the daemon starts normally, with
no agy provisioning and no relay. An unparseable file, or a server definition
Drovr refuses (e.g. `"type": "sse"`), does the same, logged as an error.
`.mcp.json` is deployment-local, is not checked into this repo, and is
intentionally not gitignored either (nothing here names a path that doesn't
exist to ignore); this is a call the PR makes rather than decides silently —
say if you'd rather usrr ship an `.mcp.json.example`.

**To activate this feature on a deployment**, three things must all be true,
and none of them exist anywhere in this repo or on any host checked so far:

1. `USRR_AGENT_PROVIDERS` includes `agy` (agy is the only provider this
   provisions; a Claude- or Codex-only deployment gets nothing from it).
2. A `.mcp.json` exists at the repo root (or at `USRR_MCP_CONFIG`), naming a
   `rocketr` server, e.g.:
   ```json
   {
     "mcpServers": {
       "rocketr": {
         "type": "http",
         "url": "http://127.0.0.1:8790/mcp",
         "headers": { "x-rocketr-account": "<this resident's account>" }
       }
     }
   }
   ```
   The account and its headers are always read from this file, never
   hard-coded.
3. Because every opted-in connection for a rocketr account receives every
   frame, that file's rocketr entry should be tools-only for agy's own
   session (no `x-rocketr-channel: on`) once DROVR-20 lands — this daemon
   forwards whatever headers the file names verbatim and does not filter
   them itself, so a file written with the channel header on before then
   risks agy's own connection double-receiving messages already relayed as
   turns. No deployment checked so far has this header at all.

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
