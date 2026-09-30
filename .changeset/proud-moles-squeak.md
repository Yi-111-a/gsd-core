---
type: Fixed
pr: 5127
---
Read-only git spawns (the statusline's per-render `git status` and the tool's shared `execGit` seam) no longer take git's optional `.git/index.lock`, so a statusline render or another read can no longer fail a concurrent `git add`/`git commit` with `Unable to create '.git/index.lock': File exists`
