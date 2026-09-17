'use strict';

/**
 * gsd-slash-sync — installs GSD Core's slash commands into pi as native prompt
 * templates and GSD's subagents as pi-subagents agent definitions, and keeps
 * both in sync across GSD Core updates.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * GSD Core's own capability descriptor for pi
 * (`gsd-core/bin/lib/capability-registry.cjs` → `runtimes.pi`) declares:
 *
 *   "hostBehaviors": { "pluginOnlyInstall": true, ... }
 *   "artifactLayout": { "global": [], "local": [] }
 *
 * i.e. a pi install is deliberately *plugin-only*: GSD ships
 * `<agentDir>/extensions/gsd.js` (which registers the single `/gsd` hub command
 * plus the `gsd_invoke` tool) and NEVER installs a `commands/gsd/` directory,
 * per-command prompt templates, or an `agents/` directory. Every other runtime's
 * descriptor carries an `agents` artifact (`destSubpath: "agents"`,
 * `prefix: "gsd-"`) with a `convertClaudeAgentTo<Runtime>Agent` converter; pi is
 * the only one with an empty `artifactLayout`. Claude Code installs get the full
 * `~/.claude/gsd-core/{commands/gsd,agents}/*.md` sets, which is why Claude Code
 * shows all of them under `/gsd-…` and can dispatch `gsd-planner` while pi shows
 * only `/gsd` and has no named subagents at all.
 *
 * This extension closes both gaps without forking GSD: it reads the canonical
 * command/agent definitions that GSD already ships for *another* runtime,
 * converts them to pi's native formats, registers the generated command
 * directory with pi through the documented `resources_discover` event, and
 * writes the agents where pi-subagents discovers them.
 *
 *   source (canonical, shipped by GSD)      →  pi (generated)
 *   ~/.claude/gsd-core/commands/gsd/*.md    →  ~/.pi/agent/gsd-commands/gsd-*.md
 *   ~/.claude/gsd-core/agents/gsd-*.md      →  ~/.pi/agent/agents/gsd-*.md
 *
 * Re-running is cheap and idempotent: a content fingerprint short-circuits the
 * no-op case, and files are only rewritten when their bytes actually change.
 *
 * ── Conventions it follows ────────────────────────────────────────────────────
 * - Command naming: hyphen form (`/gsd-plan-phase`), which is GSD's canonical
 *   non-Claude form (`commandStyle: "slash-hyphen"`, ADR-457 / #2808 / #3584,
 *   "the colon form is never emitted"). `--naming colon` is available for people
 *   who prefer `/gsd:plan-phase`.
 * - Context paths always point at the *pi* GSD tree (`<agentDir>/gsd-core/...`),
 *   because that tree is the one GSD's installer rewrites for this runtime.
 * - `$ARGUMENTS` is preserved: pi's prompt-template substitution uses the exact
 *   same token, so Claude Code argument semantics carry over unchanged.
 *
 * ── Modes ─────────────────────────────────────────────────────────────────────
 * - `reference` (default): the template carries the command contract, the user's
 *   arguments and a MUST-READ list of absolute paths into the pi GSD tree. Tiny
 *   files, nothing is duplicated, no shell text is ever rewritten.
 * - `inline`: the referenced files are expanded into the template recursively,
 *   which is byte-for-byte what Claude Code feeds the model. Needed because pi's
 *   prompt-template engine also substitutes `$@`, `$N` and `${N:-…}`, which
 *   appear in GSD's shell shims, those tokens are rewritten to their equivalent
 *   braces form (`"${@}"`, `"${1}"`, `${1-…}`) before inlining.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   /gsd-sync                     regenerate now (auto-reloads pi resources)
 *   /gsd-sync --status            what is installed / is it stale
 *   /gsd-sync --dry-run           show the plan, write nothing
 *   /gsd-sync --mode inline       switch to full-fidelity inlined templates
 *   /gsd-sync --naming colon      generate `/gsd:plan-phase` style names
 *   /gsd-sync --no-agents         skip the subagent definitions
 *
 *   node gsd-slash-sync.js sync [--dry-run|--status|--json|--force|--mode …]
 *   node gsd-slash-sync.js install          copy self into extensions/
 *
 * Sync also happens automatically on session start when GSD Core has changed.
 *
 * ── Subagents ─────────────────────────────────────────────────────────────────
 * GSD workflows spawn named agents (`Agent(subagent_type="gsd-planner", …)`, 149
 * spawn sites across the pi GSD tree) and GSD's own dispatch resolver tells pi
 * to substitute `coder`/`explore`/`plan` — Kimi Code's built-ins, which do not
 * exist here. Converting the agents to pi-subagents definitions and teaching the
 * generated commands the exact `subagent({ agent, task })` translation is what
 * makes those steps run instead of degrading to inline work.
 *
 * Generated agent frontmatter only ever names pi *builtin* tools: a declared
 * extension tool would be dropped from the child allowlist anyway, `mcp:<server>`
 * selectors that cannot resolve abort the whole spawn, and an allowlist that
 * filters down to nothing leaves the child with no tools at all. Capabilities
 * without a pi tool (skills, web/MCP lookups, nested fanout, asking the user) are
 * instead spelled out in a `<pi_runtime_contract>` block at the top of the agent
 * prompt, where the child can act on them.
 *
 * @param {object} pi pi ExtensionAPI (registerCommand / registerTool / on / …)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GENERATOR = 'gsd-slash-sync';
// Bump on ANY change to the conversion output (not just when the CLI surface
// changes): the state file records this string and a mismatch forces a re-sync,
// so an upgraded plugin never leaves stale templates behind.
const GENERATOR_VERSION = '1.2.0';
const STATE_FILE = '.gsd-slash-sync-state.json';
// The agent set keeps its own state file: the two artifacts are written into
// different directories and can be redirected independently, so each one carries
// the record of what it owns without a schema migration of the other.
const AGENTS_STATE_FILE = '.gsd-slash-sync-agents-state.json';
const CONFIG_FILE = 'gsd-slash-sync.json';
const MARKER_PREFIX = `<!-- generated by ${GENERATOR}`;
// How far into a file to look for the generator marker when the state file has
// no record of it. Agent frontmatter (name + a long description + tools) alone
// can exceed 400 bytes, so the marker that follows it must still be in range.
const MARKER_SCAN_BYTES = 4096;
const MIN_SOURCE_COMMANDS = 5; // refuse to wipe an install on a broken source
const MIN_SOURCE_AGENTS = 5; // same guard for the generated agent set
const MAX_INLINE_DEPTH = 6;

const HOME = os.homedir();

const DEFAULT_CONFIG = Object.freeze({
  /** "reference" | "inline" */
  mode: 'reference',
  /** "hyphen" → /gsd-plan-phase · "colon" → /gsd:plan-phase */
  naming: 'hyphen',
  /** output directory (absolute, or ~/…); default <agentDir>/gsd-commands */
  outDir: null,
  /** output directory for the pi-subagents agent definitions; default <agentDir>/agents */
  agentsOut: null,
  /** convert GSD's subagents into pi-subagents agent definitions */
  syncAgents: true,
  /** explicit source directory holding the canonical commands/gsd/*.md */
  source: null,
  /** inline mode only: fall back to reference past this many KB (0 = no limit) */
  maxInlineKb: 0,
  /** regenerate on session start when the source changed */
  autoSync: true,
  /** surface a notification when an automatic sync changed something */
  notify: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, HOME);
}

/** pi's own agent directory (honours PI_CODING_AGENT_DIR). */
function resolveAgentDir() {
  const env = process.env.PI_CODING_AGENT_DIR || process.env.TAU_CODING_AGENT_DIR;
  if (env && String(env).trim()) return path.resolve(expandHome(String(env).trim()));
  return path.join(HOME, '.pi', 'agent');
}

/**
 * Tool names the host's installed extension packages actually register.
 *
 * Detection is package-name based, read from pi's `settings.json` package list
 * and, when that list is an npm spec, from the resolved install under
 * `<agentDir>/npm/node_modules`. A package that is declared but not yet
 * installed contributes nothing, so discovery never promises a tool the host
 * cannot provide.
 *
 * @param {string} agentDir pi's agent directory (`~/.pi/agent`).
 * @returns {string[]} extension tool names, in declaration order, deduped.
 */
function detectHostExtensionTools(agentDir, packageSpecs) {
  const specs = Array.isArray(packageSpecs) ? packageSpecs : readInstalledPackageSpecs(agentDir);
  const out = [];
  const seenPackages = new Set();
  for (const spec of specs) {
    const name = npmPackageName(spec);
    if (!name || seenPackages.has(name)) continue;
    const tools = HOST_EXTENSION_TOOLS[name];
    if (!tools) continue;
    if (!isPackageInstalled(agentDir, name)) continue;
    seenPackages.add(name);
    for (const tool of tools) if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

/** pi spec (`npm:foo`, `foo@1.2.3`, `npm:@scope/bar`) → bare package name. */
function npmPackageName(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return '';
  const body = raw.startsWith('npm:') ? raw.slice(4) : raw;
  if (!body || body.startsWith('.') || body.startsWith('/') || path.isAbsolute(body)) return '';
  const at = body.lastIndexOf('@');
  return at > 0 ? body.slice(0, at) : body;
}

/** True when the package resolves inside pi's own npm install tree. */
function isPackageInstalled(agentDir, name) {
  if (!agentDir) return false;
  return isDir(path.join(agentDir, 'npm', 'node_modules', ...name.split('/')));
}

/** The `packages` array from pi's `settings.json`; `[]` when unreadable. */
function readInstalledPackageSpecs(agentDir) {
  if (!agentDir) return [];
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.packages) ? parsed.packages : [];
  } catch {
    return [];
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listCommandFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

function unquoteYaml(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Always emit a double-quoted YAML scalar — GSD descriptions contain `:` and `|`. */
function yamlQuote(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function relativeTo(root, p) {
  const rel = path.relative(root, p);
  return rel === '' ? '.' : rel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

function configPath(agentDir) {
  return path.join(agentDir, CONFIG_FILE);
}

function readConfigFile(agentDir) {
  const raw = readIfExists(configPath(agentDir));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into the plugin's config file.
 *
 * An explicit `--mode` / `--naming` / `--max-inline-kb` / `--source` is an
 * instruction about how this plugin should behave from now on, so it is
 * persisted: otherwise an automatic sync (which only reads env + config) would
 * immediately revert the template set to the configured mode on the next
 * session start. Location flags (`--out`) stay transient.
 *
 * @returns {string[]} the keys that were written
 */
function persistConfig(agentDir, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return [];
  const file = readConfigFile(agentDir);
  for (const k of keys) file[k] = patch[k];
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(configPath(agentDir), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    return keys;
  } catch {
    return [];
  }
}

function parseBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'auto'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'none'].includes(s)) return false;
  return undefined;
}

/**
 * Merge CLI flags > environment > config file > defaults.
 * @param {object} [flags] parsed flags (see parseFlags)
 * @param {object} [ctx]   { cwd, agentDir }
 * @returns {object} fully resolved options
 */
function resolveOptions(flags = {}, ctx = {}) {
  const agentDir = path.resolve(ctx.agentDir || resolveAgentDir());
  const file = readConfigFile(agentDir);
  const env = process.env;

  const pick = (flagValue, envValue, fileValue, fallback, cast) => {
    for (const candidate of [flagValue, envValue, fileValue]) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const v = cast ? cast(candidate) : candidate;
      if (v !== undefined) return v;
    }
    return fallback;
  };

  const mode = pick(
    flags.mode,
    env.GSD_SLASH_SYNC_MODE,
    file.mode,
    DEFAULT_CONFIG.mode,
    (v) => (['reference', 'inline'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : undefined),
  );
  const naming = pick(
    flags.naming,
    env.GSD_SLASH_SYNC_NAMING,
    file.naming,
    DEFAULT_CONFIG.naming,
    (v) => (['hyphen', 'colon'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : undefined),
  );
  const maxInlineKb = pick(
    flags.maxInlineKb,
    env.GSD_SLASH_SYNC_MAX_INLINE_KB,
    file.maxInlineKb,
    DEFAULT_CONFIG.maxInlineKb,
    (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    },
  );
  const autoSync = pick(
    flags.autoSync,
    env.GSD_SLASH_SYNC_AUTO,
    file.autoSync,
    DEFAULT_CONFIG.autoSync,
    parseBoolean,
  );
  const notify = pick(flags.notify, env.GSD_SLASH_SYNC_NOTIFY, file.notify, DEFAULT_CONFIG.notify, parseBoolean);

  const outDir = path.resolve(expandHome(String(pick(flags.outDir, env.GSD_SLASH_SYNC_OUT, file.outDir, null) || path.join(agentDir, 'gsd-commands'))));
  const agentsOut = path.resolve(
    expandHome(
      String(
        pick(flags.agentsOut, env.GSD_SLASH_SYNC_AGENTS_OUT, file.agentsOut, null) ||
          // pi-subagents' user agent directory, and the same global path GSD's own
          // `getAgentsDir('pi')` resolves to (agent-install-check.cjs).
          path.join(agentDir, 'agents'),
      ),
    ),
  );
  // `syncAgents` reads as a positive option (config `syncAgents`, flag `--no-agents`,
  // env `GSD_SLASH_SYNC_NO_AGENTS=1`), so the negative inputs are inverted here.
  const noAgentsEnv = parseBoolean(env.GSD_SLASH_SYNC_NO_AGENTS);
  const syncAgents = pick(
    flags.noAgents === true ? false : flags.agents === true ? true : undefined,
    noAgentsEnv === undefined ? undefined : !noAgentsEnv,
    file.syncAgents,
    DEFAULT_CONFIG.syncAgents,
    parseBoolean,
  );
  const source = pick(flags.source, env.GSD_SLASH_SOURCE, file.source, null);

  return {
    agentDir,
    outDir,
    agentsOut,
    syncAgents,
    source: source ? path.resolve(expandHome(String(source))) : null,
    mode,
    naming,
    maxInlineKb,
    autoSync,
    notify,
    cwd: path.resolve(ctx.cwd || process.cwd()),
    force: !!flags.force,
    dryRun: !!flags.dryRun,
    quiet: !!flags.quiet,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source discovery
// ─────────────────────────────────────────────────────────────────────────────

function sourceCandidates(opts) {
  const env = process.env;
  const list = [];
  const add = (p, runtime) => {
    if (!p) return;
    const abs = path.resolve(expandHome(String(p)));
    if (!list.some((c) => c.dir === abs)) list.push({ dir: abs, runtime });
  };

  add(opts.source, 'explicit');

  // pi runtime install (absent today: pi installs are plugin-only, but a future
  // GSD release could ship it and it should win automatically).
  add(path.join(opts.agentDir, 'gsd-core', 'commands', 'gsd'), 'pi');

  add(path.join(env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'gsd-core', 'commands', 'gsd'), 'claude');
  add(path.join(opts.cwd, '.claude', 'gsd-core', 'commands', 'gsd'), 'claude(project)');
  add(path.join(opts.cwd, 'gsd-core', 'commands', 'gsd'), 'repo');
  add(path.join(opts.cwd, 'commands', 'gsd'), 'repo');

  const homes = [
    [env.CODEX_HOME || path.join(HOME, '.codex'), 'codex'],
    [env.CURSOR_CONFIG_DIR || path.join(HOME, '.cursor'), 'cursor'],
    [env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode'), 'opencode'],
    [path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'kilo'), 'kilo'],
    [env.GEMINI_CONFIG_DIR || path.join(HOME, '.gemini'), 'gemini'],
    [path.join(HOME, '.qwen'), 'qwen'],
    [env.GROK_AGENTS_HOME || path.join(HOME, '.agents'), 'grok'],
    [env.HERMES_HOME || path.join(HOME, '.hermes'), 'hermes'],
    [env.COPILOT_CONFIG_DIR || path.join(HOME, '.copilot'), 'copilot'],
  ];
  for (const [home, runtime] of homes) add(path.join(home, 'gsd-core', 'commands', 'gsd'), runtime);

  return list;
}

/** Count command files that actually look like GSD commands. */
function scoreSource(dir) {
  const files = listCommandFiles(dir);
  const valid = [];
  for (const f of files) {
    const raw = readIfExists(path.join(dir, f));
    if (!raw) continue;
    // GSD spells the frontmatter name `gsd:cmd`; the `ns-*` namespace stubs use
    // `gsd-<label>` instead. Command identity always comes from the file stem —
    // that is what GSD's own roster (readdir-based) and Claude Code both use.
    const m = /^name:\s*gsd[-:]\S/m.exec(raw);
    if (m) valid.push(f);
  }
  return { files, valid };
}

function resolveCoreRoot(opts, sourceDir) {
  const candidates = [
    path.join(opts.agentDir, 'gsd-core'), // the pi-runtime tree (path-rewritten for pi)
    path.resolve(sourceDir, '..', '..'), // sibling tree of the source commands dir
  ];
  for (const c of candidates) {
    if (isDir(path.join(c, 'workflows'))) return c;
  }
  return null;
}

function readVersion(coreRoot, sourceDir) {
  for (const p of [coreRoot && path.join(coreRoot, 'VERSION'), path.resolve(sourceDir, '..', 'VERSION')]) {
    if (!p) continue;
    const v = readIfExists(p);
    if (v && v.trim()) return v.trim();
  }
  return 'unknown';
}

/**
 * Pick the best available canonical command source.
 * @returns {object} { dir, runtime, coreRoot, version, candidates, valid }
 * @throws {Error} when nothing usable is on disk
 */
function discoverSource(opts) {
  const candidates = sourceCandidates(opts);
  const scanned = candidates.map((c) => ({ ...c, ...scoreSource(c.dir) }));
  // An explicit --source / GSD_SLASH_SOURCE always wins — it is a user instruction,
  // not one more candidate to be outbid by a bigger install elsewhere on the box.
  const explicit = opts.source ? scanned.find((c) => c.runtime === 'explicit') : null;
  let chosen = explicit;
  if (explicit && explicit.valid.length === 0) {
    throw new Error(`--source ${explicit.dir} does not look like a GSD commands/gsd directory (no *.md with a \`name: gsd:…\` frontmatter)`);
  }
  if (!chosen) {
    const usable = scanned.filter((c) => c.valid.length > 0);
    if (usable.length === 0) {
      const tried = candidates.map((c) => `  - ${c.dir} (${c.runtime})`).join('\n');
      throw new Error(
        `no GSD Core command definitions found. Looked for commands/gsd/*.md in:\n${tried}\n` +
          'Run the GSD installer for Claude Code (`npx -y @opengsd/gsd-core@latest --claude`), ' +
          'or point this plugin at a directory with --source <dir> / GSD_SLASH_SOURCE=<dir>.',
      );
    }
    usable.sort((a, b) => b.valid.length - a.valid.length);
    chosen = usable[0];
  }
  const coreRoot = resolveCoreRoot(opts, chosen.dir);
  return {
    dir: chosen.dir,
    runtime: chosen.runtime,
    coreRoot,
    version: readVersion(coreRoot, chosen.dir),
    candidates: scanned.map((c) => ({ dir: c.dir, runtime: c.runtime, commands: c.valid.length })),
    valid: chosen.valid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent source discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Candidate directories holding canonical `agents/gsd-*.md` (Claude dialect).
 *
 * The pi tree comes first but is normally absent — pi installs are plugin-only,
 * so the canonical copy is whatever install GSD wrote for another runtime.
 * Converted copies for other runtimes (Codex TOML, Cursor's reduced markdown) are
 * scored out rather than special-cased, so they can be listed safely.
 *
 * With an explicit `--source` the search stays inside that tree: an explicit
 * source is a user instruction about *which* GSD Core copy to convert, and
 * silently mixing in agents from a different install could pair a command's
 * workflow with an agent definition from another version.
 */
/**
 * Candidate directories holding canonical `agents/gsd-*.md`.
 *
 * The pi tree comes first but is normally absent — pi installs are plugin-only,
 * so the canonical copy is whatever install GSD wrote for another runtime.
 * Converted copies for other runtimes (Codex TOML, Cursor's reduced markdown) are
 * scored out rather than special-cased, so they can be listed safely.
 *
 * For Claude Code the *installed* directory (`~/.claude/agents`) is preferred
 * over the pristine `~/.claude/gsd-core/agents`: GSD's installer injects the
 * per-agent `effort:` every agent carries and the `disallowedTools:` seven of them
 * declare, and those two fields are exactly what becomes pi's `thinking:` and
 * `excludeTools:`. The pristine tree stays as the fallback for an install whose
 * agents were never staged.
 *
 * With an explicit `--source` the search stays inside that tree: an explicit
 * source is a user instruction about *which* GSD Core copy to convert, and
 * silently mixing in agents from a different install could pair a command's
 * workflow with an agent definition from another version.
 */
function agentSourceCandidates(opts, coreRoot, sourceDir) {
  const env = process.env;
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const list = [];
  const add = (dir, runtime) => {
    if (!dir) return;
    const abs = path.resolve(expandHome(String(dir)));
    if (!list.some((c) => c.dir === abs)) list.push({ dir: abs, runtime });
  };

  add(coreRoot && path.join(coreRoot, 'agents'), 'pi-core');
  if (opts.source) {
    add(sourceDir && path.resolve(sourceDir, '..', '..', 'agents'), 'source-tree');
    return list;
  }

  add(path.join(opts.agentDir, 'gsd-core', 'agents'), 'pi');
  add(path.join(claudeHome, 'agents'), 'claude');
  add(path.join(claudeHome, 'gsd-core', 'agents'), 'claude-canonical');
  add(path.join(opts.cwd, '.claude', 'gsd-core', 'agents'), 'claude(project)');
  add(path.join(opts.cwd, 'gsd-core', 'agents'), 'repo');

  const homes = [
    [env.CODEX_HOME || path.join(HOME, '.codex'), 'codex'],
    [env.CURSOR_CONFIG_DIR || path.join(HOME, '.cursor'), 'cursor'],
    [env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode'), 'opencode'],
    [env.GEMINI_CONFIG_DIR || path.join(HOME, '.gemini'), 'gemini'],
    [path.join(HOME, '.qwen'), 'qwen'],
    [env.HERMES_HOME || path.join(HOME, '.hermes'), 'hermes'],
    [env.COPILOT_CONFIG_DIR || path.join(HOME, '.copilot'), 'copilot'],
  ];
  for (const [home, runtime] of homes) add(path.join(home, 'gsd-core', 'agents'), runtime);

  // Last resort: the tree the chosen command source itself came from.
  add(sourceDir && path.resolve(sourceDir, '..', '..', 'agents'), 'source-tree');

  return list;
}

/**
 * Count agent files that look like GSD's own Claude-dialect definitions.
 *
 * `name: gsd-*` plus a `tools:` key is what separates the canonical set from
 * Codex `.toml` files, Cursor/Augment's reduced frontmatter, and a user's own
 * agents living in the same directory. `.compact.md` siblings are excluded by
 * file name, not by dedupe: they share their canonical agent's `name:` and sort
 * *before* it (`gsd-x.compact.md` < `gsd-x.md`), so a name-keyed pass would keep
 * the prompt-length fallback and drop the real agent.
 */
function scoreAgentSource(dir) {
  const valid = [];
  for (const file of listCommandFiles(dir)) {
    if (file.endsWith('.compact.md')) continue;
    const raw = readIfExists(path.join(dir, file));
    if (!raw) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!fm) continue;
    if (!/^name:\s*gsd-/m.test(fm[1])) continue;
    if (!/^tools:/m.test(fm[1])) continue;
    // pi-subagents skips definitions without a non-empty description, and our own
    // discovery must not depend on the source being well-formed.
    if (!/^description:\s*\S/m.test(fm[1])) continue;
    valid.push(file);
  }
  return valid;
}

/**
 * Pick the best available canonical agent source. Never throws: a machine with
 * commands but no canonical agents is a valid state, so the caller degrades to a
 * note and the commands still sync.
 * @returns {object|null} { dir, runtime, valid, candidates }
 */
function discoverAgentSource(opts, coreRoot, sourceDir) {
  const candidates = agentSourceCandidates(opts, coreRoot, sourceDir);
  const scanned = candidates.map((c) => ({ ...c, valid: scoreAgentSource(c.dir) }));
  const usable = scanned.filter((c) => c.valid.length > 0);
  if (usable.length === 0) return null;
  usable.sort((a, b) => b.valid.length - a.valid.length);
  const chosen = usable[0];
  return {
    dir: chosen.dir,
    runtime: chosen.runtime,
    valid: chosen.valid,
    candidates: scanned.map((c) => ({ dir: c.dir, runtime: c.runtime, agents: c.valid.length })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter reader — enough for GSD's command and agent files
 * (scalars, `key:\n  - item` block lists, `[a, b]` flow lists, comments).
 *
 * `data` always holds the scalar form; `lists` holds the block-list items of any
 * key that used the `- item` form (`tools:` in `gsd-nyquist-auditor` and
 * `gsd-security-auditor`). Callers that need either form use `frontmatterList`.
 *
 * @returns {{ data: object, body: string, lists: object }}
 */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw, lists: {} };
  const data = {};
  const lists = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      lists[listKey].push(unquoteYaml(item[1]));
      continue;
    }
    if (/^\s/.test(line)) continue; // nested list item / block scalar body
    if (/^-\s/.test(line)) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    let value = line.slice(i + 1).trim();
    if (value === '') {
      // Could be a block list, a nested map, or a block scalar — collect items
      // optimistically and fall back to '' (the previous behaviour).
      listKey = key;
      lists[key] = [];
      data[key] = '';
      continue;
    }
    listKey = null;
    if (value === '|' || value === '>' || /^[|>][-+]?$/.test(value)) value = ''; // block scalar: not needed
    data[key] = unquoteYaml(value);
  }
  for (const [key, items] of Object.entries(lists)) {
    if (items.length) data[key] = items;
  }
  return { data, body: raw.slice(m[0].length), lists };
}

/**
 * Frontmatter field → string array, tolerating every form GSD uses:
 * block lists, flow lists (`[Read, Write]`), and comma-separated scalars.
 */
function frontmatterList(data, lists, key) {
  const block = lists && lists[key];
  if (Array.isArray(block) && block.length) return block.map((v) => String(v).trim()).filter(Boolean);
  const value = data ? data[key] : undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value == null ? '' : value)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^-\s*/, ''))
    .filter(Boolean);
}

function buildFrontmatter(description, argumentHint) {
  const lines = ['---', `description: ${yamlQuote(description || 'GSD command')}`];
  if (argumentHint) lines.push(`argument-hint: ${yamlQuote(argumentHint)}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent frontmatter → pi-subagents metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claude tool name → pi builtin tool name.
 *
 * Only pi *builtins* belong in a generated allowlist. pi's SDK `tools` option
 * filters builtins only, so a name the host does not provide is dropped at launch
 * (a non-fatal warning) — and a list that filters down to nothing leaves the
 * child session with no tools at all. Extension tools (pi-web-access, MCP) stay
 * available to the child regardless, because their providers are loaded by the
 * child session itself.
 */
const AGENT_TOOL_MAP = Object.freeze({
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'find', // pi's glob-style search tool is `find`
  ls: 'ls',
});

/**
 * Extension packages → the tool names they register at runtime.
 *
 * Corrects the assumption above. A generated `tools:` allowlist is *strict*:
 * an extension tool whose name is absent from it never reaches the child, even
 * though the child did load the extension. Background (async) children were the
 * common case — they load ambient extensions, yet every extension tool stayed
 * invisible unless its name was listed. Measured on this repo: across 19 GSD
 * phase-5 subagent runs (845 bash calls, 0 codegraph calls), not one extension
 * tool was ever invoked.
 *
 * Packages absent from the host contribute nothing, so an install without them
 * keeps exactly the allowlist it had before.
 */
const HOST_EXTENSION_TOOLS = Object.freeze({
  '@izhimu/pi-codegraph': ['codegraph_explore'],
  '@ff-labs/pi-fff': ['ffgrep', 'fffind', 'fff-multi-grep'],
  'pi-hashline-edit-pro': ['anchor_grep', 'replace', 'insert', 'undo_last_change'],
});

/** MCP server → human name for the fallback note written into the agent prompt. */
const MCP_SERVER_LABELS = Object.freeze({
  'plugin_context7_context7': 'Context7',
  context7: 'Context7',
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  tavily: 'Tavily',
  ref: 'Ref',
  jina: 'Jina',
  perplexity: 'Perplexity',
  'chrome-devtools': 'Chrome DevTools',
  'claude-in-chrome': 'Claude in Chrome',
});

/**
 * Map a GSD agent's `tools:` value onto pi's tool surface.
 *
 * Tools that exist in pi are mapped; `Agent`/`AskUserQuestion` become pi's
 * coordination tools; everything else is dropped and reported as a capability so
 * the generated prompt can tell the child what to do instead.
 *
 * @returns {{ tools: string[], caps: object }}
 */
function mapAgentTools(data, lists, extensionTools) {
  const caps = { nested: false, asks: false, skill: false, web: false, mcp: [], unknown: [], dropped: [] };
  const tools = [];
  const push = (tool) => {
    if (tool && !tools.includes(tool)) tools.push(tool);
  };
  for (const raw of frontmatterList(data, lists, 'tools')) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (AGENT_TOOL_MAP[lower]) {
      push(AGENT_TOOL_MAP[lower]);
      continue;
    }
    const mcp = /^mcp__(.+?)__(.+)$/.exec(lower);
    if (mcp) {
      if (!caps.mcp.includes(mcp[1])) caps.mcp.push(mcp[1]);
      continue;
    }
    if (lower === 'agent' || lower === 'task') {
      // Claude's nested-spawn tool → pi-subagents' `subagent`.
      caps.nested = true;
      push('subagent');
      continue;
    }
    if (lower === 'askuserquestion') {
      caps.asks = true;
      push('contact_supervisor');
      continue;
    }
    if (lower === 'skill') {
      caps.skill = true;
      continue;
    }
    if (lower === 'websearch' || lower === 'webfetch') {
      caps.web = true;
      continue;
    }
    if (lower === 'multiedit' || lower === 'notebookedit' || lower === 'todowrite') {
      caps.dropped.push(name); // no pi equivalent; harmless, so no note
      continue;
    }
    caps.unknown.push(name);
  }
  caps.dropped = [...new Set(caps.dropped)];
  caps.unknown = [...new Set(caps.unknown)];
  // Extension tools the host actually provides. A declared allowlist is strict,
  // so without this every extension tool stays invisible to the child even
  // though the child loaded the extension (measured: 0 uses in 19 runs).
  // Adding them can never empty the allowlist, so the failure mode the map
  // guards against — a list that filters down to nothing — cannot happen.
  for (const tool of Array.isArray(extensionTools) ? extensionTools : []) push(tool);
  return { tools, caps };
}

/** `disallowedTools:` → pi-subagents `excludeTools:` (same name mapping). */
function mapAgentDisallowed(data, lists) {
  const out = [];
  for (const raw of frontmatterList(data, lists, 'disallowedTools')) {
    const mapped = AGENT_TOOL_MAP[raw.trim().toLowerCase()];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** pi-subagents thinking levels; GSD's `effort:` values are a subset. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * GSD `effort:` → pi-subagents `thinking:`.
 * An unrecognised level is dropped rather than emitted: pi-subagents silently
 * ignores values outside its level set, so passing it through would only hide the
 * mismatch from the sync report.
 */
function mapAgentEffort(rawEffort) {
  const level = String(rawEffort == null ? '' : rawEffort)
    .trim()
    .toLowerCase();
  return THINKING_LEVELS.includes(level) ? level : null;
}

/**
 * Render the generated agent's frontmatter.
 * @returns {string} YAML frontmatter block, including the trailing newline
 */
function buildAgentFrontmatter({ name, description, tools, excludeTools, thinking, nested, inheritSkills }) {
  const lines = ['---', `name: ${yamlQuote(name)}`, `description: ${yamlQuote(description)}`];
  // An empty `tools:` would mean "no tools at all", not "default tools".
  if (tools.length) lines.push(`tools: ${tools.join(', ')}`);
  if (excludeTools.length) lines.push(`excludeTools: ${excludeTools.join(', ')}`);
  if (thinking) lines.push(`thinking: ${thinking}`);
  if (nested) lines.push('allowNestedSubagents: true');
  if (inheritSkills) lines.push('inheritSkills: true');
  // Custom agents drop repository instructions by default; GSD's agents are repo
  // workers that assume they see the project's conventions.
  lines.push('inheritProjectContext: true');
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Command reference / shell-token handling
// ─────────────────────────────────────────────────────────────────────────────

// `@path.md` style includes. Deliberately conservative: only path-shaped tokens
// ending in `.md` (so `@opengsd/gsd-core@latest` and `@gsd-core/references/<FILE>.md`
// placeholders are never touched) and only if they resolve inside the GSD tree.
const REF_RE = /@((?:~\/|\$HOME\/|\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s)`,;:'"<>\]}]*?\.md)/g;

/** `~/x`, `$HOME/x`, `/abs/x` and `.claude/gsd-core/…` → absolute path in the pi GSD tree. */
function resolveCoreRef(ref, baseDir, ctx) {
  const expanded = expandHome(ref);
  const gsdCore = /(?:^|\/)gsd-core\/(.+)$/.exec(expanded);
  if (gsdCore) {
    const abs = path.join(ctx.coreRoot, gsdCore[1]);
    return isFile(abs) ? abs : null;
  }
  if (path.isAbsolute(expanded)) return null;
  const bases = [baseDir, ctx.engineRoot, ctx.coreRoot];
  for (const b of bases) {
    if (!b) continue;
    const abs = path.join(b, expanded);
    if (!isFile(abs)) continue;
    const rel = path.relative(ctx.coreRoot, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
  }
  return null;
}

/**
 * Make a template body immune to pi's `substituteArgs()` rewrites.
 *
 * pi replaces `$1`, `$@`, `$ARGUMENTS`, `${1:-x}`, `${@:1:2}` … in the template
 * string. GSD's shell shims contain bash positionals, which must survive:
 *   `"$@"`      → `"${@}"`      (identical bash)
 *   `$1`        → `${1}`        (identical bash)
 *   `${1:-DEF}` → `${1-DEF}`    (differs only when $1 is set-but-empty)
 * `$ARGUMENTS` is intentionally left alone: it means the same thing in pi.
 * @returns {{ text: string, count: number }}
 */
function protectShellPositionals(text) {
  let count = 0;
  const out = String(text)
    .replace(/\$\{([0-9]+):-([^}]*)\}/g, (_m, num, def) => {
      count += 1;
      return `\${${num}-${def}}`;
    })
    .replace(/\$@/g, () => {
      count += 1;
      return '${@}';
    })
    .replace(/\$([0-9]+)/g, (_m, num) => {
      count += 1;
      return `\${${num}}`;
    });
  return { text: out, count };
}

/**
 * GSD ships runtime-specific question notes for hosts whose interactive-question
 * tool differs (currently Copilot's `vscode_askquestions`). Neither that tool nor
 * `AskUserQuestion` exists in pi, so those notes are replaced with the pi
 * equivalent: ask in chat with a plain-text numbered list. Blocks that do not
 * mention another runtime are left untouched.
 * @returns {{ text: string, count: number }}
 */
function rewriteRuntimeNotes(text) {
  let count = 0;
  const out = String(text).replace(/<runtime_note>[\s\S]*?<\/runtime_note>/gi, (block) => {
    if (!/vscode_askquestions|Copilot|\(VS Code\)/i.test(block)) return block;
    count += 1;
    return (
      '<runtime_note>\n' +
      '**pi:** `AskUserQuestion` and `vscode_askquestions` do not exist in pi. Wherever this workflow ' +
      '(or any file it has you read) calls `AskUserQuestion`, ask the user directly in the chat with a ' +
      'plain-text numbered list of options and wait for their reply.\n' +
      '</runtime_note>'
    );
  });
  return { text: out, count };
}

/**
 * Point other-runtime GSD paths at the pi equivalents.
 *
 * GSD's own installer performs exactly this rewrite for pi: the pi tree contains
 * 113 `${CLAUDE_CONFIG_DIR:-$HOME/.pi/agent}` shims and zero `~/.claude/gsd-core`
 * references. The command definitions still carry the Claude form, which matters
 * in practice — GSD's `gsd_run` shim searches those paths for `gsd-tools.cjs`, and
 * without the rewrite a pi session in a project with no local `gsd-core/` would
 * find no engine at all.
 *
 * The same applies to the two paths GSD's text uses for skills and MCP config
 * (`.claude/skills/` in 32 files, `~/.claude/mcp.json`): on pi those are
 * `.pi/skills/` + `<agentDir>/skills/` and `.pi/mcp.json` + `<agentDir>/mcp.json`,
 * and a child following GSD's literal text would otherwise look in a Claude
 * directory and find nothing.
 *
 * @returns {{ text: string, count: number }}
 */
function normalizeRuntimePaths(text, ctx) {
  if (!ctx.coreRoot) return { text: String(text), count: 0 };
  const homeDir = ctx.agentDir || path.dirname(ctx.coreRoot);
  let count = 0;
  const bump = (replacement) => {
    count += 1;
    return replacement;
  };
  const out = String(text)
    .replace(/\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/g, () => bump(`\${CLAUDE_CONFIG_DIR:-${homeDir}}`))
    .replace(/\$\{HOME\}\/\.claude\/gsd-core/g, () => bump(ctx.coreRoot))
    .replace(/\$HOME\/\.claude\/gsd-core/g, () => bump(ctx.coreRoot))
    .replace(/~\/\.claude\/gsd-core/g, () => bump(ctx.coreRoot))
    .replace(/\$\{HOME\}\/\.claude\/skills/g, () => bump(`${homeDir}/skills`))
    .replace(/\$HOME\/\.claude\/skills/g, () => bump(`${homeDir}/skills`))
    .replace(/~\/\.claude\/skills/g, () => bump(`${homeDir}/skills`))
    .replace(/\$\{HOME\}\/\.claude\/mcp\.json/g, () => bump(`${homeDir}/mcp.json`))
    .replace(/\$HOME\/\.claude\/mcp\.json/g, () => bump(`${homeDir}/mcp.json`))
    .replace(/~\/\.claude\/mcp\.json/g, () => bump(`${homeDir}/mcp.json`))
    // Project-relative skill root. The lookbehind keeps absolute non-home paths
    // (a genuine Claude install elsewhere) and `my.claude/…` untouched.
    .replace(/(?<![\w./~-])\.claude\/skills/g, () => bump('.pi/skills'));
  return { text: out, count };
}
function buildColonPattern(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9_-])gsd:(${sorted.join('|')})(?=[^A-Za-z0-9_-]|$)`, 'g');
}

/** `/gsd:<cmd>` → `/gsd-<cmd>` (GSD's canonical pi form). */
function normalizeColonCommands(text, names, pattern) {
  const p = pattern || buildColonPattern(names);
  if (!p) return { text, count: 0 };
  let count = 0;
  const out = text.replace(p, (_m, cmd) => {
    count += 1;
    return `gsd-${cmd}`;
  });
  return { text: out, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inlining
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively expand `@…md` includes from the pi GSD tree.
 * @returns {{ text: string, bytes: number, files: string[], truncated: string[] }}
 */
function inlineContext(text, { baseDir, ctx, seen, depth = 0, acc }) {
  const state = acc || { bytes: 0, files: [], truncated: [] };
  const out = String(text).replace(REF_RE, (match, ref) => {
    const abs = resolveCoreRef(ref, baseDir, ctx);
    if (!abs) return match;
    const rel = relativeTo(ctx.coreRoot, abs);
    if (seen.has(abs)) return `[gsd context already inlined above: ${rel}]`;
    if (depth >= MAX_INLINE_DEPTH) {
      state.truncated.push(rel);
      return `[gsd context depth limit reached — read this file directly: ${abs}]`;
    }
    seen.add(abs);
    const raw = readIfExists(abs);
    if (raw == null) return match;
    const body = parseFrontmatter(raw).body;
    state.bytes += Buffer.byteLength(body, 'utf8');
    state.files.push(rel);
    const inner = inlineContext(body, { baseDir: path.dirname(abs), ctx, seen, depth: depth + 1, acc: state });
    return `\n<!-- gsd-context:begin ${rel} -->\n${inner.text}\n<!-- gsd-context:end ${rel} -->\n`;
  });
  return { text: out, bytes: state.bytes, files: state.files, truncated: state.truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The parent-side contract that turns GSD's spawn steps into pi-subagents calls.
 *
 * GSD's workflows are written for Claude Code's `Agent` tool, and GSD's own
 * dispatch resolver (`gsd_run query resolve-dispatch-type`) answers for a runtime
 * whose descriptor says named dispatch is unavailable — on pi it replies
 * `coder`/`explore`/`plan`, which are another runtime's built-ins and do not
 * exist here. Without this block a session either follows that answer into a
 * failed spawn or quietly skips the delegation.
 *
 * @returns {string[]} lines to append after the runtime contract
 */
function subagentDispatchBlock(agents) {
  const core = [];
  core.push(`<gsd_subagent_dispatch agents="${agents.names.length}" dir="${agents.dir}">`);
  core.push(
    'GSD\u2019s agent definitions are installed as pi-subagents agents, so GSD\u2019s spawn steps must be translated:',
  );
  core.push(
    '  \u2022 `Agent(subagent_type="gsd-planner", model="\u2026", prompt="\u2026")` \u2192 ' +
      '`subagent({ agent: "gsd-planner", task: "\u2026" })`',
  );
  core.push('  \u2022 `run_in_background: false` \u2192 `async: false` (block and wait for the result); `true` or absent \u2192 leave `async` off (background is the default).');
  core.push(
    '  \u2022 `model="{PLANNER_MODEL}"` and friends are unresolved placeholders here \u2014 omit `model` so the agent\u2019s ' +
      'own default applies, or pass an exact `provider/id` copied from `subagent({action:"models"})`.',
  );
  core.push('  \u2022 `subagent_type="general-purpose"` \u2192 `agent: "delegate"`.');
  core.push(
    '  \u2022 `TaskOutput` and any "wait for the subagent" step \u2192 `subagent({action:"status", id})` ' +
      '(an agent id is not a task id, which is why GSD warns about this); a background child also wakes you when it finishes.',
  );
  core.push(
    '  \u2022 Several spawns in one step \u2192 one `subagent({ workflowScript })` call with ' +
      '`const [a, b] = await runs.all([{ key, agent, task }, \u2026])` and an explicit `return`.',
  );
  core.push(
    '  \u2022 Ignore what `gsd_run query resolve-dispatch-type` answers on pi: it maps every role to ' +
      '`coder`/`explore`/`plan`, which do not exist in pi. Dispatch the `gsd-*` role name itself.',
  );
  core.push(
    '  \u2022 Spawn agents that need web or MCP lookups as background children: a foreground child ' +
      '(`async: false`) does not load the installed pi extension packages. Use `async: false` only where GSD ' +
      'explicitly requires a blocking spawn (its debug session manager).',
  );
  core.push(`  \u2022 Installed roles: ${agents.names.map((n) => `\`${n}\``).join(', ')}.`);
  core.push(
    '  \u2022 Confirm a role with `subagent({action:"list", capabilities:true})`, and give a spawned agent the same ' +
      'task text GSD\u2019s `prompt` would have used.',
  );
  core.push(
    '  \u2022 If a spawn genuinely cannot run, do that step yourself in this session \u2014 never skip it.',
  );
  core.push('</gsd_subagent_dispatch>');
  return core;
}

function runtimeContract({ name, description, argumentHint, data, ctx, mode, refs, maxInlineKb }) {
  const coreRoot = ctx.coreRoot;
  const toolsPath = coreRoot ? path.join(coreRoot, 'bin', 'gsd-tools.cjs') : null;
  const agents = ctx.agents || { enabled: false, names: [], dir: '' };
  const lines = [];
  lines.push(`<gsd_command name="/gsd-${name}" source="gsd:${name}" gsd_core="${ctx.version}" runtime="pi" mode="${mode}">`);
  lines.push('<runtime_contract>');
  lines.push(
    `You are executing the GSD Core command \`gsd:${name}\` inside pi (pi.dev). ` +
      `This prompt is a generated conversion of GSD's own command definition, not a rewrite: follow GSD's process.`,
  );
  lines.push('');
  let step = 0;
  const item = (text) => {
    step += 1;
    lines.push(`${step}. ${text}`);
  };
  if (mode === 'reference' && refs.length > 0) {
    item(
      'FIRST, before any other action, read every file listed under <execution_context_must_read> ' +
        'with the `read` tool, in order and in full. Those files ARE this command\u2019s operating procedure.',
    );
  } else if (mode === 'inline') {
    item('The complete GSD workflow and its context files are inlined below — treat them as the procedure.');
  } else {
    item('Follow the procedure below. Read any project file it names before relying on it.');
  }
  item(
    'Slash commands in pi use the hyphen form: `/gsd-<name>` (e.g. `/gsd-execute-phase`). ' +
      'Wherever GSD text says `/gsd:<name>`, run `/gsd-<name>`. ' +
      'The `/gsd` hub command and the `gsd_invoke` tool dispatch to the same engine.',
  );
  item(
    'Skills: where GSD says to invoke a skill (`/skill:<name>` in pi, e.g. `/skill:gsd-map-codebase`), ' +
      'use it if it is installed; otherwise run the matching `/gsd-<command>` template instead — never skip the step.',
  );
  item(
    '`AskUserQuestion` does not exist in pi. Ask the user directly in the chat with a plain-text ' +
      'numbered list of options and wait for the answer. With `--text` (or `workflow.text_mode: true`), ' +
      'always use plain-text numbered lists.',
  );
  if (agents.enabled && agents.names.length) {
    item(
      'Subagents: every GSD role agent is installed for pi-subagents. GSD writes its spawn steps in Claude Code\u2019s ' +
        '`Agent(...)` form and GSD\u2019s own dispatch query answers for a different runtime — <gsd_subagent_dispatch> ' +
        'below has the translation and the rules.',
    );
  } else {
    item(
      'Subagents: where GSD says to spawn an agent (e.g. `gsd-planner`, `gsd-executor`), use pi\u2019s ' +
        'subagent tooling if that agent is registered; otherwise do that step inline yourself rather than skipping it.',
    );
  }
  if (toolsPath) {
    item(
      `GSD core for this runtime: \`${coreRoot}\` — CLI: \`node ${toolsPath} <family> <subcommand> [args]\` ` +
        "(GSD's workflows define a `gsd_run` shell shim that resolves this automatically).",
    );
  }
  item(
    'Every literal `$ARGUMENTS` (or `$@`) you meet inside files you read afterwards stands for the ' +
      'user-arguments block below — pi substitutes it here only, never in files read later.',
  );
  const extra = [];
  if (data.effort) extra.push(`GSD requests effort: ${data.effort} (use the deepest reasoning level available).`);
  if (data.requires) {
    const list = String(data.requires)
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `\`/gsd-${s}\``);
    if (list.length) extra.push(`Related commands GSD pairs with this one: ${list.join(', ')}.`);
  }
  if (maxInlineKb > 0 && mode === 'inline') extra.push(`Inline context budget: ${maxInlineKb} KB per command.`);
  if (extra.length) {
    lines.push('');
    lines.push(...extra);
  }
  lines.push('</runtime_contract>');
  if (agents.enabled && agents.names.length) {
    lines.push('');
    lines.push(...subagentDispatchBlock(agents));
  }
  lines.push('');
  lines.push(`<user_arguments>$ARGUMENTS</user_arguments>`);
  lines.push('');
  lines.push(`<command_description>${description || ''}</command_description>`);
  if (argumentHint) lines.push(`<argument_hint>${argumentHint}</argument_hint>`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Convert one GSD command definition into a pi prompt template.
 * @returns {{ content: string, mode: string, inlinedBytes: number, inlinedFiles: string[], refs: string[], notes: string[] }}
 */
function convertCommand(raw, name, ctx) {
  const { data, body } = parseFrontmatter(raw);
  const description = data.description || '';
  const argumentHint = data['argument-hint'] || '';
  const rosterPattern = ctx.rosterPattern;

  // Collect the execution-context references (before any rewriting).
  const refs = [];
  {
    const re = new RegExp(REF_RE.source, 'g');
    let m;
    while ((m = re.exec(body)) !== null) {
      const abs = resolveCoreRef(m[1], ctx.srcDir, ctx);
      if (abs && !refs.includes(abs)) refs.push(abs);
    }
  }

  const notes = [];
  let mode = ctx.mode;
  let inlined = { text: '', bytes: 0, files: [], truncated: [] };

  if (mode === 'inline' && refs.length > 0) {
    inlined = inlineContext(body, { baseDir: ctx.srcDir, ctx, seen: new Set(), depth: 0 });
    if (ctx.maxInlineKb > 0 && inlined.bytes / 1024 > ctx.maxInlineKb) {
      notes.push(
        `inline context ${(inlined.bytes / 1024).toFixed(1)}KB exceeds maxInlineKb=${ctx.maxInlineKb} — used reference mode`,
      );
      mode = 'reference';
      inlined = { text: '', bytes: 0, files: [], truncated: [] };
    }
  }

  // Strip the original <execution_context> block; it is re-emitted below in the
  // shape this runtime needs.
  let bodyOut = body.replace(/<execution_context>[\s\S]*?<\/execution_context>/i, '').trim();
  const runtimeNotes = rewriteRuntimeNotes(bodyOut);
  bodyOut = runtimeNotes.text;
  if (runtimeNotes.count) notes.push(`rewrote ${runtimeNotes.count} runtime-specific question note(s) for pi`);

  const paths = normalizeRuntimePaths(bodyOut, ctx);
  bodyOut = paths.text;
  if (paths.count) notes.push(`pointed ${paths.count} runtime path reference(s) at the pi GSD tree`);

  const colon = normalizeColonCommands(bodyOut, ctx.roster, rosterPattern);
  bodyOut = colon.text;
  if (colon.count) notes.push(`normalized ${colon.count} /gsd:<cmd> reference(s) to /gsd-<cmd>`);

  const shell = protectShellPositionals(bodyOut);
  bodyOut = shell.text;
  if (shell.count) notes.push(`protected ${shell.count} shell positional token(s) from pi substitution`);

  let contextBlock = '';
  if (mode === 'inline' && inlined.text) {
    const pathsIn = normalizeRuntimePaths(inlined.text, ctx);
    const colonIn = normalizeColonCommands(pathsIn.text, ctx.roster, rosterPattern);
    const shellIn = protectShellPositionals(colonIn.text);
    if (pathsIn.count) notes.push(`pointed ${pathsIn.count} runtime path reference(s) in inlined context at the pi GSD tree`);
    if (colonIn.count) notes.push(`normalized ${colonIn.count} /gsd:<cmd> reference(s) in inlined context`);
    if (shellIn.count) notes.push(`protected ${shellIn.count} shell token(s) in inlined context`);
    contextBlock =
      '<execution_context>\n' +
      'The following files were expanded from GSD Core (Claude-Code-equivalent).\n' +
      shellIn.text.trim() +
      '\n</execution_context>\n';
  } else if (refs.length > 0) {
    contextBlock =
      '<execution_context_must_read>\n' +
      'Read these files now, in order, in full — they are this command\u2019s procedure:\n' +
      refs.map((abs, i) => `${i + 1}. ${abs}`).join('\n') +
      '\n</execution_context_must_read>\n';
  }

  const content =
    buildFrontmatter(description, argumentHint) +
    // Deliberately timestamp-free: the generated bytes must be a pure function of
    // the source so that re-running the sync is a no-op (the sync time lives in
    // the state file instead).
    `${MARKER_PREFIX} v${GENERATOR_VERSION} · GSD Core ${ctx.version} · do not edit — run /gsd-sync -->\n` +
    runtimeContract({ name, description, argumentHint, data, ctx, mode, refs, maxInlineKb: ctx.maxInlineKb }) +
    (contextBlock ? `\n${contextBlock}` : '') +
    `\n${bodyOut.trim()}\n`;

  return {
    content,
    mode,
    inlinedBytes: inlined.bytes,
    inlinedFiles: inlined.files,
    refs: refs.map((abs) => relativeTo(ctx.coreRoot || ctx.srcDir, abs)),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The runtime contract prepended to every generated agent prompt.
 *
 * A subagent's system prompt is handed to the child session as-is (pi-subagents
 * does not run prompt-template substitution on it), so everything the child needs
 * to adapt GSD's Claude-Code assumptions has to be stated here — and anything
 * without a pi tool is named here rather than in the frontmatter, where a tool
 * that cannot resolve would be dropped or, for `mcp:` selectors, abort the spawn.
 */
function agentRuntimeContract({ name, ctx, mode, refs }) {
  const coreRoot = ctx.coreRoot;
  const toolsPath = coreRoot ? path.join(coreRoot, 'bin', 'gsd-tools.cjs') : null;
  const caps = ctx.caps || {};
  const lines = [];
  lines.push(`<pi_runtime_contract agent="${name}" runtime="pi" mode="${mode}" gsd_core="${ctx.version}">`);
  lines.push(
    'You are a pi (pi.dev) subagent session running one of GSD Core\u2019s agent definitions. ' +
      'The persona below is GSD\u2019s own text, converted for pi — follow its process, gates, and output contract.',
  );
  lines.push('');
  let step = 0;
  const item = (text) => {
    step += 1;
    lines.push(`${step}. ${text}`);
  };
  if (mode === 'reference' && refs.length > 0) {
    item(
      'FIRST, before you act, read every file listed under <gsd_must_read> with the `read` tool, in full. ' +
        'They are part of this agent\u2019s GSD definition, and GSD text that points at them assumes their contents are in front of you.',
    );
  } else if (mode === 'inline' && refs.length > 0) {
    item('The files this agent references are inlined below — treat them as part of your instructions.');
  }
  item(
    'Slash commands in pi use the hyphen form: `/gsd-<name>`. Wherever GSD text says `/gsd:<name>`, use `/gsd-<name>`.',
  );
  if (toolsPath) {
    item(
      `GSD core for this runtime: \`${coreRoot}\` — CLI: \`node ${toolsPath} <family> <subcommand> [args]\` ` +
        "(GSD's workflows define a `gsd_run` shell shim that resolves this automatically).",
    );
  }
  item(
    '`$ARGUMENTS` or `$@` in any GSD text you read means the task the orchestrator handed you — it is literal here, ' +
      'never substituted.',
  );
  if (caps.skill) {
    item(
      '`Skill` is not a tool in pi: where GSD tells you to invoke a skill, read that skill\u2019s `SKILL.md` yourself ' +
        '(project skills live in `.pi/skills/` and `.agents/skills/`) or follow the matching `/gsd-<command>` workflow instead.',
    );
  }
  if (caps.asks) {
    item(
      '`AskUserQuestion` does not exist in pi. When you would ask the user, call `contact_supervisor` with ' +
        '`reason: "need_decision"` — the orchestrator relays it and replies with the answer. If that tool is not ' +
        'available in this session, put the question in your final report and continue with the safest ' +
        'assumption rather than waiting.',
    );
  }
  if (caps.web || caps.mcp.length > 0) {
    // Server names are deduped by label: GSD lists Context7 under two spellings.
    const wanted = [
      ...(caps.web ? ['web search / page fetching'] : []),
      ...new Set(caps.mcp.map((server) => MCP_SERVER_LABELS[server] || server)),
    ];
    item(
      `This agent asks for ${wanted.join(', ')}, which GSD reaches through MCP or host search tools. pi has no MCP ` +
        'server wired to this agent: use the installed pi web tools (`web_search`, `fetch_content`, ' +
        '`get_search_content`) when they are present in the session, and GSD\u2019s own CLI fallback otherwise ' +
        '(for Context7: `ctx7 library <name> "<query>"` / `ctx7 docs <libraryId> "<query>"`, never `npx --yes ctx7@latest`). ' +
        'Those tools only exist in background child sessions, so if a lookup tool is missing, say so in your report ' +
        'instead of stalling.',
    );
  }
  if (caps.nested) {
    item(
      'You may spawn further subagents with `subagent({ agent, task })` using the GSD roles you need ' +
        '(for example `gsd-debugger`), and collect their results before you finish.',
    );
  }
  if (caps.unknown.length) {
    item(`Tools GSD grants this agent that pi has no equivalent for (do not wait for them): ${caps.unknown.join(', ')}.`);
  }
  item(
    'Your final message is the only thing the orchestrator receives: report the files you wrote, the evidence you ' +
      'produced, and any open question — keep it short and concrete.',
  );
  lines.push('</pi_runtime_contract>');
  lines.push('');
  return lines.join('\n');
}

/**
 * Convert one GSD agent definition into a pi-subagents agent definition.
 *
 * Mirrors `convertCommand`, except that shell-token protection is deliberately
 * skipped: an agent body becomes a session system prompt, which pi never runs
 * through `substituteArgs`, so rewriting `"$@"` would only make the child's copy
 * differ from GSD's.
 *
 * @returns {{ content: string, mode: string, refs: string[], caps: object, notes: string[] }}
 */
function convertAgent(raw, name, ctx) {
  const { data, body, lists } = parseFrontmatter(raw);
  const description = String(data.description || '').trim() || `GSD ${name} agent`;
  const { tools, caps } = mapAgentTools(data, lists, ctx.extensionTools);
  // Several agents dispatch or load skills without ever declaring the Claude
  // `Skill` tool (`gsd-debug-session-manager` maps a hint to a skill to invoke,
  // `gsd-intel-updater` walks project `skills/` directories). They still need pi's
  // skills catalogue to work the same way.
  if (!caps.skill && /(\/skill:|\bskill\(|skills?\/|SKILL\.md|skill to invoke)/i.test(body)) caps.skill = true;
  const excludeTools = mapAgentDisallowed(data, lists);
  const thinking = mapAgentEffort(data.effort);
  const rosterPattern = ctx.rosterPattern;
  const notes = [];

  // Collect the referenced files before any rewriting, exactly as the command
  // converter does. Refs that do not resolve inside the GSD tree (project files
  // like `.planning/PROJECT.md`) stay untouched on purpose. Keyed by resolved
  // path as well as by raw text: the same file is often referenced twice, once as
  // `@~/.claude/…` and once as `@gsd-core/…`.
  const refMap = new Map(); // raw ref → resolved absolute path
  const refs = [];
  {
    const re = new RegExp(REF_RE.source, 'g');
    let m;
    while ((m = re.exec(body)) !== null) {
      const abs = resolveCoreRef(m[1], ctx.srcDir, ctx);
      if (!abs) continue;
      refMap.set(m[1], abs);
      if (!refs.includes(abs)) refs.push(abs);
    }
  }

  let mode = ctx.mode;
  let inlined = { text: '', bytes: 0, files: [], truncated: [] };
  if (mode === 'inline' && refs.length > 0) {
    inlined = inlineContext(body, { baseDir: ctx.srcDir, ctx, seen: new Set(), depth: 0 });
    if (ctx.maxInlineKb > 0 && inlined.bytes / 1024 > ctx.maxInlineKb) {
      notes.push(
        `inline context ${(inlined.bytes / 1024).toFixed(1)}KB exceeds maxInlineKb=${ctx.maxInlineKb} — used reference mode`,
      );
      mode = 'reference';
      inlined = { text: '', bytes: 0, files: [], truncated: [] };
    }
  }

  let bodyOut;
  if (mode === 'inline' && inlined.text) {
    bodyOut = inlined.text;
  } else {
    // Reference mode: the include becomes the absolute path in the pi GSD tree
    // (pi has no `@file` expansion), and the must-read list below names them all.
    bodyOut = body.replace(new RegExp(REF_RE.source, 'g'), (match, ref) => refMap.get(ref) || match);
  }

  const runtimeNotes = rewriteRuntimeNotes(bodyOut);
  bodyOut = runtimeNotes.text;
  if (runtimeNotes.count) notes.push(`rewrote ${runtimeNotes.count} runtime-specific question note(s) for pi`);

  const paths = normalizeRuntimePaths(bodyOut, ctx);
  bodyOut = paths.text;
  if (paths.count) notes.push(`pointed ${paths.count} runtime path reference(s) at the pi GSD tree`);

  const colon = normalizeColonCommands(bodyOut, ctx.roster, rosterPattern);
  bodyOut = colon.text;
  if (colon.count) notes.push(`normalized ${colon.count} /gsd:<cmd> reference(s) to /gsd-<cmd>`);

  if (caps.dropped.length) notes.push(`dropped tool(s) with no pi equivalent: ${caps.dropped.join(', ')}`);
  if (caps.unknown.length) notes.push(`unknown tool(s) kept out of the allowlist: ${caps.unknown.join(', ')}`);
  if (data.effort && !thinking) notes.push(`effort "${data.effort}" is not a pi thinking level — dropped`);

  const mustRead =
    mode === 'reference' && refs.length
      ? '<gsd_must_read>\n' +
        'Read these files now, in full — they are part of this agent\u2019s GSD definition:\n' +
        refs.map((abs, i) => `${i + 1}. ${abs}`).join('\n') +
        '\n</gsd_must_read>\n'
      : '';

  const content =
    buildAgentFrontmatter({
      name,
      description,
      tools,
      excludeTools,
      thinking,
      nested: caps.nested,
      inheritSkills: caps.skill,
    }) +
    // Deliberately timestamp-free: the generated bytes must be a pure function of
    // the source so that re-running the sync is a no-op (the sync time lives in
    // the state file instead).
    `${MARKER_PREFIX} v${GENERATOR_VERSION} · GSD Core ${ctx.version} · do not edit — run /gsd-sync -->\n` +
    agentRuntimeContract({ name, ctx: { ...ctx, caps }, mode, refs }) +
    (mustRead ? `\n${mustRead}` : '') +
    `\n${bodyOut.trim()}\n`;

  return {
    content,
    mode,
    caps,
    tools,
    excludeTools,
    thinking,
    inlinedBytes: inlined.bytes,
    inlinedFiles: inlined.files,
    refs: refs.map((abs) => relativeTo(ctx.coreRoot || ctx.srcDir, abs)),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync
// ─────────────────────────────────────────────────────────────────────────────

function computeFingerprint(parts) {
  return sha256(JSON.stringify(parts));
}

function readState(statePath) {
  const raw = readIfExists(statePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeFileAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Convert GSD's agent definitions into pi-subagents agent definitions and
 * reconcile the output directory.
 *
 * Same ownership rule as the command templates: the generated files are named
 * here, recorded in the agents state file, and carry a generator marker; a file
 * that is neither is left alone, and a file this plugin would overwrite but does
 * not own is reported instead of clobbered.
 *
 * @returns {void} mutates `report.agents`
 */
function syncAgents(opts, ctx, source, agentSource, report) {
  const out = report.agents;
  const statePath = path.join(opts.agentsOut, AGENTS_STATE_FILE);
  // Detected once per run so every generated allowlist carries the same set;
  // an install without these packages yields `[]` and no allowlist changes.
  const extensionTools = detectHostExtensionTools(opts.agentDir);
  const agentCtx = extensionTools.length > 0 ? { ...ctx, extensionTools } : ctx;
  if (extensionTools.length > 0) out.extensionTools = extensionTools;

  if (path.resolve(opts.agentsOut) === path.resolve(opts.outDir)) {
    out.errors.push(
      `agent output ${opts.agentsOut} is the same directory as the command output — refusing to mix ` +
        'prompt templates and agent definitions (use --agents-out)',
    );
    return;
  }
  if (agentSource.valid.length < MIN_SOURCE_AGENTS && !opts.force) {
    out.errors.push(
      `agent source ${agentSource.dir} exposes only ${agentSource.valid.length} agent(s) (min ${MIN_SOURCE_AGENTS}); ` +
        'refusing to regenerate — re-run with --force to override',
    );
    return;
  }

  const previous = readState(statePath);
  const previousFiles = (previous && previous.files) || {};
  const fingerprintParts = {
    generator: `${GENERATOR}@${GENERATOR_VERSION}`,
    kind: 'agents',
    mode: opts.mode,
    maxInlineKb: opts.maxInlineKb,
    source: agentSource.dir,
    // Installing or removing an extension changes every generated allowlist, so
    // it must change the fingerprint too — otherwise a sync would report "no
    // changes" while the on-disk allowlists are stale.
    extensionTools,
    coreRoot: ctx.coreRoot,
    version: ctx.version,
    agents: [],
  };
  const outputs = [];
  for (const fileName of agentSource.valid) {
    const name = fileName.replace(/\.md$/, '');
    const raw = readIfExists(path.join(agentSource.dir, fileName));
    if (raw == null) {
      out.warnings.push(`unreadable: ${fileName}`);
      continue;
    }
    fingerprintParts.agents.push([name, sha256(raw)]);
    try {
      const converted = convertAgent(raw, name, { ...agentCtx, srcDir: agentSource.dir });
      outputs.push({ outName: `${name}.md`, name, content: converted.content, info: converted });
    } catch (err) {
      out.errors.push(`convert ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  const fingerprint = computeFingerprint(fingerprintParts);
  out.fingerprint = fingerprint;
  out.count = outputs.length;

  if (!opts.dryRun) {
    try {
      fs.mkdirSync(opts.agentsOut, { recursive: true });
    } catch (err) {
      out.errors.push(`cannot create ${opts.agentsOut}: ${err && err.message ? err.message : String(err)}`);
      return;
    }
  }

  const nextFiles = {};
  const generatedNames = new Set(outputs.map((o) => o.outName));
  for (const entry of outputs) {
    const target = path.join(opts.agentsOut, entry.outName);
    const existing = readIfExists(target);
    nextFiles[entry.outName] = {
      sha256: sha256(entry.content),
      mode: entry.info.mode,
      tools: entry.info.tools,
      thinking: entry.info.thinking,
      refs: entry.info.refs.length,
    };
    for (const note of entry.info.notes) out.notes.push(`${entry.outName}: ${note}`);
    if (existing == null) {
      out.added.push(entry.outName);
    } else if (existing === entry.content) {
      out.unchanged.push(entry.outName);
      continue;
    } else {
      const wasOurs = Object.prototype.hasOwnProperty.call(previousFiles, entry.outName);
      const marked = !wasOurs && existing.slice(0, MARKER_SCAN_BYTES).includes(MARKER_PREFIX);
      if (!wasOurs && !marked && !opts.force) {
        // Somebody's own agent with a colliding name — never overwrite it.
        out.skipped.push(entry.outName);
        out.warnings.push(`${entry.outName} exists and was not generated by ${GENERATOR} — left untouched (--force overwrites)`);
        delete nextFiles[entry.outName];
        out.count -= 1;
        continue;
      }
      out.updated.push(entry.outName);
    }
    if (!opts.dryRun) {
      try {
        writeFileAtomic(target, entry.content);
      } catch (err) {
        out.errors.push(`write ${entry.outName}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  // ── prune stale generated agents ──────────────────────────────────────────
  for (const f of listCommandFiles(opts.agentsOut)) {
    if (!f.startsWith('gsd-') || generatedNames.has(f)) continue;
    const wasOurs = Object.prototype.hasOwnProperty.call(previousFiles, f);
    let marked = false;
    if (!wasOurs) {
      const head = readIfExists(path.join(opts.agentsOut, f));
      marked = head != null && head.slice(0, MARKER_SCAN_BYTES).includes(MARKER_PREFIX);
    }
    if (!wasOurs && !marked) {
      out.skipped.push(f); // somebody else's agent — never touch it
      continue;
    }
    out.removed.push(f);
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(path.join(opts.agentsOut, f));
      } catch (err) {
        out.warnings.push(`could not remove ${f}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  if (!opts.dryRun) {
    const state = {
      schema: 1,
      generator: `${GENERATOR}@${GENERATOR_VERSION}`,
      generatedAt: new Date().toISOString(),
      fingerprint,
      mode: opts.mode,
      maxInlineKb: opts.maxInlineKb,
      source: { dir: agentSource.dir, runtime: agentSource.runtime, version: source.version },
      coreRoot: ctx.coreRoot,
      outDir: opts.agentsOut,
      files: nextFiles,
    };
    try {
      fs.mkdirSync(opts.agentsOut, { recursive: true });
      writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      out.errors.push(`state write failed: ${err && err.message ? err.message : String(err)}`);
    }
  }
}

/**
 * Regenerate the pi prompt templates from the canonical GSD command definitions.
 *
 * Idempotent: unchanged templates are not touched, and stale generated templates
 * (recorded in the state file, or carrying the generator marker) are pruned.
 * Never throws for expected conditions — the returned report carries `ok`,
 * `errors` and `warnings` instead.
 *
 * @param {object} [flags] { cwd, agentDir, mode, naming, outDir, source, maxInlineKb, force, dryRun, quiet }
 * @returns {object} report
 */
function sync(flags = {}) {
  const opts = resolveOptions(flags, flags);
  const report = {
    ok: false,
    dryRun: opts.dryRun,
    changed: false,
    inSync: false,
    outDir: opts.outDir,
    agentDir: opts.agentDir,
    mode: opts.mode,
    naming: opts.naming,
    source: null,
    sourceRuntime: null,
    coreRoot: null,
    version: null,
    fingerprint: null,
    templates: 0,
    bytes: 0,
    inlinedBytes: 0,
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    skipped: [],
    notes: [],
    warnings: [],
    errors: [],
    // Present on every return path so callers never have to guard for it, even
    // when the command source turns out to be unusable.
    agents: {
      enabled: !!opts.syncAgents,
      dir: opts.agentsOut,
      source: null,
      sourceRuntime: null,
      count: 0,
      added: [],
      updated: [],
      unchanged: [],
      removed: [],
      skipped: [],
      notes: [],
      warnings: [],
      errors: [],
      fingerprint: null,
    },
    startedAt: new Date().toISOString(),
  };

  let source;
  try {
    source = discoverSource(opts);
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
    report.agents.notes.push('not attempted — no command source to derive them from');
    return report;
  }
  report.source = source.dir;
  report.sourceRuntime = source.runtime;
  report.coreRoot = source.coreRoot;
  report.version = source.version;

  if (source.valid.length < MIN_SOURCE_COMMANDS && !opts.force) {
    report.errors.push(
      `source ${source.dir} exposes only ${source.valid.length} command(s) (min ${MIN_SOURCE_COMMANDS}); ` +
        'refusing to regenerate — re-run with --force to override',
    );
    report.agents.notes.push('not attempted — the whole run was refused');
    return report;
  }

  const ctx = {
    srcDir: source.dir,
    coreRoot: source.coreRoot || path.resolve(source.dir, '..', '..'),
    engineRoot: source.coreRoot ? path.dirname(source.coreRoot) : opts.agentDir,
    agentDir: opts.agentDir,
    version: source.version,
    mode: opts.mode,
    naming: opts.naming,
    maxInlineKb: opts.maxInlineKb,
    roster: source.valid.map((f) => f.replace(/\.md$/, '')),
    rosterPattern: null,
  };
  ctx.rosterPattern = buildColonPattern(ctx.roster);

  if (!source.coreRoot) {
    report.warnings.push(
      `no pi GSD core tree found beside ${source.dir}; context paths will point at the source tree instead`,
    );
  }

  // ── agents: resolved before the command loop ──────────────────────────────
  // Every generated command tells the model which `gsd-*` agents exist, so the
  // agent roster has to be known before the templates are rendered.
  const agentSource = opts.syncAgents ? discoverAgentSource(opts, source.coreRoot, source.dir) : null;
  const agentNames = agentSource ? agentSource.valid.map((f) => f.replace(/\.md$/, '')).sort() : [];
  ctx.agents = { enabled: !!agentSource, names: agentNames, dir: opts.agentsOut };
  report.agents.source = agentSource ? agentSource.dir : null;
  report.agents.sourceRuntime = agentSource ? agentSource.runtime : null;
  if (!opts.syncAgents) {
    report.agents.notes.push('agent sync disabled (--no-agents)');
  } else if (!agentSource) {
    report.agents.notes.push(
      `no canonical agents/gsd-*.md directory found${opts.source ? ' beside the explicit --source' : ''} — skipped`,
    );
  } else if (agentSource.runtime !== 'pi-core' && agentSource.runtime !== 'pi') {
    report.agents.notes.push(`agent definitions come from the ${agentSource.runtime} install`);
  }

  // ── generate ───────────────────────────────────────────────────────────────
  const statePath = path.join(opts.outDir, STATE_FILE);
  const previous = readState(statePath);
  const nextFiles = {};
  const outputs = [];
  const fingerprintParts = {
    generator: `${GENERATOR}@${GENERATOR_VERSION}`,
    mode: opts.mode,
    naming: opts.naming,
    maxInlineKb: opts.maxInlineKb,
    source: source.dir,
    coreRoot: ctx.coreRoot,
    version: source.version,
    commands: [],
    // The roster is embedded in every template's dispatch contract, so a change
    // to the agent set invalidates the command templates too.
    agents: { enabled: !!agentSource, names: agentNames },
  };

  for (const fileName of source.valid) {
    const name = fileName.replace(/\.md$/, '');
    const raw = readIfExists(path.join(source.dir, fileName));
    if (raw == null) {
      report.warnings.push(`unreadable: ${fileName}`);
      continue;
    }
    fingerprintParts.commands.push([name, sha256(raw)]);
    let converted;
    try {
      converted = convertCommand(raw, name, ctx);
    } catch (err) {
      report.errors.push(`convert ${name}: ${err && err.message ? err.message : String(err)}`);
      continue;
    }
    const outName = (opts.naming === 'colon' ? 'gsd:' : 'gsd-') + name + '.md';
    outputs.push({ outName, name, content: converted.content, info: converted });
  }

  const fingerprint = computeFingerprint(fingerprintParts);
  report.fingerprint = fingerprint;
  report.templates = outputs.length;

  const stateInSync =
    !!previous &&
    previous.fingerprint === fingerprint &&
    previous.mode === opts.mode &&
    previous.naming === opts.naming &&
    previous.generator === `${GENERATOR}@${GENERATOR_VERSION}`;

  const existingFiles = listCommandFiles(opts.outDir).filter((f) => f.startsWith('gsd-') || f.startsWith('gsd:'));
  const generatedNames = new Set(outputs.map((o) => o.outName));

  if (!opts.dryRun) {
    try {
      fs.mkdirSync(opts.outDir, { recursive: true });
    } catch (err) {
      report.errors.push(`cannot create ${opts.outDir}: ${err && err.message ? err.message : String(err)}`);
      return report;
    }
  }
  for (const entry of outputs) {
    const target = path.join(opts.outDir, entry.outName);
    const existing = readIfExists(target);
    const bytes = Buffer.byteLength(entry.content, 'utf8');
    report.bytes += bytes;
    report.inlinedBytes += entry.info.inlinedBytes;
    nextFiles[entry.outName] = {
      sha256: sha256(entry.content),
      mode: entry.info.mode,
      inlinedBytes: entry.info.inlinedBytes,
      refs: entry.info.refs.length,
    };
    for (const note of entry.info.notes) report.notes.push(`${entry.outName}: ${note}`);
    if (existing == null) {
      report.added.push(entry.outName);
    } else if (existing !== entry.content) {
      report.updated.push(entry.outName);
    } else {
      report.unchanged.push(entry.outName);
      continue;
    }
    if (!opts.dryRun) {
      try {
        writeFileAtomic(target, entry.content);
      } catch (err) {
        report.errors.push(`write ${entry.outName}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  // ── prune stale generated templates ───────────────────────────────────────
  const previousFiles = (previous && previous.files) || {};
  for (const f of existingFiles) {
    if (generatedNames.has(f)) continue;
    const wasOurs = Object.prototype.hasOwnProperty.call(previousFiles, f);
    let marked = false;
    if (!wasOurs) {
      const head = readIfExists(path.join(opts.outDir, f));
      marked = head != null && head.slice(0, MARKER_SCAN_BYTES).includes(MARKER_PREFIX);
    }
    if (!wasOurs && !marked) {
      report.skipped.push(f); // somebody else's template — never touch it
      continue;
    }
    report.removed.push(f);
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(path.join(opts.outDir, f));
      } catch (err) {
        report.warnings.push(`could not remove ${f}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }
  // ── agents: same pipeline, different artifact ─────────────────────────────
  if (opts.syncAgents && agentSource) {
    syncAgents(opts, ctx, source, agentSource, report);
  }

  report.changed =
    report.added.length > 0 ||
    report.updated.length > 0 ||
    report.removed.length > 0 ||
    report.agents.added.length > 0 ||
    report.agents.updated.length > 0 ||
    report.agents.removed.length > 0;
  report.inSync = stateInSync && !report.changed && outputs.length > 0;

  if (!opts.dryRun) {
    const state = {
      schema: 1,
      generator: `${GENERATOR}@${GENERATOR_VERSION}`,
      generatedAt: new Date().toISOString(),
      fingerprint,
      mode: opts.mode,
      naming: opts.naming,
      maxInlineKb: opts.maxInlineKb,
      source: { dir: source.dir, runtime: source.runtime, version: source.version },
      coreRoot: ctx.coreRoot,
      outDir: opts.outDir,
      files: nextFiles,
    };
    try {
      fs.mkdirSync(opts.outDir, { recursive: true });
      writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      report.errors.push(`state write failed: ${err && err.message ? err.message : String(err)}`);
    }
  }

  // Explicit generation flags are persisted so the automatic sync (which only
  // sees env + config) does not revert them on the next session start.
  // `persist: false` (CLI: --no-persist) keeps a run strictly one-off.
  // `--out` / `--agents-out` stay transient: they say where to write this run.
  if (!opts.dryRun && flags.persist !== false && report.errors.length === 0 && report.agents.errors.length === 0) {
    const patch = {};
    if (flags.mode !== undefined) patch.mode = opts.mode;
    if (flags.naming !== undefined) patch.naming = opts.naming;
    if (flags.maxInlineKb !== undefined) patch.maxInlineKb = opts.maxInlineKb;
    if (flags.source !== undefined) patch.source = opts.source;
    if (flags.agents !== undefined) patch.syncAgents = opts.syncAgents;
    if (flags.noAgents !== undefined) patch.syncAgents = opts.syncAgents;
    const persisted = persistConfig(opts.agentDir, patch);
    if (persisted.length) report.notes.push(`persisted to ${CONFIG_FILE}: ${persisted.join(', ')}`);
  }
  report.ok = report.errors.length === 0 && report.agents.errors.length === 0;
  report.finishedAt = new Date().toISOString();
  return report;
}

/** Read-only view of what is currently installed. */
function status(flags = {}) {
  const opts = resolveOptions(flags, flags);
  const statePath = path.join(opts.outDir, STATE_FILE);
  const previous = readState(statePath);
  const files = listCommandFiles(opts.outDir).filter((f) => f.startsWith('gsd-') || f.startsWith('gsd:'));
  const agentStatePath = path.join(opts.agentsOut, AGENTS_STATE_FILE);
  const previousAgents = readState(agentStatePath);
  const agentFiles = listCommandFiles(opts.agentsOut).filter((f) => f.startsWith('gsd-'));
  const info = {
    ok: false,
    outDir: opts.outDir,
    agentDir: opts.agentDir,
    exists: isDir(opts.outDir),
    templates: files.length,
    agents: {
      enabled: opts.syncAgents,
      dir: opts.agentsOut,
      count: agentFiles.length,
      state: previousAgents
        ? {
            generator: previousAgents.generator,
            generatedAt: previousAgents.generatedAt,
            version: previousAgents.source && previousAgents.source.version,
            source: previousAgents.source && previousAgents.source.dir,
            files: previousAgents.files ? Object.keys(previousAgents.files).length : 0,
          }
        : null,
      stale: null,
      warnings: [],
    },
    state: previous
      ? {
          generator: previous.generator,
          generatedAt: previous.generatedAt,
          fingerprint: previous.fingerprint,
          mode: previous.mode,
          naming: previous.naming,
          version: previous.source && previous.source.version,
          source: previous.source && previous.source.dir,
          coreRoot: previous.coreRoot,
          files: previous.files ? Object.keys(previous.files).length : 0,
        }
      : null,
    configured: {
      mode: opts.mode,
      naming: opts.naming,
      maxInlineKb: opts.maxInlineKb,
      autoSync: opts.autoSync,
      syncAgents: opts.syncAgents,
    },
    errors: [],
    warnings: [],
    stale: null,
  };
  // pi-subagents only reads PI_CODING_AGENT_DIR; a TAU-only override would send
  // the agents to a directory nothing loads.
  if (opts.syncAgents && process.env.TAU_CODING_AGENT_DIR && !process.env.PI_CODING_AGENT_DIR) {
    info.agents.warnings.push(
      'TAU_CODING_AGENT_DIR is set without PI_CODING_AGENT_DIR: pi-subagents resolves its agent directory from ' +
        'PI_CODING_AGENT_DIR only, so the generated agents would not be discovered. Set PI_CODING_AGENT_DIR too.',
    );
  }
  try {
    const source = discoverSource(opts);
    info.source = { dir: source.dir, runtime: source.runtime, version: source.version, commands: source.valid.length };
    info.coreRoot = source.coreRoot;
    const agentSource = opts.syncAgents ? discoverAgentSource(opts, source.coreRoot, source.dir) : null;
    if (agentSource) {
      info.agents.source = { dir: agentSource.dir, runtime: agentSource.runtime, agents: agentSource.valid.length };
    }
    const fingerprintParts = {
      generator: `${GENERATOR}@${GENERATOR_VERSION}`,
      mode: opts.mode,
      naming: opts.naming,
      maxInlineKb: opts.maxInlineKb,
      source: source.dir,
      coreRoot: source.coreRoot || path.resolve(source.dir, '..', '..'),
      version: source.version,
      commands: source.valid.map((f) => [f.replace(/\.md$/, ''), sha256(readIfExists(path.join(source.dir, f)) || '')]),
      agents: {
        enabled: !!agentSource,
        names: agentSource ? agentSource.valid.map((f) => f.replace(/\.md$/, '')).sort() : [],
      },
    };
    const fingerprint = computeFingerprint(fingerprintParts);
    info.fingerprint = fingerprint;
    // Stale when the source, the settings, OR this plugin's conversion logic
    // changed — the last one is why an upgraded plugin re-syncs on its own.
    info.stale =
      !previous ||
      previous.fingerprint !== fingerprint ||
      previous.generator !== `${GENERATOR}@${GENERATOR_VERSION}` ||
      previous.mode !== opts.mode ||
      previous.naming !== opts.naming;
    if (opts.syncAgents && agentSource) {
      // Must stay byte-comparable with the parts `syncAgents` records, unreadable
      // files dropped the same way, or a run would report itself stale forever.
      const agentParts = [];
      for (const f of agentSource.valid) {
        const raw = readIfExists(path.join(agentSource.dir, f));
        if (raw == null) continue;
        agentParts.push([f.replace(/\.md$/, ''), sha256(raw)]);
      }
      const agentFingerprint = computeFingerprint({
        generator: `${GENERATOR}@${GENERATOR_VERSION}`,
        kind: 'agents',
        mode: opts.mode,
        maxInlineKb: opts.maxInlineKb,
        source: agentSource.dir,
        // Must match syncAgents' fingerprint exactly, or every status call
        // would report STALE on a host with extensions installed.
        extensionTools: detectHostExtensionTools(opts.agentDir),
        coreRoot: source.coreRoot || path.resolve(source.dir, '..', '..'),
        version: source.version,
        agents: agentParts,
      });
      info.agents.fingerprint = agentFingerprint;
      info.agents.stale = !previousAgents || previousAgents.fingerprint !== agentFingerprint;
      info.stale = info.stale || info.agents.stale;
    } else {
      info.agents.stale = false;
    }
    info.ok = true;
  } catch (err) {
    info.errors.push(err && err.message ? err.message : String(err));
    info.stale = files.length === 0;
    info.agents.stale = agentFiles.length === 0;
  }
  return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

function formatStatus(info) {
  const L = [];
  L.push(`GSD slash commands → pi  ·  ${GENERATOR} v${GENERATOR_VERSION}`);
  L.push(`  output      ${info.outDir}`);
  L.push(`  templates   ${info.templates}  (${info.state ? info.state.mode : info.configured.mode} mode, ${info.state ? info.state.naming : info.configured.naming} naming)`);
  if (info.state) {
    L.push(`  installed   GSD Core ${info.state.version || '?'} from ${info.state.source || '?'}`);
    L.push(`  generated   ${info.state.generatedAt}`);
  } else {
    L.push('  installed   (never synced)');
  }
  if (info.source) {
    L.push(`  source      GSD Core ${info.source.version} · ${info.source.runtime} · ${info.source.commands} commands · ${info.source.dir}`);
    L.push(`  pi core     ${info.coreRoot || '(missing)'}`);
  }
  L.push(`  fingerprint ${info.fingerprint ? info.fingerprint.slice(0, 16) : '?'} ${info.stale === true ? '(STALE — run /gsd-sync)' : info.stale === false ? '(up to date)' : ''}`);
  const A = info.agents || {};
  if (A.enabled === false) {
    L.push('  agents      disabled (--no-agents)');
  } else {
    L.push(
      `  agents      ${A.count || 0} in ${A.dir}` +
        (A.state ? `  (GSD Core ${A.state.version || '?'}, generated ${A.state.generatedAt})` : '  (never synced)') +
        (A.stale === true ? '  · STALE' : ''),
    );
    if (A.source) L.push(`  agent src   ${A.source.runtime} · ${A.source.agents} definitions · ${A.source.dir}`);
    for (const w of A.warnings || []) L.push(`  ! ${w}`);
  }
  L.push(`  autosync    ${info.configured.autoSync ? 'on' : 'off'}  ·  mode ${info.configured.mode}  ·  naming ${info.configured.naming}${info.configured.maxInlineKb ? `  ·  maxInlineKb ${info.configured.maxInlineKb}` : ''}`);
  for (const w of info.warnings) L.push(`  ! ${w}`);
  for (const e of info.errors) L.push(`  ✗ ${e}`);
  return L.join('\n');
}

function formatReport(report) {
  const L = [];
  const head = report.dryRun ? 'dry-run' : report.changed ? 'synced' : report.inSync ? 'up to date' : 'no changes';
  L.push(`GSD slash commands → pi  ·  ${GENERATOR} v${GENERATOR_VERSION}  ·  ${head}`);
  if (report.source) {
    L.push(`  source      GSD Core ${report.version} · ${report.sourceRuntime} · ${report.source}`);
    L.push(`  pi core     ${report.coreRoot || '(missing — paths fall back to the source tree)'}`);
  }
  L.push(`  output      ${report.outDir}`);
  L.push(
    `  templates   ${report.templates} total · +${report.added.length} new · ~${report.updated.length} updated · ` +
      `${report.unchanged.length} unchanged · -${report.removed.length} removed` +
      (report.inlinedBytes ? ` · ${(report.inlinedBytes / 1024).toFixed(0)} KB inlined` : '') +
      ` · ${(report.bytes / 1024).toFixed(0)} KB written`,
  );
  const A = report.agents;
  if (A) {
    if (A.enabled === false) {
      L.push('  agents      disabled (--no-agents)');
    } else if (A.source) {
      L.push(
        `  agents      ${A.count} total · +${A.added.length} new · ~${A.updated.length} updated · ` +
          `${A.unchanged.length} unchanged · -${A.removed.length} removed  ·  ${A.dir}`,
      );
      if (A.removed.length) L.push(`  agent rm    ${A.removed.join(', ')}`);
      if (A.skipped.length) {
        L.push(`  agent keep  ${A.skipped.length} foreign file(s): ${A.skipped.slice(0, 5).join(', ')}`);
      }
    } else {
      L.push(`  agents      none synced — ${A.notes[0] || 'no source'}`);
    }
  }
  L.push(`  mode        ${report.mode}  ·  naming ${report.naming}  ·  fingerprint ${(report.fingerprint || '').slice(0, 16)}`);
  if (report.removed.length) L.push(`  removed     ${report.removed.join(', ')}`);
  if (report.skipped.length) L.push(`  kept        ${report.skipped.length} foreign file(s): ${report.skipped.slice(0, 5).join(', ')}`);
  for (const n of report.notes.slice(0, 12)) L.push(`  · ${n}`);
  if (report.notes.length > 12) L.push(`  · … ${report.notes.length - 12} more note(s)`);
  for (const w of report.warnings) L.push(`  ! ${w}`);
  if (A) for (const n of A.notes.slice(0, 8)) L.push(`  · ${n}`);
  if (A) for (const w of A.warnings) L.push(`  ! ${w}`);
  for (const e of report.errors) L.push(`  ✗ ${e}`);
  if (A) for (const e of A.errors) L.push(`  ✗ ${e}`);
  if (report.changed && !report.dryRun && report.mode === 'reference') {
    L.push('  hint        pi expands these as native prompt templates — invoke one with /gsd-<command>');
  }
  if (A && A.count > 0 && !report.dryRun) {
    L.push(
      '  hint        pi-subagents picks the agents up on its next run; a session that is already open can use ' +
        '/reload (or restart pi) to see them in {action:"list"}.',
    );
  }
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI flag parsing
// ─────────────────────────────────────────────────────────────────────────────

const FLAG_SPEC = {
  '--mode': 'mode',
  '--naming': 'naming',
  '--out': 'outDir',
  '--agents-out': 'agentsOut',
  '--source': 'source',
  '--max-inline-kb': 'maxInlineKb',
};

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inlineValue = eq === -1 ? null : a.slice(eq + 1);
    if (Object.prototype.hasOwnProperty.call(FLAG_SPEC, key)) {
      const name = FLAG_SPEC[key];
      const value = inlineValue != null ? inlineValue : argv[++i];
      flags[name] = value;
      continue;
    }
    switch (a) {
      case '--dry-run':
      case '-n':
        flags.dryRun = true;
        break;
      case '--status':
        flags.status = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--no-persist':
        flags.persist = false;
        break;
      case '--force':
      case '-f':
        flags.force = true;
        break;
      case '--quiet':
      case '-q':
        flags.quiet = true;
        break;
      case '--inline':
        flags.mode = 'inline';
        break;
      case '--reference':
        flags.mode = 'reference';
        break;
      case '--agents':
        flags.agents = true;
        break;
      case '--no-agents':
        flags.noAgents = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        if (a.startsWith('-')) flags.unknown = [...(flags.unknown || []), a];
        else flags._.push(a);
    }
  }
  return flags;
}

const HELP = `gsd-slash-sync v${GENERATOR_VERSION} — GSD Core commands + subagents → pi

Usage:
  node gsd-slash-sync.js sync [options]     regenerate the templates and agents
  node gsd-slash-sync.js status [--json]    show what is installed / whether it is stale
  node gsd-slash-sync.js install            copy this file into <agentDir>/extensions/
  node gsd-slash-sync.js help

Options:
  --mode <reference|inline>   reference (default, tiny templates) or inline (Claude-Code-equivalent)
  --naming <hyphen|colon>     /gsd-plan-phase (default, GSD's canonical pi form) or /gsd:plan-phase
  --out <dir>                 command template directory (default <agentDir>/gsd-commands)
  --agents-out <dir>          pi-subagents agent directory (default <agentDir>/agents)
  --agents / --no-agents      convert GSD's subagents, or skip them (default: convert)
  --source <dir>              explicit directory holding the canonical commands/gsd/*.md
  --max-inline-kb <n>         inline mode: fall back to reference above n KB per file (0 = no limit)
  --dry-run, -n               report what would change, write nothing
  --status                    print status instead of syncing
  --json                      machine-readable output
  --force, -f                 proceed even when the source looks broken
  --quiet, -q                 no output unless something changed or failed
  --no-persist                do not write --mode/--naming/--source/--agents to the config file

Environment: GSD_SLASH_SYNC_MODE, GSD_SLASH_SYNC_NAMING, GSD_SLASH_SYNC_OUT,
             GSD_SLASH_SYNC_AGENTS_OUT, GSD_SLASH_SYNC_NO_AGENTS, GSD_SLASH_SYNC_SOURCE,
             GSD_SLASH_SYNC_MAX_INLINE_KB, GSD_SLASH_SYNC_AUTO=off, GSD_SLASH_SYNC_NOTIFY=off

Inside pi: /gsd-sync [same flags]  ·  commands appear as /gsd-<command>,
           agents as gsd-<role> for pi-subagents (subagent({ agent: "gsd-planner", task: "…" }))
`;

// ─────────────────────────────────────────────────────────────────────────────
// pi extension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surface command output. TUI (and RPC clients) get `ui.notify`; `pi -p` has no
 * UI, so the report goes to stdout where scripts can read it. RPC stdout is a
 * JSON protocol and must never be written to directly.
 */
function notify(ctx, message, type, opts) {
  const mode = ctx && ctx.mode;
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notify === 'function') ctx.ui.notify(message, type || 'info');
    // `pi -p` has no UI at all, so an explicit command's report would otherwise be
    // invisible. stdout is only ever written for that explicit path (never for the
    // automatic session-start sync, which must not pollute a printed model reply),
    // and never in RPC mode, where stdout is a JSON protocol.
    if (opts && opts.stdout === true && (mode === 'print' || mode === 'json')) {
      process.stdout.write(`${message}\n`);
    }
  } catch {
    /* fail-open: notifying is never worth breaking a session for */
  }
}

const SYNC_FLAG_COMPLETIONS = [
  '--status',
  '--dry-run',
  '--force',
  '--json',
  '--mode inline',
  '--mode reference',
  '--naming hyphen',
  '--naming colon',
  '--no-agents',
];

/**
 * pi extension entry point.
 * @param {object} pi pi ExtensionAPI
 */
module.exports = function gsdSlashSyncExtension(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdSlashSyncExtension: pi ExtensionAPI is required');
  }

  /** Directory pi should load prompt templates from — resolved once per load. */
  let outDir;
  try {
    outDir = resolveOptions({}, {}).outDir;
  } catch {
    outDir = path.join(resolveAgentDir(), 'gsd-commands');
  }

  // ── resource registration: make the generated templates first-class pi prompt
  // templates without touching the user's own ~/.pi/agent/prompts directory.
  // Fires after session_start on every startup and reload.
  pi.on('resources_discover', async () => ({ promptPaths: [outDir] }));

  // ── automatic sync when GSD Core moved ahead of the generated set.
  pi.on('session_start', async (event, ctx) => {
    let opts;
    try {
      opts = resolveOptions({}, { cwd: ctx && ctx.cwd });
    } catch {
      return;
    }
    if (!opts.autoSync) return;
    try {
      const info = status({ cwd: ctx && ctx.cwd });
      if (info.stale !== true) return;
      const report = sync({ cwd: ctx && ctx.cwd });
      const changed = report.ok && report.changed;
      if (opts.notify) {
        if (changed) {
          const agentPart = report.agents && report.agents.count ? `, ${report.agents.count} subagents` : '';
          notify(
            ctx,
            `GSD synced for pi (${report.templates} commands${agentPart}, GSD Core ${report.version}): ` +
              `+${report.added.length + report.agents.added.length} ~${report.updated.length + report.agents.updated.length}`,
            'info',
          );
        } else if (!report.ok) {
          notify(
            ctx,
            `GSD slash sync failed: ${report.errors[0] || report.agents.errors[0] || 'unknown error'}`,
            'warning',
          );
        }
      }
    } catch (err) {
      notify(ctx, `GSD slash sync error: ${err && err.message ? err.message : String(err)}`, 'warning');
    }
  });

  // ── manual sync command
  pi.registerCommand('gsd-sync', {
    description: 'Sync GSD Core slash commands into pi prompt templates (run after a GSD Core update).',
    getArgumentCompletions: (prefix) => {
      const p = typeof prefix === 'string' ? prefix : '';
      const matches = SYNC_FLAG_COMPLETIONS.filter((c) => c.startsWith(p));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const flags = parseFlags(String(args || '').split(/\s+/).filter(Boolean));
      const cwd = (ctx && ctx.cwd) || process.cwd();
      if (flags.help) {
        notify(ctx, HELP, 'info', { stdout: true });
        return;
      }
      try {
        if (flags.status) {
          const info = status({ cwd, ...flags });
          notify(
            ctx,
            flags.json ? JSON.stringify(info, null, 2) : formatStatus(info),
            info.ok ? 'info' : 'warning',
            { stdout: true },
          );
          return;
        }
        const report = sync({ cwd, ...flags });
        notify(ctx, formatReport(report), report.ok ? 'info' : 'error', { stdout: true });
        // Pick the freshly written templates up in this session. Print/json runs are
        // one-shot (nothing to reload for) and reloading there only ends the process.
        if (report.changed && report.ok && ctx && ctx.mode !== 'print' && ctx.mode !== 'json' && typeof ctx.reload === 'function') {
          await ctx.reload();
        }
      } catch (err) {
        notify(ctx, `GSD slash sync failed: ${err && err.message ? err.message : String(err)}`, 'error', { stdout: true });
      }
    },
  });

  // ── tool: lets the agent refresh the command surface itself (e.g. right after
  // running a GSD Core update) without the user typing a command.
  pi.registerTool({
    name: 'gsd_slash_sync',
    label: 'GSD Slash Sync',
    description:
      'Regenerate the /gsd-* slash command templates and the gsd-* pi-subagents agent definitions for pi from the ' +
      'installed GSD Core sources. Run this after a GSD Core update so newly added/changed commands and agents show ' +
      'up. Use action "status" to inspect.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sync', 'status'], description: 'sync (default) or status' },
        mode: { type: 'string', enum: ['reference', 'inline'], description: 'template mode override' },
        naming: { type: 'string', enum: ['hyphen', 'colon'], description: 'command naming override' },
        agents: { type: 'boolean', description: 'convert GSD subagents too (default true)' },
        dryRun: { type: 'boolean', description: 'report planned changes without writing' },
        force: { type: 'boolean', description: 'proceed even if the source looks broken' },
      },
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const p = params && typeof params === 'object' ? params : {};
      const cwd = (ctx && ctx.cwd) || process.cwd();
      // Only forward the agent switches when the caller actually set them —
      // `agents: undefined` must stay "use the configured behaviour".
      const agentFlags =
        typeof p.agents === 'boolean' ? { agents: p.agents, noAgents: p.agents === false } : {};
      try {
        if (p.action === 'status') {
          const info = status({ cwd, mode: p.mode, naming: p.naming, ...agentFlags });
          return { content: [{ type: 'text', text: formatStatus(info) }] };
        }
        const report = sync({
          cwd,
          mode: p.mode,
          naming: p.naming,
          ...agentFlags,
          dryRun: !!p.dryRun,
          force: !!p.force,
        });
        return { content: [{ type: 'text', text: formatReport(report) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `gsd_slash_sync failed: ${err && err.message ? err.message : String(err)}` }],
        };
      }
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function installSelf(argv) {
  const flags = parseFlags(argv);
  const agentDir = resolveOptions({}, {}).agentDir;
  const target = path.join(agentDir, 'extensions', path.basename(__filename));
  const self = fs.realpathSync(__filename);
  if (fs.existsSync(target) && fs.realpathSync(target) === self) {
    return `already installed at ${target}`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !flags.force) {
    fs.copyFileSync(self, target); // keep it simple: refresh in place
    return `refreshed ${target}\npi auto-discovers <agentDir>/extensions/*.js — restart pi or run /reload`;
  }
  fs.copyFileSync(self, target);
  return (
    `installed ${target}\n` +
    'pi auto-discovers <agentDir>/extensions/*.js — restart pi or run /reload, then use /gsd-sync'
  );
}

function main(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'sync';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
  const flags = parseFlags(rest);

  if (flags.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.unknown && flags.unknown.length) {
    process.stderr.write(`unknown flag(s): ${flags.unknown.join(', ')}\n${HELP}`);
    return 2;
  }

  switch (command) {
    case 'sync': {
      if (flags.status) {
        const info = status(flags);
        process.stdout.write((flags.json ? JSON.stringify(info, null, 2) : formatStatus(info)) + '\n');
        return info.ok ? 0 : 1;
      }
      const report = sync(flags);
      if (!flags.quiet || report.changed || !report.ok) {
        process.stdout.write((flags.json ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n');
      }
      return report.ok ? 0 : 1;
    }
    case 'status': {
      const info = status(flags);
      process.stdout.write((flags.json ? JSON.stringify(info, null, 2) : formatStatus(info)) + '\n');
      return info.ok ? 0 : 1;
    }
    case 'install': {
      process.stdout.write(installSelf(rest) + '\n');
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n${HELP}`);
      return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

// Test seams (mirrors the convention used by GSD's own pi extension).
module.exports._internals = {
  GENERATOR,
  CONFIG_FILE,
  STATE_FILE,
  AGENTS_STATE_FILE,
  MARKER_PREFIX,
  MARKER_SCAN_BYTES,
  GENERATOR_VERSION,
  MIN_SOURCE_COMMANDS,
  MIN_SOURCE_AGENTS,
  DEFAULT_CONFIG,
  expandHome,
  resolveAgentDir,
  parseFrontmatter,
  frontmatterList,
  buildFrontmatter,
  buildAgentFrontmatter,
  mapAgentTools,
  mapAgentDisallowed,
  mapAgentEffort,
  protectShellPositionals,
  normalizeRuntimePaths,
  rewriteRuntimeNotes,
  buildColonPattern,
  detectHostExtensionTools,
  npmPackageName,
  isPackageInstalled,
  normalizeColonCommands,
  resolveCoreRef,
  inlineContext,
  convertCommand,
  convertAgent,
  agentRuntimeContract,
  subagentDispatchBlock,
  discoverSource,
  sourceCandidates,
  discoverAgentSource,
  agentSourceCandidates,
  scoreAgentSource,
  computeFingerprint,
  readState,
  writeFileAtomic,
  resolveOptions,
  parseFlags,
  runtimeContract,
  sync,
  status,
  formatReport,
  formatStatus,
};
module.exports.sync = sync;
module.exports.status = status;
module.exports.resolveOptions = resolveOptions;
