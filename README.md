# gsd-slash-sync

Sync **GSD Core's slash commands and subagents** into **pi (pi.dev)** — as native prompt templates and as
**pi-subagents** agent definitions — and re-sync them with one command whenever GSD Core updates.

After installing you get:

- **72 pi slash commands** `/gsd-<command>` (plus the `/gsd-sync` command and the `gsd_slash_sync` tool),
- **35 pi-subagents agents** `gsd-<role>` (`gsd-planner`, `gsd-executor`, `gsd-verifier`, …) so the
  `spawn agent` steps inside GSD's workflows actually dispatch a child session on pi.

```
/gsd-plan-phase     /gsd-execute-phase   /gsd-new-project    /gsd-quick
/gsd-progress       /gsd-verify-work     /gsd-code-review    /gsd-ship
… 72 commands, see /gsd-sync --status
gsd-planner · gsd-executor · gsd-verifier · gsd-code-reviewer · … 35 agents
```

---

## 1. Why pi has no GSD slash commands (and no GSD subagents) out of the box

This is a deliberate choice by GSD, not a broken install. GSD's own runtime descriptor
(`gsd-core/bin/lib/capability-registry.cjs`, entry `runtimes.pi`) says:

```jsonc
"pi": {
  "runtime": {
    "commandStyle": "slash-hyphen",          // commands are /gsd-<cmd>
    "installSurface": "profile-marker-only",
    "artifactLayout": { "global": [], "local": [] },   // ← nothing else is installed
    "hostBehaviors": {
      "nativePlugin": { "dir": "extensions", "file": "gsd.js" },
      "pluginOnlyInstall": true,             // ← the important one
      "sharedHooksDirName": "gsd-hooks"
    }
  }
}
```

`pluginOnlyInstall: true` plus an empty `artifactLayout` means a pi install ships **one native extension
file** (`~/.pi/agent/extensions/gsd.js`, which registers the single `/gsd` hub command and the `gsd_invoke`
tool) and **never installs** a `commands/gsd/` directory or an `agents/` directory. Claude Code installs get
both (`~/.claude/gsd-core/commands/gsd/*.md`, 72 files, and `~/.claude/agents/gsd-*.md`, 64 files), which is
why `/gsd-…` and named `gsd-*` subagents all exist there while pi only has `/gsd`.

Every *other* runtime's descriptor carries an `agents` artifact with a converter
(`{"kind":"agents","destSubpath":"agents","prefix":"gsd-","converter":"convertClaudeAgentTo<Runtime>Agent"}`);
pi is the only one with an empty layout. The same descriptor also drives GSD's dispatch resolver, and that
has a visible consequence on pi:

```console
$ node ~/.pi/agent/gsd-core/bin/gsd-tools.cjs query resolve-dispatch-type gsd-planner
coder          # ← kimi-code's built-in, which does not exist in pi
```

Because pi's descriptor says `namedDispatch: false`, GSD maps every role to `coder`/`explore`/`plan`. A pi
session that follows that instruction either fails the spawn or quietly skips the delegation — which is what
this plugin removes.

This plugin closes both gaps without forking GSD: it reads the canonical command and agent definitions GSD
already installed for another runtime, converts them into pi's native formats, registers the commands with pi
through the documented `resources_discover` event, and writes the agents where pi-subagents discovers them.
**No GSD file is ever modified**; a GSD update is picked up by re-syncing.

```
already on disk (canonical source)          generated for pi
~/.claude/gsd-core/commands/gsd/*.md   →    ~/.pi/agent/gsd-commands/gsd-*.md     (pi prompt templates)
~/.claude/gsd-core/agents/*.md         →    ~/.pi/agent/agents/gsd-*.md          (pi-subagents agents)
```

---

## 2. Install

```bash
# 1) install the extension (copies itself into pi's extension directory)
node gsd-slash-sync.js install

# 2) first sync (or run /gsd-sync inside pi)
node gsd-slash-sync.js sync
```

`install` only copies `gsd-slash-sync.js` into `~/.pi/agent/extensions/`. pi auto-discovers
`*.js` / `*.ts` there, so **no `settings.json` change is needed**. Restart pi afterwards,
or run `/reload` inside pi.

### 2.1 What each half needs

| Piece | Needed for | How to get it |
|---|---|---|
| **pi** (`@earendil-works/pi-coding-agent`) | everything | https://pi.dev |
| A **GSD Core install for another runtime** | the source definitions — commands *and* agents | `npx -y @opengsd/gsd-core@latest --claude` (the richest tree — see §2.3 for the alternatives, including a zero-install path via the npm package) |
| **pi-subagents** | the 35 `gsd-*` agents; without it the generated files are inert | `pi install npm:pi-subagents` |
| **pi-web-access** | the web tools the research/audit agents use | `pi install npm:pi-web-access` |
| **pi-mcp-adapter** (optional) | MCP servers you configure yourself | `pi install npm:pi-mcp-adapter`, then `/mcp setup` |

`--source <dir>` (or `GSD_SLASH_SYNC_SOURCE`) points the plugin at a specific
`commands/gsd` directory; the agent definitions are then taken from the `agents/` directory **beside that
same tree**, never mixed in from a different GSD version.

### 2.2 The search / web tools the subagents need

GSD's research and audit agents (`gsd-phase-researcher`, `gsd-project-researcher`, `gsd-ui-researcher`,
`gsd-domain-researcher`, `gsd-ai-researcher`, `gsd-advisor-researcher`, `gsd-planner`, `gsd-executor`,
`gsd-code-reviewer` and friends) ask for `WebSearch`, `WebFetch` and Context7-style MCP lookups. pi has no
such built-ins, so those agent definitions declare **only pi builtin tools** and the child is told in its
prompt what to use instead:

- **pi-web-access** supplies `web_search`, `fetch_content`, `get_search_content` and `source_check`. It is a
  pi *package* (`~/.pi/agent/settings.json` → `packages`), and pi loads package extensions into **background**
  child sessions. pi-subagents runs single-agent calls in the background by default, so nothing extra is
  needed for the normal case — **but a foreground child (`async: false`, or a config with
  `asyncByDefault: false`) does not load ambient extensions and will not see those tools.** GSD's own spawn
  steps are followed literally, so spawn a research agent as a background child unless GSD explicitly demands
  a blocking wait.
- **Context7** (and the other doc-lookup MCP servers GSD names) have no MCP wiring out of the box. The
  generated agent prompts tell the child to use GSD's own documented CLI fallback instead
  (`ctx7 library <name> "<query>"` / `ctx7 docs <libraryId> "<query>"`), or to continue without that lookup
  and say so in its report. If you want real MCP, install **pi-mcp-adapter** and configure servers in
  `~/.pi/agent/mcp.json` — but note that the generated agents deliberately declare **no** `mcp:` selectors:
  pi-subagents aborts a whole spawn when an `mcp:` selector cannot be resolved, so adding one is a
  per-machine decision rather than a safe default.
- **`gsd-dom-verifier`** asks for browser automation (`chrome-devtools` / `claude-in-chrome`). Nothing
  provides that by default; the agent degrades to non-browser evidence unless you wire a browser MCP server.

Nothing above is required to *use* the agents: an agent with no web access still runs, it just reports that a
lookup was unavailable. Only **pi-subagents** is a hard prerequisite for the agent half.

### 2.2.1 Extension tools are merged into every generated allowlist
A generated `tools:` line is a **strict allowlist**, not a hint. pi-subagents filters the child's tool
registry down to the names it lists, and extension tools are filtered exactly like builtins — so an extension
tool that is not named never reaches the child *even though the child did load the extension*. Background
(`async`) children are the common case: they load ambient extensions, yet every extension tool stayed
invisible because the generated allowlist only named pi builtins. Measured before the fix: across 19 GSD
subagent runs (845 `bash` calls) not one extension tool was ever invoked.

**Division of labor: the allowlist grants existence, the prompt selects use.** Every generated agent gets the
same tool surface — GSD's own agent text already tells each child which lookups its job needs (researchers
are told to search the web, the executor is told to use web tools only for Context7-style doc lookups), and
that guidance was unusable while the names were filtered out. Role restrictions that matter for integrity are
kept where GSD put them: checker/auditor agents still receive no `write`/`edit` because GSD's own
`tools:` lines never granted those, and that read-only discipline is what makes their verdicts trustworthy.

The generator checks pi's `settings.json` (`packages`) and confirms each package resolves under
`<agentDir>/npm/node_modules` before naming its tools:

| package | tools merged into every allowlist |
| --- | --- |
| `@izhimu/pi-codegraph` | `codegraph_explore` |
| `@ff-labs/pi-fff` | `ffgrep`, `fffind`, `fff-multi-grep` |
| `pi-hashline-edit-pro` | `anchor_grep`, `replace`, `insert`, `undo_last_change` |
| `pi-web-access` | `web_search`, `source_check`, `fetch_content`, `get_search_content` |

An install without a package contributes nothing, so the allowlists are byte-identical to the pre-2.2.1
behavior there. Deliberately **not** merged, because they change what a child can *do* to the machine or the
session rather than what it can read: `bg_*` / `fusion_*` (`pi-background-tasks`), `subagent` /
`contact_supervisor` (except agents GSD marks as nested-capable), and `pi-autoresearch`'s
`init_experiment` / `run_experiment` / `log_experiment`.

**Skills need no equivalent change.** Skills are not tool-registry entries at all — pi formats them into the
child's system prompt (`noSkills = !inheritSkills`), so they were never blocked by the allowlist. GSD's
`Skill` tool maps to `inheritSkills`, already emitted for every agent that GSD gives `Skill` to; those
children read the skill's `SKILL.md` directly (project skills live in `.pi/skills/` and `.agents/skills/`).

### 2.3 Where the source definitions come from (and which one to install)

The plugin never ships GSD's commands or agents itself — it converts a GSD Core copy that is already on disk.
**Claude Code itself is not required**: GSD's installer is a file-layout installer (`--claude` just means
"write into `~/.claude/…`"); it never probes for a `claude` binary. What you need is *a definition set*, and a
pi-only install is not one — `--pi` ships the engine tree (`~/.pi/agent/gsd-core/`: `bin/`, `references/`,
`workflows/`, `templates/`) plus the `/gsd` extension, and **no `commands/` or `agents/` directory at all**.
That is precisely the gap this plugin fills.

Candidate sources are searched automatically, in this order (an explicit `--source` replaces the search):

| Source | Commands | Agents | `thinking:` / `excludeTools:` | How to get it |
|---|---|---|---|---|
| **Claude Code layout** — `~/.claude/gsd-core/commands/gsd` + `~/.claude/agents` ← recommended | 72 | 35 | **yes** | `npx -y @opengsd/gsd-core@latest --claude` |
| **The npm package itself** — `<npx cache>/node_modules/@opengsd/gsd-core/` | 72 | 35 | no | `npx -y @opengsd/gsd-core@latest` (the tarball carries `commands/gsd/` and `agents/`), then `--source …/commands/gsd` |
| Other runtime installs (qwen, copilot, opencode, kilo, hermes, cline, codebuddy, trae, augment, antigravity, zcode) | yes | yes | no | `npx -y @opengsd/gsd-core@latest --<runtime>` |
| cursor, windsurf (reduced frontmatter, no `tools:`) · codex, kimi (TOML / manifest) | yes | **no** | — | `--cursor`, `--codex`, … |
| `--pi` only | **no** | **no** | — | `npx -y @opengsd/gsd-core@latest --pi` |

"**yes**" in the `thinking:` column is why the Claude Code layout is the recommended one: GSD's installer injects
a per-agent `effort:` (35/35 agents) and `disallowedTools:` (7 agents) into that copy, and those are exactly what
become pi's `thinking:` and `excludeTools:`. The npm package and the other runtime trees carry the pristine
frontmatter instead, so those two fields are simply absent — the agents still work, they just leave the reasoning
level to pi's default. Pointing `--source` at the npm package is nonetheless the zero-install path:

```bash
PKG=$(find ~/.npm/_npx -maxdepth 4 -type d -path '*node_modules/@opengsd/gsd-core' | head -1)
node gsd-slash-sync.js sync --source "$PKG/commands/gsd"
```

The agent side of an explicit `--source` stays inside that same tree (`<tree>/agents`), never mixing in agents
from a different GSD version, and `~/.claude/gsd-core/agents` (the pristine Claude tree) is used when the
installed `~/.claude/agents` copy is missing.

---

## 3. Usage

### Inside pi

| Command | Effect |
|---|---|
| `/gsd-sync` | Re-sync now (reloads pi resources so the new templates work in this session) |
| `/gsd-sync --status` | Show what is installed and whether it is stale |
| `/gsd-sync --dry-run` | Report what would change, write nothing |
| `/gsd-sync --mode inline` | Switch to inline mode (persisted to the config file) |
| `/gsd-sync --naming colon` | Switch to `/gsd:plan-phase` naming (persisted) |
| `/gsd-sync --agents-out <dir>` | Write the agent definitions somewhere else (this run only) |
| `/gsd-sync --no-agents` | Skip the subagents entirely (persisted) |
| `/gsd-sync --force` | Proceed even when the source looks broken |
| `/gsd-sync --no-persist` | Apply `--mode/--naming/--source/--agents` for this run only |

The agent can also call the `gsd_slash_sync` tool itself (handy right after a GSD Core update).

### From a shell

```bash
node gsd-slash-sync.js sync [--dry-run|--status|--json|--force|--mode …|--naming …|--no-agents]
node gsd-slash-sync.js status [--json]
node gsd-slash-sync.js install
node gsd-slash-sync.js help
```

In `pi -p` (non-interactive) mode the `/gsd-sync` report goes to stdout, so scripts can read it:

```bash
pi -p --no-session "/gsd-sync --status"
```

### Automatic sync

Every pi start (`session_start`) runs a cheap fingerprint comparison:

- fingerprint matches → nothing happens, nothing is printed;
- GSD Core changed (version or command/agent file contents) → templates and agents are regenerated and you
  get `GSD synced for pi (72 commands, 35 subagents, GSD Core x.y.z)`;
- the plugin itself was upgraded (conversion logic changed), or the configured mode/naming changed →
  regenerated as well.

In other words: **after a GSD upgrade, your next pi session already has the new commands and agents** —
nothing to run by hand. Turn it off with `"autoSync": false` in the config file or
`GSD_SLASH_SYNC_AUTO=off`.

### Spawning the agents

Every generated command carries a `<gsd_subagent_dispatch>` block that translates GSD's Claude Code spawn
syntax into pi's, so a workflow step like

```text
Agent(subagent_type="gsd-planner", model="{PLANNER_MODEL}", prompt="…")
```

becomes

```js
subagent({ agent: "gsd-planner", task: "…" })
```

with `run_in_background: false` → `async: false`, `run_in_background: true` → the default background run,
`subagent_type="general-purpose"` → `agent: "delegate"`, `TaskOutput` → `subagent({action:"status", id})`,
and parallel spawns collapsing into one `workflowScript` call with `runs.all([...])`. You can also drive the
agents yourself:

```text
Use gsd-planner to plan phase 3.            # or: /run gsd-planner "plan phase 3"
subagent({ action: "list", capabilities: true })   # what is installed
```

Agents are discovered when a `subagent` call runs, so a sync is picked up without a restart; a session that
is already open only needs `/reload` to show the new roles in `{action:"list"}`.

---

## 4. Modes (default: `reference`)

Every GSD command file has an `<execution_context>` section pointing at the real workflow
(for example `workflows/plan-phase.md`, 92 KB). Claude Code expands those `@file` references
into the prompt. pi prompt templates have no `@` expansion, so there are two ways to bridge
that:

| | `reference` (default) | `inline` |
|---|---|---|
| Template size | 72 files / 512 KB (≈7 KB each) | 72 files / ~2.5 MB of inlined content |
| Agent size | 35 files / 757 KB (≈22 KB each) | up to ~190 KB for one agent (`gsd-planner`) |
| Single command prompt | ~10 KB, with a MUST-READ list of absolute paths | Same as Claude Code: workflow plus every nested reference (plan-phase ≈ 150 KB) |
| Model behaviour | Reads the listed files first, then follows the workflow | Has the whole procedure up front |
| Good for | Everyday use: fewer tokens, no compaction risk, reviewable templates | Byte-for-byte reproduction of Claude Code's “give it everything at once” |

```bash
/gsd-sync --mode inline        # switch (persisted)
/gsd-sync --mode reference     # switch back
```

In inline mode you can also cap per-command size; anything larger falls back to reference:

```bash
/gsd-sync --mode inline --max-inline-kb 40
```

**Recommendation:** start with the default `reference`. If you ever see a workflow step being
skipped (rare), switch to `--mode inline`.

The same setting governs the agents: 27 of the 35 agent definitions contain 120 `@file.md` references
(`@~/.claude/gsd-core/references/…`). In `reference` mode a generated agent carries a `<gsd_must_read>` list of
absolute paths into the pi GSD tree; in `inline` mode those files are expanded in place, exactly like Claude
Code. Inline makes `gsd-planner`'s system prompt ~190 KB (its references alone are 187 KB), and a child
re-sends that on every turn, so `reference` is the better default for agents too — the plain
`--max-inline-kb` fallback applies per agent.

---

## 5. Command naming

The default is the hyphen form `/gsd-plan-phase`. That is the form GSD itself mandates for
every non-Claude runtime: `runtime-slash.cjs` (ADR-457 / #2808 / #3584) states that codex uses
`$gsd-<cmd>` while claude/cursor/opencode/kilo use `/gsd-<cmd>`, and that
“**the colon form is never emitted**”. pi's own `commandStyle` is `slash-hyphen` too.

`/gsd:plan-phase` works as well, since pi allows `:` in template names:

```bash
/gsd-sync --naming colon
```

The generated file name is the command name (`gsd-plan-phase.md` vs `gsd:plan-phase.md`).
The converter also rewrites leftover `/gsd:<cmd>` references inside command bodies to
`/gsd-<cmd>` (GSD's own pi tree still carries 633 colon-form references, see #3584).

---

## 6. Configuration

`~/.pi/agent/gsd-slash-sync.json` (optional — defaults apply when it is absent):

```jsonc
{
  "mode": "reference",      // reference | inline
  "naming": "hyphen",       // hyphen | colon
  "maxInlineKb": 0,         // inline mode: fall back to reference above this size (0 = no limit)
  "syncAgents": true,       // convert GSD's subagents for pi-subagents
  "autoSync": true,         // check and re-sync on session_start
  "notify": true,           // notify when an automatic sync changed something
  "source": null,           // explicit commands/gsd directory
  "outDir": null,           // command output, default <agentDir>/gsd-commands
  "agentsOut": null         // agent output, default <agentDir>/agents (pi-subagents' user dir)
}
```

Environment variables (higher priority than the config file, lower than CLI flags):
`GSD_SLASH_SYNC_MODE`, `GSD_SLASH_SYNC_NAMING`, `GSD_SLASH_SYNC_MAX_INLINE_KB`,
`GSD_SLASH_SYNC_SOURCE`, `GSD_SLASH_SYNC_OUT`, `GSD_SLASH_SYNC_AGENTS_OUT`,
`GSD_SLASH_SYNC_NO_AGENTS=1`, `GSD_SLASH_SYNC_AUTO=off`, `GSD_SLASH_SYNC_NOTIFY=off`.

> Values passed explicitly as `--mode` / `--naming` / `--max-inline-kb` / `--source` / `--agents` /
> `--no-agents` are written back to the config file; otherwise the next automatic sync would revert to the
> old configured values. `--out` and `--agents-out` stay per-run. Use `--no-persist` to keep a run strictly
> one-off.

---

## 7. Generated artifacts

```
~/.pi/agent/gsd-commands/                  ← command output (pi loads prompt templates from here)
  gsd-plan-phase.md                        ← file name == command name
  gsd-execute-phase.md
  …
  .gsd-slash-sync-state.json               ← fingerprint + per-file state (pi ignores it)
~/.pi/agent/agents/                        ← agent output (pi-subagents scans **/*.md here)
  gsd-planner.md                           ← frontmatter name == agent name
  gsd-executor.md
  …
  .gsd-slash-sync-agents-state.json        ← its own fingerprint + per-file state
~/.pi/agent/extensions/gsd-slash-sync.js   ← the plugin
```

`~/.pi/agent/agents/` is pi-subagents' documented *user* agent directory, and the same global path GSD's own
`agent-install-check.cjs → getAgentsDir('pi')` resolves to — so the files land where both sides expect them.
A project's `.pi/agents/*.md` still wins over them, exactly as pi-subagents specifies.

- **Deterministic output.** The bytes depend only on the source files, the mode and the naming —
  no timestamps — so re-running the sync is a true no-op and never churns mtimes. `--naming colon` affects
  command names only; agent bytes are identical either way (pi-subagents names cannot contain `:`).
- **Pruning.** Files for commands/agents GSD removed are deleted — but only files this plugin created
  (recorded in the matching state file, or carrying the generator marker). Anything else is never touched,
  and a *colliding* file the plugin does not own is reported (`agent keep …`) instead of overwritten
  (`--force` overwrites).
- **Safety valves.** Fewer than 5 commands (or 5 agents) in the source refuses the run, so a broken source
  can never wipe a 72-command / 35-agent install; and pointing `--out` and `--agents-out` at the same
  directory is refused outright. Override the count guard with `--force`.

---

## 8. What the conversion does

For each `commands/gsd/<name>.md`:

1. **Frontmatter** → pi's `description` / `argument-hint` (YAML values quoted and escaped).
   Fields pi templates cannot express (`allowed-tools`, `type`) are dropped; `effort` and
   `requires` are surfaced as text in the runtime contract.
2. **`<execution_context>`** → in `reference` mode a MUST-READ list of absolute paths into the
   pi GSD tree; in `inline` mode a recursive expansion where `~/.claude/…`, `$HOME/…` and
   `gsd-core/…` references are all mapped onto **pi's own tree** (`~/.pi/agent/gsd-core/…`),
   because GSD's installer already rewrote that tree for this runtime.
3. **Runtime contract** injected into every command:
   - read the execution context first, in order, in full;
   - pi uses `/gsd-<name>`; a `/gsd:<name>` in GSD text means `/gsd-<name>`;
   - skills are `/skill:<name>`; if a skill is not installed, run the matching
     `/gsd-<command>` instead;
   - **`AskUserQuestion` does not exist in pi** → ask in chat with a plain-text numbered list
     and wait for the answer (always plain text under `--text` / `workflow.text_mode`);
   - subagents: the `<gsd_subagent_dispatch>` block below the contract translates every
     `Agent(subagent_type=…)` spawn into `subagent({ agent, task })` (see §3);
     step inline in the session — never skip it;
   - the GSD core path and the `gsd-tools.cjs` CLI path;
   - any `$ARGUMENTS` encountered in files read later stands for this run's user arguments.
4. **`<runtime_note>` blocks** — 10 commands carry a Copilot/VS Code note about asking
   questions; it is replaced with the pi equivalent, otherwise the model would hunt for a
   `vscode_askquestions` tool that does not exist.
5. **Shell positional protection** — pi's template engine substitutes `$1`, `$@`, `${1:-x}`,
   while GSD's shell shims are full of `"$@"` and `$1`. They are rewritten to the equivalent
   `"${@}"`, `"${1}"`, `${1-x}` so the shim survives (`$ARGUMENTS` is left alone: it means the
   same thing in pi).
6. **Colon → hyphen normalisation** for known command names (longest match, word-boundary safe).
7. **Runtime path rewriting** — the command files still reference Claude-shaped paths
   (`~/.claude/gsd-core/…`, `$HOME/.claude/gsd-core/…`, `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`,
   152 occurrences) and those are rewritten to the pi tree. This is exactly what GSD's own
   installer does for pi (its tree has 113 `${CLAUDE_CONFIG_DIR:-$HOME/.pi/agent}` and zero
   `~/.claude/gsd-core`), and it matters: GSD's `gsd_run` shim uses those paths to locate
   `gsd-tools.cjs`, so without the rewrite pi would find no engine in a project that has no
   local `gsd-core/` directory.

### 8.1 Agents

For each `agents/gsd-<role>.md`:

| GSD (Claude dialect) | Generated for pi-subagents | Notes |
|---|---|---|
| `name`, `description` | `name`, `description` | written verbatim; the runtime agent name comes from this `name` field, not the file name |
| `Read` `Write` `Edit` `Bash` `Grep` `Glob` | `read` `write` `edit` `bash` `grep` `find` | `Glob` → pi's glob-style `find` |
| `Agent` | `subagent` + `allowNestedSubagents: true` | only `gsd-debug-session-manager` spawns children |
| `AskUserQuestion` | `contact_supervisor` | pi-subagents' child→parent channel (a subagent cannot prompt the user directly) |
| `Skill` (or any skill talk in the body) | — + `inheritSkills: true` | pi skills are a prompt-time catalogue, not a tool; the child is told to read `SKILL.md` directly |
| `WebSearch`, `WebFetch`, `mcp__*` | — (dropped) | the child is told to use the installed pi web tools or GSD's CLI fallback (§2.2). A declared-but-unavailable tool name would be dropped anyway, and an `mcp:<server>` selector that cannot resolve **aborts the whole spawn** |
| `effort:` | `thinking:` | GSD's per-agent reasoning level (`low`/`high`/`xhigh`), validated against pi's level set |
| `disallowedTools:` | `excludeTools:` | e.g. `gsd-verifier`: `Edit, MultiEdit` → `excludeTools: edit` |
| `color:` | — (dropped) | no pi equivalent |
| — | `inheritProjectContext: true` | custom pi agents drop repository instructions by default; GSD's agents are repo workers |
| `@file.md` references | `<gsd_must_read>` list (reference) / expanded in place (inline) | see §4 |

The generated prompt then opens with a `<pi_runtime_contract>` block covering what the child has to know to
behave like the Claude-Code original: the GSD core path and `gsd-tools.cjs`, `/gsd-<command>` naming,
`$ARGUMENTS` being literal, the substitutions above, and "your final message is all the orchestrator sees".

`.compact.md` siblings are deliberately **not** installed: they are prompt-length fallbacks GSD serves when a
project sets `workflow.compact_content`, they share their canonical agent's `name:`, and pi-subagents would
register them as separate `gsd-<role>.compact` agents.

---

## 9. Verification

```bash
node test/verify.mjs        # 118 checks: drives pi's real template engine and pi-subagents' real discovery
node test/verify-pi-e2e.mjs # spawns a real `pi --mode rpc` and asks pi what commands it has
```

`verify.mjs` covers: the 72 templates, idempotency (a second sync changes nothing), loading and
`$ARGUMENTS` substitution through pi's own engine, shell-token protection, runtime path
rewriting, recursive inlining that survives substitution, colon naming, stale-template pruning,
refusing a broken source, the extension registration surface (`resources_discover`, command,
tool), and hygiene checks proving the suite cannot mutate a real install.

For the agents it additionally covers: the 35 generated definitions and their own state file, idempotency and
pruning/foreign-file protection (including a hand-written file with a colliding name, which must be reported
rather than overwritten), the full frontmatter mapping table above (block-list `tools:` included), the
reference/inline reference handling with its per-agent `--max-inline-kb` fallback, the parent dispatch block
(and its absence under `--no-agents`), both safety valves, and `--naming colon` leaving agent bytes untouched.
The strongest checks import **pi-subagents' own discovery** through `jiti` (the loader pi uses for TS
extensions) and assert that all 35 agents load with the expected tools, thinking level, `excludeTools` and
nested-fanout flag, and with zero diagnostics — skipped, not failed, on a machine without pi-subagents.

`verify-pi-e2e.mjs` covers what cannot be tested in-process: pi auto-discovering the extension
from `~/.pi/agent/extensions/`, and `resources_discover → promptPaths` really registering the
templates as native commands. Measured on a real install:
`148 commands · 78 prompt templates · 72 gsd templates · 35 generated agents`.

A real spawn, for the record (`pi --mode rpc`, `/run gsd-user-profiler[async=false] …`):

```json
{ "ok": true, "agent": "gsd-user-profiler", "output": "SPAWN-OK", "resolvedContext": "fresh" }
```

---

## 10. Known limitations

- **GSD's skills are not synced.** Commands such as `ns-*` are skill routers; the contract
  points at `/skill:<name>` and falls back to the matching `/gsd-<command>`. Agents that rely on skills get
  `inheritSkills: true` so they can see what is installed.
- **MCP and browser tools are not wired.** GSD's agents reach for Context7, Exa, Firecrawl, Tavily, Jina,
  Perplexity and Chrome DevTools over MCP. Nothing is declared in the generated agents on purpose (an
  unresolvable `mcp:` selector fails the whole spawn); see §2.2 for what to install and what the agents do
  instead.
- **Extension-provided tools need a background child.** Foreground children (`async: false`) do not load the
  ambient pi packages, so `pi-web-access` tools are only present in the default background runs. Use
  `async: false` when GSD explicitly demands a blocking spawn (its debug session manager), and expect the
  research agents to report a missing lookup tool if you force them into the foreground.
- **`.compact.md` agent variants are not used** (see §8.1). If you need the smaller payloads, `--mode
  reference` already keeps the child's system prompt small.
- **`advertise` is not set** on any generated agent. pi-subagents' advertised-agent catalogue is capped at 16
  entries / 12 KB and the generated commands already name the role to spawn, so advertising all 35 would only
  push the commonly used ones out of the catalogue.
- `reference` mode relies on the model following the read-first instruction (it is the very
  first item in the prompt). For absolute fidelity use `inline`.
- In `inline` mode `${1:-default}` is downgraded to `${1-default}`, which differs only when the
  variable is set-but-empty. There are exactly 2 such occurrences in the whole tree. Agent bodies are *not*
  shell-token protected at all: a child's system prompt never goes through pi's `substituteArgs`, so `"$@"`
  and `$1` are shipped exactly as GSD wrote them.
- The plugin never modifies or takes over GSD's install tree; a GSD upgrade is picked up by
  regenerating on the pi side only.

---

## 11. Repository layout

```
gsd-slash-sync.js        the plugin (pi extension + CLI, single file, zero npm dependencies)
test/verify.mjs          main verification suite (hermetic; drives pi and pi-subagents)
test/verify-pi-e2e.mjs   end-to-end verification through a real pi process
README.md
```

## License

MIT — see `LICENSE`.
