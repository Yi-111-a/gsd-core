---
type: Fixed
pr: 5283
---
**`evaluation-scope --plan` no longer reports an empty scope for a project-coded plan id** — a plan id carrying the project code (`PRJ-01-01`) now resolves the plan’s own commits instead of matching literally against a subject no executor ever writes.
