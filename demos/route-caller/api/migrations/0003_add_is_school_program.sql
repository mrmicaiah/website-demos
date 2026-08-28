-- Public schools, elementary schools and Head Start programs: the caller does
-- not sell to them. This is a visibility flag behind a UI toggle, never a
-- deletion — the rows stay in D1 and she can flip the toggle off at any time.
-- Existing rows default to 0 and are backfilled by classification, not by hand.

ALTER TABLE facilities ADD COLUMN is_school_program INTEGER DEFAULT 0;
