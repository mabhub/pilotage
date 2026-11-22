// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests of the templates filled by `init` and `decision`: user text is copied verbatim.
 * Run from the repository root: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pilotage', 'scripts', 'pilotage.mjs');

test('titles keep replacement patterns and placeholders verbatim', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-render-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: project, encoding: 'utf8' });
  // `$&` and `$'` are String.replace patterns; `{{DATE}}` is a placeholder of the same templates.
  const titre = "Prix $& et $' {{DATE}}";
  const init = run(['init', '--chantier', 'demo', '--titre', titre]);
  assert.equal(init.status, 0, init.stderr);
  const plan = fs.readFileSync(path.join(project, '.pilotage', 'demo', 'plan.md'), 'utf8');
  assert.equal(plan.split('\n')[0], `# ${titre}`);
  const decision = run(['decision', 'demo', ...titre.split(' ')]);
  assert.equal(decision.status, 0, decision.stderr);
  const [file] = fs.readdirSync(path.join(project, '.pilotage', 'demo', 'decisions'));
  assert.ok(fs.readFileSync(path.join(project, '.pilotage', 'demo', 'decisions', file), 'utf8').includes(titre));
});
