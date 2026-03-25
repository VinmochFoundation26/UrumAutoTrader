# Claude Code Instructions

## Git Push Policy

Always push directly to `main` using:

```bash
git push origin HEAD:main
```

Never push to auto-generated session branches (e.g. `claude/some-name-XYZ`).
This avoids the need to create PRs for every session.
