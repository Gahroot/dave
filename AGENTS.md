# Coding agent quick start

Read `CLAUDE.md` for project boundaries and agent-behavior details.

- Runtime: Node 24; package manager: npm (`package-lock.json`).
- Install: `npm ci`.
- Build: `npm run build`.
- Test: `npm test`.
- Type check: `npm run typecheck`.
- Lint: no lint script is configured; do not invent one or skip existing checks.
- Development: `npm run server` and `npm run dev` in separate terminals.

CI lives in `.github/workflows/ci.yml` and must stay green.
Never commit with `--no-verify`.
Keep external project sources read-only; never commit credentials, local databases,
agent session state, or generated artifacts.
