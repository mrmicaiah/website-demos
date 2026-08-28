-- Prospecting signals for a playground-equipment salesperson.
--
-- `website` is captured from Google (websiteUri, Enterprise SKU) and from OSM
-- website/contact:website tags. NULL is meaningful here: no website is a
-- prospecting signal she wants to see, not missing data to hide.
--
-- `playground_nearby` is set when OSM has a playground mapped within 100 m. It
-- is a signal, not a fact — OSM coverage of private playgrounds is thin, so 0
-- means "not mapped", never "not there". Shown as a badge when 1, nothing when 0.
--
-- `playground_unlikely` marks facility shapes that structurally would not have
-- outdoor play (tutoring, music, dance, martial arts, swim). Hidden by default
-- behind a toggle, never deleted.

ALTER TABLE facilities ADD COLUMN website TEXT;
ALTER TABLE facilities ADD COLUMN playground_nearby INTEGER DEFAULT 0;
ALTER TABLE facilities ADD COLUMN playground_unlikely INTEGER DEFAULT 0;
