#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * pilotage — deterministic helpers for the `pilotage` skill.
 *
 * Subcommands:
 *   init [--chantier <slug>] [--titre <titre>] [--git]
 *                                                create .pilotage/ (git-excluded), optionally a chantier and,
 *                                                with --git, the optional history (.pilotage/.git, see historique.mjs)
 *   decision <slug> <titre...>                   create the next numbered decision file
 *   modele <slug> <essais|connaissances>         add an optional template to a chantier
 *   reprise [<slug>] [--entrees N]               print what a new session needs to resume (the chantier's index line, plan,
 *                                                last journal entries, next free ids, superpowers ledgers, git), within
 *                                                OUTPUT_BUDGET characters; without slug, the whole index
 *   contexte [--session <id>]                    measure the current session: context size, pauses, cache rewrites,
 *                                                cache watch hooks status (Claude Code transcripts only; the session
 *                                                defaults to $CLAUDE_CODE_SESSION_ID)
 *   point <slug>                                 history on: commit .pilotage/ at the end of a checkpoint
 *   purge --motifs <fichier>                     history on: replace the patterns (secrets) in the whole history; run by the user
 *   scan [<dossier>] [--profondeur N] [--clos] [--short|-s] [--group|-g]
 *                                                list the chantiers of every project found below a folder (read-only:
 *                                                INDEX.md, chantier folder names, « En attente » of plan.md); --short
 *                                                prints one line per chantier, --group groups them by project
 *
 * History on (.pilotage/.git): `contexte` and `reprise` first commit pending changes (catch-up).
 *
 * Only `contexte` depends on Claude Code; every other subcommand works with any coding agent.
 * `scan` is the only one that runs from any folder rather than from a project root.
 *
 * Output is French (user-facing). Transcript content is never printed: `contexte` reads only
 * types, timestamps and token counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters, styleText } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  HistoryError, catchUp, commitPoint, gitAvailable, historyActive, initHistory, projectLink, purgeHistory,
} from './historique.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = path.join(SKILL_DIR, 'assets');
const DIR_NAME = '.pilotage';
const EXCLUDE_LINE = `/${DIR_NAME}/`;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SESSION_RE = /^[A-Za-z0-9-]{1,128}$/;

// Read-only on the project: no optional index refresh by `git status`, no index.lock race.
const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

/**
 * Runs a git command and returns trimmed stdout, or null outside a repository / on failure.
 * @param {string[]} args - git arguments
 * @param {string} cwd - working directory
 * @returns {string|null} stdout or null
 */
const git = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      env: READ_ONLY_GIT_ENV,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Resolves the project root: git toplevel when inside a repository, cwd otherwise.
 * @returns {{root: string, inGit: boolean}} root directory and git flag
 */
const projectRoot = () => {
  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  return { root: top ?? process.cwd(), inGit: top !== null };
};

/**
 * Directory of an existing chantier. The slug must match SLUG_RE, so it can never point
 * outside .pilotage/ (e.g. `../..`).
 * @param {string} root - project root
 * @param {string|undefined} slug - chantier slug
 * @returns {string|null} chantier directory, or null when invalid or absent
 */
const chantierDir = (root, slug) => {
  if (!slug || !SLUG_RE.test(slug)) return null;
  const dir = path.join(root, DIR_NAME, slug);
  return fs.existsSync(dir) ? dir : null;
};

// One-letter forms of boolean flags.
const SHORT_FLAGS = { '-s': 'short', '-g': 'group' };

/**
 * A path with the home directory shown as `~`, only when the path is inside it: a plain string replace
 * would also turn `/home/user2` into `~2`, or a home path nested in another tree into `/mnt/copy~`.
 * @param {string} file - absolute path
 * @returns {string} path for display
 */
const tildePath = file => {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

/**
 * Parses `--key value` flags, value-less boolean flags (long or one-letter form) and positional arguments.
 * @param {string[]} argv - raw arguments
 * @param {Set<string>} [booleans] - flags that take no value (they are set to 'true')
 * @returns {{flags: Object<string,string>, positional: string[]}} parsed arguments
 */
const parseArgs = (argv, booleans = new Set(['git', 'clos', 'short', 'group'])) => argv.reduce(
  (acc, arg, i, all) => {
    if (acc.skip) return { ...acc, skip: false };
    if (Object.hasOwn(SHORT_FLAGS, arg)) return { ...acc, flags: { ...acc.flags, [SHORT_FLAGS[arg]]: 'true' } };
    if (arg.startsWith('--') && booleans.has(arg.slice(2))) {
      return { ...acc, flags: { ...acc.flags, [arg.slice(2)]: 'true' } };
    }
    if (arg.startsWith('--')) {
      return { ...acc, flags: { ...acc.flags, [arg.slice(2)]: all[i + 1] ?? '' }, skip: true };
    }
    return { ...acc, positional: [...acc.positional, arg] };
  },
  { flags: {}, positional: [], skip: false },
);

/**
 * Calendar date in the local time zone, as YYYY-MM-DD (toISOString would give the UTC date,
 * a day off in the evening west of Greenwich or in the morning east of it).
 * @param {Date} [date] - instant, now by default
 * @returns {string} local date
 */
const localDate = (date = new Date()) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

const today = () => localDate();

/**
 * Fills a template from assets/ with {{KEY}} placeholders, in one pass: values are inserted
 * verbatim (no `$&` or `$'` replacement patterns) and never scanned for placeholders themselves.
 * @param {string} name - template file name
 * @param {Object<string,string|number>} values - placeholder values
 * @returns {string} rendered text
 */
const render = (name, values) => fs.readFileSync(path.join(ASSETS, name), 'utf8')
  .replace(/\{\{([A-Z]+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/**
 * Writes a file only if it does not exist yet.
 * @param {string} file - target path
 * @param {string} content - file content
 * @returns {boolean} true if written
 */
const writeIfAbsent = (file, content) => {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content);
  return true;
};

/**
 * Ensures .pilotage/ is listed in the repository's info/exclude (worktree-aware).
 * Refuses to proceed if .pilotage is already tracked by git.
 * @param {string} root - repository root
 * @returns {string} human-readable status line
 */
const ensureExcluded = root => {
  const tracked = git(['ls-files', '--', DIR_NAME], root);
  if (tracked) {
    console.error(`ERREUR : ${DIR_NAME}/ contient des fichiers suivis par git. Arrêt, à régler avec l'utilisateur.`);
    process.exit(2);
  }
  const excludePath = path.resolve(root, git(['rev-parse', '--git-path', 'info/exclude'], root));
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (current.split('\n').some(line => line.trim() === EXCLUDE_LINE)) {
    return `exclusion déjà présente dans ${excludePath}`;
  }
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(excludePath, `${prefix}${EXCLUDE_LINE}\n`);
  return `exclusion ajoutée dans ${excludePath}`;
};

/**
 * Runs a history action; a HistoryError is printed on stderr and ends the command with code 1.
 * @param {Function} action - action to run
 * @returns {*} the action's result
 */
const withHistoryErrors = action => {
  try {
    return action();
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
};

/**
 * `init`: create .pilotage/, its INDEX.md, optionally a chantier skeleton and the git history.
 * @param {{flags: Object<string,string>}} args - parsed arguments
 */
const cmdInit = ({ flags }) => {
  const { root, inGit } = projectRoot();
  const base = path.join(root, DIR_NAME);
  fs.mkdirSync(base, { recursive: true });
  console.log(inGit ? ensureExcluded(root) : 'hors dépôt git : aucune exclusion nécessaire');
  const indexWritten = writeIfAbsent(
    path.join(base, 'INDEX.md'),
    render('INDEX.md', { PROJET: path.basename(root) }),
  );
  console.log(`${base}/INDEX.md ${indexWritten ? 'créé' : 'existant'}`);

  const slug = flags.chantier;
  if (slug) {
    if (!SLUG_RE.test(slug)) {
      console.error(`ERREUR : slug invalide « ${slug} » (minuscules, chiffres, tirets).`);
      process.exit(1);
    }
    const dir = path.join(base, slug);
    fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
    const envSession = process.env.CLAUDE_CODE_SESSION_ID ?? '';
    // Ties the opening entry to its transcript (see references/formats.md, "Journal").
    const session = SESSION_RE.test(envSession) ? ` · session ${envSession.slice(0, 8)}` : '';
    const values = { TITRE: flags.titre || slug, DATE: today(), SESSION: session };
    ['plan.md', 'journal.md', 'connaissances.md'].forEach(out => {
      const written = writeIfAbsent(path.join(dir, out), render(out, values));
      console.log(`${dir}/${out} ${written ? 'créé' : 'existant (non modifié)'}`);
    });
  }

  if (flags.git) {
    withHistoryErrors(() => initHistory({ base, root, inGit }).forEach(line => console.log(line)));
  } else if (indexWritten && !historyActive(base) && gitAvailable()) {
    // The only trace of the history mode in the standard flow: one line, once per project.
    console.log('Historique git possible : init --git (voir references/historique.md)');
  }
};

/**
 * `decision`: create decisions/NNN-<slug-titre>.md from the template.
 * @param {{positional: string[]}} args - parsed arguments
 */
const cmdDecision = ({ positional }) => {
  const [slug, ...words] = positional;
  const titre = words.join(' ');
  const { root } = projectRoot();
  const chantier = chantierDir(root, slug);
  const dir = chantier && path.join(chantier, 'decisions');
  if (!titre || !dir || !fs.existsSync(dir)) {
    console.error('Usage : decision <chantier-existant> <titre de la décision>');
    process.exit(1);
  }
  const next = fs.readdirSync(dir)
    .map(name => Number.parseInt(name, 10))
    .filter(Number.isFinite)
    .reduce((max, n) => Math.max(max, n), 0) + 1;
  const num = String(next).padStart(3, '0');
  // A title without any ASCII letter or digit (e.g. only emoji) would leave an empty slug.
  const fileSlug = titre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'decision';
  const file = path.join(dir, `${num}-${fileSlug}.md`);
  fs.writeFileSync(file, render('decision.md', { NUM: num, TITRE: titre, DATE: today() }));
  console.log(file);
};

/**
 * Returns the last `count` journal entries (blocks starting with "## ").
 * @param {string} text - journal content
 * @param {number} count - number of entries
 * @returns {{shown: string, total: number}} rendered entries and total count
 */
const lastEntries = (text, count) => {
  const blocks = text.split(/^(?=## )/m).filter(block => block.startsWith('## '));
  return { shown: blocks.slice(-count).join('').trimEnd(), total: blocks.length };
};

/**
 * Lists decision files with their status line.
 * @param {string} dir - decisions directory
 * @returns {string[]} one line per decision
 */
const decisionSummaries = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
  .filter(name => name.endsWith('.md'))
  .toSorted()
  .map(name => {
    const statut = fs.readFileSync(path.join(dir, name), 'utf8')
      .match(/^- \*\*Statut\*\* : (.*)$/m)?.[1] ?? '?';
    return `- ${name} — ${statut}`;
  });

const BASE_ENTRIES = new Set(['plan.md', 'journal.md', 'connaissances.md', 'decisions']);

/**
 * Removes template guidance comments and the blank lines they leave behind.
 * @param {string} text - markdown content
 * @returns {string} text without HTML comments
 */
const stripComments = text => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trimEnd();

// A subdirectory holding more complementary files than this is summed up in one line.
const MAX_FILES_PER_DIR = 5;

/**
 * Human-readable size in French units.
 * @param {number} bytes - size in bytes
 * @returns {string} e.g. "12 Ko", "1,4 Mo"
 */
const formatSize = bytes => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
  : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`);

/**
 * Size of one complementary file: its line count for a text file, its weight otherwise.
 * @param {string} file - absolute path
 * @returns {string} e.g. "42 lignes", "1263 Ko"
 */
const describeFile = file => {
  const { size } = fs.statSync(file);
  const lines = size < 1_000_000 ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : null;
  return lines === null ? formatSize(size) : `${lines} ligne${lines > 1 ? 's' : ''}`;
};

/**
 * Lists complementary files of a chantier (recursively), with their size, without reading them aloud.
 * A top-level subdirectory with more than MAX_FILES_PER_DIR files (proofs, logs, sources) takes a single
 * line: listing it file by file costs thousands of tokens at every resume for names nobody needs yet.
 * @param {string} dir - chantier directory
 * @returns {string[]} one line per file or summarized subdirectory
 */
const extraFiles = dir => {
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter(rel => !BASE_ENTRIES.has(rel.split(path.sep)[0]))
    .toSorted();
  const topDir = rel => (rel.includes(path.sep) ? rel.split(path.sep)[0] : '');
  const groups = Object.groupBy(files, topDir);
  return files.flatMap(rel => {
    const group = groups[topDir(rel)];
    if (topDir(rel) === '' || group.length <= MAX_FILES_PER_DIR) return [`- ${rel} (${describeFile(path.join(dir, rel))})`];
    if (group[0] !== rel) return [];
    const size = group.reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);
    return [`- ${topDir(rel)}/ (${group.length} fichiers, ${formatSize(size)} ; non détaillés)`];
  });
};

// `décision·Claude` is the former name of `décision·agent`, still found in older journals.
const ID_PREFIXES = {
  directive: 'D', 'décision·utilisateur': 'C', 'décision·agent': 'C', 'décision·Claude': 'C', hypothèse: 'H', question: 'Q', attente: 'A',
};
const ID_DEFINITION_RE = new RegExp(`\\[(${Object.keys(ID_PREFIXES).join('|')}) ([A-Z])(\\d+)\\]`, 'g');

/**
 * Id definition sites (`[hypothèse H3]`) of a chantier's base files. Template guidance comments are
 * stripped first: their examples (`[question Q1]`…) are not real ids.
 * @param {string} dir - chantier directory
 * @returns {Array<{site: string, status: string, prefix: string, num: number}>} definitions
 */
const idDefinitions = dir => ['plan.md', 'journal.md', 'connaissances.md']
  .map(name => path.join(dir, name))
  .filter(file => fs.existsSync(file))
  .flatMap(file => [...stripComments(fs.readFileSync(file, 'utf8')).matchAll(ID_DEFINITION_RE)])
  .map(([site, status, prefix, num]) => ({ site, status, prefix, num: Number(num) }));

// Bare reference to an id (`H1 confirmée`, `bloque : Q3`). One or two digits only, so that `H264`
// or `A380` are not taken for ids.
const ID_REFERENCE_RE = /(?<![\p{L}\p{N}_-])([DCHQA])(\d{1,2})(?![\p{L}\p{N}_-])/gu;

/**
 * Bare id references of a chantier's base files, comments stripped. An id defined only in plan.md is
 * removed from it once settled, and the journal often keeps only a bare reference to it: without
 * these, the id would be handed out again.
 * @param {string} dir - chantier directory
 * @returns {Array<{prefix: string, num: number}>} references
 */
const idReferences = dir => ['plan.md', 'journal.md', 'connaissances.md']
  .map(name => path.join(dir, name))
  .filter(file => fs.existsSync(file))
  .flatMap(file => [...stripComments(fs.readFileSync(file, 'utf8')).matchAll(ID_REFERENCE_RE)])
  .map(([, prefix, num]) => ({ prefix, num: Number(num) }));

/**
 * Computes the next free short id per prefix (D, C, H, Q, A), above every definition and every bare
 * reference. A false positive (`A4` for a paper size) only skips a number; reusing an id would make
 * two items share it. A definition with the wrong prefix still counts for its prefix, so that its id
 * is never handed out again.
 * @param {Array<{prefix: string, num: number}>} ids - id definitions and references
 * @returns {string} e.g. "D4 · C2 · H5 · Q1 · A1"
 */
const nextIds = ids => {
  const max = ids.reduce(
    (acc, { prefix, num }) => ({ ...acc, [prefix]: Math.max(acc[prefix] ?? 0, num) }),
    {},
  );
  return [...new Set(Object.values(ID_PREFIXES))].map(prefix => `${prefix}${(max[prefix] ?? 0) + 1}`).join(' · ');
};

/**
 * Definitions whose prefix does not match their status (e.g. `[hypothèse D9]`).
 * @param {Array<{site: string, status: string, prefix: string}>} definitions - id definitions
 * @returns {string[]} offending definition sites
 */
const misprefixedIds = definitions => definitions
  .filter(({ status, prefix }) => ID_PREFIXES[status] !== prefix)
  .map(({ site }) => site);

/**
 * Summarizes the superpowers plan ledgers (`.superpowers/sdd/<plan>/progress.md`) found in the
 * repository and its worktrees. A ledger exists while executing-plans or subagent-driven-development
 * runs a plan; superpowers deletes the workspace once the final branch review is clean.
 * @param {string} root - project root
 * @returns {string[]} one line per ledger
 */
const superpowersLedgers = root => {
  const worktrees = (git(['worktree', 'list', '--porcelain'], root) ?? '')
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
  return [...new Set([root, ...worktrees])]
    .map(tree => path.join(tree, '.superpowers', 'sdd'))
    .filter(base => fs.existsSync(base))
    .flatMap(base => [
      path.join(base, 'progress.md'),
      ...fs.readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(base, entry.name, 'progress.md')),
    ])
    .filter(file => fs.existsSync(file))
    .map(file => {
      const lines = fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      const plan = lines[0]?.match(/plan: (.*)$/)?.[1] ?? '?';
      const done = lines.filter(line => /Task \d+: complete/.test(line)).length;
      const date = localDate(fs.statSync(file).mtime);
      const last = (lines.at(-1) ?? '').slice(0, 120);
      return `- ${path.relative(root, file) || file} — plan : ${plan} — ${done} tâche(s) complete — modifié le ${date}\n  dernière ligne : ${last}`;
    });
};

/**
 * Finds backticked paths in the "Repères" section of a plan that no longer exist.
 * A path is resolved against the chantier directory, then the project root; `~` is expanded
 * and a trailing `:line` or `:start-end` is ignored. Commands (with spaces) and URLs are skipped.
 * @param {string} planText - plan.md content
 * @param {{root: string, dir: string}} bases - project root and chantier directory
 * @returns {string[]} missing paths as written in the plan
 */
const missingReferences = (planText, { root, dir }) => {
  const section = planText.split(/^## /m).find(block => block.startsWith('Repères')) ?? '';
  return [...section.matchAll(/`([^`\s]+)`/g)]
    .map(match => match[1])
    .filter(ref => ref.includes('/') && !ref.includes('://'))
    .filter(ref => {
      const clean = ref.replace(/:\d+(-\d+)?$/, '').replace(/^~(?=\/)/, os.homedir());
      return !(path.isAbsolute(clean) ? [clean] : [path.join(dir, clean), path.join(root, clean)])
        .some(candidate => fs.existsSync(candidate));
    });
};

/**
 * Reduces INDEX.md to what resuming one chantier needs: the chantier's own line under its section
 * title, then a count of the other entries per section. Closed chantiers and project-wide follow-ups
 * can weigh several thousand tokens; `reprise` without a slug still prints the whole index.
 * @param {string} text - INDEX.md content
 * @param {string} slug - chantier slug
 * @returns {string} reduced index
 */
const indexFor = (text, slug) => {
  const isOwn = line => line.includes(`[${slug}](`);
  const sections = stripComments(text).split(/^(?=## )/m)
    .filter(block => block.startsWith('## '))
    .map(block => {
      const [title, ...body] = block.split('\n');
      return { title, own: body.filter(isOwn), others: body.filter(line => line.startsWith('- ') && !isOwn(line)).length };
    });
  const own = sections.flatMap(({ title, own: lines }) => (lines.length > 0 ? [title, ...lines] : []));
  const others = sections.filter(({ others: count }) => count > 0)
    .map(({ title, others: count }) => `${title.slice(3).trim()} ${count}`);
  return [
    own.length > 0 ? own.join('\n') : `(aucune ligne pour « ${slug} »)`,
    others.length > 0 ? `\nAutres entrées non affichées : ${others.join(' · ')} (index complet : reprise sans chantier)` : '',
  ].join('');
};

// Claude Code keeps a Bash output above ~30 KB out of the conversation and shows only a 2 KB preview,
// so the agent has to read the whole saved file in a second call. `reprise` stays below, with a margin.
const OUTPUT_BUDGET = 25_000;
// git status lines shown by `reprise`; the rest is counted. The plan always keeps its head.
const STATUS_LINES = 40;
const PLAN_FLOOR = 2_000;

/**
 * Caps `git status --short --branch` to its branch line and STATUS_LINES files.
 * @param {string|null} status - git output, null when git failed
 * @returns {string} status block body
 */
const cappedStatus = status => {
  if (status === null) return '(git status a échoué)';
  const [branch, ...files] = status.split('\n');
  const rest = files.length - STATUS_LINES;
  return [branch, ...files.slice(0, STATUS_LINES), ...(rest > 0 ? [`… +${rest} autre(s) fichier(s), voir git status`] : [])].join('\n');
};

/**
 * Cuts a plan at a line boundary so that it fits `keep` characters, with a pointer to the rest.
 * The line number refers to the file on disk: stripped comments only remove lines, so the first
 * omitted line is searched in the raw file from its position in the stripped text onwards.
 * @param {{planText: string, rawText: string, keep: number, slug: string}} args - plan.md content
 *   (comments stripped), raw file content, characters to keep, chantier slug
 * @returns {string} truncated plan
 */
const cutPlan = ({ planText, rawText, keep, slug }) => {
  const lines = planText.split('\n');
  const kept = lines.reduce(
    (acc, line) => (acc.full || acc.length + line.length + 1 > keep
      ? { ...acc, full: true }
      : { ...acc, lines: [...acc.lines, line], length: acc.length + line.length + 1 }),
    { lines: [], length: 0, full: false },
  ).lines;
  const rawAt = rawText.split('\n').indexOf(lines[kept.length], kept.length);
  const from = rawAt >= 0 ? ` à partir de la ligne ${rawAt + 1}` : '';
  return `${kept.join('\n')}\n[… plan.md coupé ici : ${planText.length - kept.join('\n').length} caractères non affichés → lire ${DIR_NAME}/${slug}/plan.md${from}]`;
};

/**
 * `reprise`: print index, plan, last journal entries, decision statuses and git state in one go,
 * within OUTPUT_BUDGET: the journal shrinks to fewer entries first, then the plan is cut.
 * @param {{flags: Object<string,string>, positional: string[]}} args - parsed arguments
 */
const cmdReprise = ({ flags, positional }) => {
  const { root, inGit } = projectRoot();
  const base = path.join(root, DIR_NAME);
  if (historyActive(base)) catchUp({ base, command: 'reprise' }).forEach(line => console.log(line));
  const index = path.join(base, 'INDEX.md');
  if (!fs.existsSync(index)) {
    console.log(`Aucun ${DIR_NAME}/INDEX.md dans ${root} → rien à reprendre.`);
    return;
  }
  const indexText = fs.readFileSync(index, 'utf8');
  const [slug] = positional;
  if (!slug) {
    console.log(`=== ${DIR_NAME}/INDEX.md ===\n${indexText.trimEnd()}\n`);
    console.log('(Préciser le chantier : reprise <slug>)');
    return;
  }
  const dir = chantierDir(root, slug);
  if (!dir) {
    console.log(`=== ${DIR_NAME}/INDEX.md ===\n${indexText.trimEnd()}\n`);
    console.error(`ERREUR : chantier « ${slug} » introuvable dans ${base}.`);
    process.exit(1);
  }

  const blocks = [`=== ${DIR_NAME}/INDEX.md — ligne du chantier ===\n${indexFor(indexText, slug)}\n`];
  if (inGit && git(['check-ignore', '-q', path.join(DIR_NAME, 'INDEX.md')], root) === null) {
    blocks.push(`ALERTE : ${DIR_NAME}/ n'est plus ignoré par git (relancer init, ne rien commiter).\n`);
  }
  const plan = path.join(dir, 'plan.md');
  const rawPlan = fs.existsSync(plan) ? fs.readFileSync(plan, 'utf8') : null;
  const planText = rawPlan === null ? null : stripComments(rawPlan);
  const planHeader = `=== ${slug}/plan.md ===\n`;
  const planAt = planText === null ? -1 : blocks.push(`${planHeader}${planText}\n`) - 1;
  if (planText !== null) {
    const missing = missingReferences(planText, { root, dir });
    if (missing.length > 0) blocks.push(`ALERTE : chemins cités dans « Repères » introuvables :\n${missing.map(p => `- ${p}`).join('\n')}\n`);
  }

  const knowledge = path.join(dir, 'connaissances.md');
  if (fs.existsSync(knowledge)) {
    const headings = fs.readFileSync(knowledge, 'utf8').split('\n').filter(line => /^#{2,3} /.test(line));
    blocks.push(`=== ${slug}/connaissances.md — titres seulement ===\n${headings.join('\n') || '(vide)'}\n`);
  }

  const journal = path.join(dir, 'journal.md');
  const journalText = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : null;
  const requested = Number(flags.entrees ?? 3);
  const count = Number.isInteger(requested) && requested >= 1 ? requested : 3;
  const journalBlock = n => {
    const { shown, total } = lastEntries(journalText, n);
    return `=== ${slug}/journal.md — ${Math.min(n, total)} dernière(s) entrée(s) sur ${total} ===\n${shown}\n`;
  };
  const journalAt = journalText === null ? -1 : blocks.push(journalBlock(count)) - 1;

  const decisions = decisionSummaries(path.join(dir, 'decisions'));
  if (decisions.length > 0) blocks.push(`=== ${slug}/decisions ===\n${decisions.join('\n')}\n`);
  const others = extraFiles(dir);
  if (others.length > 0) blocks.push(`=== ${slug} — fichiers complémentaires (non affichés) ===\n${others.join('\n')}\n`);
  const definitions = idDefinitions(dir);
  blocks.push(`=== ${slug} — prochains identifiants libres ===\n${nextIds([...definitions, ...idReferences(dir)])}\n`);
  const misprefixed = misprefixedIds(definitions);
  if (misprefixed.length > 0) blocks.push(`ALERTE : identifiants au préfixe incohérent avec leur statut (D directive, C décision, H hypothèse, Q question, A attente) :\n${misprefixed.map(site => `- ${site}`).join('\n')}\n`);

  if (inGit) {
    const ledgers = superpowersLedgers(root);
    if (ledgers.length > 0) blocks.push(`=== registres superpowers en cours (non affichés) ===\n${ledgers.join('\n')}\n`);
    const status = cappedStatus(git(['status', '--short', '--branch'], root));
    const link = projectLink({ base, root, inGit, slug });
    const log = link ? link.join('\n') : git(['log', '--oneline', '-8'], root) ?? '(git log a échoué)';
    // Commit messages may come from third parties: no escape sequence reaches the output.
    blocks.push(printable(`=== git ===\n${status}\n\n${log}`));
  }

  // Each block is printed by its own console.log, hence the +1 for its newline.
  const sizeOf = list => list.reduce((sum, block) => sum + block.length + 1, 0);
  const withBlock = (list, at, block) => list.map((existing, i) => (i === at ? block : existing));
  const entries = journalAt < 0 || sizeOf(blocks) <= OUTPUT_BUDGET
    ? count
    : Array.from({ length: count }, (_, i) => count - i)
      .find(n => sizeOf(withBlock(blocks, journalAt, journalBlock(n))) <= OUTPUT_BUDGET) ?? 1;
  const shrunk = journalAt < 0 ? blocks : withBlock(blocks, journalAt, journalBlock(entries));
  const overflow = sizeOf(shrunk) - OUTPUT_BUDGET;
  const keep = planAt < 0 ? 0 : Math.max(planText.length - overflow - 300, PLAN_FLOOR);
  const fitted = overflow > 0 && planAt >= 0 && keep < planText.length
    ? withBlock(shrunk, planAt, `${planHeader}${cutPlan({ planText, rawText: rawPlan, keep, slug })}\n`)
    : shrunk;

  const reductions = [
    entries < count ? `journal ramené à ${entries} entrée(s)` : null,
    fitted !== shrunk ? 'plan.md coupé' : null,
  ].filter(Boolean);
  if (reductions.length > 0) {
    console.log(`ALERTE : sortie réduite pour rester sous ~30 Ko (au-delà, Claude Code n'en montre qu'un aperçu) : ${reductions.join(', ')}. Alléger le suivi : « Où on en est » court, détails dans des fichiers complémentaires.\n`);
  }
  fitted.forEach(block => console.log(block));
};

/**
 * Converts a directory path to Claude Code's project slug (every non-alphanumeric char → "-").
 * @param {string} dir - absolute directory
 * @returns {string} project slug
 */
const projectSlug = dir => dir.replace(/[^a-zA-Z0-9]/g, '-');

/** Bytes read at the head of a transcript to find its working directory. */
const CWD_PROBE_BYTES = 1024 * 1024;

/**
 * Working directory recorded in a transcript: the `cwd` field of its first entry that has one,
 * within its first CWD_PROBE_BYTES (metadata only).
 * @param {string} file - transcript path
 * @returns {string|null} working directory, or null when absent or unreadable
 */
const transcriptCwd = file => {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(CWD_PROBE_BYTES);
      head = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, CWD_PROBE_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const { cwd } = JSON.parse(line);
      if (typeof cwd === 'string') return cwd;
    } catch {
      // Truncated last line or malformed entry: try the next one.
    }
  }
  return null;
};

/**
 * Locates the transcript of the current session. Claude Code files transcripts under the folder the
 * session started in, which may be a subfolder of the project root: the root, the cwd and every
 * project folder below the root are searched. A slug does not tell `foo/bar` from the sibling
 * project `foo-bar`, so a transcript found through a longer slug counts only if its recorded
 * working directory lies inside the root.
 * @param {string|undefined} sessionId - explicit session id
 * @returns {string|null} transcript path
 */
const findTranscript = sessionId => {
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const { root } = projectRoot();
  const exactSlugs = new Set([projectSlug(root), projectSlug(process.cwd())]);
  const projectDirs = fs.readdirSync(projectsDir)
    .filter(name => exactSlugs.has(name) || name.startsWith(`${projectSlug(root)}-`))
    .map(name => ({ dir: path.join(projectsDir, name), exact: exactSlugs.has(name) }));
  const inProject = ({ file, exact }) => {
    if (exact) return true;
    const cwd = transcriptCwd(file);
    return cwd !== null && cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  };
  if (sessionId) {
    return projectDirs
      .map(({ dir, exact }) => ({ file: path.join(dir, `${sessionId}.jsonl`), exact }))
      .find(candidate => fs.existsSync(candidate.file) && inProject(candidate))?.file ?? null;
  }
  // The current session's transcript is the one being written right now.
  return projectDirs
    .flatMap(({ dir, exact }) => fs.readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => ({ file: path.join(dir, name), exact })))
    .map(candidate => ({ ...candidate, mtime: fs.statSync(candidate.file).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime)
    .find(inProject)?.file ?? null;
};

/**
 * Parses a transcript into main-thread turns and user prompts (metadata only).
 * @param {string} file - transcript path
 * @returns {{turns: Array<{ts: number, context: number, written: number}>, prompts: number[]}} parsed data
 */
const parseTranscript = file => {
  const entries = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(entry => entry && !entry.isSidechain && entry.timestamp);
  // Claude Code writes one line per content block of an API response, each repeating the same usage:
  // one turn per message id (position of its first line, timestamp of its last one).
  const turns = [...new Map(entries
    .filter(entry => entry.type === 'assistant' && entry.message?.usage)
    .map((entry, i) => {
      const { usage } = entry.message;
      const written = usage.cache_creation_input_tokens ?? 0;
      const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + written;
      return [entry.message.id ?? `#${i}`, { ts: Date.parse(entry.timestamp), context, written }];
    })).values()];
  const prompts = entries
    .filter(entry => entry.type === 'user' && !entry.isMeta)
    .filter(({ message }) => typeof message?.content === 'string'
      || (Array.isArray(message?.content) && message.content.some(part => part.type === 'text')))
    .map(entry => Date.parse(entry.timestamp));
  return { turns, prompts };
};

const fmtK = n => `${Math.round(n / 1000)}K`;
const fmtMin = ms => `${Math.round(ms / 60000)} min`;

/**
 * Parsed settings file (unreadable or invalid file → empty object).
 * @param {string} file - settings.json path
 * @returns {object} settings
 */
const readSettings = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

/**
 * One-line status of the cache watch hooks (see the README, « Cache watch »), from user and project settings.
 * @param {string} root - project root
 * @param {boolean} inClaudeCode - whether the script runs inside Claude Code
 * @returns {string} status line
 */
const veilleStatus = (root, inClaudeCode) => {
  const userDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  // Lowest to highest precedence, as Claude Code merges them.
  const settings = [
    path.join(userDir, 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
  ].map(file => ({ file, ...readSettings(file) }));
  const find = (event, verb) => settings
    .flatMap(({ file, hooks }) => (hooks?.[event] ?? [])
      .flatMap(group => group.hooks ?? [])
      .map(hook => ({ file, command: hook.command ?? '' })))
    .find(({ command }) => new RegExp(`veille\\.mjs["']?\\s+${verb}\\b`).test(command));
  const armer = find('Stop', 'armer');
  const desarmer = find('UserPromptSubmit', 'desarmer');
  if (!armer) {
    return inClaudeCode
      ? 'Veille cache : non installée (facultative : veille.mjs config, README de mabhub/pilotage)'
      : 'Veille cache : sans objet hors Claude Code';
  }
  if (!desarmer) return 'Veille cache : incomplète, hook UserPromptSubmit absent (veille.mjs config, README de mabhub/pilotage)';
  if (!fs.existsSync('/proc/self/cmdline')) return 'Veille cache : installée mais inactive, /proc absent (README de mabhub/pilotage)';
  // Same resolution as veille.mjs sees it: command prefix, then settings `env`, then the shell.
  const raw = armer.command.match(/PILOTAGE_VEILLE_DELAI=(\S+)/)?.[1]
    ?? settings.findLast(({ env }) => env?.PILOTAGE_VEILLE_DELAI !== undefined)?.env.PILOTAGE_VEILLE_DELAI
    ?? process.env.PILOTAGE_VEILLE_DELAI;
  const delay = Number.isInteger(Number(raw)) && Number(raw) >= 1 ? Number(raw) : 3300;
  return `Veille cache : active (réveil à ${Math.round(delay / 60)} min, ${tildePath(armer.file)})`;
};

/**
 * `contexte`: report context size, pauses and full cache rewrites of the current session,
 * plus the status of the cache watch hooks.
 * @param {{flags: Object<string,string>}} args - parsed arguments
 */
const cmdContexte = ({ flags }) => {
  // Same rule as veille.mjs: the id becomes a file name, so `../x` must not leave the projects folder.
  if (flags.session !== undefined && !SESSION_RE.test(flags.session)) {
    console.error(`ERREUR : identifiant de session invalide « ${flags.session} » (lettres, chiffres, tirets).`);
    process.exit(1);
  }
  // Claude Code exports both variables to the commands it runs; other agents set neither.
  const inClaudeCode = Boolean(process.env.CLAUDECODE);
  const envSession = process.env.CLAUDE_CODE_SESSION_ID;
  const sessionId = flags.session ?? (SESSION_RE.test(envSession ?? '') ? envSession : undefined);
  const { root } = projectRoot();
  console.log(veilleStatus(root, inClaudeCode));
  const base = path.join(root, DIR_NAME);
  if (historyActive(base)) catchUp({ base, command: 'contexte' }).forEach(line => console.log(line));
  const exact = sessionId ? findTranscript(sessionId) : null;
  // Without an exact match, guess the most recent transcript, only inside Claude Code (elsewhere it
  // would be an older Claude Code session of the project) and unless the user named the session.
  const file = exact ?? (flags.session || !inClaudeCode ? null : findTranscript());
  if (!file) {
    console.log(inClaudeCode || flags.session
      ? 'Transcript introuvable (passer --session <id>). Taille de contexte inconnue.'
      : "Taille de contexte non mesurable hors Claude Code. L'estimer (voir references/autres-agents.md).");
    return;
  }
  const { turns, prompts } = parseTranscript(file);
  if (turns.length === 0) {
    console.log(`Aucun tour mesurable dans ${path.basename(file)}.`);
    return;
  }
  const last = turns.at(-1);
  // Gap before each prompt = time since the previous assistant turn.
  const pauses = prompts
    .map(ts => ({ ts, gap: ts - (turns.findLast(turn => turn.ts < ts)?.ts ?? ts) }))
    .filter(pause => pause.gap > 0);
  const lastPause = pauses.at(-1);
  const longPauses = pauses.filter(pause => pause.gap > 60 * 60000);
  // A full rewrite: most of the context written to cache in one turn after a previous turn existed.
  const rewrites = turns.slice(1).filter(turn => turn.written > 0.6 * turn.context && turn.context > 50000);

  console.log(`Session : ${path.basename(file, '.jsonl')}${exact ? '' : ' (transcript le plus récent du projet)'}`);
  console.log(`Contexte au dernier tour : ${fmtK(last.context)} · tours mesurés : ${turns.length}`);
  console.log(`Pic de contexte : ${fmtK(Math.max(...turns.map(turn => turn.context)))}`);
  console.log(`Pause avant le dernier message : ${lastPause ? fmtMin(lastPause.gap) : 'aucune'}`);
  console.log(`Pauses > 1 h dans la session : ${longPauses.length}`);
  console.log(`Réécritures complètes du cache : ${rewrites.length}${rewrites.length ? ` (dernière : ${fmtK(rewrites.at(-1).written)})` : ''}`);
};

/** Optional templates that `modele` can add to an existing chantier. */
const OPTIONAL_TEMPLATES = new Set(['essais', 'connaissances']);

/**
 * `modele`: add an optional template (e.g. essais.md) to an existing chantier, never overwriting.
 * @param {{positional: string[]}} args - parsed arguments
 */
const cmdModele = ({ positional }) => {
  const [slug, name] = positional;
  const { root } = projectRoot();
  const dir = chantierDir(root, slug);
  if (!dir || !OPTIONAL_TEMPLATES.has(name)) {
    console.error(`Usage : modele <chantier-existant> <${[...OPTIONAL_TEMPLATES].join('|')}>`);
    process.exit(1);
  }
  const file = path.join(dir, `${name}.md`);
  const written = writeIfAbsent(file, render(`${name}.md`, { TITRE: slug, DATE: today() }));
  console.log(`${file} ${written ? 'créé' : 'existant (non modifié)'}`);
};

/**
 * `point`: commit .pilotage/ at the end of a checkpoint (history on only).
 * @param {{positional: string[]}} args - parsed arguments
 */
const cmdPoint = ({ positional }) => {
  const [slug] = positional;
  const { root, inGit } = projectRoot();
  if (!chantierDir(root, slug)) {
    console.error('Usage : point <chantier-existant>');
    process.exit(1);
  }
  const base = path.join(root, DIR_NAME);
  withHistoryErrors(() => commitPoint({ base, root, inGit, slug }).forEach(line => console.log(line)));
};

/**
 * `purge --motifs <file>`: removes secrets from the whole history of .pilotage/.
 * @param {{flags: Object<string,string>}} args - parsed arguments
 */
const cmdPurge = ({ flags }) => {
  const { root } = projectRoot();
  const base = path.join(root, DIR_NAME);
  if (historyActive(base) && !flags.motifs) {
    console.error('Usage : purge --motifs <fichier>');
    process.exit(1);
  }
  withHistoryErrors(() => purgeHistory({ base, patternsFile: flags.motifs }).forEach(line => console.log(line)));
};

// `scan` never descends into these: dependencies and virtual environments hold no project of their own
// and can be huge. Hidden directories are skipped too (.git, .venv…), `.pilotage` itself included.
const SCAN_SKIP = new Set(['node_modules', 'vendor', 'venv', '__pycache__']);
const SCAN_DEFAULT_DEPTH = 4;
const SCAN_MAX_DEPTH = 10;
// An active chantier without checkpoint for longer than this is flagged as dormant.
const DORMANT_DAYS = 30;
const SCAN_TEXT_MAX = 200;
// Chantiers updated within this many days are shown as fresh (green) in a terminal.
const FRESH_DAYS = 7;

/**
 * Directory entries, or null when the directory cannot be read (permissions, vanished).
 * @param {string} dir - directory
 * @returns {fs.Dirent[]|null} entries or null
 */
const readDirSafe = dir => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
};

/**
 * Text content of a file, or null when it cannot be read (permissions, vanished, not a file).
 * @param {string} file - file path
 * @returns {string|null} content or null
 */
const readTextSafe = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// C0 and C1 control characters except the line feed. `scan` prints text read from other projects, and
// `reprise` commit messages, both possibly from a third party: no escape sequence must reach the output.
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const printable = text => text.replace(CONTROL_RE, '');

/**
 * Walks a tree for project folders holding `.pilotage/INDEX.md`. The walk never follows a symbolic link
 * (a Dirent for a link is not a directory), so a linked project is neither listed twice nor escaped to;
 * a `.pilotage` that is itself a link (synced folder) is still read, as `reprise` does.
 * @param {string} dir - directory to scan
 * @param {number} depth - depth of `dir` below the scan root
 * @param {number} maxDepth - deepest level where a project is looked for
 * @returns {{projects: string[], unreadable: number}} project directories and unreadable directory count
 */
const findProjects = (dir, depth, maxDepth) => {
  const entries = readDirSafe(dir);
  if (entries === null) return { projects: [], unreadable: 1 };
  const own = fs.existsSync(path.join(dir, DIR_NAME, 'INDEX.md')) ? [dir] : [];
  const children = depth < maxDepth
    ? entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SCAN_SKIP.has(entry.name))
      .map(entry => findProjects(path.join(dir, entry.name), depth + 1, maxDepth))
    : [];
  return children.reduce(
    (acc, child) => ({ projects: [...acc.projects, ...child.projects], unreadable: acc.unreadable + child.unreadable }),
    { projects: own, unreadable: 0 },
  );
};

const INDEX_LINE_RE = /^- \[([^\]]+)\]\(([^)]*)\)\s*(?:—\s*)?(.*)$/;
const INDEX_DATE_RE = /\s*·\s*(?:maj|clos)\s+(\d{4}-\d{2}-\d{2})/;

/**
 * Sections of an INDEX.md: chantier lines (`- [slug](lien) — texte · maj AAAA-MM-JJ`) and the count of
 * all bullet lines, so that free-form sections (« À suivre ») are counted too. Template comments are ignored,
 * control characters removed.
 * @param {string} text - INDEX.md content
 * @returns {Array<{title: string, bullets: number, entries: Array<{slug: string, text: string, date: string|null}>}>} sections
 */
const parseIndex = text => stripComments(printable(text)).split(/^(?=## )/m)
  .filter(block => block.startsWith('## '))
  .map(block => {
    const [title, ...body] = block.split('\n');
    const entries = body.map(line => line.match(INDEX_LINE_RE)).filter(Boolean).map(([, slug, , rest]) => {
      const date = rest.match(INDEX_DATE_RE);
      return { slug, text: (date ? rest.replace(date[0], '') : rest).trim(), date: date?.[1] ?? null };
    });
    return { title: title.slice(3).trim(), bullets: body.filter(line => line.startsWith('- ')).length, entries };
  });

const PENDING_RE = /\[(?:question|attente)(?:\s+([QA]\d+))?\]/g;
const LAST_POINT_RE = /\*\*Dernier point d'étape\*\*\s*:\s*(\d{4}-\d{2}-\d{2})/;

/**
 * What `scan` reads from a plan.md: the last checkpoint date and the questions and actions waiting for
 * the user (« En attente » section only; ids, or null for an item written without id).
 * @param {string} planFile - plan.md path
 * @returns {{lastPoint: string|null, pending: Array<string|null>}} plan summary
 */
const planSummary = planFile => {
  const raw = readTextSafe(planFile);
  if (raw === null) return { lastPoint: null, pending: [] };
  const text = stripComments(raw);
  const section = text.split(/^(?=## )/m).find(block => block.startsWith('## En attente'));
  return {
    lastPoint: text.match(LAST_POINT_RE)?.[1] ?? null,
    pending: section ? [...section.matchAll(PENDING_RE)].map(([, id]) => id ?? null) : [],
  };
};

/**
 * Days elapsed since a date (YYYY-MM-DD), counted in whole days from today. Both dates parse as
 * UTC midnight, so the difference is a whole number of days whatever the zone or daylight saving.
 * @param {string} date - ISO date
 * @returns {number} days
 */
const daysSince = date => Math.round((Date.parse(today()) - Date.parse(date)) / 86_400_000);

/**
 * Everything `scan` needs from one project: index entries, pending ids of active chantiers, anomalies.
 * Only INDEX.md, the chantier folder names, and the last checkpoint date and « En attente » section of
 * plan.md are read. An index line without `maj` falls back on the plan's last checkpoint date.
 * @param {string} dir - project directory
 * @param {string} name - project name shown (path relative to the scan root)
 * @returns {object|null} project summary, or null when INDEX.md cannot be read
 */
const scanProject = (dir, name) => {
  const base = path.join(dir, DIR_NAME);
  const index = readTextSafe(path.join(base, 'INDEX.md'));
  if (index === null) return null;
  const sections = parseIndex(index);
  const entriesOf = title => sections.filter(section => section.title === title).flatMap(({ entries }) => entries);
  const planOf = slug => (SLUG_RE.test(slug) ? path.join(base, slug, 'plan.md') : null);
  const active = entriesOf('Actifs').map(entry => {
    const { lastPoint, pending } = planOf(entry.slug) ? planSummary(planOf(entry.slug)) : { lastPoint: null, pending: [] };
    return { ...entry, project: name, date: entry.date ?? lastPoint, pending };
  });
  const indexed = new Set(sections.flatMap(({ entries }) => entries.map(({ slug }) => slug)));
  const unindexed = (readDirSafe(base) ?? [])
    .filter(entry => entry.isDirectory() && SLUG_RE.test(entry.name) && !indexed.has(entry.name))
    .filter(entry => fs.existsSync(path.join(base, entry.name, 'plan.md')))
    .map(entry => `chantier « ${entry.name} » absent de INDEX.md`);
  const missing = active.filter(({ slug }) => !planOf(slug) || !fs.existsSync(planOf(slug)))
    .map(({ slug }) => `« ${slug} » actif sans ${DIR_NAME}/${slug}/plan.md`);
  return {
    dir,
    name,
    active,
    closed: entriesOf('Clos').map(entry => ({ ...entry, project: name })),
    otherSections: sections.filter(({ title, bullets }) => title !== 'Actifs' && title !== 'Clos' && bullets > 0)
      .map(({ title, bullets }) => `${title} ${bullets}`),
    anomalies: [...missing, ...unindexed],
  };
};

/**
 * Shortens a free-text index entry.
 * @param {string} text - entry text
 * @param {number} max - maximum length
 * @returns {string} text, cut with an ellipsis when too long
 */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Longest description line: the terminal width in a terminal, so that every entry keeps its two-line
 * rhythm instead of wrapping; SCAN_TEXT_MAX otherwise.
 * @returns {number} maximum length
 */
const scanTextMax = () => (process.stdout.isTTY && process.stdout.columns
  ? Math.max(40, process.stdout.columns - 3)
  : SCAN_TEXT_MAX);

/** Most recent first; undated entries last, then by project and slug. */
const byDateDesc = (a, b) => (b.date ?? '').localeCompare(a.date ?? '')
  || a.project.localeCompare(b.project) || a.slug.localeCompare(b.slug);

/**
 * Head line of an active chantier: where and how fresh.
 * Styles only apply in a terminal: styleText drops them when stdout is piped or redirected (an agent's
 * call), and honours NO_COLOR / FORCE_COLOR. Every head line keeps the same anchors (bold project when shown,
 * coloured chantier) so that heads stay distinct from descriptions; the age shows only in the date's colour.
 * No dim style: some terminals do not render it, and a dimmed line then loses every anchor.
 * @param {object} entry - active entry from scanProject
 * @param {boolean} withProject - false under a project heading (--group) or when there is a single project
 * @returns {string} head line
 */
const activeHead = ({ project, slug, date, pending }, withProject) => {
  const age = date ? daysSince(date) : null;
  const dormant = age > DORMANT_DAYS;
  const when = date ? `maj ${date} (${age} j${dormant ? ', dormant' : ''})` : 'sans date';
  const ids = pending.filter(Boolean);
  const anonymous = pending.length - ids.length;
  const waiting = pending.length > 0
    ? ` · ${styleText('yellow', `attend : ${[...ids, ...(anonymous > 0 ? [`${anonymous} sans id`] : [])].join(', ')}`)}`
    : '';
  const fresh = age !== null && age <= FRESH_DAYS;
  const shownWhen = fresh ? styleText('green', when) : dormant ? styleText('magenta', when) : when;
  return `${withProject ? `${styleText('bold', project)} · ` : ''}${styleText('cyan', slug)} · ${shownWhen}${waiting}`;
};

/**
 * A head and its description on one line, the description clipped so that the whole line fits `width`
 * visible characters (style codes do not count); the head alone when no room is left.
 * @param {string} head - possibly styled head
 * @param {string} text - description
 * @param {number} width - longest line
 * @returns {string} line
 */
const oneLine = (head, text, width) => {
  const room = width - stripVTControlCharacters(head).length - 3;
  return room > 1 && text ? `${head} — ${clip(text, room)}` : head;
};

/**
 * Layout of the chantier lists: one line per chantier (--short) or two; project on every line, as a
 * heading (--group), or nowhere (single project, already named in the header).
 * @param {{short: boolean, group: boolean, withProject: boolean, textMax: number}} options - layout options
 * @returns {{active: function(object): string, closed: function(object): string}} formatters
 */
const scanLayout = ({ short, group, withProject, textMax }) => {
  const indent = group ? '  ' : '';
  const lineMax = textMax + 2;
  return {
    active: entry => {
      const head = indent + activeHead(entry, withProject);
      return short
        ? oneLine(head, entry.text, lineMax)
        : `${head}\n${indent}  ${clip(entry.text, lineMax - indent.length - 2)}`;
    },
    closed: ({ project, slug, date, text }) => indent
      + clip(`${withProject ? `${project} · ` : ''}${slug} · clos ${date ?? '?'} — ${text}`, lineMax - indent.length),
  };
};

/**
 * Chantier lines, under a bold heading per project (--group) or as they come. Projects keep the order of
 * their first chantier in `entries`: with entries sorted most recent first, the most active project leads.
 * @param {object[]} entries - sorted entries, each with a `project`
 * @param {function(object): string} format - one entry's lines
 * @param {boolean} group - group by project
 * @returns {string} lines
 */
const listChantiers = (entries, format, group) => (group
  ? [...Map.groupBy(entries, ({ project }) => project)]
    .map(([project, list]) => `${styleText('bold', project)} (${list.length})\n${list.map(format).join('\n')}`)
    .join('\n')
  : entries.map(format).join('\n'));

/**
 * Section title of the scan output, bold in a terminal.
 * @param {string} title - title text
 * @returns {string} styled title line
 */
const scanTitle = title => styleText('bold', `=== ${title} ===`);

/**
 * `scan [<racine>] [--profondeur N] [--clos] [--short|-s] [--group|-g]`: list the chantiers of every project
 * found below a folder, on two lines each or one (--short), the project on every line or as a heading (--group).
 * Read-only; meant to be run by the user in a terminal as well as by an agent. Output is capped at
 * OUTPUT_BUDGET characters, except in a terminal.
 * @param {{flags: Object<string,string>, positional: string[]}} args - parsed arguments
 */
const cmdScan = ({ flags, positional }) => {
  const root = path.resolve(positional[0] ?? process.cwd());
  const depth = flags.profondeur === undefined ? SCAN_DEFAULT_DEPTH : Number(flags.profondeur);
  if (!Number.isInteger(depth) || depth < 0 || depth > SCAN_MAX_DEPTH || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Usage : scan [<dossier>] [--profondeur 0-${SCAN_MAX_DEPTH}] [--clos] [--short|-s] [--group|-g]`);
    process.exit(1);
  }
  const { projects: dirs, unreadable: unreadableDirs } = findProjects(root, 0, depth);
  const scanned = dirs.toSorted().map(dir => scanProject(dir, printable(path.relative(root, dir) || path.basename(root))));
  const projects = scanned.filter(Boolean);
  const unreadable = unreadableDirs + scanned.length - projects.length;
  // A single project is named in the header: neither a project heading nor the name on every line, and
  // no « Sans chantier actif » section, which would only repeat the header's « 0 chantier actif ».
  const single = projects.length === 1;
  const named = (name, text) => (single ? text : `${name} : ${text}`);
  const active = projects.flatMap(({ active: list }) => list).toSorted(byDateDesc);
  const idle = single ? [] : projects.filter(({ active: list }) => list.length === 0).map(({ name }) => name);
  const others = projects.filter(({ otherSections }) => otherSections.length > 0)
    .map(({ name, otherSections }) => named(name, otherSections.join(' · ')));
  const anomalies = projects.flatMap(({ name, anomalies: list }) => list.map(anomaly => named(name, anomaly)));
  const closed = projects.flatMap(({ closed: list }) => list).toSorted(byDateDesc);
  const shown = dir => tildePath(printable(dir));
  const group = Boolean(flags.group) && !single;
  const layout = scanLayout({ short: Boolean(flags.short), group, withProject: !group && !single, textMax: scanTextMax() });
  const header = [
    // A single project: its path says it all, the scan root, depth and project count add nothing.
    single
      ? `Chantiers de ${shown(projects[0].dir)} — `
      : `Chantiers sous ${shown(root)} (profondeur ${depth}) — ${projects.length} projet${projects.length > 1 ? 's' : ''} suivi${projects.length > 1 ? 's' : ''}, `,
    `${active.length} chantier${active.length > 1 ? 's' : ''} actif${active.length > 1 ? 's' : ''}`,
    unreadable > 0 ? ` · ${unreadable} dossier${unreadable > 1 ? 's' : ''} illisible${unreadable > 1 ? 's' : ''} ignoré${unreadable > 1 ? 's' : ''}` : '',
  ].join('');
  const blocks = [
    header,
    active.length > 0
      ? `${scanTitle(`Actifs${group ? ' par projet' : ''} (plus récents d'abord)`)}\n${listChantiers(active, layout.active, group)}`
      : '',
    idle.length > 0 ? `${scanTitle(`Sans chantier actif (${idle.length})`)}\n${idle.join(', ')}` : '',
    others.length > 0 ? `${scanTitle('Autres sections')}\n${others.join('\n')}` : '',
    anomalies.length > 0
      ? `${scanTitle('Anomalies')}\n${anomalies.map(anomaly => styleText('red', anomaly)).join('\n')}`
      : '',
    flags.clos && closed.length > 0
      ? `${scanTitle(`Clos (${closed.length}${group ? ', par projet' : ''}, plus récents d'abord)`)}\n${listChantiers(closed, layout.closed, group)}`
      : '',
  ].filter(Boolean);
  const output = blocks.join('\n\n');
  // The budget protects an agent's context; a user reading in a terminal gets everything.
  if (output.length <= OUTPUT_BUDGET || process.stdout.isTTY) {
    console.log(output);
    return;
  }
  const cut = output.slice(0, output.lastIndexOf('\n', OUTPUT_BUDGET));
  const remedies = ['restreindre le dossier', '--profondeur', ...(flags.short ? [] : ['--short'])].join(', ');
  console.log(`ALERTE : sortie coupée à ${cut.length} caractères sur ${output.length} → ${remedies}, ou retirer --clos\n\n${cut}`);
};

const COMMANDS = {
  scan: cmdScan,
  modele: cmdModele,
  init: cmdInit,
  decision: cmdDecision,
  reprise: cmdReprise,
  contexte: cmdContexte,
  point: cmdPoint,
  purge: cmdPurge,
};

const [command, ...rest] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) {
  console.error('Usage : pilotage.mjs <init|decision|modele|reprise|contexte|point|purge|scan> [options]');
  process.exit(1);
}
handler(parseArgs(rest));
