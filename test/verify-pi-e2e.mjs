#!/usr/bin/env node
/**
 * End-to-end check through a real pi process.
 *
 * Unlike test/verify.mjs (hermetic, temp dirs, pi's template engine imported
 * directly), this drives an actual `pi --mode rpc` session and asks pi itself
 * what commands it has. It therefore verifies the two things that cannot be
 * checked in-process:
 *
 *   1. pi auto-discovers ~/.pi/agent/extensions/gsd-slash-sync.js
 *   2. the `resources_discover` → promptPaths wiring really registers the
 *      generated templates as native `/gsd-<command>` prompt templates
 *
 * Requires the plugin to be installed (`node gsd-slash-sync.js install`) and
 * the templates to exist (run `/gsd-sync` once). Exit code 0 = pass.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { _internals } = require(path.join(here, '..', 'gsd-slash-sync.js'));

const agentDir = _internals.resolveAgentDir();
const outDir = path.join(agentDir, 'gsd-commands');
const extensionPath = path.join(agentDir, 'extensions', 'gsd-slash-sync.js');

const expected = _internals.resolveOptions({}, {}).outDir === outDir;
if (!expected) {
  console.error(`agent dir mismatch: resolving to ${outDir}`);
  process.exit(1);
}

// Run pi from a scratch cwd: pi creates its own .pi/ project state, which must
// not land in this repository.
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slash-sync-pi-'));
const child = spawn('pi', ['--mode', 'rpc', '--no-session'], {
  cwd: scratchCwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const messages = [];
const stderr = [];

child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* non-JSON chatter on stdout is itself noteworthy, but keep going */
    }
  }
});
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

const done = new Promise((resolve) => {
  setTimeout(() => child.stdin.write(`${JSON.stringify({ id: 'verify-1', type: 'get_commands' })}\n`), 1500);
  const wait = setInterval(() => {
    const response = messages.find((m) => m.type === 'get_commands' || m.id === 'verify-1');
    if (response) {
      clearInterval(wait);
      resolve(response);
    }
  }, 250);
  setTimeout(() => {
    clearInterval(wait);
    resolve(null);
  }, 20000);
});

const response = await done;
child.kill('SIGTERM');

if (!response) {
  console.error('FAIL: no get_commands response from pi');
  console.error(stderr.join('').slice(-2000));
  process.exit(1);
}

const commands = response.commands || (response.data && response.data.commands) || [];
const templates = commands.filter((c) => c.source === 'prompt');
const gsd = templates.filter((c) => /^gsd[-:]/.test(c.name));
const failures = [];

if (!gsd.length) failures.push('pi reports no /gsd-* prompt templates');
if (gsd.length === 72) {
  /* as expected */
} else if (gsd.length > 0) {
  failures.push(`pi reports ${gsd.length} /gsd-* templates (expected 72)`);
}
if (!commands.some((c) => c.name === 'gsd-sync')) failures.push('/gsd-sync extension command is not registered');
if (!gsd.every((c) => c.sourceInfo && c.sourceInfo.path && c.sourceInfo.path.startsWith(outDir))) {
  failures.push('template source info does not point at the generated directory');
}

console.log('pi end-to-end check');
console.log(`  extension   ${extensionPath} (exists: ${require('node:fs').existsSync(extensionPath)})`);
console.log(`  commands    ${commands.length} total · ${templates.length} prompt templates · ${gsd.length} gsd templates`);
console.log(`  /gsd-sync   ${commands.some((c) => c.name === 'gsd-sync') ? 'registered' : 'MISSING'}`);
console.log(`  sample      ${gsd.slice(0, 3).map((c) => c.name).join(', ')}`);

if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nOK — pi loads the GSD slash commands from the generated templates.');
}
