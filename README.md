# herdr-pr-comments

A [Herdr](https://herdr.dev) side-panel mod for the open comments on the pull request of the space you're looking at. It finds the PR for the branch checked out where the space's focused terminal is. Unresolved review threads come first, and the PR's conversation folds below them.

**Send to agent** pastes one thread, or all unresolved ones, into the space's agent. If the space has no agent, it starts Claude in a new tab with them. It never replies on GitHub or resolves threads. It runs only `git` and `gh`, so it sees what your `gh` login can.

## Install

Requires `gh`, logged in.

```sh
./install.sh
```

Add it to your layout's side-panel stack:

```json
{ "id": "pr", "type": "block", "content": { "mod": "pr-comments" } }
```

With [herdr-critters](https://github.com/jnhooper/herdr-critters), it gets a PR button in the tab bar from its `mod.json` `panel` section and matches the critters look (`critters-look.js`). Without critters it draws in Herdr's theme.
