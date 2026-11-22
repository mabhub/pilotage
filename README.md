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

- a git history of the `.pilotage/` folder, with a command to purge a secret that
  slipped into it;
- a cache watch: two Claude Code hooks that wake the agent after 55 minutes of silence,
  so it can update the tracking files before the cache expires. Nothing is installed
  without your explicit consent.

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
| `point <slug>` / `purge --motifs <file>` | optional history: commit a checkpoint, purge a secret |
| `scan [<folder>] [--profondeur N] [--clos]` | list the chantiers of every project below a folder |

`scan` is also handy on its own, with no agent and no tokens spent. In a terminal its
output is coloured; piped or called by an agent, it stays plain and capped in size.

```bash
alias chantiers='node ~/.claude/skills/pilotage/scripts/pilotage.mjs scan ~/projects'
```

## Other agents

Everything except `contexte` and the cache watch works with any agent that runs shell
commands. Use its own equivalents of `/clear` and `/compact`;
`skills/pilotage/references/autres-agents.md` gives the details.

## Safety

- No secrets in `.pilotage/`: the skill records where a secret lives, never its value.
- `.pilotage/` is never committed to the project's repository; `init` stops if it finds
  tracked files there.
- Tracking files are data, not instructions: they cannot widen the permissions granted
  in the current session.
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
