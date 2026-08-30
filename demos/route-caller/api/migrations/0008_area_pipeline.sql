-- Area Caller phase 2: the binary pipeline.
--
-- The call has two gates: are they shopping for a website person, and will they
-- book a brainstorm right now. If they don't book, they're out. There is no
-- nurture stage, no warming, no callback-for-the-maybe — "you're either ready
-- or you're not". This migration is the schema half of enforcing that; the
-- other half is that the status set below has no gray zone in it.
--
-- AREA_FACILITIES ONLY. `facilities` keeps route-caller's generic status set:
-- the caller works a different pipeline and this is not her workflow.

-- Two dates. Both are stored as LOCAL WALL-CLOCK STRINGS, never UTC:
--   follow_up_date  'YYYY-MM-DD'
--   meeting_at      'YYYY-MM-DDTHH:MM'
--
-- That is a deliberate choice for a single-user tool in one timezone. He picks
-- "Tuesday 2pm" and it means 2pm where he is standing; converting to UTC would
-- require knowing his zone, would make the stored value unreadable in a D1
-- console, and would move the meeting if he ever travelled. The server never
-- decides what "today" is — it returns these strings verbatim and the browser
-- compares them against its own local date. See src/areas/agenda.js.
--
-- Both are INERT rather than deleted when they stop applying: a meeting_at on a
-- row moved off meeting_set is kept but not surfaced, and a follow_up_date on a
-- row that is now `out` is kept but not surfaced. Nothing he typed is destroyed
-- by a status change.
ALTER TABLE area_facilities ADD COLUMN follow_up_date TEXT;
ALTER TABLE area_facilities ADD COLUMN meeting_at TEXT;

-- Remap the generic statuses onto the pipeline. Verified live before writing
-- this: all 259 pilot rows were `not_called`, with no flags and no notes, so
-- these two statements were expected to affect zero rows — and did.
--
-- `interested` was the closest thing the generic set had to a booked meeting,
-- and `not_interested` to `out`. Anything already `not_called`, `no_answer` or
-- `voicemail` carries over unchanged: those three mean the same thing in both
-- sets.
UPDATE area_facilities SET status = 'meeting_set' WHERE status = 'interested';
UPDATE area_facilities SET status = 'out'         WHERE status = 'not_interested';

CREATE INDEX idx_area_fac_meeting ON area_facilities(meeting_at);
CREATE INDEX idx_area_fac_followup ON area_facilities(follow_up_date);
