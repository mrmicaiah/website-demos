-- The corridor radius a route was ingested at, so the UI knows which distance
-- options its stored data can actually honour.
--
-- Existing rows were all ingested at 16,000 m (10 miles) and are backfilled to
-- that. Routes ingested from now on store 48,280 m (30 miles). A route whose
-- data only reaches 10 miles must disable the 20- and 30-mile lens options
-- rather than silently showing the same rows for all three.

ALTER TABLE routes ADD COLUMN corridor_m INTEGER DEFAULT 16000;
UPDATE routes SET corridor_m = 16000 WHERE corridor_m IS NULL;
