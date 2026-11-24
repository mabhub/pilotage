#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * purge — removes secrets from the optional git history of .pilotage/ (nested repository
 * .pilotage/.git). Run by the user from a clone of the repository, never by the agent, and
 * never installed with the skill:
 *
 *   node <clone>/scripts/purge.mjs --motifs <fichier>      (from the project root)
 *
 * Rewrites the whole history to replace every match of the patterns (motifs.mjs), then checks
 * that no object, unreachable ones included, still holds one. Only counts are printed: the
 * matches may be secrets. Writes only inside .pilotage/ (its .git, and filter-branch's temporary
 * .git-rewrite/); the project repository is only read.
 * Output is French (user-facing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HistoryError, assertCanCommit, catchUp, firstLine, runGit } from '../skills/pilotage/scripts/historique.mjs';
import { containsAny, decodeFile, parsePatterns } from './motifs.mjs';

const USAGE = 'Usage : node <clone>/scripts/purge.mjs --motifs <fichier> (depuis la racine du projet)';
const FILTER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'purge-filtre.mjs');

/**
 * @param {string} dir - folder to walk
 * @param {string[]} [skip] - entry names skipped at this level
 * @returns {string[]} regular files below it (symbolic links are not followed)
 */
const filesBelow = (dir, skip = []) => fs.readdirSync(dir, { withFileTypes: true })
  .filter(entry => !skip.includes(entry.name))
  .flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(full);
    return entry.isFile() ? [full] : [];
  });

/**
 * Counts the blobs and commits of the nested repository, unreachable ones included, whose
 * content matches a pattern. Contents are only tested, never returned.
 * @param {string} base - .pilotage folder (history on)
 * @param {RegExp[]} patterns - purge patterns
 * @returns {{blob: number, commit: number}} matching objects by type
 * @throws {HistoryError} when the objects cannot be read
 */
const objectsWithPattern = (base, patterns) => {
  const ids = runGit(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'], { base }).stdout
    .split('\n')
    .map(line => line.split(' '))
    .filter(([, type]) => type === 'blob' || type === 'commit')
    .map(([id]) => id);
  const count = { blob: 0, commit: 0 };
  if (ids.length === 0) return count;
  const res = spawnSync('git', ['--git-dir', path.join(base, '.git'), 'cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`, maxBuffer: 1024 ** 3, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.status !== 0) throw new HistoryError('ERREUR : lecture des objets du mini-dépôt impossible.');
  const out = res.stdout;
  // Output: `<id> <type> <size>\n<content>\n` per object.
  for (let pos = 0; pos < out.length;) {
    const eol = out.indexOf(0x0a, pos);
    const [, type, size] = out.subarray(pos, eol).toString('utf8').split(' ');
    if (containsAny(decodeFile(out.subarray(eol + 1, eol + 1 + Number(size))).text, patterns)) count[type] += 1;
    pos = eol + 1 + Number(size) + 1;
  }
  return count;
};

/**
 * Reads and checks the patterns file: it must exist outside .pilotage/ (it would be committed).
 * @param {string} base - .pilotage folder
 * @param {string} patternsFile - path given by the user
 * @returns {{file: string, patterns: RegExp[]}} resolved path and patterns
 * @throws {HistoryError} missing file, file inside .pilotage, refused pattern
 */
const readPatterns = (base, patternsFile) => {
  if (!patternsFile || !fs.existsSync(patternsFile)) throw new HistoryError('ERREUR : fichier de motifs introuvable.');
  const file = fs.realpathSync(patternsFile);
  const realBase = fs.realpathSync(base);
  if (file === realBase || file.startsWith(`${realBase}${path.sep}`)) {
    throw new HistoryError('ERREUR : le fichier de motifs doit être hors de .pilotage/ (il y serait commité).');
  }
  try {
    return { file, patterns: parsePatterns(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    throw new HistoryError(`ERREUR : ${error.message}.`);
  }
};

/**
 * Runs a git command on the nested repository and throws on failure.
 * @param {string} base - .pilotage folder
 * @param {string[]} args - git arguments
 * @param {object} [env] - environment
 * @returns {string} stdout
 * @throws {HistoryError} on failure (first line of stderr)
 */
const mustGit = (base, args, env) => {
  const res = runGit(args, { base, env });
  if (!res.ok) throw new HistoryError(`ERREUR : git ${args[0]} a échoué (${firstLine(res.stderr)}).`);
  return res.stdout;
};

/**
 * Rewrites the whole history of .pilotage/ to replace every match of
 * the patterns, then checks that no object still holds one. Only counts are printed.
 * @param {{base: string, patternsFile: string}} context - .pilotage folder, patterns file
 * @returns {string[]} lines to print
 * @throws {HistoryError} on any refusal or failure
 */
const purgeHistory = ({ base, patternsFile }) => {
  assertCanCommit(base);
  const { file, patterns } = readPatterns(base, patternsFile);
  const current = filesBelow(base, ['.git'])
    .filter(name => containsAny(decodeFile(fs.readFileSync(name)).text, patterns)).length;
  if (current > 0) {
    throw new HistoryError(`ERREUR : un motif est encore présent dans ${current} fichier(s) actuel(s) : le retirer d'abord.`);
  }
  const caughtUp = catchUp({ base, command: 'purge' });
  if (runGit(['status', '--porcelain'], { base }).stdout !== '') {
    throw new HistoryError('ERREUR : suivi non commité, purge impossible.');
  }
  // Commit objects hold identities, shas and trailers, which the tree filter cannot rewrite.
  const { blob: found, commit: inCommits } = objectsWithPattern(base, patterns);
  if (inCommits > 0) {
    throw new HistoryError(`ERREUR : le motif correspond aussi à ${inCommits} commit(s) du mini-dépôt (auteur, e-mail, sha ou branche), que la purge ne réécrit pas : préciser le motif.`);
  }
  // The file is never deleted: it may be the very file that holds the secret elsewhere.
  const keptFile = `Fichier de motifs conservé (${patternsFile}) : le supprimer s'il a été écrit pour la purge.`;
  if (found === 0) {
    return [...caughtUp, "Purge : aucun motif trouvé dans l'historique, rien à réécrire.", keptFile];
  }
  const commits = () => mustGit(base, ['rev-list', '--all']).split('\n');
  const before = commits();
  mustGit(base, ['filter-branch', '-f', '--tree-filter', '"$PILOTAGE_NODE" "$PILOTAGE_PURGE_FILTRE"', '--', '--all'], {
    ...process.env,
    FILTER_BRANCH_SQUELCH_WARNING: '1',
    PILOTAGE_NODE: process.execPath,
    PILOTAGE_PURGE_FILTRE: FILTER_SCRIPT,
    PILOTAGE_MOTIFS: file,
  });
  mustGit(base, ['for-each-ref', '--format=%(refname)', 'refs/original/']).split('\n').filter(Boolean)
    .forEach(ref => mustGit(base, ['update-ref', '-d', ref]));
  mustGit(base, ['reflog', 'expire', '--expire=now', '--all']);
  mustGit(base, ['gc', '--prune=now', '--aggressive', '-q']);
  const left = objectsWithPattern(base, patterns).blob;
  if (left > 0) {
    throw new HistoryError(`ERREUR : vérification échouée, ${left} objet(s) contiennent encore un motif.`);
  }
  const after = new Set(commits());
  const rewritten = before.filter(id => !after.has(id)).length;
  return [...caughtUp, `Purge : ${found} objet(s) contenaient un motif · ${rewritten} commit(s) réécrit(s) · vérification OK`, keptFile];
};

/**
 * Project root: git toplevel when inside a repository, cwd otherwise (same rule as pilotage.mjs).
 * @returns {string} project root
 */
const projectRoot = () => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return process.cwd();
  }
};

const args = process.argv.slice(2);
const at = args.indexOf('--motifs');
const patternsFile = at >= 0 ? args[at + 1] : undefined;
if (!patternsFile || args.length !== 2) {
  console.error(USAGE);
  process.exit(1);
}
try {
  purgeHistory({ base: path.join(projectRoot(), '.pilotage'), patternsFile }).forEach(line => console.log(line));
} catch (error) {
  if (!(error instanceof HistoryError)) throw error;
  console.error(error.message);
  process.exit(1);
}
