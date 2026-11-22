// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests of the safety guards: slugs and session ids that could leave .pilotage/, the info/exclude
 * line, a tracked .pilotage/, the output budget of `reprise`, and the veille hooks (veille.mjs).
 * Every test runs in a throwaway folder with its own git config and runtime folder: the user's
 * config, repositories, transcripts and pending timers are never touched.
 * Run from the repository root: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pilotage', 'scripts');
const PILOTAGE = path.join(SCRIPTS, 'pilotage.mjs');
const VEILLE = path.join(SCRIPTS, 'veille.mjs');
// Neither git variables, Claude Code markers nor veille settings leak from the developer's shell.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(GIT_|EMAIL$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$|CLAUDE_CONFIG_DIR$|PILOTAGE_|XDG_RUNTIME_DIR$)/.test(key)));
const SETUP_IDENTITY = {
  GIT_AUTHOR_NAME: 'Setup',
  GIT_AUTHOR_EMAIL: 'setup@example.invalid',
  GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 'setup@example.invalid',
};

/**
 * Creates a throwaway git project with one empty commit, and helpers.
 * @param {import('node:test').TestContext} t - test context, used for cleanup
 * @returns {object} sandbox helpers
 */
const sandbox = t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-guards-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const project = path.join(tmp, 'projet');
  fs.mkdirSync(project);
  const env = { ...CLEAN_ENV, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };
  const git = (args, cwd = project) => execFileSync('git', args, { cwd, env: { ...env, ...SETUP_IDENTITY }, encoding: 'utf8' }).trim();
  const run = (args, cwd = project) => spawnSync(process.execPath, [PILOTAGE, ...args], { cwd, env, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'initial']);
  return { tmp, project, pilotage: path.join(project, '.pilotage'), env, git, run };
};

/**
 * Files below a folder, as paths relative to it (to prove that a refused command wrote nothing).
 * @param {string} dir - folder
 * @returns {string[]} sorted relative paths
 */
const filesBelow = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort();

// --- Slugs and session ids -------------------------------------------------------------------

test('init refuses a chantier slug that leaves .pilotage', t => {
  const s = sandbox(t);
  const res = s.run(['init', '--chantier', '../evil']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /slug invalide « \.\.\/evil »/);
  assert.ok(!fs.existsSync(path.join(s.project, 'evil')), 'folder created outside .pilotage');
});

test('decision, modele and reprise refuse a slug that leaves .pilotage', t => {
  const s = sandbox(t);
  assert.equal(s.run(['init']).status, 0);
  // A decoy chantier next to .pilotage: without the slug check, `../evil` would reach it.
  const decoy = path.join(s.project, 'evil');
  fs.mkdirSync(path.join(decoy, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(decoy, 'plan.md'), 'CONTENU-HORS-PILOTAGE\n');
  const before = filesBelow(decoy);

  const decision = s.run(['decision', '../evil', 'un titre']);
  assert.equal(decision.status, 1);
  assert.match(decision.stderr, /^Usage : decision /);
  const modele = s.run(['modele', '../evil', 'essais']);
  assert.equal(modele.status, 1);
  assert.match(modele.stderr, /^Usage : modele /);
  const reprise = s.run(['reprise', '../evil']);
  assert.equal(reprise.status, 1);
  assert.match(reprise.stderr, /chantier « \.\.\/evil » introuvable/);
  assert.doesNotMatch(reprise.stdout, /CONTENU-HORS-PILOTAGE/);
  assert.deepEqual(filesBelow(decoy), before);
});

test('contexte refuses a session id that leaves the projects folder', t => {
  const s = sandbox(t);
  const res = s.run(['contexte', '--session', '../x']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /identifiant de session invalide « \.\.\/x »/);
  assert.equal(res.stdout, '');
});

// --- info/exclude and tracked .pilotage --------------------------------------------------------

test('init adds the exclusion line once, after a last line without newline', t => {
  const s = sandbox(t);
  const exclude = path.join(s.project, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '*.log');
  const first = s.run(['init']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /exclusion ajoutée dans /);
  const second = s.run(['init']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /exclusion déjà présente dans /);
  assert.equal(fs.readFileSync(exclude, 'utf8'), '*.log\n/.pilotage/\n');
  assert.equal(s.git(['status', '--porcelain']), '');
});

test('init from a linked worktree excludes .pilotage in the shared info/exclude', t => {
  const s = sandbox(t);
  const worktree = path.join(s.tmp, 'wt');
  s.git(['worktree', 'add', '-q', worktree]);
  const res = s.run(['init'], worktree);
  assert.equal(res.status, 0, res.stderr);
  const exclude = path.join(s.project, '.git', 'info', 'exclude');
  assert.match(res.stdout, new RegExp(`exclusion ajoutée dans ${exclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(fs.readFileSync(exclude, 'utf8').split('\n').includes('/.pilotage/'));
  assert.ok(fs.existsSync(path.join(worktree, '.pilotage', 'INDEX.md')));
  assert.equal(s.git(['status', '--porcelain'], worktree), '');
});

test('init stops when .pilotage holds files tracked by git', t => {
  const s = sandbox(t);
  fs.mkdirSync(s.pilotage);
  fs.writeFileSync(path.join(s.pilotage, 'notes.md'), 'suivi\n');
  s.git(['add', '.pilotage/notes.md']);
  s.git(['commit', '-q', '-m', 'track pilotage']);
  const exclude = path.join(s.project, '.git', 'info', 'exclude');
  const before = fs.readFileSync(exclude, 'utf8');
  const res = s.run(['init', '--chantier', 'demo']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /contient des fichiers suivis par git/);
  assert.equal(fs.readFileSync(exclude, 'utf8'), before);
  assert.deepEqual(filesBelow(s.pilotage), ['notes.md']);
});

// --- Output budget of reprise ---------------------------------------------------------------

test('reprise shrinks the journal before cutting the plan', t => {
  const s = sandbox(t);
  assert.equal(s.run(['init', '--chantier', 'demo']).status, 0);
  const entries = Array.from({ length: 5 }, (_, i) => `\n## 2026-11-0${i + 1} · entrée ${i + 1}\n${`- [constat] ligne de journal assez longue n° ${i + 1}\n`.repeat(150)}`);
  fs.appendFileSync(path.join(s.pilotage, 'demo', 'journal.md'), entries.join(''));
  const res = s.run(['reprise', 'demo', '--entrees', '5']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.length < 30_000, `${res.stdout.length} characters`);
  const [, shown, total] = res.stdout.match(/=== demo\/journal\.md — (\d+) dernière\(s\) entrée\(s\) sur (\d+) ===/) ?? [];
  assert.ok(Number(shown) >= 1 && Number(shown) < 5, `${shown} entries shown`);
  assert.equal(Number(total), 6);
  assert.match(res.stdout, new RegExp(`^ALERTE : sortie réduite .* journal ramené à ${shown} entrée\\(s\\)\\. `, 'm'));
  assert.doesNotMatch(res.stdout, /plan\.md coupé/);
  assert.match(res.stdout, /## 2026-11-05 · entrée 5/, 'newest entry kept');
});

test('reprise cuts the plan at a line and points to that line of the file on disk', t => {
  const s = sandbox(t);
  assert.equal(s.run(['init', '--chantier', 'demo']).status, 0);
  const plan = path.join(s.pilotage, 'demo', 'plan.md');
  // The template's comments are stripped from the output: the line number must still be the file's.
  const notes = Array.from({ length: 800 }, (_, i) => `- note ${String(i).padStart(4, '0')} assez longue pour peser dans le budget`);
  fs.appendFileSync(plan, `\n## Notes\n\n${notes.join('\n')}\n`);
  const res = s.run(['reprise', 'demo']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.length < 30_000, `${res.stdout.length} characters`);
  assert.match(res.stdout, /^ALERTE : sortie réduite .* plan\.md coupé\. /m);
  const [, line] = res.stdout.match(/\[… plan\.md coupé ici : \d+ caractères non affichés → lire \.pilotage\/demo\/plan\.md à partir de la ligne (\d+)\]/) ?? [];
  assert.ok(line, 'line pointer');
  const shown = res.stdout.slice(res.stdout.indexOf('=== demo/plan.md ===\n') + '=== demo/plan.md ===\n'.length, res.stdout.indexOf('\n[… plan.md coupé ici')).split('\n');
  const lastShown = shown.at(-1);
  const raw = fs.readFileSync(plan, 'utf8').split('\n');
  assert.match(lastShown, /^- note \d{4} /);
  assert.equal(raw[Number(line) - 2], lastShown, 'pointer is the line after the last one shown');
  assert.ok(Number(line) > shown.length + 1, 'comments shift the numbering');
});

test('reprise strips control characters from the commits it prints', t => {
  const s = sandbox(t);
  assert.equal(s.run(['init', '--chantier', 'demo']).status, 0);
  s.git(['commit', '-q', '--allow-empty', '-m', 'sujet \x1b]52;c;ZXZpbA==\x07 fin \x1b[2J']);
  const res = s.run(['reprise', 'demo']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /\x1b|\x07/);
  assert.match(res.stdout, /sujet \]52;c;ZXZpbA== fin \[2J/);
});

// --- veille.mjs ----------------------------------------------------------------------------

const SESSION = '0123abcd-0000-4000-8000-000000000000';

/**
 * Creates a throwaway project for the veille hooks: runtime folder, transcript, optional .pilotage.
 * @param {import('node:test').TestContext} t - test context, used for cleanup
 * @param {{pilotage?: boolean, marker?: boolean}} [options] - project with an active chantier,
 *   transcript showing that the skill was loaded
 * @returns {object} sandbox helpers
 */
const veilleSandbox = (t, { pilotage = true, marker = true } = {}) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-veille-')));
  const children = [];
  t.after(() => {
    children.forEach(child => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const runDir = path.join(tmp, 'run', 'user');
  fs.mkdirSync(runDir, { recursive: true });
  const project = path.join(tmp, 'projet');
  fs.mkdirSync(project);
  if (pilotage) {
    fs.mkdirSync(path.join(project, '.pilotage'));
    fs.writeFileSync(path.join(project, '.pilotage', 'INDEX.md'), '# Pilotage\n\n## Actifs\n- [demo](demo/plan.md) — essai\n\n## Clos\n');
  }
  const transcript = path.join(tmp, 'transcript.jsonl');
  const entries = [
    { type: 'user', message: { content: marker ? '<command-name>/pilotage</command-name>' : 'bonjour' } },
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
        },
      },
    },
  ];
  fs.writeFileSync(transcript, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  const env = { ...CLEAN_ENV, HOME: tmp, XDG_RUNTIME_DIR: runDir, PILOTAGE_VEILLE_SEUIL: '0', PILOTAGE_VEILLE_DELAI: '1' };
  const input = (extra = {}) => JSON.stringify({ session_id: SESSION, cwd: project, transcript_path: transcript, ...extra });
  const hook = (command, extra = {}, extraEnv = {}) => spawnSync(
    process.execPath,
    [VEILLE, command],
    { cwd: project, env: { ...env, ...extraEnv }, input: input(extra), encoding: 'utf8', timeout: 20_000 },
  );
  /** Starts a long-lived `armer` timer in the background. */
  const armBackground = () => {
    const child = spawn(process.execPath, [VEILLE, 'armer'], { cwd: project, env: { ...env, PILOTAGE_VEILLE_DELAI: '60' }, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(child);
    child.stdin.end(input());
    return child;
  };
  /** Starts a process that is not a veille timer. */
  const decoy = () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  };
  const pidFile = path.join(runDir, `pilotage-veille-${SESSION}.pid`);
  const log = path.join(project, '.pilotage', 'veille.log');
  const logText = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { tmp, runDir, project, hook, armBackground, decoy, pidFile, log, logText };
};

/**
 * Waits until a file exists.
 * @param {string} file - path
 */
const waitFor = async file => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await sleep(20);
  }
};

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('veille config prints the hooks block that contexte then reports as active', t => {
  const s = sandbox(t);
  const res = spawnSync(process.execPath, [VEILLE, 'config'], { cwd: s.project, env: s.env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(res.status, 0, res.stderr);
  const { hooks } = JSON.parse(res.stdout);
  const [armer] = hooks.Stop[0].hooks;
  const [desarmer] = hooks.UserPromptSubmit[0].hooks;
  assert.equal(armer.command, `node "${VEILLE}" armer`);
  assert.equal(armer.asyncRewake, true);
  assert.ok(armer.timeout > 3300, 'default delay below the timeout');
  assert.equal(desarmer.command, `node "${VEILLE}" desarmer`);
  fs.mkdirSync(s.env.CLAUDE_CONFIG_DIR);
  fs.writeFileSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'settings.json'), res.stdout);
  assert.match(s.run(['contexte']).stdout, /^Veille cache : active \(réveil à 55 min, /);
});

test('veille wakes Claude after the delay, then clears its pid file', t => {
  const v = veilleSandbox(t);
  const res = v.hook('armer');
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /^\[pilotage · veille\] /);
  assert.match(res.stderr, /\/clear puis \/pilotage reprise demo/);
  assert.ok(!fs.existsSync(v.pidFile), 'pid file left behind');
  assert.match(v.logText(), / 0123abcd armé : 1 s, .*chantiers demo\n.* 0123abcd réveil\n$/);
});

test('veille never arms with a session id that would move the pid file', t => {
  const v = veilleSandbox(t);
  // `pilotage-veille-/../../x.pid` would resolve two levels up, out of the runtime folder.
  const res = v.hook('armer', { session_id: '/../../x' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(filesBelow(path.join(v.tmp, 'run')), ['user']);
  assert.ok(!fs.existsSync(path.join(v.tmp, 'x.pid')));
  assert.equal(v.logText(), '');
});

test('veille logs nothing outside a project with .pilotage', t => {
  const v = veilleSandbox(t, { pilotage: false });
  const res = v.hook('armer');
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(filesBelow(v.project), []);
  assert.deepEqual(filesBelow(v.runDir), []);
});

test('veille logs why it does not arm', t => {
  const v = veilleSandbox(t, { marker: false });
  const res = v.hook('armer');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(v.pidFile));
  assert.match(v.logText(), / 0123abcd non armé : skill pilotage non chargé dans la session\n$/);
});

test('desarmer stops a pending veille timer', async t => {
  const v = veilleSandbox(t);
  const timer = v.armBackground();
  await waitFor(v.pidFile);
  const res = v.hook('desarmer');
  assert.equal(res.status, 0, res.stderr);
  const [code] = await once(timer, 'exit');
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(v.pidFile));
  assert.match(v.logText(), / 0123abcd désarmé : réponse de l'utilisateur\n$/);
});

test('desarmer from a folder without .pilotage stops the timer and logs nothing there', async t => {
  const v = veilleSandbox(t);
  const timer = v.armBackground();
  await waitFor(v.pidFile);
  const elsewhere = path.join(v.tmp, 'ailleurs');
  fs.mkdirSync(elsewhere);
  const logged = v.logText();
  const res = v.hook('desarmer', { cwd: elsewhere });
  assert.equal(res.status, 0, res.stderr);
  const [code] = await once(timer, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(filesBelow(elsewhere), []);
  assert.deepEqual(fs.readdirSync(v.project), ['.pilotage']);
  assert.equal(v.logText(), logged);
});

test('desarmer kills no process other than a veille timer', t => {
  const v = veilleSandbox(t);
  const other = v.decoy();
  fs.writeFileSync(v.pidFile, String(other.pid));
  const res = v.hook('desarmer');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(alive(other.pid), 'unrelated process killed');
  assert.ok(!fs.existsSync(v.pidFile), 'stale pid file kept');
  assert.doesNotMatch(v.logText(), /désarmé/);
});
