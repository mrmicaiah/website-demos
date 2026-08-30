# Area Caller — Workflow (Phase 2)

## Philosophy — from Micaiah directly, this shapes everything

The call has two gates: (1) are they shopping for a website person? (2) will they book a brainstorm meeting right now? **If they don't book, they're out.** No nurture stages, no warming, no callback-for-the-maybe. "You're either ready or you're not." The tool must enforce this clean path, not soften it. Any design choice that adds a gray zone between "meeting set" and "out" is wrong for this product.

Applies to area-caller ONLY. Route-caller's statuses and UI are untouched — she has her own workflow.

## Statuses (replace the generic set for area_facilities)

- `not_called` — untouched
- `no_answer` — phone rang out; retryable
- `voicemail` — left message; retryable
- `out` — reached them; not ready (covers both "not shopping" and "shopping but wouldn't book"). Terminal but reversible like everything else.
- `meeting_set` — the brainstorm is booked. THE pipeline milestone.
- `won` — signed
- `lost` — meeting happened (or no-showed) and didn't close

Migration 0008: no schema change needed for status (TEXT already), but map existing area statuses: `interested` → `meeting_set`, `not_interested` → `out`. Report how many rows were remapped (expect zero or near-zero; the pilot had no real call activity last checked — verify live first, as always).

Add columns to area_facilities: `follow_up_date TEXT` (date), `meeting_at TEXT` (datetime). Rules the UI enforces: follow_up_date only meaningful for no_answer/voicemail (retry scheduling); meeting_at required when status becomes meeting_set (prompt for it in the same interaction — date + time picker, minimal). Changing status away from meeting_set keeps meeting_at stored but inert (never delete her... his data).

## The Today panel

Top of the area-caller landing page AND top of each area's call list (same component, area-filtered on the latter):
- **Meetings today** (and next 7 days, collapsed) — name, time, phone, tap-to-call, jump-to-card
- **Follow-ups due** — today or overdue, oldest first — the no_answer/voicemail retries
- Empty state: one quiet line, not a big empty box.
This panel IS the reminder system. No notifications, no email — opening the tool tells him the day.

## Calendar handoff (no integration, no OAuth)

When meeting_set is saved, show an **Add to Google Calendar** button on the card and in the Today panel: a prefilled calendar.google.com/render?action=TEMPLATE link — title "Brainstorm: {business name}", the meeting_at time (default 45 min), details containing phone + a snapshot of the notes. Pure link, works everywhere, nothing to authenticate.

## Funnel on area cards

Area cards gain a funnel line under the lead count: `248 leads · 31 reached · 4 meetings · 1 won` where reached = any status except not_called (visible rows only, same rules as visible_count). Add the counts to the GET /api/areas list SQL (real-SQLite tested like the existing count queries). Keep it one line, muted; the lead count stays the headline.

## Card interaction changes

- Status dropdown gets the new set, in pipeline order. Choosing meeting_set opens the minimal date/time input inline; choosing no_answer/voicemail offers an optional quick follow-up chip row (Tomorrow / In 3 days / Next week / pick date) — one tap, no modal ceremony.
- meeting_set cards get a subtle distinct treatment (left border accent) and show the meeting time + calendar button.
- won cards celebrate quietly (checkmark accent); lost and out cards mute.
- Notes placeholder stays "Owner name, current marketing spend, callback".

## Filters/sort touch-ups

- Status filter dropdown reflects the new set, plus a "Pipeline" option showing meeting_set+won+lost only.
- Lead-score sort unchanged. No new sorts.

## Explicitly NOT building (locked scope, record in docs)

No email sequences, no deal values, no reminders/notifications, no multi-user, no nurture stages, no automation. The Today panel and the binary pipeline ARE the workflow.

## Tests

Status mapping migration (real SQLite), funnel SQL counts (visible-rows rule, per-status), Today-panel date selection logic (due/overdue/upcoming boundaries — pin timezone handling: dates are stored and compared in the user's local sense, document the choice), calendar link construction (URL encoding with real awkward business names), meeting_at required-on-set validation, follow_up chips setting correct dates. Existing 217 must pass unchanged.

## Docs

CONTEXT.md: the binary pipeline as a locked decision with Micaiah's phrasing ("you're either ready or you're not") and the not-building list. STATE.md + SESSION_LOG.md as usual. Commit but do not push.
