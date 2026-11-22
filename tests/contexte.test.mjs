// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests of `pilotage.mjs contexte`: which Claude Code transcript it measures.
 * Every test runs in a throwaway folder with its own Claude config folder: the user's
 * transcripts are never read.
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
// Neither the Claude Code markers nor git variables leak from the developer's shell.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(GIT_|EMAIL$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$|CLAUDE_CONFIG_DIR$)/.test(key)));

/**
 * Creates a throwaway project folder (not a git repository) and an empty Claude config folder.
 * @param {import('node:test').TestContext} t - test context, used for cleanup
 * @returns {object} sandbox helpers
 */
const sandbox = t => {
  // Real path: the script compares it with the cwd recorded in transcripts.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-contexte-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'foo');
  fs.mkdirSync(project);
  const config = path.join(tmp, 'claude');
  const env = { ...CLEAN_ENV, HOME: tmp, CLAUDE_CONFIG_DIR: config };
  /**
   * Writes a one-turn transcript recorded as started in `cwd`, under that folder's slug.
   * @param {string} cwd - session folder
   * @param {string} id - session id
   * @param {number} mtime - modification time (seconds since the epoch)
   */
  const transcript = (cwd, id, mtime) => {
    const dir = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    const entries = [
      { type: 'user', cwd, timestamp: '2026-11-22T10:00:00.000Z', message: { content: 'x' } },
      {
        type: 'assistant', cwd, timestamp: '2026-11-22T10:00:05.000Z',
        message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 } },
      },
    ];
    fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
    fs.utimesSync(file, mtime, mtime);
  };
  const run = (args, extraEnv = {}) => spawnSync(
    process.execPath,
    [SCRIPT, ...args],
    { cwd: project, env: { ...env, ...extraEnv }, encoding: 'utf8' },
  );
  return { tmp, project, transcript, run };
};

const sessionLine = res => res.stdout.split('\n').find(line => line.startsWith('Session : ')) ?? res.stdout;

test('contexte ignores the newer transcript of a sibling project sharing the slug prefix', t => {
  const s = sandbox(t);
  s.transcript(s.project, 'own', 1000);
  // `foo-bar` and `foo/bar` have the same slug: only the recorded cwd tells them apart.
  s.transcript(path.join(s.tmp, 'foo-bar'), 'sibling', 2000);
  const res = s.run(['contexte'], { CLAUDECODE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(sessionLine(res), 'Session : own (transcript le plus récent du projet)');
});

test('contexte finds a session started in a subfolder of the project', t => {
  const s = sandbox(t);
  s.transcript(s.project, 'own', 1000);
  s.transcript(path.join(s.project, 'bar'), 'sub', 2000);
  const res = s.run(['contexte'], { CLAUDECODE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(sessionLine(res), 'Session : sub (transcript le plus récent du projet)');
});

test('contexte refuses a sibling project session named explicitly', t => {
  const s = sandbox(t);
  s.transcript(path.join(s.tmp, 'foo-bar'), 'sibling', 2000);
  const res = s.run(['contexte', '--session', 'sibling'], { CLAUDECODE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Transcript introuvable \(passer --session <id>\)/);
});

test('contexte does not guess a transcript outside Claude Code', t => {
  const s = sandbox(t);
  s.transcript(s.project, 'own', 1000);
  const res = s.run(['contexte']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Taille de contexte non mesurable hors Claude Code/);
  assert.doesNotMatch(res.stdout, /Session : /);
});

test('contexte still measures an explicit session outside Claude Code', t => {
  const s = sandbox(t);
  s.transcript(s.project, 'own', 1000);
  const res = s.run(['contexte', '--session', 'own']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(sessionLine(res), 'Session : own');
});
