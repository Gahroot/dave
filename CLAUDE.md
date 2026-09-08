<!-- gg:init:start -->
# Portfolio Command Center

Local dashboard that discovers projects from Ezboss, Ezcoder and Pew2 state, combines Git/agent evidence, and ranks projects into summaries, Today actions and an inbox.

## Boundaries and invariants

- External project/agent state is read-only; user overrides and inbox state belong in the app's SQLite store, not upstream tools. Keep the server loopback-only: it exposes private local state (`src/shared/paths.ts`, `src/server/index.ts`).
- Ezcoder discovery must not open `projects.json`: it is explicitly credential-denied, not a project inventory. Supported discovery paths are defined in `sourcePaths()` (`src/shared/paths.ts`).
- `PCC_HOME` relocates only application storage (`pcc.db`); it does not relocate external discovery sources. Tests isolating all sources need an explicit fixture `home` passed to `sourcePaths()` (`src/shared/paths.ts`, `src/db/index.ts`).
- Opening an existing pre-v3 database drops legacy setup tables and clears snapshots, inbox items and adapter issues. Merely starting the server performs this migration; use fixture storage when investigating old schemas (`src/db/index.ts`, `src/server/index.ts`).
- Portfolio assembly ranks cheap facts before deep-scanning only a capped set of active, non-hidden projects. Other projects can retain cached or empty summaries; Today and new inbox events derive only from the active set. Preserve this distinction when changing ranking or summary freshness (`src/model/build.ts`, `src/model/refresh.ts`).

## Local development

- Run `npm run server` and `npm run dev` in separate terminals for API plus hot-reloading UI. Vite proxies `/api` to port 4317; changing backend `PORT` also requires changing that proxy (`vite.config.ts`).
- The backend serves built `dist`, not live UI source. `npm start` builds first; the server-only script can serve stale assets or no UI if no build exists (`package.json`, `src/server/index.ts`).
<!-- gg:init:end -->
