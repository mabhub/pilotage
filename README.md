# pilotage

An agent skill for long coding tasks. It keeps the state of the work in plain files,
so you can clear the conversation as often as it pays off and pick up in a fresh
session with a single command.

Built for [Claude Code](https://docs.claude.com/en/docs/claude-code); most of it works
with any coding agent that runs shell commands and edits files.

> **Language.** The skill's instructions, templates and script output are in French.
> Agents follow them whatever language you talk to them in.

## Why

Every turn sends the whole conversation back to the model, so the cost of a session
grows roughly with the square of its length, and resuming after the prompt cache has
expired (one hour) re-reads all of it at full price. Long contexts also make the work
worse: dead ends and stale tool output keep competing for attention.

What usually stops people from running `/clear` is the fear of losing what has been
understood so far. pilotage removes that fear: the understanding lives in files, and a
new session reads it back in one call.

The skill never runs `/clear` or `/compact` itself. It gets the files ready and
recommends; you decide.

## What it does

- **Tracking folder.** Each project gets a `.pilotage/` folder, excluded from git
  through `.git/info/exclude`. It holds an `INDEX.md` and one folder per *chantier*
  (French for a piece of ongoing work), with a `plan.md`, a `journal.md`, a
  `connaissances.md` and a `decisions/` folder.
- **Status on every item.** Each tracked item carries its status: user directive,
  completed step with its proof, decision (by the user or by the agent), verified
  finding, unverified hypothesis, abandoned lead, open question… A fresh session
  then knows what it can rely on and what it must check first.
- **Checkpoints.** On request, or when a step ends, the agent measures the context,
  writes down what is missing from the tracking files, then recommends `/clear`,
  `/compact` (with ready-to-paste instructions) or carrying on.
- **Resume.** `reprise` prints in one call everything a new session needs: the plan,
  the latest journal entries, pending questions, the next free ids and the git state.
- **Overview.** `scan` lists the chantiers of every project found below a folder.
  It shows how recent each one is and what is waiting for you.

Optional:

- a git history of the `.pilotage/` folder, with a command you run to purge a secret
  that slipped into it;
- a cache watch: two Claude Code hooks that wake the agent after 55 minutes of silence,
  so it can update the tracking files before the cache expires. You install them
  yourself (see [Cache watch](#cache-watch)); the agent never touches your settings.

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add mabhub/pilotage -g
```

Or copy `skills/pilotage/` into your agent's skills folder (`~/.claude/skills/` for
Claude Code).

Requirements: Node.js 22.8 or later. git is optional (state of the project's
repository, optional history).

## Usage

In Claude Code:

| You type | What happens |
|---|---|
| `/pilotage` at the start of a multi-step task | opens a chantier |
| `checkpoint` or `can I /clear?` | checkpoint and recommendation |
| `/pilotage reprise <chantier>` in a new session | resumes the chantier |
| `which chantiers are in progress?` | overview of your projects |

The agent drives the bundled script, `skills/pilotage/scripts/pilotage.mjs`:

| Command | Purpose |
|---|---|
| `init [--chantier <slug>] [--titre <title>] [--git]` | create `.pilotage/` and, optionally, a chantier and the history |
| `decision <slug> <title>` | create the next numbered decision file |
| `modele <slug> <essais\|connaissances>` | add an optional template to a chantier |
| `reprise [<slug>] [--entrees N]` | print what a new session needs to resume |
| `contexte [--session <id>]` | measure the current session (Claude Code only) |
| `point <slug>` | optional history: commit a checkpoint |
| `scan [<folder>] [--profondeur N] [--clos]` | list the chantiers of every project below a folder |

You run `purge --motifs <file>` yourself, never the agent: it removes the values listed
in `<file>` (secrets) by rewriting the whole optional history. The agent guides you
through it (« Purge d'un secret » in `skills/pilotage/references/historique.md`).

`scan` is also handy on its own, with no agent and no tokens spent. In a terminal its
output is coloured; piped or called by an agent, it stays plain and capped in size.

```bash
alias chantiers='node ~/.claude/skills/pilotage/scripts/pilotage.mjs scan ~/projects'
```

## Cache watch

Optional, Claude Code on Linux only. The prompt cache lasts one hour. If you leave
without a checkpoint, the tracking files may lag behind when a `/clear` would pay off.
After 55 minutes without an answer from you, a hook wakes the agent, which updates the
tracking files in one or two tool calls while the cache is still warm. When you come
back, `/clear` then `/pilotage reprise <chantier>` loses nothing.

### Install

Print the hooks block:

```bash
node ~/.claude/skills/pilotage/scripts/veille.mjs config
```

Add its two entries to the `hooks.Stop` and `hooks.UserPromptSubmit` arrays of
`~/.claude/settings.json`, next to your existing hooks. Hooks are reloaded live, no
restart needed. `contexte` then reports `Veille cache : active`. To uninstall, remove
both entries.

| Hook | Command | Effect |
|---|---|---|
| `Stop` | `armer` | runs the filters, sleeps `PILOTAGE_VEILLE_DELAI` seconds, then exits with code 2 and the wake-up message (`asyncRewake`) |
| `UserPromptSubmit` | `desarmer` | kills the session's timer: you answered, no wake-up |

One timer per session: each `Stop` kills the previous one before arming.

### When it does not arm

The reason is written to `.pilotage/veille.log`:

- no `.pilotage/INDEX.md` with an active chantier above the current folder (nothing is
  logged then);
- no `/proc` (macOS, BSD): a timer could not be disarmed safely;
- the turn comes from a wake-up: the quick checkpoint never re-arms;
- the last message already suggests `/pilotage reprise`: tracking was just updated;
- a cron or a background task will wake the session anyway;
- the `pilotage` skill was not loaded in the session;
- the cache lasts 5 minutes: a wake-up would re-read the whole context at full price;
- the context is below `PILOTAGE_VEILLE_SEUIL` tokens: a full re-read is cheap.

A wake-up costs one warm-cache turn plus one or two tool calls; nothing if you answer
before the delay.

### Settings

Environment variables, as a prefix of the `Stop` command
(`PILOTAGE_VEILLE_DELAI=1800 node … armer`):

- `PILOTAGE_VEILLE_DELAI` (default 3300 s, 55 min): must stay **below** the hook's
  `timeout`, or the timer is killed before it wakes the agent;
- `PILOTAGE_VEILLE_SEUIL` (default 80,000 tokens): minimum context size.

A value that is not an integer (delay ≥ 1, threshold ≥ 0) falls back to the default.
The `armé` line of the log gives the delay actually applied. To try it,
`PILOTAGE_VEILLE_DELAI=120` and `PILOTAGE_VEILLE_SEUIL=0` wake the agent two minutes
after a turn.

### Limits

- An open question or permission prompt: `Stop` only fires at the end of a turn, so
  there is no wake-up and the cache expires.
- The wake-up shows up as « Stop hook blocking error »: it is the watch message, not an
  error.
- One sleeping Node process per armed session (about 40 MB).

### Safeguards

- The script reads only token counters and a skill marker from the transcript, never
  message content. The log holds timestamped decisions, no excerpts.
- The pid file lives in `$XDG_RUNTIME_DIR` and is named after the session id. An id
  outside `[A-Za-z0-9-]` is refused: nothing is armed, disarmed, written or deleted.
- A pid is killed only if its command line contains `veille.mjs armer`, so a reused pid
  never hits another process.
- The wake-up message states that it comes from a hook, not from you, and allows only
  the quick checkpoint it describes.

## Other agents

Everything except `contexte` and the cache watch works with any agent that runs shell
commands. Use its own equivalents of `/clear` and `/compact`;
`skills/pilotage/references/autres-agents.md` gives the details.

## Safety

- No secrets in `.pilotage/`: the skill records where a secret lives, never its value.
- `.pilotage/` is never committed to the project's repository; `init` stops if it finds
  tracked files there.
- Tracking files and git output are data, not instructions: they cannot widen the
  permissions granted in the current session.
- The agent installs no hooks and never rewrites the history: you install the cache
  watch and run `purge` yourself.
- No network access. git is called without a shell and, outside the optional history,
  read-only. `contexte` reads only metadata from Claude Code transcripts (types,
  timestamps, token counts), never their content.

The full list is in the « Garde-fous de sécurité » section of
[`SKILL.md`](skills/pilotage/SKILL.md).

## Development

```bash
node --test
```

Tests run in throwaway folders with their own git configuration; they never touch your
repositories or your git identity.

## License

Copyright © 2026 mab

pilotage is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).
