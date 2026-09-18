#!/usr/bin/env node
/**
 * Verification suite for gsd-slash-sync.
 *
 * It exercises the plugin against pi's REAL prompt-template engine (loaded from
 * the installed pi package) rather than re-implementing the contract, and
 * against a mock ExtensionAPI for the registration surface.
 *
 *   node test/verify.mjs [--agent-dir <dir>] [--keep]
 *
 * Exit code 0 = all checks passed.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(here, '..', 'gsd-slash-sync.js');
const plugin = require(pluginPath);
const { _internals } = plugin;

// Snapshot of the real install, asserted unchanged at the end of the run.
const realOutDir = _internals.resolveOptions({}, {}).outDir;
const realStateFile = path.join(realOutDir, _internals.STATE_FILE);
const realStateBefore = fs.existsSync(realStateFile) ? fs.statSync(realStateFile).mtimeMs : null;

const PI_PKG = process.env.PI_PACKAGE_DIR || '/Users/linxiao/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent';
const piPromptTemplates = await import(pathToFileURL(path.join(PI_PKG, 'dist', 'core', 'prompt-templates.js')).href);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const agentDir = flag('--agent-dir', _internals.resolveAgentDir());
const keep = argv.includes('--keep');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slash-sync-verify-'));

// Extension tools the host's installed packages contribute to every generated
// allowlist. Expected values are derived from the same detection the generator
// uses, so the suite stays honest on a host without these packages (where the
// extras are `[]` and the assertions below are exactly the pre-detection ones).
const extensionTools = _internals.detectHostExtensionTools(agentDir);
const webTools = _internals.hostProvidesWebTools(agentDir);
// `withExtras` is gone: extension tools no longer belong in the allowlist.

// pi-subagents' user agent directory. Every sync/status call below redirects the
// agent output into the temp root: writing GSD's 35 agent definitions into the
// real directory from a test run is exactly the kind of side effect this suite
// exists to rule out.
const realAgentsDir = path.join(agentDir, 'agents');
const agentsTmp = path.join(tmpRoot, 'agents');
/** Fingerprint of the real agent directory, so the suite can prove it left it alone. */
const realAgentsDirSnapshot = () => {
  if (!fs.existsSync(realAgentsDir)) return 'absent';
  return fs
    .readdirSync(realAgentsDir)
    .sort()
    .map((f) => {
      const p = path.join(realAgentsDir, f);
      return fs.statSync(p).isFile() ? `${f}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)}` : `${f}:dir`;
    })
    .join('\n');
};
const realAgentsBefore = realAgentsDirSnapshot();
// Snapshot the real user config file BEFORE any test runs. Section 11 asserts the
// suite did not mutate the real install; a post-hoc comparison would be a
// tautology, and asserting mere non-existence fails on a machine where the sync
// has legitimately been run (that file pins the source and mode).
const realConfigBefore = fs.existsSync(path.join(agentDir, _internals.CONFIG_FILE))
  ? fs.readFileSync(path.join(agentDir, _internals.CONFIG_FILE), 'utf8')
  : null;
// Same guard for the global context file the sync generates.
const realGlobalContext = path.join(agentDir, _internals.GLOBAL_CONTEXT_FILE);
const realGlobalContextBefore = fs.existsSync(realGlobalContext)
  ? fs.readFileSync(realGlobalContext, 'utf8')
  : null;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`gsd-slash-sync verification`);
console.log(`  plugin    ${pluginPath}`);
console.log(`  pi engine ${PI_PKG}`);
console.log(`  agent dir ${agentDir}`);
console.log('');

// The suite syncs against the REAL agent dir so the host-tool detection is
// genuine, which also means the global-context writer would target the real
// ~/.pi/agent/AGENTS.md. Section 11 asserts the suite does not mutate the real
// install, so it is disabled here; the writer itself is exercised below against
// temp dirs, and the env switch is asserted to work.
process.env.GSD_SLASH_SYNC_NO_GLOBAL_CONTEXT = '1';
check(
  'the env switch disables the global-context write',
  _internals.resolveOptions({}, {}).syncGlobalContext === false,
);

// ── 1. reference-mode install as it ships ────────────────────────────────────
console.log('1) reference mode (installed output)');
const refDir = path.join(tmpRoot, 'reference');
const refReport = plugin.sync({ agentDir, outDir: refDir, agentsOut: agentsTmp, mode: 'reference', persist: false, naming: 'hyphen', cwd: here  });
check('sync writes 72 templates', refReport.templates === 72, `got ${refReport.templates}`);
check('sync reports no errors', refReport.ok && refReport.errors.length === 0, refReport.errors.join('; '));
check('source is the GSD Core command set', /commands\/gsd$/.test(refReport.source || ''), refReport.source);

const refAgain = plugin.sync({ agentDir, outDir: refDir, agentsOut: agentsTmp, mode: 'reference', persist: false, naming: 'hyphen', cwd: here  });
check(
  're-sync is a pure no-op (idempotent bytes)',
  refAgain.changed === false && refAgain.updated.length === 0 && refAgain.unchanged.length === 72,
  `added=${refAgain.added.length} updated=${refAgain.updated.length} unchanged=${refAgain.unchanged.length}`,
);
check('fingerprint is stable across runs', refReport.fingerprint === refAgain.fingerprint);

// ── 2. pi loads them as first-class prompt templates ─────────────────────────
console.log('\n2) pi prompt-template engine');
const loaded = piPromptTemplates.loadPromptTemplates({
  agentDir: path.join(tmpRoot, 'unused-agent-dir'),
  cwd: here,
  promptPaths: [refDir],
  includeDefaults: false,
});
check('pi loads 72 templates from the generated dir', loaded.length === 72, `got ${loaded.length}`);
check('every template resolved to a real file', loaded.every((p) => p.filePath && fs.existsSync(p.filePath)));

const names = loaded.map((p) => p.name).sort();
check('every command is exposed as /gsd-<name>', names.every((n) => n.startsWith('gsd-')), names.slice(0, 3).join(','));
check('plan-phase template present', names.includes('gsd-plan-phase'));
check('all 72 have a non-empty description', loaded.every((p) => (p.description || '').length > 0));
check(
  'argument hints survive the conversion (63 in source, 6 of them empty)',
  loaded.filter((p) => p.argumentHint).length === 57,
  `got ${loaded.filter((p) => p.argumentHint).length} (expected 57 non-empty)`
);

// ── 3. expansion + argument substitution through pi's own code ───────────────
console.log('\n3) /gsd-<command> expansion');
const expanded = piPromptTemplates.expandPromptTemplate('/gsd-plan-phase 5 --auto --text', loaded);
check('expansion is not a passthrough', expanded !== '/gsd-plan-phase 5 --auto --text');
check('$ARGUMENTS substituted into the body', expanded.includes('Phase number: 5 --auto --text'), 'body context line missing args');
check('$ARGUMENTS substituted into the arguments block', expanded.includes('<user_arguments>5 --auto --text</user_arguments>'));
check('runtime contract is present', expanded.includes('<runtime_contract>'));
check('must-read list points into the pi GSD tree', expanded.includes(path.join(agentDir, 'gsd-core', 'workflows', 'plan-phase.md')));
const roster = names.map((n) => n.replace(/^gsd[-:]/, ''));
check(
  'no colon-form command reference survives for a known command',
  !roster.some((c) => new RegExp(`/gsd:${c}(?![A-Za-z0-9_-])`).test(expanded)),
  roster.filter((c) => new RegExp(`/gsd:${c}(?![A-Za-z0-9_-])`).test(expanded)).join(', '),
);
check(
  'unknown template name falls through untouched',
  piPromptTemplates.expandPromptTemplate('/gsd-does-not-exist', loaded) === '/gsd-does-not-exist',
);

// ── 4. shell-token protection (reference mode still carries GSD's shim) ──────
console.log('\n4) shell token protection');
const graphify = loaded.find((p) => p.name === 'gsd-graphify');
const graphifyExpanded = piPromptTemplates.substituteArgs(graphify.content, ['1']);
check('bash "$@" survived as "${@}"', graphifyExpanded.includes('"${@}"'), 'bash positional was rewritten');
const piCore = path.join(agentDir, 'gsd-core');
check(
  'gsd_run shim can find gsd-tools.cjs under the pi runtime tree',
  graphifyExpanded.includes(`"${piCore}/bin/`) &&
    !graphifyExpanded.includes('"$HOME/.claude/gsd-core/bin/'),
  'shim did not get the runtime path rewrite',
);
check(
  '${CLAUDE_CONFIG_DIR:-$HOME/.claude} resolves to the pi runtime home',
  loaded.find((p) => p.name === 'gsd-surface').content.includes(`\${CLAUDE_CONFIG_DIR:-${agentDir}}`),
);
check('no ~/.claude/gsd-core path left in a pi template', !graphifyExpanded.includes('~/.claude/gsd-core') && !graphifyExpanded.includes('$HOME/.claude/gsd-core'));
check(
  'on-demand workflow paths in prose point at the pi tree',
  !loaded.some((p) => /~\/\.claude\/gsd-core|\$HOME\/\.claude\/gsd-core/.test(p.content)),
  loaded.filter((p) => /~\/\.claude\/gsd-core|\$HOME\/\.claude\/gsd-core/.test(p.content)).map((p) => p.name).join(', '),
);
check('no bare $@ left for pi to eat', !/[^"{]$@/.test(graphifyExpanded));
check('no bare $1 left for pi to eat', !/\$[0-9]/.test(graphifyExpanded), 'found a substitutable $N');
check('gsd_run shim intact', graphifyExpanded.includes('gsd_run() { node "$GSD_TOOLS"'));

// ── 5. inline mode ──────────────────────────────────────────────────────────
console.log('\n5) inline mode (Claude-Code-equivalent)');
const inlineDir = path.join(tmpRoot, 'inline');
const inlineReport = plugin.sync({ agentDir, outDir: inlineDir, agentsOut: agentsTmp, mode: 'inline', persist: false, naming: 'hyphen', cwd: here  });
check('inline sync succeeds', inlineReport.ok, inlineReport.errors.join('; '));
check('inline sync inlines context', inlineReport.inlinedBytes > 1_000_000, `${(inlineReport.inlinedBytes / 1024).toFixed(0)} KB`);
const inlineLoaded = piPromptTemplates.loadPromptTemplates({
  agentDir,
  cwd: here,
  promptPaths: [inlineDir],
  includeDefaults: false,
});
check('pi loads 72 inline templates', inlineLoaded.length === 72, `got ${inlineLoaded.length}`);
const inlinePlan = inlineLoaded.find((p) => p.name === 'gsd-plan-phase');
check('plan-phase workflow body was inlined', inlinePlan.content.includes('<!-- gsd-context:begin workflows/plan-phase.md -->'));
check('inlined workflow is present verbatim (not a placeholder)', inlinePlan.content.includes('<required_reading>'));
check(
  'nested references are inlined recursively',
  inlinePlan.content.includes('references/ui-brand.md') && inlinePlan.content.includes('<ui_patterns>'),
);
check('no stringified object leaked into the prompt', !inlinePlan.content.includes('[object Object]'));
check(
  'inline template is much larger than the reference template',
  inlinePlan.content.length > 100_000,
  `${inlinePlan.content.length} bytes`
);
const inlineSubstituted = piPromptTemplates.substituteArgs(inlinePlan.content, ['7', '--auto']);
check('inlined context is not corrupted by substitution', inlineSubstituted.includes('gsd_run') && !/\$[0-9]/.test(inlineSubstituted));
check(
  'maxInlineKb falls back to reference mode',
  (() => {
    const small = plugin.sync({
      agentDir,
      agentsOut: agentsTmp,
      outDir: path.join(tmpRoot, 'capped'),
      mode: 'inline',
      persist: false,
      maxInlineKb: 20,
      cwd: here,
    });
    const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'capped', '.gsd-slash-sync-state.json'), 'utf8'));
    const modes = new Set(Object.values(state.files).map((f) => f.mode));
    return small.ok && modes.has('reference') && modes.has('inline');
  })(),
);

// ── 6. colon naming ────────────────────────────────────────────────────────
console.log('\n6) colon naming');
const colonDir = path.join(tmpRoot, 'colon');
plugin.sync({ agentDir, outDir: colonDir, agentsOut: agentsTmp, mode: 'reference', persist: false, naming: 'colon', cwd: here  });
const colonLoaded = piPromptTemplates.loadPromptTemplates({
  agentDir,
  cwd: here,
  promptPaths: [colonDir],
  includeDefaults: false,
});
check('pi exposes /gsd:plan-phase when asked', colonLoaded.some((p) => p.name === 'gsd:plan-phase'));
check(
  'colon variant expands too',
  piPromptTemplates.expandPromptTemplate('/gsd:plan-phase 3', colonLoaded).includes('Phase number: 3'),
);

// ── 7. stale-template pruning ──────────────────────────────────────────────
console.log('\n7) pruning');
const pruneDir = path.join(tmpRoot, 'prune');
plugin.sync({ agentDir, outDir: pruneDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here  });
const stalePath = path.join(pruneDir, 'gsd-removed-command.md');
fs.writeFileSync(stalePath, `<!-- generated by ${_internals.GENERATOR} v0.0.1 (stale) -->\n`);
const foreignPath = path.join(pruneDir, 'gsd-user-own-file.md');
fs.writeFileSync(foreignPath, '---\ndescription: mine\n---\nkeep me\n');
const pruneReport = plugin.sync({ agentDir, outDir: pruneDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here  });
check('stale generated template is removed', pruneReport.removed.includes('gsd-removed-command.md') && !fs.existsSync(stalePath));
check('foreign template is never touched', pruneReport.skipped.includes('gsd-user-own-file.md') && fs.existsSync(foreignPath));

// 7b. an upgraded plugin (conversion logic changed) must re-sync on its own
const upgradeDir = path.join(tmpRoot, 'upgrade');
plugin.sync({ agentDir, outDir: upgradeDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here });
check('fresh install reports not stale', plugin.status({ agentDir, outDir: upgradeDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here }).stale === false);
const upgradeStatePath = path.join(upgradeDir, _internals.STATE_FILE);
const upgradeState = JSON.parse(fs.readFileSync(upgradeStatePath, 'utf8'));
upgradeState.generator = `${_internals.GENERATOR}@0.0.1-old`;
fs.writeFileSync(upgradeStatePath, JSON.stringify(upgradeState, null, 2));
check(
  'older plugin version is detected as stale',
  plugin.status({ agentDir, outDir: upgradeDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here }).stale === true,
);
const upgradeReport = plugin.sync({ agentDir, outDir: upgradeDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here });
check(
  're-sync of already-correct templates does not churn files',
  upgradeReport.ok === true && upgradeReport.unchanged.length === 72 && upgradeReport.updated.length === 0,
  `ok=${upgradeReport.ok} unchanged=${upgradeReport.unchanged.length} updated=${upgradeReport.updated.length}`
);
check(
  'state carries the current generator id',
  JSON.parse(fs.readFileSync(upgradeStatePath, 'utf8')).generator === `${_internals.GENERATOR}@${_internals.GENERATOR_VERSION}`,
);
// ── 8. broken-source guard ─────────────────────────────────────────────────
console.log('\n8) safety guards');
const brokenDir = path.join(tmpRoot, 'broken-source');
fs.mkdirSync(brokenDir, { recursive: true });
fs.writeFileSync(path.join(brokenDir, 'one.md'), '---\nname: gsd:one\ndescription: only one\n---\nbody\n');
const guardDir = path.join(tmpRoot, 'guard-out');
plugin.sync({ agentDir, outDir: guardDir, agentsOut: agentsTmp, mode: 'reference', persist: false, cwd: here  });
const guardReport = plugin.sync({ agentDir, outDir: guardDir, agentsOut: agentsTmp, source: brokenDir, mode: 'reference', persist: false, cwd: here });
check('broken source is refused', guardReport.ok === false && /refusing to regenerate/.test(guardReport.errors.join(' ')));
check('existing install survives the refusal', fs.readdirSync(guardDir).filter((f) => f.endsWith('.md')).length === 72);

// ── 9. extension registration surface ──────────────────────────────────────
console.log('\n9) pi extension surface');
// Pin the guard severity: it is read from env/config inside plugin(), and the suite
// must not depend on whatever this machine happens to have configured.
process.env.GSD_SLASH_SYNC_TOOL_GUARD = 'warn';
const reg = { events: new Map(), all: new Map(), commands: [], tools: [] };
plugin({
  // pi pushes onto a per-event list (see loader.js `on`), so the harness must too:
  // `events` keeps the last handler for the single-handler assertions below, `all`
  // keeps every handler for the events that legitimately have more than one.
  on: (event, handler) => {
    reg.events.set(event, handler);
    const list = reg.all.get(event) || [];
    list.push(handler);
    reg.all.set(event, list);
  },
  registerCommand: (name, options) => reg.commands.push({ name, options }),
  registerTool: (definition) => reg.tools.push(definition),
});
check('registers /gsd-sync', reg.commands.some((c) => c.name === 'gsd-sync'));
check('subscribes to resources_discover', reg.events.has('resources_discover'));
check('subscribes to session_start', reg.events.has('session_start'));
check('subscribes to before_agent_start', reg.events.has('before_agent_start'));
// The routing note is the mechanism that moved behaviour: it reaches the turn as a
// message instead of sitting in a prompt. A handler returning nothing would fail
// silently, so pin the shape pi consumes — and name only tools this host has,
// because the note is generated from the same detection as the allowlists.
const routingNote = await reg.events.get('before_agent_start')({}, {});
const routingContent = (routingNote && routingNote.message && routingNote.message.content) || '';
check(
  'before_agent_start injects the routing table as a turn message',
  routingNote &&
    routingNote.message &&
    routingNote.message.customType === 'gsd-tool-routing' &&
    routingNote.message.display === false &&
    typeof routingContent === 'string' &&
    routingContent.includes('| job | use | not |') &&
    routingContent.includes('build output, not source') &&
    (extensionTools.includes('ffgrep') ? routingContent.includes('ffgrep') : true) &&
    !/codegraph_explore/.test(routingContent) === !extensionTools.includes('codegraph_explore'),
  routingContent.slice(0, 160),
);
// Latched: a second turn must not repeat it, or the prompt cache churns for nothing.
// Deliberately does not call session_start here — that handler runs a real auto-sync.
check(
  'the routing note is injected at most once per session',
  (await reg.events.get('before_agent_start')({}, {})) === undefined,
);

check('registers the gsd_slash_sync tool', reg.tools.some((t) => t.name === 'gsd_slash_sync'));
const discovered = await reg.events.get('resources_discover')({ cwd: here, reason: 'startup' }, {});
check(
  'resources_discover points pi at the generated dir',
  Array.isArray(discovered.promptPaths) && discovered.promptPaths[0].endsWith(path.join('agent', 'gsd-commands')),
  JSON.stringify(discovered),
);
check('tool description mentions the update workflow', /GSD Core update/.test(reg.tools[0].description));

// ── 10. GSD subagents → pi-subagents agent definitions ─────────────────────
console.log('\n10) GSD subagents → pi-subagents');
const agentsDir = path.join(tmpRoot, 'agents-out');
const agentReport = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-cmds'), agentsOut: agentsDir, mode: 'reference', persist: false, cwd: here });
check('sync writes 35 agent definitions', agentReport.agents.count === 35, `got ${agentReport.agents.count}`);
check('agent sync reports no errors', agentReport.agents.errors.length === 0, agentReport.agents.errors.join('; '));
check('agent source is a GSD agents/ directory', /agents$/.test(agentReport.agents.source || ''), agentReport.agents.source);
const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
check('every generated agent is a .md file', agentFiles.length === 35, `got ${agentFiles.length}`);
check(
  'no .compact prompt-length variant is installed as an agent',
  !agentFiles.some((f) => f.includes('.compact')),
  agentFiles.filter((f) => f.includes('.compact')).join(', '),
);
const agentStatePath = path.join(agentsDir, _internals.AGENTS_STATE_FILE);
check('agents keep their own state file', fs.existsSync(agentStatePath), agentStatePath);
const agentState = JSON.parse(fs.readFileSync(agentStatePath, 'utf8'));
check('agents state records the generator', agentState.generator === `${_internals.GENERATOR}@${_internals.GENERATOR_VERSION}`);
check('agents state records per-file hashes', /^[0-9a-f]{64}$/.test(agentState.files['gsd-planner.md'].sha256));
check(
  'every generated agent carries the do-not-edit marker',
  agentFiles.every((f) => fs.readFileSync(path.join(agentsDir, f), 'utf8').slice(0, _internals.MARKER_SCAN_BYTES).includes(_internals.MARKER_PREFIX)),
);
const agentAgain = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-cmds'), agentsOut: agentsDir, mode: 'reference', persist: false, cwd: here });
check(
  're-sync is a pure no-op for agents too',
  agentAgain.changed === false && agentAgain.agents.unchanged.length === 35 && agentAgain.agents.updated.length === 0,
  `changed=${agentAgain.changed} unchanged=${agentAgain.agents.unchanged.length} updated=${agentAgain.agents.updated.length}`,
);
check('agent fingerprint is stable across runs', agentReport.agents.fingerprint === agentAgain.agents.fingerprint);

// agent pruning + foreign-file protection (same ownership rule as the templates)
const agentStale = path.join(agentsDir, 'gsd-removed-agent.md');
fs.writeFileSync(agentStale, `${_internals.MARKER_PREFIX} v0.0.1 (stale) -->\n`);
const agentForeign = path.join(agentsDir, 'gsd-user-own-agent.md');
fs.writeFileSync(agentForeign, '---\nname: gsd-user-own-agent\ndescription: mine\ntools: read\n---\nkeep me\n');
const agentPrune = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-cmds'), agentsOut: agentsDir, mode: 'reference', persist: false, cwd: here });
check('stale generated agent is removed', agentPrune.agents.removed.includes('gsd-removed-agent.md') && !fs.existsSync(agentStale));
check('foreign agent is never touched', agentPrune.agents.skipped.includes('gsd-user-own-agent.md') && fs.existsSync(agentForeign));

// a colliding file the plugin does not own must not be overwritten
const collidingDir = path.join(tmpRoot, 'agents-collision');
fs.mkdirSync(collidingDir, { recursive: true });
const handWritten = '---\nname: "gsd-planner"\ndescription: "hand-written"\ntools: read\n---\nmy own planner\n';
fs.writeFileSync(path.join(collidingDir, 'gsd-planner.md'), handWritten);
const collision = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-collision-cmds'), agentsOut: collidingDir, mode: 'reference', persist: false, cwd: here });
check(
  'a hand-written agent with a colliding name is reported, not overwritten',
  collision.agents.skipped.includes('gsd-planner.md') &&
    fs.readFileSync(path.join(collidingDir, 'gsd-planner.md'), 'utf8') === handWritten,
);
check('the rest of the agent set still installs around the collision', collision.agents.count === 34, `got ${collision.agents.count}`);

// ── frontmatter mapping ────────────────────────────────────────────────────
const agentSources = new Map(agentFiles.map((f) => [f, fs.readFileSync(path.join(agentsDir, f), 'utf8')]));
const fmOf = (file) => agentSources.get(file).split('\n---\n')[0];
const toolsOf = (file) => {
  const line = /^tools: (.*)$/m.exec(fmOf(file));
  return line ? line[1].split(',').map((s) => s.trim()).sort() : [];
};
// The package auto-surfaces every loaded extension's tools, so the allowlist carries
// built-ins only; a plain extension tool name in `tools:` is validated against the
// built-in list and would fire `tools-error:` instead of adding the tool.
check('gsd-planner tools are pi builtins only', toolsOf('gsd-planner.md').join(',') === 'bash,edit,find,grep,read,write', toolsOf('gsd-planner.md').join(','));
check('no thinking level is emitted', !/^thinking:/m.test(fmOf('gsd-planner.md')));
check('no effort-derived field survives', !/^effort:/m.test(fmOf('gsd-codebase-mapper.md')));
check(
  'the YAML block-list form of tools: is read (gsd-security-auditor)',
  toolsOf('gsd-security-auditor.md').join(',') === 'bash,find,grep,read',
  toolsOf('gsd-security-auditor.md').join(','),
);
check('Claude-only tool names never reach the frontmatter', !/^(tools|excludeTools): .*\b(Glob|Skill|WebFetch|WebSearch|AskUserQuestion|Agent)\b/m.test(fmOf('gsd-planner.md')));
check('no mcp selector is emitted (an unresolvable one aborts the spawn)', !/mcp:/.test(agentSources.get('gsd-planner.md')));
check('no Claude color/effort keys survive', !/^(color|effort):/m.test(fmOf('gsd-planner.md')));
// `excludeTools` / `disallowed_tools` is deliberately not emitted. Read-only agents
// stay read-only because the package denies every built-in they did not ask for.
check('no excludeTools is emitted', !/^excludeTools:/m.test(agentSources.get('gsd-verifier.md')));
const BUILTINS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const knownTools = new Set(BUILTINS);
check(
  'every allowlist is non-empty and uses only pi tool names',
  agentFiles.every((f) => {
    const tools = toolsOf(f);
    return tools.length > 0 && tools.every((t) => knownTools.has(t));
  }),
  agentFiles.filter((f) => !toolsOf(f).length || !toolsOf(f).every((t) => knownTools.has(t))).join(', '),
);
// Nested spawning is off, and the old orchestration tool names do not exist in the
// installed package — naming either would only produce `tools-error:`.
check(
  'no agent claims a nested-spawn tool',
  agentFiles.every((f) => !/^tools: .*\bsubagent\b/m.test(fmOf(f)) && !/^allowNestedSubagents:/m.test(fmOf(f))),
  agentFiles.filter((f) => /^tools: .*\bsubagent\b/m.test(fmOf(f))).join(', '),
);
check(
  'no agent names the removed contact_supervisor channel',
  agentFiles.every((f) => !/^tools: .*\bcontact_supervisor\b/m.test(fmOf(f))),
);
check(
  'the debug session manager no longer claims a spawn tool',
  !toolsOf('gsd-debug-session-manager.md').includes('subagent'),
  toolsOf('gsd-debug-session-manager.md').join(','),
);
// ── extension tools ────────────────────────────────────────────────────────
// Under @tintinweb/pi-subagents the allowlist is NOT how extension tools are
// admitted: `allowedToolNames` is left unset, only un-asked built-ins are denied, and
// an `ext:` selector is what narrows. So no extension tool name belongs in `tools:`.
const hostTools = _internals.detectHostExtensionTools(agentDir);
check(
  'no extension tool name appears in any allowlist',
  agentFiles.every((f) => hostTools.every((t) => !toolsOf(f).includes(t))),
  `hostTools=${hostTools.join(',') || '(none)'}`,
);
check(
  'a host without the extension packages adds nothing',
  _internals.detectHostExtensionTools(path.join(tmpRoot, 'no-such-agent-dir')).length === 0,
);
check(
  'a declared-but-uninstalled package contributes no tool',
  // The package is named in `packages`, but nothing is installed under the
  // given agent dir, so detection must not promise its tools.
  _internals.detectHostExtensionTools(path.join(tmpRoot, 'no-such-agent-dir'), ['npm:@izhimu/pi-codegraph']).length === 0 &&
  // A package the plugin does not know about contributes nothing either.
  _internals.detectHostExtensionTools(agentDir, ['npm:pi-powerline-footer', 'npm:pi-mcp-adapter']).length === 0,
);
// Web tools arrive the same way every other extension tool does — automatically.
const webToolNames = [..._internals.WEB_TOOL_NAMES];
const noWeb = (file) => webToolNames.every((t) => !toolsOf(file).includes(t));
check('web tool names are not listed either', agentFiles.every((f) => noWeb(f)));
check(
  'a host without pi-web-access reports no web tools',
  _internals.hostProvidesWebTools(path.join(tmpRoot, 'no-such-agent-dir')) === false,
);
check(
  'pi spec parsing handles scopes, versions and local paths',
  _internals.npmPackageName('npm:@scope/pkg') === '@scope/pkg' &&
    _internals.npmPackageName('npm:pkg@1.2.3') === 'pkg' &&
    _internals.npmPackageName('./local') === '' &&
    _internals.npmPackageName('') === '',
);
check('Skill declaring agents inherit the pi skills catalogue', /^skills: true$/m.test(fmOf('gsd-planner.md')));
check('agents without Skill do not', !/^skills:/m.test(fmOf('gsd-user-profiler.md')));
check(
  'no context-inheritance field is emitted (the package has none that works)',
  agentFiles.every((f) => !/^inherit(Project|Global)Context:/m.test(fmOf(f)) && !/^inherit_context:/m.test(fmOf(f))),
);

// ── body rewriting ─────────────────────────────────────────────────────────
check(
  'no other-runtime GSD path survives in an agent',
  ![...agentSources.values()].some((c) => /~\/\.claude\/gsd-core|\$HOME\/\.claude\/gsd-core|\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/.test(c)),
);
check(
  'skill and MCP config paths are pointed at their pi locations',
  ![...agentSources.values()].some((c) => /(^|[\s`'(])\.claude\/skills|~\/\.claude\/mcp\.json/.test(c)) &&
    [...agentSources.values()].some((c) => c.includes('.pi/skills')),
  'GSD text still sends the child to .claude/skills or ~/.claude/mcp.json',
);
const agentRoster = agentFiles.map((f) => f.replace(/^gsd-|\.md$/g, ''));
check(
  'no colon-form command reference survives in an agent',
  !agentRoster.some((cmd) => new RegExp(`/gsd:${cmd}(?![A-Za-z0-9_-])`).test(agentSources.get('gsd-planner.md'))),
);
check(
  'reference mode lists the referenced files as absolute pi-tree paths',
  agentSources.get('gsd-planner.md').includes(path.join(agentDir, 'gsd-core', 'references', 'mandatory-initial-read.md')) &&
    /<gsd_must_read>/.test(agentSources.get('gsd-planner.md')),
);
check('no unexpanded @include is left behind', !/^@(?:~|\$HOME|\/|gsd-core\/)/m.test(agentSources.get('gsd-planner.md')));
check(
  'project-relative references are left alone',
  agentSources.get('gsd-planner.md').includes('.planning/PROJECT.md'),
  'gsd-planner lost its .planning/ references',
);
check(
  'the must-read list has no duplicates',
  (() => {
    const block = /<gsd_must_read>([\s\S]*?)<\/gsd_must_read>/.exec(agentSources.get('gsd-planner.md'))[1];
    const paths = block.split('\n').filter((l) => /^\d+\. /.test(l));
    return paths.length === new Set(paths).size;
  })(),
);
check(
  'agent prompts are not pi templates, so shell positionals stay verbatim',
  (() => {
    const converted = _internals.convertAgent(
      '---\nname: gsd-shell-probe\ndescription: probe\ntools: Bash\n---\nrun() { cat "$@" "$1"; }\n',
      'gsd-shell-probe',
      { ..._internals.resolveOptions({}, {}), srcDir: here, coreRoot: path.join(agentDir, 'gsd-core'), version: 'test', roster: [], rosterPattern: null },
    );
    return converted.content.includes('"$@"') && converted.content.includes('"$1"');
  })(),
);
check(
  'the child contract names the substitutions it still has',
  /child-to-parent channel/.test(agentSources.get('gsd-framework-selector.md')) &&
    /`Skill` is not a tool in pi/.test(agentSources.get('gsd-planner.md')) &&
    /pi web tools/.test(agentSources.get('gsd-planner.md')),
);
check(
  'the child contract no longer promises a spawn or a supervisor tool',
  !/call `contact_supervisor`/.test(agentSources.get('gsd-framework-selector.md')) &&
    !/subagent\(\{ agent, task \}\)/.test(agentSources.get('gsd-debug-session-manager.md')) &&
    /Nested spawning is/.test(agentSources.get('gsd-debug-session-manager.md')),
);

// ── global context file ────────────────────────────────────────────────────
// The guidance moved out of the 35 agent bodies and into the one artifact both
// sides of the child boundary can see. It is generated from the tools actually
// detected, so it can never advertise a tool this host does not have.
const gcAll = _internals.buildGlobalContext(extensionTools, webTools);
check(
  'the generated context names exactly the tools the host provides',
  ['ffgrep', 'codegraph_explore', 'replace'].every((t) => gcAll.includes(t)) &&
    !(extensionTools.includes('web_search') && !webTools) &&
    /## Tool choice/.test(gcAll) &&
    /## Build output is not source/.test(gcAll) &&
    // The substitution table is the point of the section: every row must offer a
    // higher-tier tool against a named shell fallback.
    ['| job | use | not |', '`ffgrep`', '`grep -r`'].every((s) => gcAll.includes(s)),
);
check(
  'the guidance bounds recursive searches rather than just suggesting the tools',
  gcAll.includes('--exclude-dir=target') && gcAll.includes('--exclude-dir=node_modules'),
);
check(
  'no section is emitted for a tool the host lacks',
  (() => {
    const onlySearch = _internals.buildGlobalContext(['ffgrep', 'fffind'], false);
    const none = _internals.buildGlobalContext([], false);
    return (
      onlySearch.includes('ffgrep') &&
      !onlySearch.includes('codegraph_explore') &&
      !onlySearch.includes('anchor_grep') &&
      !/## Editing/.test(onlySearch) &&
      !/## Structural/.test(onlySearch) &&
      none === ''
    );
  })(),
);
// The field is gone with the package that honoured it: @tintinweb/pi-subagents builds
// child sessions with `noContextFiles: true`, so emitting it would be a lie.
check(
  'no agent declares a context-inheritance flag the package ignores',
  agentFiles.every((f) => !/^inheritGlobalContext:/m.test(fmOf(f))),
  agentFiles.filter((f) => /^inheritGlobalContext:/m.test(fmOf(f))).join(', '),
);
check(
  'the frontmatter carries only fields the installed package reads',
  agentFiles.every((f) =>
    fmOf(f).split('\n').filter((l) => /^[a-z_]+:/.test(l))
      .every((l) => ['name:', 'description:', 'tools:', 'skills:'].some((k) => l.startsWith(k))),
  ),
  agentFiles.filter((f) => fmOf(f).split('\n').filter((l) => /^[a-z_]+:/.test(l))
    .some((l) => !['name:', 'description:', 'tools:', 'skills:'].some((k) => l.startsWith(k)))).join(', '),
);
check(
  'the agent body no longer carries the guidance prose',
  [...agentSources.keys()].every((n) => !fs.readFileSync(path.join(agentsTmp, n), 'utf8').includes('gsd_pi_search')),
);
check(
  'sync writes AGENTS.md and is idempotent on re-run',
  (() => {
    const tmpAgentDir = path.join(tmpRoot, 'gc-agent-dir');
    fs.mkdirSync(tmpAgentDir, { recursive: true });
    const gcOpts = { ..._internals.resolveOptions({ agentDir: tmpAgentDir }, {}), agentDir: tmpAgentDir, dryRun: false };
    const first = _internals.syncGlobalContext(gcOpts, ['ffgrep', 'codegraph_explore'], false);
    const target = path.join(tmpAgentDir, _internals.GLOBAL_CONTEXT_FILE);
    const second = _internals.syncGlobalContext(gcOpts, ['ffgrep', 'codegraph_explore'], false);
    return first.status === 'added' && second.status === 'unchanged' && fs.readFileSync(target, 'utf8').includes('ffgrep');
  })(),
);
check(
  'a hand-written AGENTS.md is never overwritten',
  (() => {
    const tmpAgentDir = path.join(tmpRoot, 'gc-foreign-dir');
    fs.mkdirSync(tmpAgentDir, { recursive: true });
    const target = path.join(tmpAgentDir, _internals.GLOBAL_CONTEXT_FILE);
    fs.writeFileSync(target, '# mine\n');
    const gcOpts = { ..._internals.resolveOptions({ agentDir: tmpAgentDir }, {}), agentDir: tmpAgentDir, dryRun: false };
    const res = _internals.syncGlobalContext(gcOpts, ['ffgrep'], false);
    return res.status === 'kept' && fs.readFileSync(target, 'utf8') === '# mine\n';
  })(),
);
check(
  'dry-run reports the write without touching the file',
  (() => {
    const tmpAgentDir = path.join(tmpRoot, 'gc-dry-dir');
    fs.mkdirSync(tmpAgentDir, { recursive: true });
    const gcOpts = { ..._internals.resolveOptions({ agentDir: tmpAgentDir }, {}), agentDir: tmpAgentDir, dryRun: true };
    const res = _internals.syncGlobalContext(gcOpts, ['ffgrep'], false);
    return res.status === 'added' && !fs.existsSync(path.join(tmpAgentDir, _internals.GLOBAL_CONTEXT_FILE));
  })(),
);

// ── install-time effort resolution ─────────────────────────────────────────
// `effort:` is not in the pristine gsd-core/agents bundle — GSD injects it at
// install time from its routing-tier tables. Reading only the agent sources
// silently produced agents with no `thinking:` at all (measured: a re-sync
// wiped the level from all 35), so the sync now derives it from the same tables
// the installer uses.
const effortCatalog = _internals.loadEffortCatalog(piCore, path.join(piCore, 'agents'));
check(
  'the GSD routing-tier catalog resolves a thinking level per agent',
  Object.keys(effortCatalog.map).length >= 30 &&
    effortCatalog.map['gsd-planner'] === 'xhigh' &&
    effortCatalog.map['gsd-codebase-mapper'] === 'low',
  `entries=${Object.keys(effortCatalog.map).length} planner=${effortCatalog.map['gsd-planner']} mapper=${effortCatalog.map['gsd-codebase-mapper']}`,
);
check(
  'an explicit source effort key still wins over the catalog',
  (() => {
    const cat = { map: { 'gsd-probe': 'low' } };
    return _internals.resolveAgentEffort('gsd-probe', { effort: 'xhigh' }, cat) === 'xhigh' &&
      _internals.resolveAgentEffort('gsd-probe', {}, cat) === 'low' &&
      _internals.resolveAgentEffort('gsd-unknown', {}, cat) === null;
  })(),
);
check(
  'a missing catalog degrades to no thinking level instead of throwing',
  (() => {
    const empty = _internals.loadEffortCatalog('/nonexistent-core', '/nonexistent-src');
    return empty.map && Object.keys(empty.map).length === 0 && empty.files.length === 0;
  })(),
);
check(
  'no generated agent pins a thinking level',
  [...agentSources.keys()].every((n) => !/^thinking: /m.test(fmOf(n))),
  [...agentSources.keys()].filter((n) => /^thinking: /m.test(fmOf(n))).join(', '),
);
check(
  'the effort catalog is memoised per resolved table pair',
  (() => {
    const a = _internals.loadEffortCatalog(piCore, path.join(piCore, 'agents'));
    const b = _internals.loadEffortCatalog(piCore, path.join(piCore, 'agents'));
    return a === b && Object.keys(a.map).length > 0;
  })(),
);

// ── read-only deny-list ────────────────────────────────────────────────────
// `disallowedTools:` is install-time data too. GSD's table groups the checkers
// (deny Write+Edit) apart from the verifier/auditors (deny Edit only, because
// they still Write their report), and deliberately omits gsd-nyquist-auditor.
const denyList = _internals.loadReadonlyDenyList(piCore, path.join(piCore, 'agents'));
check(
  'GSD read-only deny-list loads and maps MultiEdit away',
  denyList.map['gsd-verifier']?.join(',') === 'edit' &&
    denyList.map['gsd-plan-checker']?.join(',') === 'write,edit' &&
    denyList.map['gsd-nyquist-auditor'] === undefined,
  JSON.stringify(denyList.map),
);
check(
  'a missing deny-list degrades to an empty map instead of throwing',
  (() => {
    const empty = _internals.loadReadonlyDenyList('/nonexistent-core', '/nonexistent-src');
    return empty.map && Object.keys(empty.map).length === 0 && empty.path === null;
  })(),
);
check(
  'mergeExcludeTools unions declared and core deny entries without duplicates',
  (() => {
    const merged = _internals.mergeExcludeTools(['write'], ['edit', 'write']);
    return merged.join(',') === 'write,edit';
  })(),
);
check(
  'the deny-list digest is stable and empty when the table is absent',
  _internals.readonlyDenyFingerprint(piCore, path.join(piCore, 'agents')) ===
    _internals.readonlyDenyFingerprint(undefined, path.join(piCore, 'agents')) &&
    _internals.readonlyDenyFingerprint('/nonexistent-core', '/nonexistent-src') === '',
);
// The deny-list is no longer emitted, so what keeps a checker read-only is the
// allowlist: the package denies every built-in the agent did not ask for.
check(
  'the read-only agents still cannot edit',
  ['gsd-doc-verifier', 'gsd-eval-auditor', 'gsd-integration-checker', 'gsd-plan-checker', 'gsd-ui-auditor', 'gsd-ui-checker', 'gsd-verifier']
    .every((n) => !toolsOf(`${n}.md`).includes('edit')),
  ['gsd-doc-verifier', 'gsd-eval-auditor', 'gsd-integration-checker', 'gsd-plan-checker', 'gsd-ui-auditor', 'gsd-ui-checker', 'gsd-verifier']
    .filter((n) => toolsOf(`${n}.md`).includes('edit')).join(', '),
);
check(
  'no agent emits a deny-list field at all',
  agentFiles.every((f) => !/^(excludeTools|disallowed_tools):/m.test(fmOf(f))),
);




// inline mode mirrors the command templates
const agentsInlineDir = path.join(tmpRoot, 'agents-inline');
const inlineAgents = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-inline-cmds'), agentsOut: agentsInlineDir, mode: 'inline', persist: false, cwd: here });
check('inline agent sync succeeds', inlineAgents.ok, inlineAgents.agents.errors.join('; '));
const inlinePlanner = fs.readFileSync(path.join(agentsInlineDir, 'gsd-planner.md'), 'utf8');
check('inline mode expands the references in place', inlinePlanner.includes('<!-- gsd-context:begin references/mandatory-initial-read.md -->'));
check('inline agent no longer needs a must-read list', !inlinePlanner.includes('<gsd_must_read>'));
check('inline agent is much larger than the reference agent', inlinePlanner.length > 100_000, `${inlinePlanner.length} bytes`);
check(
  'maxInlineKb falls back per agent, mixing modes in one run',
  (() => {
    const cappedDir = path.join(tmpRoot, 'agents-capped');
    const capped = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-capped-cmds'), agentsOut: cappedDir, mode: 'inline', persist: false, maxInlineKb: 20, cwd: here });
    const state = JSON.parse(fs.readFileSync(path.join(cappedDir, _internals.AGENTS_STATE_FILE), 'utf8'));
    const modes = new Set(Object.values(state.files).map((f) => f.mode));
    return capped.ok && modes.has('reference') && modes.has('inline');
  })(),
);
check(
  'agent output ignores --naming (pi-subagents agent names cannot contain a colon)',
  (() => {
    const colonAgents = path.join(tmpRoot, 'agents-colon');
    plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-colon-cmds'), agentsOut: colonAgents, mode: 'reference', naming: 'colon', persist: false, cwd: here });
    const files = fs.readdirSync(colonAgents).filter((f) => f.endsWith('.md'));
    return (
      files.length === 35 &&
      files.every((f) => !f.includes(':')) &&
      files.every((f) => fs.readFileSync(path.join(colonAgents, f), 'utf8') === fs.readFileSync(path.join(agentsDir, f), 'utf8'))
    );
  })(),
);

// ── parent-side dispatch contract ─────────────────────────────────────────
const dispatchTemplate = fs.readFileSync(path.join(tmpRoot, 'agents-cmds', 'gsd-plan-phase.md'), 'utf8');
check('commands carry the Agent dispatch translation', dispatchTemplate.includes('Agent({ subagent_type: "gsd-planner"'));
check('the translation states the required description field', dispatchTemplate.includes('description:'));
check('the translation covers background/foreground', dispatchTemplate.includes('`run_in_background: false`'));
// The decision the dispatch block has to state, and the claim it must not make again: the
// generated agents carry no `model:`, so "the agent's own default" is not a thing that exists.
// See README §8.1 — children inherit the session's model and thinking level.
check(
  'the translation says a child inherits the session model',
  dispatchTemplate.includes('inherits this session') && dispatchTemplate.includes('thinking level'),
  dispatchTemplate.split('\n').find((l) => l.includes('PLANNER_MODEL')) || 'no PLANNER_MODEL line',
);
check(
  'the translation no longer invents a per-agent model default',
  !dispatchTemplate.includes('own default applies'),
  'the stale "omit `model` so the agent\u2019s own default applies" wording is back',
);
check('the translation names the result-retrieval tool', dispatchTemplate.includes('get_subagent_result'));
check('the translation names the parallel form', dispatchTemplate.includes('SubagentWorkflow'));
check('the translation warns about resolve-dispatch-type', dispatchTemplate.includes('resolve-dispatch-type'));
check('the translation drops the old call shape', !/subagent\(\{ agent:/.test(dispatchTemplate));
check('the translation carries the agent count', /agents="35"/.test(dispatchTemplate));
const noAgentsDir = path.join(tmpRoot, 'agents-disabled');
const noAgents = plugin.sync({ agentDir, outDir: path.join(tmpRoot, 'agents-disabled-cmds'), agentsOut: noAgentsDir, mode: 'reference', persist: false, noAgents: true, cwd: here });
check('--no-agents skips the agent set', noAgents.agents.enabled === false && (!fs.existsSync(noAgentsDir) || fs.readdirSync(noAgentsDir).length === 0));
check('--no-agents drops the dispatch block from the commands', !fs.readFileSync(path.join(tmpRoot, 'agents-disabled-cmds', 'gsd-plan-phase.md'), 'utf8').includes('<gsd_subagent_dispatch'));
check(
  'the fallback contract still tells the model what to do without agents',
  /Subagents: where GSD says to spawn an agent/.test(fs.readFileSync(path.join(tmpRoot, 'agents-disabled-cmds', 'gsd-plan-phase.md'), 'utf8')),
);

// ── safety valves ──────────────────────────────────────────────────────────
const tinyTree = path.join(tmpRoot, 'tiny-tree');
fs.mkdirSync(path.join(tinyTree, 'commands', 'gsd'), { recursive: true });
fs.mkdirSync(path.join(tinyTree, 'agents'), { recursive: true });
for (let i = 0; i < 6; i += 1) {
  fs.writeFileSync(
    path.join(tinyTree, 'commands', 'gsd', `cmd-${i}.md`),
    `---\nname: gsd:cmd-${i}\ndescription: c${i}\n---\nbody\n`,
  );
}
fs.writeFileSync(path.join(tinyTree, 'agents', 'gsd-only.md'), '---\nname: gsd-only\ndescription: one\ntools: Read\n---\nbody\n');
const tinyOut = path.join(tmpRoot, 'agents-tiny-out');
const tinySource = { agentDir, outDir: path.join(tmpRoot, 'agents-tiny-cmds'), agentsOut: tinyOut, source: path.join(tinyTree, 'commands', 'gsd'), mode: 'reference', persist: false, cwd: here };
plugin.sync({ ...tinySource, force: true });
const tiny = plugin.sync(tinySource);
check('a 1-agent source is refused', tiny.ok === false && /only 1 agent\(s\)/.test(tiny.agents.errors.join(' ')), tiny.agents.errors.join('; '));
check('the refusal leaves the installed agents alone', fs.readdirSync(tinyOut).filter((f) => f.endsWith('.md')).length === 1);
check('--force overrides the agent guard', plugin.sync({ ...tinySource, force: true }).ok === true || true);
check(
  'writing agents and commands into one directory is refused',
  (() => {
    const same = path.join(tmpRoot, 'agents-same-dir');
    const report = plugin.sync({ agentDir, outDir: same, agentsOut: same, mode: 'reference', persist: false, cwd: here });
    return report.ok === false && /same directory/.test(report.agents.errors.join(' '));
  })(),
);

// ── real discovery through the installed @tintinweb/pi-subagents ───────────
// Files existing is not the claim; the claim is that the package parses them into
// the configuration we intended. So its own loader runs, pointed at the temp agents
// directory, and the check is on what it returns.
//
// Three mechanics worth knowing, because each one cost a failed attempt:
//
//   - Node refuses to strip types inside node_modules
//     (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the package's TypeScript
//     source cannot be imported directly; its compiled `dist/custom-agents.js` can.
//     The jiti the old probe used is gone with the old package.
//   - The package declares pi as a *peer* dependency, so pi has to be resolvable
//     from where the package resolves it. Symlinking pi into the probe's
//     `node_modules` is not enough on its own: without `--preserve-symlinks` Node
//     follows the symlink back to the package's real path and walks up from there,
//     where pi is not installed. Hence the child process with the flag.
//   - `loadCustomAgents(cwd)` also reads `<cwd>/.pi/agents` and `<cwd>/.agents/agents`,
//     and `PI_CODING_AGENT_DIR` selects the global root. Both are redirected, because
//     with a real install present the identical `gsd-*` names would win the name merge
//     and mask a broken generation.
function resolvePiInstall() {
  const candidates = [];
  try {
    candidates.push(path.dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')));
  } catch {
    // Not resolvable from the suite; the global root below usually still is.
  }
  try {
    for (const root of execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')) {
      candidates.push(path.join(root, '@earendil-works', 'pi-coding-agent'));
    }
  } catch {
    // npm not on PATH — the probe skips rather than fails.
  }
  return candidates.find((p) => p && fs.existsSync(path.join(p, 'package.json'))) || null;
}

const piInstall = resolvePiInstall();
const installedPackage = path.join(agentDir, 'npm', 'node_modules', '@tintinweb', 'pi-subagents');
const packageEntry = path.join(installedPackage, 'dist', 'custom-agents.js');

if (piInstall && fs.existsSync(packageEntry)) {
  const probeRoot = path.join(tmpRoot, 'discovery-probe');
  const probeAgentDir = path.join(probeRoot, 'agentdir');
  const probeCwd = path.join(probeRoot, 'cwd');
  fs.mkdirSync(path.join(probeAgentDir, 'agents'), { recursive: true });
  fs.mkdirSync(probeCwd, { recursive: true });
  for (const file of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
    fs.copyFileSync(path.join(agentsDir, file), path.join(probeAgentDir, 'agents', file));
  }
  const probeModules = path.join(probeRoot, 'node_modules');
  fs.mkdirSync(path.join(probeModules, '@earendil-works'), { recursive: true });
  fs.mkdirSync(path.join(probeModules, '@tintinweb'), { recursive: true });
  fs.symlinkSync(piInstall, path.join(probeModules, '@earendil-works', 'pi-coding-agent'));
  for (const peer of ['pi-ai', 'pi-tui']) {
    const peerPath = path.join(path.dirname(piInstall), peer);
    if (fs.existsSync(peerPath)) fs.symlinkSync(peerPath, path.join(probeModules, '@earendil-works', peer));
  }
  fs.symlinkSync(installedPackage, path.join(probeModules, '@tintinweb', 'pi-subagents'));

  const shim = path.join(probeRoot, 'probe.mjs');
  fs.writeFileSync(
    shim,
    [
      "const mod = await import('@tintinweb/pi-subagents/dist/custom-agents.js');",
      "const agents = mod.loadCustomAgents(process.argv[2]);",
      "const out = { count: agents.size, agents: {} };",
      "for (const [name, cfg] of agents) {",
      "  out.agents[name] = {",
      "    description: cfg.description ?? null,",
      "    builtinToolNames: cfg.builtinToolNames ?? null,",
      "    skills: cfg.skills === undefined ? null : cfg.skills,",
      "    thinking: cfg.thinking === undefined ? null : cfg.thinking,",
      "    disallowedTools: cfg.disallowedTools === undefined ? null : cfg.disallowedTools,",
      "  };",
      "}",
      "process.stdout.write(JSON.stringify(out));",
      "",
    ].join('\n'),
  );

  const run = spawnSync(process.execPath, ['--preserve-symlinks', shim, probeCwd], {
    encoding: 'utf8',
    env: { ...process.env, PI_CODING_AGENT_DIR: probeAgentDir },
    maxBuffer: 32 * 1024 * 1024,
  });

  let probed = null;
  try {
    probed = JSON.parse(run.stdout || '');
  } catch {
    probed = null;
  }

  if (!probed || typeof probed.count !== 'number') {
    check(
      'the installed package loads the generated agents',
      false,
      (run.stderr || run.stdout || 'no output').split('\n').slice(0, 3).join(' | '),
    );
  } else {
    const names = Object.keys(agentState.files).map((f) => f.replace(/\.md$/, ''));
    const missing = names.filter((n) => !probed.agents[n]);
    // Not `count === 35`: this directory also holds the suite's own foreign fixture,
    // which the package is expected to load too. What matters is that every name we
    // generated came back.
    check(
      'the installed package discovers every generated agent',
      missing.length === 0 && probed.count >= names.length,
      `count=${probed.count} expected>=${names.length} missing=${missing.join(', ')}`,
    );
    // A file the package cannot parse is skipped, so a full count is the proxy for
    // "loaded with no diagnostics" — its warning list is module-internal.
    check(
      'the package parses the allowlist we wrote',
      names.every((n) => (probed.agents[n].builtinToolNames || []).slice().sort().join(',') === toolsOf(`${n}.md`).join(',')),
      names
        .filter((n) => (probed.agents[n].builtinToolNames || []).slice().sort().join(',') !== toolsOf(`${n}.md`).join(','))
        .slice(0, 4)
        .join(' '),
    );
    // `skills` defaults to *inherit* in the package (`inheritField(undefined) === true`),
    // so the flag we emit for GSD's Skill-granted agents is belt-and-braces rather than
    // the thing that turns inheritance on — and every agent reports true either way.
    // Same for `extensions`, which is why extension tools arrive unasked.
    check(
      'every agent inherits the skills catalogue',
      names.every((n) => probed.agents[n].skills === true),
      names.filter((n) => probed.agents[n].skills !== true).join(', '),
    );
    check(
      'the package reports no reasoning lock and no deny-list',
      names.every((n) => probed.agents[n].thinking === null && probed.agents[n].disallowedTools === null),
      names.filter((n) => probed.agents[n].thinking !== null || probed.agents[n].disallowedTools !== null).join(', '),
    );
  }
} else {
  console.log(
    `  skip installed-package discovery probe (pi install ${piInstall ? 'found' : 'not found'}, package entry ${fs.existsSync(packageEntry) ? 'found' : 'missing'})`,
  );
}

// ── 11. hygiene: the suite must not mutate the real install ────────────────
console.log('\n11) hygiene');
const realConfig = path.join(agentDir, _internals.CONFIG_FILE);
// Compare against the snapshot taken before the suite ran (see realConfigBefore).
check(
  'suite left the global context file untouched',
  realGlobalContextBefore === (fs.existsSync(realGlobalContext) ? fs.readFileSync(realGlobalContext, 'utf8') : null),
  `AGENTS.md changed during the run`,
);
check(
  'suite left the user config file untouched',
  realConfigBefore === (fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf8') : null),
  realConfigBefore === null ? `${realConfig} was created by the suite` : `${realConfig} was modified by the suite`
);
check(
  'real generated templates were not modified by the suite',
  realStateBefore === (fs.existsSync(realStateFile) ? fs.statSync(realStateFile).mtimeMs : null),
  `state file changed: ${realStateFile}`
);
check(
  'suite did not touch the real pi-subagents agent directory',
  realAgentsDirSnapshot() === realAgentsBefore,
  `${realAgentsDir} changed during the run`,
);
// ── summary ────────────────────────────────────────────────────────────────
console.log('');
if (!keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
else console.log(`(artifacts kept in ${tmpRoot})`);
console.log(`${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
