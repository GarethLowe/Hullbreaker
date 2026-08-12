# HULLBREAK — working agreements

## Work on `main`

Work directly on `main`. Do not create a feature branch, and do not work in a
git worktree unless explicitly asked to.

This is a solo repo with no PR workflow and no other contributors, so branching
buys nothing — and it actively costs something: work sitting on a branch or in
a worktree is work Gareth cannot see. From the outside it looks like nothing
happened. Land it on `main` where it is visible.

If a session starts in a worktree anyway, merge back to `main` and say so
rather than leaving the branch as the deliverable.

## Committing

Commit when the work is done and verified; do not ask first. Push and anything
else outward-facing still needs asking.

Commits are SSH-signed through 1Password (`op-ssh-sign.exe`, `commit.gpgsign =
true`). A locked or stopped 1Password fails the commit with:

```
error: 1Password: Could not connect to socket. Is the agent running?
```

That is the agent, not the change. **Never** work around it with
`--no-gpg-sign` — ask for 1Password to be unlocked and retry. The message
survives in `.git/COMMIT_EDITMSG`, so the retry is
`git commit -F .git/COMMIT_EDITMSG`.

Messages follow the existing log: one sentence-case line saying what changed and
why it was wrong before, no trailing full stop. "Only guns that have actually
laid on the solution fire", not "fix gunnery bug".

## Verify before claiming

`npm test` is the headless suite (`test/selfcheck.js`) — no framework, several
seconds. It drives the real `Systems`, `Crew` and `Ballistics` with no renderer.
It must pass before a commit, and probabilistic assertions should be run a few
times, not once.

The suite cannot see anything rendered. Effects, shaders and anything visual
have to be checked in the running game — `npm start`, or drive `window.game`
from the console. Several real defects here were invisible to the tests and
obvious on screen: additive "dark" smoke reading as white bokeh, damage effects
authored a hundred times too small to resolve at engagement range, and guidance
that looked textbook-correct while missing every time.

When a number decides behaviour, measure it rather than reasoning about it, and
put the measurement in the comment. Most of this codebase's comments exist
because someone assumed instead.

## Generated files

`src/world/kit.js` is generated from Blender by `tools/kit_build.py`. Do not
hand-edit it. New or changed ship hardware means rebuilding the kit; a weapon
with no model of its own can borrow another's with `art`.
