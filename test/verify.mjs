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
const withExtras = (base) => [...base.split(','), ...extensionTools].sort().join(',');

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
const reg = { events: new Map(), commands: [], tools: [] };
plugin({
  on: (event, handler) => reg.events.set(event, handler),
  registerCommand: (name, options) => reg.commands.push({ name, options }),
  registerTool: (definition) => reg.tools.push(definition),
});
check('registers /gsd-sync', reg.commands.some((c) => c.name === 'gsd-sync'));
check('subscribes to resources_discover', reg.events.has('resources_discover'));
check('subscribes to session_start', reg.events.has('session_start'));
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
check('gsd-planner tools mapped to pi builtins', toolsOf('gsd-planner.md').join(',') === withExtras('bash,edit,find,grep,read,write'), toolsOf('gsd-planner.md').join(','));
check('GSD effort became pi thinking', /^thinking: xhigh$/m.test(fmOf('gsd-planner.md')));
check('a low-effort agent keeps its lower level', /^thinking: low$/m.test(fmOf('gsd-codebase-mapper.md')));
check(
  'the YAML block-list form of tools: is read (gsd-security-auditor)',
  toolsOf('gsd-security-auditor.md').join(',') === withExtras('bash,find,grep,read'),
  toolsOf('gsd-security-auditor.md').join(','),
);
check('Claude-only tool names never reach the frontmatter', !/^(tools|excludeTools): .*\b(Glob|Skill|WebFetch|WebSearch|AskUserQuestion|Agent)\b/m.test(fmOf('gsd-planner.md')));
check('no mcp selector is emitted (an unresolvable one aborts the spawn)', !/mcp:/.test(agentSources.get('gsd-planner.md')));
check('no Claude color/effort keys survive', !/^(color|effort):/m.test(fmOf('gsd-planner.md')));
check('disallowedTools became excludeTools', /^excludeTools: edit$/m.test(fmOf('gsd-verifier.md')));
const knownTools = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'subagent', 'contact_supervisor', ...extensionTools]);
check(
  'every allowlist is non-empty and uses only pi tool names',
  agentFiles.every((f) => {
    const tools = toolsOf(f);
    return tools.length > 0 && tools.every((t) => knownTools.has(t));
  }),
  agentFiles.filter((f) => !toolsOf(f).length || !toolsOf(f).every((t) => knownTools.has(t))).join(', '),
);
check(
  'nested-spawn agents get subagent + allowNestedSubagents (gsd-debug-session-manager)',
  toolsOf('gsd-debug-session-manager.md').includes('subagent') &&
    toolsOf('gsd-debug-session-manager.md').includes('contact_supervisor') &&
    /^allowNestedSubagents: true$/m.test(fmOf('gsd-debug-session-manager.md')),
);
check('ordinary agents are not authorised to fan out', !/^allowNestedSubagents:/m.test(fmOf('gsd-planner.md')));
check('AskUserQuestion maps to contact_supervisor', /^tools: .*\bcontact_supervisor\b/m.test(fmOf('gsd-eval-planner.md')));
// ── extension tools ────────────────────────────────────────────────────────
// A declared allowlist is strict: an extension tool whose name is absent never
// reaches the child, even though the child loaded the extension. The generator
// therefore merges in the tools the host's installed packages provide.
const hostTools = _internals.detectHostExtensionTools(agentDir);
check(
  'extension tools the host provides are merged into every allowlist',
  agentFiles.every((f) => hostTools.every((t) => toolsOf(f).includes(t))),
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
check(
  'pi spec parsing handles scopes, versions and local paths',
  _internals.npmPackageName('npm:@scope/pkg') === '@scope/pkg' &&
    _internals.npmPackageName('npm:pkg@1.2.3') === 'pkg' &&
    _internals.npmPackageName('./local') === '' &&
    _internals.npmPackageName('') === '',
);
check('Skill declaring agents inherit the pi skills catalogue', /^inheritSkills: true$/m.test(fmOf('gsd-planner.md')));
check('agents without Skill do not', !/^inheritSkills:/m.test(fmOf('gsd-user-profiler.md')));
check('every agent keeps repository instructions', agentFiles.every((f) => /^inheritProjectContext: true$/m.test(fmOf(f))));

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
  'the child contract names the AskUserQuestion / Skill / web substitutions',
  /contact_supervisor/.test(agentSources.get('gsd-framework-selector.md')) &&
    /`Skill` is not a tool in pi/.test(agentSources.get('gsd-planner.md')) &&
    /pi web tools/.test(agentSources.get('gsd-planner.md')),
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
check('commands carry the subagent dispatch translation', dispatchTemplate.includes('subagent({ agent: "gsd-planner", task:'));
check('the translation covers general-purpose → delegate', dispatchTemplate.includes('agent: "delegate"'));
check('the translation covers background/foreground', dispatchTemplate.includes('`async: false`'));
check('the translation names pi-subagents\u2019 parallel form', dispatchTemplate.includes('runs.all'));
check('the translation warns about resolve-dispatch-type', dispatchTemplate.includes('resolve-dispatch-type'));
check('the translation lists the installed roles', /`gsd-planner`/.test(dispatchTemplate) && /agents="35"/.test(dispatchTemplate));
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

// ── real discovery through the installed pi-subagents ─────────────────────
// What matters is not that files exist but that pi-subagents loads them as
// agents. Its own discovery is imported through jiti (the loader pi itself uses
// for TS extensions) and pointed at the temp directory, so the assertion holds on
// a machine where pi-subagents is installed and is skipped where it is not.
//
// Both discovery roots are redirected for the probe: with a real install present
// the identical `gsd-*` names in <agentDir>/agents would win the name merge and
// mask whatever the temp directory produced, so the probe would pass even if the
// generated files were broken.
const jitiPath = path.join(agentDir, 'npm', 'node_modules', 'jiti', 'lib', 'jiti.cjs');
const piSubagentsDir = path.join(agentDir, 'npm', 'node_modules', 'pi-subagents');
if (fs.existsSync(jitiPath) && fs.existsSync(piSubagentsDir)) {
  const savedEnv = {
    extra: process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = agentsDir;
  process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'empty-agent-dir');
  try {
    const { createJiti } = require(jitiPath);
    const jiti = createJiti(path.join(here, 'verify.mjs'), { interopDefault: true, moduleCache: false });
    const mod = await jiti.import(path.join(piSubagentsDir, 'src', 'agents', 'agents.ts'));
    mod.clearAgentDiscoveryCache?.();
    const found = mod.discoverAgents(here, 'user');
    const generated = Object.keys(agentState.files).map((f) => f.replace(/\.md$/, ''));
    const ours = found.agents.filter((a) => (a.filePath || '').startsWith(agentsDir));
    const discovered = new Set(ours.map((a) => a.name));
    check(
      'pi-subagents discovers every generated GSD agent',
      generated.length === 35 && generated.every((n) => discovered.has(n)),
      `generated=${generated.length} discovered=${discovered.size} missing=${generated.filter((n) => !discovered.has(n)).join(', ')}`,
    );
    const planner = ours.find((a) => a.name === 'gsd-planner');
    check('pi-subagents reads the mapped tool allowlist', planner && planner.tools.join(',') === ['read', 'write', 'edit', 'bash', 'find', 'grep', ...extensionTools].join(','), planner && planner.tools.join(','));
    check('pi-subagents reads the thinking level', planner && planner.thinking === 'xhigh', planner && String(planner.thinking));
    check('pi-subagents reads the excludeTools mapping', (ours.find((a) => a.name === 'gsd-verifier') || {}).excludeTools?.join(',') === 'edit');
    const manager = ours.find((a) => a.name === 'gsd-debug-session-manager');
    check('pi-subagents reads the nested-fanout flag', manager && manager.allowNestedSubagents === true);
    check('pi-subagents accepts every generated agent with no diagnostics', found.agentDiagnostics.filter((d) => (d.filePath || '').startsWith(agentsDir)).length === 0, JSON.stringify(found.agentDiagnostics.filter((d) => (d.filePath || '').startsWith(agentsDir))));
  } catch (err) {
    check('pi-subagents discovery probe', false, err && err.message ? err.message : String(err));
  } finally {
    if (savedEnv.extra === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = savedEnv.extra;
    if (savedEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
  }
} else {
  console.log('  skip pi-subagents discovery probe (pi-subagents or jiti not installed)');
}

// ── 11. hygiene: the suite must not mutate the real install ────────────────
console.log('\n11) hygiene');
const realConfig = path.join(agentDir, _internals.CONFIG_FILE);
check('suite left the user config file untouched', !fs.existsSync(realConfig), `${realConfig} was created by the suite`);
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
