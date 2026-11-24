// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests of `hooks/session-start.mjs`: every test builds a throwaway project; nothing outside it is read.
 * Run from the repository root: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-start.mjs');
const SCAN = path.join(path.dirname(HOOK), '..', 'skills', 'pilotage', 'scripts', 'pilotage.mjs');
const TODAY =new Intl.DateTimeFormat('en-CA').format(new Date());

/**
 * Creates a throwaway folder and helpers to add chantiers and run the hook in it.
 * @param {import('node:test').TestContext} t - test context, used for cleanup
 * @returns {object} sandbox helpers
 */
const sandbox = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  /**
   * Adds a project whose index lists the given active chantiers, each with a plan.md.
   * @param {string} rel - project path below root
   * @param {Array<[string, string]>} active - [slug, description] pairs
   */
  const project = (rel, active) => {
    write(path.join(rel, '.pilotage', 'INDEX.md'), `# Pilotage\n\n## Actifs\n\n${active
      .map(([slug, text]) => `- [${slug}](${slug}/plan.md) — ${text} · maj ${TODAY}`).join('\n')}\n\n## Clos\n`);
    active.forEach(([slug]) => write(path.join(rel, '.pilotage', slug, 'plan.md'), `# ${slug}\n`));
  };
  // The session's project comes from CLAUDE_PROJECT_DIR; the developer's own value and colour settings must not leak in.
  const baseEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(CLAUDE_PROJECT_DIR|FORCE_COLOR|NO_COLOR)$/.test(key)));
  const run = (args = [], env = {}) => spawnSync(process.execPath, [HOOK, ...args], {
    encoding: 'utf8',
    cwd: root,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear' }),
    env: { ...baseEnv, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { root, write, project, run };
};

/**
 * Parses the hook's stdout, which must be one JSON object with only a systemMessage.
 * @param {string} stdout - hook output
 * @returns {string} the systemMessage
 */
const message = stdout => {
  const output = JSON.parse(stdout);
  assert.deepEqual(Object.keys(output), ['systemMessage'], 'nothing for the model: no additionalContext, no plain text');
  return output.systemMessage;
};

test('hook shows the active chantiers of the session project as a systemMessage', t => {
  const { project, run } = sandbox(t);
  project('.', [['alpha', 'objectif alpha · étape : 2']]);
  const { status, stdout, stderr } = run();
  assert.equal(status, 0);
  assert.equal(stderr, '');
  const text = message(stdout);
  assert.match(text, /^Chantiers de .* — 1 chantier actif\n/);
  assert.match(text, /alpha · maj/);
  assert.match(text, /objectif alpha · étape : 2/);
});

test('hook prints nothing when the project has no active chantier or no tracking', t => {
  const { root, project, run } = sandbox(t);
  assert.equal(run().stdout, '', 'no .pilotage/');
  project('.', []);
  const { status, stdout } = run();
  assert.equal(status, 0);
  assert.equal(stdout, '', 'index without active chantier');
  assert.ok(fs.existsSync(path.join(root, '.pilotage', 'INDEX.md')));
});

test('hook stays at depth 0 by default and passes explicit arguments to scan', t => {
  const { root, project, run } = sandbox(t);
  project('sous/projet', [['profond', 'objectif profond']]);
  assert.equal(run().stdout, '', 'the session project itself has no tracking');
  assert.match(message(run([root]).stdout), /\nprofond · maj/);
});

test('hook shows anomalies even without an active chantier', t => {
  const { project, write, run } = sandbox(t);
  project('.', []);
  write(path.join('.pilotage', 'oublie', 'plan.md'), '# oublie\n');
  assert.match(message(run().stdout), /chantier « oublie » absent de INDEX\.md/);
});

test('hook never emits colour codes, even with FORCE_COLOR', t => {
  const { project, run } = sandbox(t);
  project('.', [['alpha', 'objectif']]);
  assert.doesNotMatch(message(run([], { FORCE_COLOR: '3' }).stdout), /\x1b\[/);
});

test('hook keeps the systemMessage under the 10,000-character cap, cut on a line boundary', t => {
  const { root, project, run } = sandbox(t);
  project('.', Array.from({ length: 120 }, (_, i) => [`chantier-${String(i).padStart(3, '0')}`, `objectif ${'x'.repeat(150)}`]));
  const text = message(run().stdout);
  assert.ok(text.length <= 10_000, `length ${text.length}`);
  const note = '\n… coupé : lancer `pilotage.mjs scan` dans un terminal pour tout voir';
  assert.ok(text.endsWith(note));
  const full = spawnSync(process.execPath, [SCAN, 'scan', root, '--profondeur', '0'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout;
  assert.ok(full.length > 10_000, 'the sandbox overflows the cap');
  assert.ok(full.startsWith(`${text.slice(0, -note.length)}\n`), 'cut on a line boundary of the scan output');
});

test('hook reports a scan failure in a short message and still exits 0', t => {
  const { root, run } = sandbox(t);
  const { status, stdout } = run([path.join(root, 'absent')]);
  assert.equal(status, 0);
  assert.match(message(stdout), /^Pilotage : vue des chantiers indisponible \(Usage : scan/);
});
