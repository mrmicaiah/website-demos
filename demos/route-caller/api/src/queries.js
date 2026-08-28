// SQL shared between the Worker and the tests, so the tests exercise the real
// query rather than a paraphrase of it.

/**
 * A row is "visible" when it survives the assumed hides — the categories the
 * caller never has to switch off. This is the server-side mirror of the
 * frontend's listScope(), and it must stay in step with the CATEGORIES list in
 * app.js.
 *
 * Caveat, deliberate: her per-category Restores live in localStorage, so they
 * are client-side and per-device. The server therefore counts against the
 * DEFAULTS. When she has restored a category, the in-route counters are the
 * source of truth and the landing card will read slightly low. That is the
 * accepted trade — the landing page cannot know her device's preferences.
 */
const VISIBLE = `COALESCE(f.is_school_program, 0) = 0
              AND COALESCE(f.is_franchise, 0) = 0
              AND COALESCE(f.is_home_daycare, 0) = 0
              AND COALESCE(f.playground_unlikely, 0) = 0`;

/**
 * Routes with their counts.
 *
 * `facility_count` is everything stored. `visible_count` is her usable list.
 * `called_count` and `flagged_count` deliberately count VISIBLE rows only: a
 * call logged against a row that is now hidden should not inflate progress
 * against a denominator that excludes it, or the card would read "12 of 10
 * called". The in-route counters follow the same rule.
 */
export const ROUTE_LIST_SQL = `
  SELECT r.*,
         COUNT(f.id) AS facility_count,
         SUM(CASE WHEN f.id IS NOT NULL AND ${VISIBLE} THEN 1 ELSE 0 END) AS visible_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status != 'not_called' THEN 1 ELSE 0 END) AS called_count,
         SUM(CASE WHEN ${VISIBLE} AND f.flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
    FROM routes r
    LEFT JOIN facilities f ON f.route_id = r.id
   GROUP BY r.id
   ORDER BY r.created_at DESC`;
