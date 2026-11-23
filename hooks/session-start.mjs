#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Claude Code `SessionStart` hook: shows the user the active chantiers when a session starts or after `/clear`.
 *
 * Installed by hand by the user (README, « Session start overview »); the skill never installs it. It lives
 * outside the skill folder on purpose: it is not part of what the agent loads or runs.
 *
 *   node <clone>/hooks/session-start.mjs                       project of the session, depth 0
 *   node <clone>/hooks/session-start.mjs <dossier> [--profondeur N] [--clos]   passed to `scan` as is
 *
 * Output contract, from the hooks reference (https://code.claude.com/docs/en/hooks):
 * - only JSON on stdout: plain stdout of a SessionStart hook is added to the model's context, a
 *   `systemMessage` is shown to the user;
 * - nothing at all when there is nothing to report (no active chantier, no anomaly);
 * - `systemMessage` kept under the 10,000-character cap, beyond which Claude Code swaps it for a file path;
 * - exit code 0 in every case: a SessionStart hook cannot block, and a failure becomes a short message.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PILOTAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pilotage', 'scripts', 'pilotage.mjs');
const MESSAGE_MAX = 9_000;
const SCAN_TIMEOUT_MS = 10_000;

/**
 * Arguments given to `scan`: the session's project at depth 0 by default, the caller's arguments otherwise.
 * @param {string[]} args - command-line arguments of the hook
 * @returns {string[]} scan arguments
 */
const scanArgs = args => (args.length > 0
  ? args
  : [process.env.CLAUDE_PROJECT_DIR || process.cwd(), '--profondeur', '0']);

/**
 * Whether the scan output has something to show: at least one active chantier, or an anomaly.
 * @param {string} output - scan output
 * @returns {boolean} true if worth a message
 */
const worthShowing = output => /\b[1-9]\d* chantiers? actifs?\b/.test(output) || /^=== Anomalies ===$/m.test(output);

/**
 * Cuts the message on a line boundary below MESSAGE_MAX and says so.
 * @param {string} text - scan output
 * @returns {string} message
 */
const fit = text => {
  if (text.length <= MESSAGE_MAX) return text;
  const note = '\n… coupé : lancer `pilotage.mjs scan` dans un terminal pour tout voir';
  return `${text.slice(0, text.lastIndexOf('\n', MESSAGE_MAX - note.length))}${note}`;
};

/**
 * Prints the hook's JSON output.
 * @param {string} message - text shown to the user
 */
const show = message => console.log(JSON.stringify({ systemMessage: message }));

const { status, stdout, stderr, error } = spawnSync(process.execPath, [PILOTAGE, 'scan', ...scanArgs(process.argv.slice(2))], {
  encoding: 'utf8',
  timeout: SCAN_TIMEOUT_MS,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});

if (error || status !== 0) {
  const reason = error?.code === 'ETIMEDOUT' ? `délai de ${SCAN_TIMEOUT_MS / 1000} s dépassé` : (stderr || error?.message || `code ${status}`).trim().split('\n')[0];
  show(fit(`Pilotage : vue des chantiers indisponible (${reason})`));
} else if (worthShowing(stdout)) {
  show(fit(stdout.trimEnd()));
}
process.exitCode = 0;
