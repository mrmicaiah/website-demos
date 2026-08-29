// SQL shared between the Worker and the tests, so the tests exercise the real
// query rather than a paraphrase of it. The area-side twin of ../queries.js.

import { LEAD_SCORE_ORDER_BY } from './leadScore.js';

/**
 * A row is "visible" when it survives the assumed hides. Two categories here,
 * both flags, both one tap from being restored: franchises (corporate marketing
 * already) and suppliers/big-box retail (not customers at all).
 *
 * Same deliberate caveat as route-caller: her Restores live in localStorage, so
 * the server counts against the DEFAULTS and a landing card can read slightly
 * low while a category is restored on her device. The in-area counters are the
 * truth in that case.
 */
// `f.id IS NOT NULL` is load-bearing, not defensive: this is a LEFT JOIN, so an
// area with no facilities still produces one all-NULL row, and without the guard
// `no_website_count` would count it — an empty area reporting one lead.
const VISIBLE = `f.id IS NOT NULL
              AND COALESCE(f.is_franchise, 0) = 0
              AND COALESCE(f.is_supplier_or_retail, 0) = 0`;

const NO_WEBSITE = `(f.website IS NULL OR TRIM(f.website) = '')`;

/**
 * Areas with their counts.
 *
 * `facility_count` is everything stored; `visible_count` is her usable list and
 * is what the card leads with. `no_website_count` is on the card too, because
 * it is the headline lead signal for this product, and it counts VISIBLE rows
 * only — a franchise with no website is not a lead.
 */
export const AREA_LIST_SQL = `
  SELECT a.*,
         COUNT(f.id) AS facility_count,
         SUM(CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END) AS visible_count,
         SUM(CASE WHEN ${VISIBLE} AND ${NO_WEBSITE} THEN 1 ELSE 0 END) AS no_website_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status != 'not_called' THEN 1 ELSE 0 END) AS called_count,
         SUM(CASE WHEN ${VISIBLE} AND f.flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
    FROM areas a
    LEFT JOIN area_facilities f ON f.area_id = a.id
   GROUP BY a.id
   ORDER BY a.created_at DESC`;

/** One area's facilities, in lead-score order — the same formula as byLeadScore. */
export const AREA_FACILITIES_SQL = `
  SELECT * FROM area_facilities WHERE area_id = ?
   ORDER BY ${LEAD_SCORE_ORDER_BY}`;
