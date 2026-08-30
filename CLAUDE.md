# website-demos

Bound to Studio87 on 2026-07-08.

## Project intent

A showcase repository of self-contained static demo websites, served via GitHub Pages, with a data-driven gallery landing page indexing them.

## Current focus

Two live products share ONE Cloudflare Worker and ONE D1 database, both in
`demos/route-caller/api/`. Do not create a second Worker or a second D1.

- **route-caller** — phase 1 complete and live, awaiting the caller's first real
  session, whose feedback decides phase 2 versus corridor tuning.
- **area-caller** — phase 1 (the list) and phase 2 (the binary pipeline, the
  Today panel, the calendar handoff) both complete and live as of 2026-08-30.
  The Huntsville pilot is loaded — 248 leads, 97 with no website, zero reached.
  Awaiting Micaiah working a town with it. The pipeline's philosophy is a locked
  decision in `CONTEXT.md`: two gates, and if they don't book, they're out.

## Session handoff

Read these first, in order:

- `CONTEXT.md` — what the project is, who it is for, and the locked decisions.
- `STATE.md` — current status, what is blocked, and the known gotchas.
- `SESSION_LOG.md` — how we got here, newest entry first.
