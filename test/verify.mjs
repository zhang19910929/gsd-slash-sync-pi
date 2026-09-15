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
const refReport = plugin.sync({ agentDir, outDir: refDir, mode: 'reference', persist: false, naming: 'hyphen', cwd: here  });
check('sync writes 72 templates', refReport.templates === 72, `got ${refReport.templates}`);
check('sync reports no errors', refReport.ok && refReport.errors.length === 0, refReport.errors.join('; '));
check('source is the GSD Core command set', /commands\/gsd$/.test(refReport.source || ''), refReport.source);

const refAgain = plugin.sync({ agentDir, outDir: refDir, mode: 'reference', persist: false, naming: 'hyphen', cwd: here  });
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
const inlineReport = plugin.sync({ agentDir, outDir: inlineDir, mode: 'inline', persist: false, naming: 'hyphen', cwd: here  });
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
plugin.sync({ agentDir, outDir: colonDir, mode: 'reference', persist: false, naming: 'colon', cwd: here  });
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
plugin.sync({ agentDir, outDir: pruneDir, mode: 'reference', persist: false, cwd: here  });
const stalePath = path.join(pruneDir, 'gsd-removed-command.md');
fs.writeFileSync(stalePath, `<!-- generated by ${_internals.GENERATOR} v0.0.1 (stale) -->\n`);
const foreignPath = path.join(pruneDir, 'gsd-user-own-file.md');
fs.writeFileSync(foreignPath, '---\ndescription: mine\n---\nkeep me\n');
const pruneReport = plugin.sync({ agentDir, outDir: pruneDir, mode: 'reference', persist: false, cwd: here  });
check('stale generated template is removed', pruneReport.removed.includes('gsd-removed-command.md') && !fs.existsSync(stalePath));
check('foreign template is never touched', pruneReport.skipped.includes('gsd-user-own-file.md') && fs.existsSync(foreignPath));

// 7b. an upgraded plugin (conversion logic changed) must re-sync on its own
const upgradeDir = path.join(tmpRoot, 'upgrade');
plugin.sync({ agentDir, outDir: upgradeDir, mode: 'reference', persist: false, cwd: here });
check('fresh install reports not stale', plugin.status({ agentDir, outDir: upgradeDir, mode: 'reference', persist: false, cwd: here }).stale === false);
const upgradeStatePath = path.join(upgradeDir, _internals.STATE_FILE);
const upgradeState = JSON.parse(fs.readFileSync(upgradeStatePath, 'utf8'));
upgradeState.generator = `${_internals.GENERATOR}@0.0.1-old`;
fs.writeFileSync(upgradeStatePath, JSON.stringify(upgradeState, null, 2));
check(
  'older plugin version is detected as stale',
  plugin.status({ agentDir, outDir: upgradeDir, mode: 'reference', persist: false, cwd: here }).stale === true,
);
const upgradeReport = plugin.sync({ agentDir, outDir: upgradeDir, mode: 'reference', persist: false, cwd: here });
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
plugin.sync({ agentDir, outDir: guardDir, mode: 'reference', persist: false, cwd: here  });
const guardReport = plugin.sync({ agentDir, outDir: guardDir, source: brokenDir, mode: 'reference', persist: false, cwd: here });
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

// ── 10. hygiene: the suite must not mutate the real install ────────────────
console.log('\n10) hygiene');
const realConfig = path.join(agentDir, _internals.CONFIG_FILE);
check('suite left the user config file untouched', !fs.existsSync(realConfig), `${realConfig} was created by the suite`);
check(
  'real generated templates were not modified by the suite',
  realStateBefore === (fs.existsSync(realStateFile) ? fs.statSync(realStateFile).mtimeMs : null),
  `state file changed: ${realStateFile}`
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
