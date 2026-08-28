-- Google's primaryType for a facility, so the retail deny-list's decisions are
-- inspectable after the fact instead of only visible in the Worker's tail log.
-- Nullable by design: OSM rows never have one, and rows ingested before this
-- migration keep NULL. The deny-list already fails open on a missing type.

ALTER TABLE facilities ADD COLUMN primary_type TEXT;
