# gsd-slash-sync

Sync **GSD Core's slash commands** into **pi (pi.dev)** as native prompt templates — and re-sync them with one command whenever GSD Core updates.

After installing you get 72 pi slash commands:

```
/gsd-plan-phase     /gsd-execute-phase   /gsd-new-project    /gsd-quick
/gsd-progress       /gsd-verify-work     /gsd-code-review    /gsd-ship
… 72 in total, see /gsd-sync --status
```

---

## 1. Why pi has no GSD slash commands out of the box

This is a deliberate choice by GSD, not a broken install. GSD's own runtime descriptor
(`gsd-core/bin/lib/capability-registry.cjs`, entry `runtimes.pi`) says:

```jsonc
"pi": {
  "runtime": {
    "commandStyle": "slash-hyphen",          // commands are /gsd-<cmd>
    "installSurface": "profile-marker-only",
    "hostBehaviors": {
      "nativePlugin": { "dir": "extensions", "file": "gsd.js" },
      "pluginOnlyInstall": true,             // ← the important one
      "sharedHooksDirName": "gsd-hooks"
    }
  }
}
```

`pluginOnlyInstall: true` plus `artifactLayout.global: []` means a pi install ships
**one native extension file** (`~/.pi/agent/extensions/gsd.js`, which registers the single
`/gsd` hub command and the `gsd_invoke` tool) and **never installs** a `commands/gsd/`
directory. Claude Code installs get the full `~/.claude/gsd-core/commands/gsd/*.md` set
(72 files), which is why `/gsd-…` all exist there while pi only has `/gsd`.

This plugin closes that gap without forking GSD: it reads the canonical command definitions
GSD already installed for another runtime, converts them into pi's native prompt-template
format, and registers the result with pi through the documented `resources_discover` event.
**No GSD file is ever modified**; a GSD update is picked up by re-syncing.

```
already on disk (canonical source)          generated for pi
~/.claude/gsd-core/commands/gsd/*.md   →   ~/.pi/agent/gsd-commands/gsd-*.md
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

Requirement: a GSD Core `commands/gsd/*.md` set somewhere on the machine — normally the
Claude Code install at `~/.claude/gsd-core/commands/gsd`. Installations for codex, cursor,
opencode, kilo, gemini, qwen and copilot are searched too, and `--source <dir>` (or
`GSD_SLASH_SYNC_SOURCE`) points the plugin at anything else.

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
| `/gsd-sync --force` | Proceed even when the source looks broken |
| `/gsd-sync --no-persist` | Apply `--mode/--naming/--source` for this run only |

The agent can also call the `gsd_slash_sync` tool itself (handy right after a GSD Core update).

### From a shell

```bash
node gsd-slash-sync.js sync [--dry-run|--status|--json|--force|--mode …|--naming …]
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
- GSD Core changed (version or command file contents) → templates are regenerated and you
  get `GSD slash commands synced (72 templates, GSD Core x.y.z)`;
- the plugin itself was upgraded (conversion logic changed), or the configured mode/naming
  changed → regenerated as well.

In other words: **after a GSD upgrade, your next pi session already has the new commands** —
nothing to run by hand. Turn it off with `"autoSync": false` in the config file or
`GSD_SLASH_SYNC_AUTO=off`.

---

## 4. Modes (default: `reference`)

Every GSD command file has an `<execution_context>` section pointing at the real workflow
(for example `workflows/plan-phase.md`, 92 KB). Claude Code expands those `@file` references
into the prompt. pi prompt templates have no `@` expansion, so there are two ways to bridge
that:

| | `reference` (default) | `inline` |
|---|---|---|
| Template size | 72 files / ~320 KB | 72 files / ~2.5 MB of inlined content |
| Single command prompt | ~5 KB, with a MUST-READ list of absolute paths | Same as Claude Code: workflow plus every nested reference (plan-phase ≈ 150 KB) |
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
  "autoSync": true,         // check and re-sync on session_start
  "notify": true,           // notify when an automatic sync changed something
  "source": null,           // explicit commands/gsd directory
  "outDir": null            // output directory, default <agentDir>/gsd-commands
}
```

Environment variables (higher priority than the config file, lower than CLI flags):
`GSD_SLASH_SYNC_MODE`, `GSD_SLASH_SYNC_NAMING`, `GSD_SLASH_SYNC_MAX_INLINE_KB`,
`GSD_SLASH_SYNC_SOURCE`, `GSD_SLASH_SYNC_OUT`, `GSD_SLASH_SYNC_AUTO=off`,
`GSD_SLASH_SYNC_NOTIFY=off`.

> Values passed explicitly as `--mode` / `--naming` / `--max-inline-kb` / `--source` are written
> back to the config file; otherwise the next automatic sync would revert the templates to the
> old configured values. Use `--no-persist` to keep a run strictly one-off.

---

## 7. Generated artifacts

```
~/.pi/agent/gsd-commands/                  ← output directory (pi loads templates from here)
  gsd-plan-phase.md                        ← file name == command name
  gsd-execute-phase.md
  …
  .gsd-slash-sync-state.json               ← fingerprint + per-file state (pi ignores it)
~/.pi/agent/extensions/gsd-slash-sync.js   ← the plugin
```

- **Deterministic output.** The bytes depend only on the source files, the mode and the naming —
  no timestamps — so re-running the sync is a true no-op and never churns mtimes.
- **Pruning.** Templates for commands GSD removed are deleted — but only files this plugin
  created (recorded in the state file, or carrying the generator marker). Anything else in that
  directory is never touched.
- **Safety valve.** Fewer than 5 commands in the source means the run is refused, so a broken
  source can never wipe a 72-template install. Override with `--force`.

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
   - subagents: use pi's subagent tooling when the named agent is registered, otherwise do that
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

---

## 9. Verification

```bash
node test/verify.mjs        # 54 checks: exercises pi's real prompt-template engine (temp dirs, repeatable)
node test/verify-pi-e2e.mjs # spawns a real `pi --mode rpc` and asks pi what commands it has
```

`verify.mjs` covers: the 72 templates, idempotency (a second sync changes nothing), loading and
`$ARGUMENTS` substitution through pi's own engine, shell-token protection, runtime path
rewriting, recursive inlining that survives substitution, colon naming, stale-template pruning,
refusing a broken source, the extension registration surface (`resources_discover`, command,
tool), and hygiene checks proving the suite cannot mutate a real install.

`verify-pi-e2e.mjs` covers what cannot be tested in-process: pi auto-discovering the extension
from `~/.pi/agent/extensions/`, and `resources_discover → promptPaths` really registering the
templates as native commands. Measured on a real install:
`148 commands · 78 prompt templates · 72 gsd templates`.

---

## 10. Known limitations

- **GSD's subagents are not synced.** GSD workflows name agents such as `gsd-planner` and
  `gsd-executor`, but a pi install contains no `agents/` directory (Claude Code's copy lives in
  `~/.claude/agents/`). The runtime contract tells the model to do that step inline in the
  current session when the agent is missing, rather than skipping it. Converting those agents
  into pi-subagents definitions is a separate piece of work.
- **GSD's skills are not synced.** Commands such as `ns-*` are skill routers; the contract
  points at `/skill:<name>` and falls back to the matching `/gsd-<command>`.
- `reference` mode relies on the model following the read-first instruction (it is the very
  first item in the prompt). For absolute fidelity use `inline`.
- In `inline` mode `${1:-default}` is downgraded to `${1-default}`, which differs only when the
  variable is set-but-empty. There are exactly 2 such occurrences in the whole tree.
- The plugin never modifies or takes over GSD's install tree; a GSD upgrade is picked up by
  regenerating on the pi side only.

---

## 11. Repository layout

```
gsd-slash-sync.js        the plugin (pi extension + CLI, single file, zero dependencies)
test/verify.mjs          main verification suite
test/verify-pi-e2e.mjs   end-to-end verification through a real pi process
README.md
```

## License

MIT — see `LICENSE`.
