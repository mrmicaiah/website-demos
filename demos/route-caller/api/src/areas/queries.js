// SQL shared between the Worker and the tests, so the tests exercise the real
// query rather than a paraphrase of it. The area-side twin of ../queries.js.

import { LEAD_SCORE_ORDER_BY } from './leadScore.js';
import { MEETING_STATUSES, RETRYABLE_STATUSES } from './statuses.js';

const quoted = (list) => list.map((s) => `'${s}'`).join(', ');

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
 * `facility_count` is everything stored; `visible_count` is his usable list and
 * is what the card leads with. `no_website_count` is on the card too, because
 * it is the headline lead signal for this product, and it counts VISIBLE rows
 * only — a franchise with no website is not a lead.
 *
 * THE FUNNEL — `visible_count · reached_count · meeting_count · won_count` — is
 * cumulative, each stage a subset of the one before it:
 *
 * - `reached_count` is any status except `not_called`. It is "I have touched
 *   this row", not "I spoke to a human": a voicemail is progress through the
 *   list even though nobody answered.
 * - `meeting_count` counts meeting_set + won + lost, because a won deal came
 *   from a meeting and a lost one is a meeting that happened. Counting only
 *   `meeting_set` would make the funnel shrink as deals closed, which is the
 *   opposite of what a funnel is for.
 * - `won_count` is the only stage with no ambiguity in it.
 *
 * Every one of them counts VISIBLE rows only, the same rule as `visible_count`,
 * so the funnel can never read "4 meetings" against a 3-lead list.
 */
export const AREA_LIST_SQL = `
  SELECT a.*,
         COUNT(f.id) AS facility_count,
         SUM(CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END) AS visible_count,
         SUM(CASE WHEN ${VISIBLE} AND ${NO_WEBSITE} THEN 1 ELSE 0 END) AS no_website_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status != 'not_called' THEN 1 ELSE 0 END) AS called_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status != 'not_called' THEN 1 ELSE 0 END) AS reached_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status IN (${quoted(MEETING_STATUSES)}) THEN 1 ELSE 0 END) AS meeting_count,
         SUM(CASE WHEN ${VISIBLE} AND f.status = 'won' THEN 1 ELSE 0 END) AS won_count,
         SUM(CASE WHEN ${VISIBLE} AND f.flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
    FROM areas a
    LEFT JOIN area_facilities f ON f.area_id = a.id
   GROUP BY a.id
   ORDER BY a.created_at DESC`;

/**
 * The Today panel's rows, across every area.
 *
 * The INERT rule is enforced here, in one place: a `meeting_at` only counts
 * while the row is still `meeting_set`, and a `follow_up_date` only while the
 * row is still retryable. Both stay in the database on a row that has moved on
 * — they are simply not surfaced. Nothing he typed is deleted by a status
 * change.
 *
 * No date comparison happens in SQL. The server does not know what timezone he
 * is in, so it returns the local wall-clock strings verbatim and the browser
 * decides what "today" means. See demos/area-caller/agenda.js.
 */
export const AGENDA_SQL = `
  SELECT f.id, f.area_id, a.name AS area_name, f.name, f.phone, f.address,
         f.notes, f.status, f.meeting_at, f.follow_up_date
    FROM area_facilities f
    JOIN areas a ON a.id = f.area_id
   WHERE (f.meeting_at IS NOT NULL AND f.status = 'meeting_set')
      OR (f.follow_up_date IS NOT NULL AND f.status IN (${quoted(RETRYABLE_STATUSES)}))
   ORDER BY COALESCE(f.meeting_at, f.follow_up_date) ASC, f.name ASC`;

/** One area's facilities, in lead-score order — the same formula as byLeadScore. */
export const AREA_FACILITIES_SQL = `
  SELECT * FROM area_facilities WHERE area_id = ?
   ORDER BY ${LEAD_SCORE_ORDER_BY}`;
