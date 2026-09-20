# Agent working notes — Vorsum

Vorsum is a single-file YouTube summary userscript (`Vorsum.user.js`). There is
no build step, lint, or test suite; the only automated check is
`node --check Vorsum.user.js`.

## Changelog (important)
- The release history lives in `changelog.json`: an array of
  `{ "version", "highlight", "changes": [...] }`, newest last.
- `highlight: true` means the version is worth surfacing in the in-panel
  "What's new" banner; `false` suppresses it (use it for trivial patch bumps).
- **At the end of a substantial feature or a critical bug fix, pause and ask
  the agent manager what to write for the changelog**, then add the entry to
  `changelog.json` (and bump `// @version` in `Vorsum.user.js`).
- Keep entries user-facing and concise — one line each, no internal jargon.

## Versioning
- The version lives in exactly one place: the `// @version` line in
  `Vorsum.user.js`. `getVersion()` reads it at runtime via `GM_info`.

## Conventions
- Single file, IIFE, `'use strict'`. No `innerHTML` (Trusted Types CSP blocks
  it) — build DOM with `createElement` / `createTextNode`.
- Theming is stamped per-element inline with `!important` (see `THEME_STYLES`,
  `registerThemedEl`, `registerThemedSubtree`), not via CSS classes.
- Storage: GM storage for small settings, IndexedDB for History, in-memory
  `Map`s for session caches.
- Network: `GM_xmlhttpRequest` for cross-origin (bypasses CORS/CSP); same-origin
  `fetch` (with credentials) for YouTube endpoints.
