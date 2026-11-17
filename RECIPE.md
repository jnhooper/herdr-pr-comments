# PR comments

A side panel with the open comments on the pull request of the space you're looking at, and a button that hands them to the space's agent.

![PR comments](preview.png)

## What you see

- **Header**: a PR icon (14 px) colored by the PR's state, the PR's number and title, and a state box. The colors are open `working`, merged `done` and closed `blocked`, from `theme()`. A refresh button and an open-on-GitHub button are on the right.
- **Review threads**, unresolved first. Each thread has:
  - a 28 px header row: the file path (JetBrains Mono 11.5 px, `muted`, truncated, with a tooltip of `path:line`), boxes for `outdated` (`dim`) and `resolved` (`done`), and an open-on-GitHub button (`external.svg`)
  - its comments: author and time (11.5 px), then the body as selectable Markdown (12.5 px)
  - `+N more on GitHub` when the thread is longer
  - a **Send to agent** button (22 px, 1 px `border`). It reads `Sending…`, `Sent to <agent>` or `Failed, retry` after a send.
- **Conversation**: the PR's top-level comments and review summaries, folded under a 28 px toggle row.
- **No PR**: a line saying so, for the branch and folder.
- A **Send all** button for every unresolved thread.
- With several agents in the space, sending opens a small picker: a `Send to` label, then 30 px rows with each agent's label and status.

When herdr-critters is installed, it draws in the critters look (`critters-look.js` reads shared `critters.look`): pixel font labels and square corners. Without critters, it uses plain Herdr theme colors and 5 px radii.

## How it behaves

- The folder is the space's focused pane's cwd, else the space's folder, as Herdr's Changes does. `git` gives the branch, and `gh pr view` finds the PR for it.
- Threads and the conversation come from one GraphQL query through `gh api graphql`.
- The cache is per folder and branch. A new folder (another space, a cd, a worktree) asks again. A full refresh runs every 90 s while Herdr is open.
- **Send to agent** turns a thread into text an agent can act on: the file, line, comments and PR link. It ends with "Fix what's right in this checkout and tell me where you disagree. Don't reply on or resolve the threads on GitHub."
  - It pastes the text into the space's agent with `hc send`.
  - If the space has no agent, it starts Claude in a new tab with the text.
- Nothing is written to GitHub.

## Built from

- **Layout**: one block in the side panel's stack, `{ "id": "pr", "type": "block", "content": { "mod": "pr-comments" } }`.
- **Mod** `mods/pr-comments/`:
  - `main.js`
  - `critters-look.js` (a copy, because mods can't import each other's files)
  - icons: `pr.svg`, `refresh.svg`, `external.svg`, `send.svg`
  - `mod.json`: `place: none`, and `"panel": { "label": "PR", "icon": "pr.svg" }`
- **herdr functions**: `spaces`, `panes`, `focused`, `exec`, `theme`, `agents`, `hc`, `run`, `openOverlay`, `closeOverlay`, `props`, `notify`, `shared`, `machines`.
- **Programs**: `git`, `gh` (on the space's machine), `hc send`, `open` (GitHub links). Nothing else leaves the machine.

## Watch out

- `gh` must be logged in on the machine the space is on.
- The picker is a popup of this same mod, with its role in `props`.
