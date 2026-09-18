# gsd-slash-sync

Sync **GSD Core's slash commands and subagents** into **pi (pi.dev)** — as native prompt templates and as
**pi-subagents** agent definitions — and re-sync them with one command whenever GSD Core updates.

```
/gsd-plan-phase  /gsd-execute-phase  /gsd-verify-work  /gsd-ship  …   72 commands
gsd-planner · gsd-executor · gsd-verifier · gsd-code-reviewer · …     35 agents
```

## Why it exists

GSD's runtime descriptor for pi sets `pluginOnlyInstall: true` and an **empty** `artifactLayout`
(`bin/lib/capability-registry.cjs` → `runtimes.pi`). A pi install therefore ships one extension
(`~/.pi/agent/extensions/gsd.js`, the `/gsd` hub) and **never** installs `commands/gsd/` or `agents/` —
while Claude Code gets both. That is why pi has only `/gsd`, no `gsd-*` subagents, and why
`resolve-dispatch-type gsd-planner` answers `coder` (kimi-code's built-in) on a pi host.

This plugin closes both gaps **without forking GSD**: it converts the definitions GSD already installed
for another runtime, registers the commands through pi's `resources_discover` event, and writes the agents
where pi-subagents discovers them. **No GSD file is ever modified.**

```
already on disk (canonical source)          generated for pi
~/.claude/gsd-core/commands/gsd/*.md   →    ~/.pi/agent/gsd-commands/gsd-*.md   (prompt templates)
~/.claude/gsd-core/agents/*.md         →    ~/.pi/agent/agents/gsd-*.md        (pi-subagents)
                                       →    ~/.pi/agent/AGENTS.md              (shared tool guidance)
```

## Install

```bash
node gsd-slash-sync.js install     # copies this file into ~/.pi/agent/extensions/
node gsd-slash-sync.js sync        # first sync (or run /gsd-sync inside pi)
```

pi auto-discovers `*.js` / `*.ts` in `extensions/`, so **no `settings.json` change is needed**. Run
`/reload` (or restart pi) afterwards.

| Piece | Needed for | How to get it |
|---|---|---|
| **pi** | everything | https://pi.dev |
| A **GSD Core install for another runtime** | the source definitions — commands *and* agents | `npx -y @opengsd/gsd-core@latest --claude` |
| **pi-subagents** | the 35 agents; without it the generated files are inert | `pi install npm:pi-subagents` |
| **pi-web-access** | the web tools the research/audit agents use | `pi install npm:pi-web-access` |
| **pi-mcp-adapter** (optional) | MCP servers you configure yourself | `pi install npm:pi-mcp-adapter`, then `/mcp setup` |

## Where the source comes from

The plugin never ships GSD's definitions — it converts a GSD Core copy already on disk. **Claude Code itself
is not required**: GSD's installer is a file-layout installer, it never probes for a `claude` binary.

| Source | Cmds | Agents | `thinking:` / `excludeTools:` |
|---|---|---|---|
| **`~/.claude/gsd-core/commands/gsd` + `~/.claude/agents`** ← recommended | 72 | 35 | **yes** |
| The npm package itself (`<npx cache>/node_modules/@opengsd/gsd-core/`) | 72 | 35 | no |
| Any other runtime install (qwen, copilot, opencode, kilo, codebuddy, …) | yes | yes | no |
| cursor, windsurf, codex, kimi | yes | **no** | — |
| `--pi` only | **no** | **no** | — |

Only the Claude Code layout carries a per-agent `effort:` (35/35) and `disallowedTools:` (7) — exactly what
become pi's `thinking:` and `excludeTools:`. The other trees carry pristine frontmatter, so those two fields
are absent and pi's default reasoning level applies.

`--source <dir>` (or `GSD_SLASH_SYNC_SOURCE`) points at a specific `commands/gsd`; agents are then taken from
the `agents/` directory **beside that same tree**, never mixed across GSD versions. Zero-install path:

```bash
PKG=$(find ~/.npm/_npx -maxdepth 4 -type d -path '*node_modules/@opengsd/gsd-core' | head -1)
node gsd-slash-sync.js sync --source "$PKG/commands/gsd"
```

## Usage

```bash
node gsd-slash-sync.js sync [--mode …|--naming …|--no-agents|--dry-run|--force|--json]
node gsd-slash-sync.js status [--json]      node gsd-slash-sync.js install
node gsd-slash-sync.js help
```

Inside pi: `/gsd-sync` and the same flags (`--status`, `--dry-run`, `--mode inline`, `--naming colon`,
`--agents-out <dir>`, `--no-agents`, `--no-global-context`, `--force`, `--no-persist`). The agent can also
call the `gsd_slash_sync` tool directly.

**Automatic sync.** Every pi start runs a cheap fingerprint comparison: unchanged → silent no-op; GSD Core
changed, or the plugin/mode/naming changed → regenerate and report
`GSD synced for pi (72 commands, 35 subagents, GSD Core x.y.z)`. So **after a GSD upgrade your next pi
session already has the new commands and agents.** Disable with `"autoSync": false` or
`GSD_SLASH_SYNC_AUTO=off`.

**Spawning agents.** Every generated command carries a `<gsd_subagent_dispatch>` block that turns GSD's
`Agent(subagent_type="gsd-planner", …)` into `subagent({ agent: "gsd-planner", task: "…" })` —
`run_in_background: false` → `async: false`, `subagent_type="general-purpose"` → `agent: "delegate"`,
`TaskOutput` → `subagent({action:"status", id})`, parallel spawns collapsing into one `workflowScript` call
with `runs.all([...])`.

## Modes (default: `reference`)

Claude Code expands the `@file` references in GSD's `<execution_context>` section; pi templates cannot, so
either list those files (`reference`) or inline them (`inline`).

| | `reference` (default) | `inline` |
|---|---|---|
| Templates | 72 files / 512 KB | 72 files / ~2.5 MB |
| Agents | 35 files / 757 KB (≈22 KB each) | up to ~190 KB for `gsd-planner` |
| Behaviour | Reads the listed paths first, then follows the workflow | Whole procedure up front |
| Good for | Everyday use: fewer tokens, no compaction risk | Byte-for-byte Claude Code parity |

The same setting governs agents: 27 of 35 contain 120 `@file.md` references, and a child re-sends its system
prompt every turn — so `reference` is the better default there too. `/gsd-sync --mode inline
--max-inline-kb 40` caps per-file size, falling back to reference above it.

## Configuration

`~/.pi/agent/gsd-slash-sync.json` (optional — defaults apply when absent):

```jsonc
{
  "mode": "reference",        // reference | inline
  "naming": "hyphen",         // hyphen | colon  (/gsd-plan-phase vs /gsd:plan-phase)
  "outDir": null,             // default <agentDir>/gsd-commands
  "agentsOut": null,          // default <agentDir>/agents
  "syncAgents": true,         // convert GSD's subagents for pi-subagents
  "syncGlobalContext": true,  // generate <agentDir>/AGENTS.md
  "source": null,             // explicit commands/gsd directory
  "maxInlineKb": 0,           // inline mode: fall back above this size (0 = no limit)
  "autoSync": true,           // re-sync on session_start when the source changed
  "notify": true              // notify when an automatic sync changed something
}
```

Env vars (config file < env < CLI flags): `GSD_SLASH_SYNC_MODE`, `_NAMING`, `_OUT`, `_AGENTS_OUT`,
`_SOURCE`, `_MAX_INLINE_KB`, `_NO_AGENTS=1`, `_NO_GLOBAL_CONTEXT=1`, `_AUTO=off`, `_NOTIFY=off`.

CLI values are **written back to the config file** (otherwise the next automatic sync would revert them);
`--out` / `--agents-out` stay per-run. Use `--no-persist` to keep a run strictly one-off.

## Generated artifacts

```
~/.pi/agent/gsd-commands/gsd-*.md           file name == command name  (+ .gsd-slash-sync-state.json)
~/.pi/agent/agents/gsd-*.md                 frontmatter name == agent name (+ .gsd-slash-sync-agents-state.json)
~/.pi/agent/AGENTS.md                       shared tool guidance
~/.pi/agent/extensions/gsd-slash-sync.js    the plugin
```

`~/.pi/agent/agents/` is pi-subagents' documented *user* directory and the same path GSD's
`getAgentsDir('pi')` resolves to; a project's `.pi/agents/*.md` still wins over it.

- **Deterministic** — bytes depend only on source + mode + naming, no timestamps, so re-syncing is a true
  no-op. `--naming colon` affects command names only; agent bytes are identical either way.
- **Pruning** — files for removed commands/agents are deleted, but only files this plugin created (state file
  or generator marker). A colliding file it does not own is reported (`agent keep …`), never overwritten
  unless `--force`.
- **Safety valves** — fewer than 5 commands (or agents) in the source refuses the run, so a broken source
  cannot wipe a 72/35 install; `--out` and `--agents-out` pointing at the same directory is refused.

## What the conversion does

**Commands.** Frontmatter → `description` / `argument-hint`; `<execution_context>` → a MUST-READ path list
(reference) or inlined content (inline), with `~/.claude/…` paths mapped onto pi's tree. Every command gets a
runtime contract stating: read the context first; `/gsd:<name>` means `/gsd-<name>`; **`AskUserQuestion` does
not exist in pi** → ask in chat and wait; if a step names an agent, dispatch it, never run it inline.
`<runtime_note>` blocks (10 commands) are rewritten to the pi equivalent, shell positionals `"$@"` / `$1` are
protected from pi's template substitution, and Claude-shaped paths (152 occurrences) are rewritten — GSD's
`gsd_run` shim uses them to locate `gsd-tools.cjs`.

**Agents.**

| GSD (Claude dialect) | pi-subagents | Notes |
|---|---|---|
| `Read` `Write` `Edit` `Bash` `Grep` `Glob` | `read` `write` `edit` `bash` `grep` `find` | |
| `Agent` | `subagent` + `allowNestedSubagents` | only `gsd-debug-session-manager` |
| `AskUserQuestion` | `contact_supervisor` | a child cannot prompt the user directly |
| `Skill` | `inheritSkills: true` | skills are prompt-time, not a tool |
| `WebSearch`, `WebFetch`, `mcp__*` | — dropped | an unresolvable `mcp:` selector **aborts the spawn** |
| `effort:` | `thinking:` | derived from GSD's routing tables |
| `disallowedTools:` | `excludeTools:` | e.g. `gsd-verifier` loses `edit` |
| — | `inheritProjectContext` `inheritGlobalContext` | without these pi strips repo instructions and `AGENTS.md` |

`thinking:` and `excludeTools:` are **read from the installed GSD Core, not hardcoded** —
`bin/shared/model-catalog.json` (`routingTier`), `bin/shared/config-defaults.manifest.json`
(`effort.routing_tier_defaults`: light→low, standard→high, heavy→xhigh) and
`READONLY_AGENT_DISALLOWED_TOOLS` in `bin/lib/runtime-artifact-conversion.cjs` — so they follow a GSD update
instead of drifting from it.

`.compact.md` siblings are deliberately not installed: they share their canonical agent's `name:` and would
register as separate `gsd-<role>.compact` agents.

## Global context (`AGENTS.md`)

pi-subagents **strips** the global context file from children unless the agent declares
`inheritGlobalContext`. Every generated agent emits the flag, which makes `~/.pi/agent/AGENTS.md` the single
channel reaching **both** the top-level session and every spawned child — the same tool guidance for the
operator and the children. (Duplicating it into 35 agent bodies would say the same thing 35 times and could
not reach the top-level session at all.)

The file is generated from the tools the host **actually** has, so it can never name an uninstalled tool:

| Section | Emitted when |
|---|---|
| `## Searching` — prefer `ffgrep` / `fffind` over recursive walks | `@ff-labs/pi-fff` |
| `## Structural questions` — use `codegraph_explore` | `@izhimu/pi-codegraph` |
| `## Editing` — use `anchor_grep` / `replace` / `insert`, not `sed -i` | `pi-hashline-edit-pro` |
| `## Web lookups` — `web_search` / `fetch_content` | `pi-web-access` |

A file without the generator marker is the user's and is **never overwritten** (reported as `kept`); with no
packages detected the file is `skipped` rather than written empty. It is a *context file*, so an open session
needs **`/reload`** before it sees new guidance.

## Tool surface

A generated `tools:` line is a **strict allowlist**: pi-subagents filters the child's registry down to the
names listed, and extension tools are filtered exactly like builtins — so an unnamed extension tool never
reaches the child even though the child loaded the extension.

Every generated agent therefore gets the **same** surface. GSD's own agent text already says which lookups
each role needs, so the allowlist decides only whether a tool *exists* — never who "deserves" it. Merged when
the package resolves under `<agentDir>/npm/node_modules`:

| package | tools |
|---|---|
| `@izhimu/pi-codegraph` | `codegraph_explore` |
| `@ff-labs/pi-fff` | `ffgrep`, `fffind`, `fff-multi-grep` |
| `pi-hashline-edit-pro` | `anchor_grep`, `replace`, `insert`, `undo_last_change` |
| `pi-web-access` | `web_search`, `source_check`, `fetch_content`, `get_search_content` |

Deliberately **not** merged, because they change what a child can *do* to the machine or session rather than
what it can read: `bg_*` / `fusion_*`, `subagent` / `contact_supervisor` (except agents GSD marks
nested-capable), and `init_experiment` / `run_experiment` / `log_experiment`.

Skills need no equivalent change — they are not registry entries; pi formats them into the prompt
(`noSkills = !inheritSkills`).

## Verification

```bash
node test/verify.mjs         # 146 checks: drives pi's real template engine and pi-subagents' real discovery
node test/verify-pi-e2e.mjs  # spawns a real `pi --mode rpc` and asks pi what commands it has
```

`verify.mjs` is hermetic (it cannot mutate a real install) and covers templates, idempotency, `$ARGUMENTS`
substitution through pi's own engine, shell-token protection, path rewriting, inlining, pruning and
foreign-file protection, both safety valves, the global-context gating, and — through `jiti`, the loader pi
uses — that all 35 agents load in **pi-subagents' own discovery** with the expected tools, thinking level and
`excludeTools`, zero diagnostics. `verify-pi-e2e.mjs` covers what cannot be tested in-process: pi
auto-discovering the extension and `resources_discover → promptPaths` really registering native commands.
Measured on a real install: `148 commands · 78 prompt templates · 72 gsd templates · 35 generated agents`.

## Known limitations

- **GSD's skills are not synced.** `ns-*` style commands are skill routers; the contract points at
  `/skill:<name>` and falls back to the matching `/gsd-<command>`.
- **MCP and browser tools are not wired.** Generated agents declare **no** `mcp:` selectors — an unresolvable
  one aborts the whole spawn. The prompts point at GSD's CLI fallback (`ctx7 …`) instead.
- **Extension tools need a background child.** Foreground children (`async: false`) do not load ambient pi
  packages, so `pi-web-access` tools are only present in the default background runs.
- **`AGENTS.md` needs `/reload`** in an already-open session.
- **`reference` mode relies on the model following the read-first instruction** (the first item in the
  prompt). For absolute fidelity use `inline`; note that `inline` downgrades `${1:-default}` to
  `${1-default}` (2 occurrences in the tree). Agent bodies are not shell-token protected at all — a child's
  system prompt never goes through `substituteArgs`.
- **`advertise` is not set** on any agent (pi-subagents' catalogue is capped at 16 entries / 12 KB, and the
  commands already name the role to spawn).

## Repository layout

```
gsd-slash-sync.js        the plugin (pi extension + CLI, single file, zero npm dependencies)
test/verify.mjs          hermetic suite driving pi and pi-subagents
test/verify-pi-e2e.mjs   end-to-end through a real pi process
```

## License

MIT — see `LICENSE`.
