# Sproto Duel

A third-person wizard duel built with Three.js, TypeScript, Vite, Rapier and Howler. `README.md`
describes the modes and controls, and `ASSETS.md` covers assets.

- `vendor/hub-sdk` comes from `metaverse-hub`. Follow `vendor/hub-sdk/VENDOR.md` to update it.
- The QA agent in `.claude/agents/qa-tester.md` reports problems and does not fix code.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run check:assets
```

## Art generation

Follow `docs/higgsfield-workflow-guide.md`. This repo uses the **rigged 3D character** workflow. If the owner says to skip approvals, follow that section of the guide.

## Working with other agents

Claude Code, Codex, Cursor and Grok Bot all work on this repo.

- Start each task on its own branch from the latest `main`, named `<agent>/<slug>`. Never push to
  `main`; open a pull request.
- On the owner's machine, `agent-task new sproto-duel <slug> --agent <name>` creates that branch in
  its own worktree.
- Don't edit files that another active task is changing.
- Run the checks before opening a pull request, and report any you could not run.
- A different agent reviews the work: `agent-task review <path>`, or `/codex:adversarial-review` in
  Claude Code.
