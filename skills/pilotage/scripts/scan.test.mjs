/**
 * Tests of `pilotage.mjs scan`: every test builds a throwaway tree of projects; nothing outside it is read.
 * Run from the repository root: node --test pilotage/scripts/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pilotage.mjs');

/**
 * Date N days before today, as YYYY-MM-DD.
 * @param {number} days - days ago
 * @returns {string} ISO date
 */
const daysAgo = days => new Date(Date.parse(new Date().toISOString().slice(0, 10)) - days * 86_400_000)
  .toISOString().slice(0, 10);

/**
 * Creates a throwaway folder and helpers to add projects and run `scan` in it.
 * @param {import('node:test').TestContext} t - test context, used for cleanup
 * @returns {object} sandbox helpers
 */
const sandbox = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  /**
   * Adds a project with an INDEX.md built from sections ({Actifs: [...lines], Clos: [...]}).
   * @param {string} rel - project path below root
   * @param {Object<string,string[]>} sections - section title → lines
   */
  const project = (rel, sections) => write(
    path.join(rel, '.pilotage', 'INDEX.md'),
    `# Pilotage — ${rel}\n\n${Object.entries(sections).map(([title, lines]) => `## ${title}\n\n<!-- - [slug](slug/plan.md) — exemple -->\n${lines.join('\n')}\n`).join('\n')}`,
  );
  /**
   * Adds a chantier plan.md.
   * @param {string} rel - project path below root
   * @param {string} slug - chantier slug
   * @param {{lastPoint?: string, pending?: string[]}} [plan] - last checkpoint date, « En attente » lines
   */
  const plan = (rel, slug, { lastPoint = daysAgo(0), pending = [] } = {}) => write(
    path.join(rel, '.pilotage', slug, 'plan.md'),
    `# ${slug}\n\n- **Ouvert le** : ${lastPoint} · **Dernier point d'étape** : ${lastPoint}\n\n## En attente de l'utilisateur\n\n<!-- - [question Q1] exemple -->\n${pending.join('\n')}\n\n## Repères\n\n- [attente A9] hors section, ignorée\n`,
  );
  // No colour by default: FORCE_COLOR or NO_COLOR from the developer's shell must not leak into the tests.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FORCE_COLOR|NO_COLOR)$/.test(key)));
  const run = (args = [], env = {}) => spawnSync(
    process.execPath,
    [SCRIPT, 'scan', root, ...args],
    { encoding: 'utf8', env: { ...baseEnv, ...env } },
  );
  return { root, write, project, plan, run };
};

const line = (slug, text, date) => `- [${slug}](${slug}/plan.md) — ${text}${date ? ` · maj ${date}` : ''}`;

test('scan lists active chantiers, most recent first, with pending ids and age', t => {
  const { project, plan, run } = sandbox(t);
  project('alpha', { Actifs: [line('ancien', 'objectif ancien · étape : 2', daysAgo(40))], Clos: [] });
  plan('alpha', 'ancien', { pending: ['- [question Q1] choisir', '- [attente] sans identifiant', 'aucune autre'] });
  project('groupe/beta', { Actifs: [line('recent', 'objectif récent · étape : 1', daysAgo(2))] });
  plan('groupe/beta', 'recent', { pending: ['- [attente A3] essai manuel'] });
  const { status, stdout } = run();
  assert.equal(status, 0);
  assert.match(stdout, /2 projets suivis, 2 chantiers actifs/);
  assert.match(stdout, new RegExp(`groupe/beta · recent · maj ${daysAgo(2)} \\(2 j\\) · attend : A3\\n  objectif récent · étape : 1`));
  assert.match(stdout, new RegExp(`alpha · ancien · maj ${daysAgo(40)} \\(40 j, dormant\\) · attend : Q1, 1 sans id`));
  assert.ok(stdout.indexOf('recent') < stdout.indexOf('ancien'), 'most recent first');
  assert.doesNotMatch(stdout, /A9/, 'only the « En attente » section counts');
  assert.doesNotMatch(stdout, /exemple/, 'template comments are ignored');
});

test('scan falls back on the plan checkpoint date when the index line has none', t => {
  const { project, plan, run } = sandbox(t);
  project('p', { Actifs: [line('sans-maj', 'objectif · étape : 3')] });
  plan('p', 'sans-maj', { lastPoint: daysAgo(5) });
  assert.match(run().stdout, new RegExp(`p · sans-maj · maj ${daysAgo(5)} \\(5 j\\)`));
});

test('scan hides closed chantiers unless --clos, and lists idle projects and other sections', t => {
  const { project, run } = sandbox(t);
  project('fini', {
    Actifs: [],
    Clos: [`- [termine](termine/plan.md) — résultat · clos ${daysAgo(3)}`],
    'À suivre': ['- point libre sans lien', '- autre point'],
  });
  const plain = run().stdout;
  assert.match(plain, /=== Sans chantier actif \(1\) ===\nfini/);
  assert.match(plain, /=== Autres sections ===\nfini : À suivre 2/);
  assert.doesNotMatch(plain, /termine/);
  assert.match(run(['--clos']).stdout, new RegExp(`=== Clos \\(1, plus récents d'abord\\) ===\\nfini · termine · clos ${daysAgo(3)} — résultat`));
});

test('scan reports unindexed chantiers and active lines without plan', t => {
  const { project, plan, run } = sandbox(t);
  project('p', { Actifs: [line('fantome', 'objectif', daysAgo(1))] });
  plan('p', 'oublie');
  const { stdout } = run();
  assert.match(stdout, /=== Anomalies ===/);
  assert.match(stdout, /p : « fantome » actif sans \.pilotage\/fantome\/plan\.md/);
  assert.match(stdout, /p : chantier « oublie » absent de INDEX\.md/);
});

test('scan skips dependencies, hidden folders and symbolic links, and honours --profondeur', t => {
  const { root, project, run } = sandbox(t);
  project('vrai', { Actifs: [line('a', 'objectif', daysAgo(1))] });
  project('node_modules/dep', { Actifs: [line('b', 'objectif', daysAgo(1))] });
  project('.cache/x', { Actifs: [line('c', 'objectif', daysAgo(1))] });
  project('n1/n2/n3', { Actifs: [line('d', 'objectif', daysAgo(1))] });
  fs.symlinkSync(path.join(root, 'vrai'), path.join(root, 'lien'));
  const all = run().stdout;
  assert.match(all, /2 projets suivis/);
  assert.match(all, /n1\/n2\/n3 · d/);
  assert.doesNotMatch(all, /dep|\.cache|lien/);
  const shallow = run(['--profondeur', '2']).stdout;
  assert.match(shallow, /1 projet suivi/);
  assert.doesNotMatch(shallow, /n1\/n2\/n3/);
});

test('scan counts unreadable folders and carries on', { skip: process.getuid?.() === 0 && 'root can read everything' }, t => {
  const { root, project, run } = sandbox(t);
  project('ok', { Actifs: [line('a', 'objectif', daysAgo(1))] });
  fs.mkdirSync(path.join(root, 'ferme'));
  fs.chmodSync(path.join(root, 'ferme'), 0o000);
  const { status, stdout } = run();
  fs.chmodSync(path.join(root, 'ferme'), 0o700);
  assert.equal(status, 0);
  assert.match(stdout, /1 projet suivi, 1 chantier actif · 1 dossier illisible ignoré/);
});

test('scan refuses a missing folder or an invalid depth', t => {
  const { root } = sandbox(t);
  const scan = args => spawnSync(process.execPath, [SCRIPT, 'scan', ...args], { encoding: 'utf8' });
  assert.equal(scan([path.join(root, 'absent')]).status, 1);
  assert.equal(scan([root, '--profondeur', 'abc']).status, 1);
  assert.equal(scan([root, '--profondeur', '11']).status, 1);
  assert.match(scan([root, '--profondeur', '-1']).stderr, /Usage : scan/);
});

test('scan output stays within budget when not in a terminal', t => {
  const { project, run } = sandbox(t);
  const text = `objectif ${'x'.repeat(300)}`;
  Array.from({ length: 150 }, (_, i) => project(`p${i}`, { Actifs: [line(`c${i}`, text, daysAgo(1))] }));
  const { stdout } = run();
  assert.match(stdout, /^ALERTE : sortie coupée/);
  assert.ok(stdout.length < 26_000, `output of ${stdout.length} characters`);
  assert.match(stdout, /…/, 'long text clipped');
});

test('scan styles its output only when colour is possible', t => {
  const { project, plan, run } = sandbox(t);
  project('chaud', { Actifs: [line('neuf', 'objectif', daysAgo(1))] });
  plan('chaud', 'neuf', { pending: ['- [attente A1] essai'] });
  project('froid', { Actifs: [line('vieux', 'objectif', daysAgo(60))] });
  plan('froid', 'vieux');
  plan('froid', 'oublie');
  assert.doesNotMatch(run().stdout, /\x1b\[/, 'no ANSI code outside a terminal');
  const colour = run([], { FORCE_COLOR: '1' }).stdout;
  assert.match(colour, /\x1b\[1m=== Actifs/, 'bold titles');
  assert.match(colour, /\x1b\[1mchaud\x1b\[22m · \x1b\[36mneuf\x1b\[39m · \x1b\[32mmaj /, 'bold project, cyan chantier, recent date in green');
  assert.match(colour, /\x1b\[33mattend : A1\x1b\[39m/, 'pending items in yellow');
  assert.match(colour, /\x1b\[1mfroid\x1b\[22m · \x1b\[36mvieux\x1b\[39m · \x1b\[35mmaj [^\n]*dormant\)\x1b\[39m/, 'dormant: same anchors, date in magenta');
  assert.match(colour, /\x1b\[31mfroid : chantier « oublie » absent de INDEX\.md\x1b\[39m/, 'anomalies in red');
});

test('scan strips control characters from what it prints', t => {
  const { project, plan, run } = sandbox(t);
  project('p', { Actifs: [line('a', 'objectif \x1b]52;c;ZXZpbA==\x07 · étape \x1b[2J1', daysAgo(1))] });
  plan('p', 'a');
  const { stdout } = run([], { FORCE_COLOR: '1' });
  assert.doesNotMatch(stdout, /\x1b\]|\x07|\x1b\[2J/);
  assert.match(stdout, /objectif \]52;c;ZXZpbA== · étape \[2J1/);
});

test('scan follows a .pilotage link but counts an unreadable index', { skip: process.getuid?.() === 0 && 'root can read everything' }, t => {
  const { root, write, project, plan, run } = sandbox(t);
  project('ailleurs', { Actifs: [line('lie', 'objectif', daysAgo(1))] });
  plan('ailleurs', 'lie');
  fs.mkdirSync(path.join(root, 'groupe', 'lien'), { recursive: true });
  fs.renameSync(path.join(root, 'ailleurs'), path.join(root, '.synchro'));
  fs.symlinkSync(path.join(root, '.synchro', '.pilotage'), path.join(root, 'groupe', 'lien', '.pilotage'));
  write('ferme/.pilotage/INDEX.md', '## Actifs\n');
  fs.chmodSync(path.join(root, 'ferme', '.pilotage', 'INDEX.md'), 0o000);
  const { status, stdout } = run();
  fs.chmodSync(path.join(root, 'ferme', '.pilotage', 'INDEX.md'), 0o600);
  assert.equal(status, 0);
  assert.match(stdout, /1 projet suivi, 1 chantier actif · 1 dossier illisible ignoré/);
  assert.match(stdout, /groupe\/lien · lie/);
});
