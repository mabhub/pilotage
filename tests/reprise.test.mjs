// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests of what `reprise` reports about the plan: the paths cited in « Repères » that no longer exist.
 * Every test runs in a throwaway folder.
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

/**
 * Paths listed by the « Repères » ALERTE of `reprise`, in output order.
 * @param {string} stdout - reprise output
 * @returns {string[]} reported paths, empty without the ALERTE
 */
const reportedMissing = stdout => {
  const [, list = ''] = stdout.match(/^ALERTE : chemins cités dans « Repères » introuvables :\n((?:- .*\n)*)/m) ?? [];
  return list.split('\n').filter(Boolean).map(line => line.slice(2));
};

test('reprise reports only the « Repères » paths found nowhere', t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-reprise-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: project, encoding: 'utf8' });
  assert.equal(run(['init', '--chantier', 'demo']).status, 0);
  const pilotage = path.join(project, '.pilotage');
  // One existing file per base a path may be relative to: the chantier, .pilotage/ and the project root.
  fs.mkdirSync(path.join(pilotage, 'demo', 'preuves'));
  fs.writeFileSync(path.join(pilotage, 'demo', 'preuves', 'essai.txt'), '');
  fs.mkdirSync(path.join(pilotage, 'etudes'));
  fs.writeFileSync(path.join(pilotage, 'etudes', 'note.md'), '');
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'app.js'), '');
  fs.appendFileSync(path.join(pilotage, 'demo', 'plan.md'), [
    '- `preuves/essai.txt` : relatif au chantier',
    '- `etudes/note.md` (racine de `.pilotage/`) : étude partagée',
    '- `src/app.js:12` : relatif au projet',
    '- essai après `/clear`, `/skill-creator:skill-creator` et `/pilotage reprise demo`',
    '- `src/absent.js` : supprimé depuis',
    '',
  ].join('\n'));
  const res = run(['reprise', 'demo']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(reportedMissing(res.stdout), ['src/absent.js']);
});
