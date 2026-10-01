---
type: Fixed
pr: 5127
---
Read-only git spawns no longer take git's optional `.git/index.lock`, so a read can no longer fail a concurrent `git add`/`git commit` with `Unable to create '.git/index.lock': File exists`. Covers the statusline's per-render `git status`, the tool's shared `execGit` seam, the `git status` in smart-entry's phase probe, and the variable-argv git helpers in pristine-baseline and the two pre-write guard hooks. `tests/git-optional-locks-parity.test.cjs` enumerates every git spawn in the runtime surfaces so the next one cannot land without it.
