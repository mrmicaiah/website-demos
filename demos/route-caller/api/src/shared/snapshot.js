// The snapshot rails: the safety pattern that lets a list somebody is actively
// calling be updated in place.
//
// Extracted from enrich.js so the area pipeline runs the same rails rather than
// a copy of them. The rule they encode is the whole point: her status, flags
// and notes are hers, an update may only write enrichment columns, and every
// run proves it against the database afterwards — in production, not only in
// tests.

/**
 * Build the guard for a table: the columns an enrichment update may never
 * write. Enforced, not just documented.
 */
export function makePatchAssertion(protectedColumns) {
  return function assertPatchIsSafe(patch) {
    for (const column of Object.keys(patch)) {
      if (protectedColumns.has(column)) {
        throw new Error(`enrichment tried to write protected column "${column}"`);
      }
    }
    return true;
  };
}

/** The columns that are HIS WORK, on every table: never written by enrichment. */
export const CALL_STATE_FIELDS = ['status', 'flagged', 'notes'];

/**
 * Build the snapshot/verify pair for a table.
 *
 * `extraFields` lets a table add its own work columns to the guarantee —
 * area_facilities adds `follow_up_date` and `meeting_at`, which are a booked
 * meeting and a scheduled retry and are therefore exactly as much his as a
 * note is. Route-caller passes none and gets the original behaviour.
 */
export function makeSnapshotRails(extraFields = []) {
  const guarded = [...CALL_STATE_FIELDS, ...extraFields];

  /** The fields whose survival we verify after every enrichment run. */
  function snapshotOf(rows) {
    return rows.map((r) => {
      const snap = {
        id: r.id,
        status: r.status,
        flagged: r.flagged ? 1 : 0,
        notes: r.notes || '',
        phone: r.phone || null,
      };
      for (const field of extraFields) snap[field] = r[field] ?? null;
      return snap;
    });
  }

  /**
   * Compare the before and after snapshots. Everything must be identical,
   * except that a NULL phone is allowed to have gained a value.
   */
  function verifySnapshot(before, after) {
    const violations = [];
    const afterById = new Map(after.map((r) => [r.id, r]));

    for (const was of before) {
      const now = afterById.get(was.id);
      if (!now) {
        violations.push({ id: was.id, field: 'row', was: 'present', now: 'missing' });
        continue;
      }
      for (const field of guarded) {
        if (was[field] !== now[field]) {
          violations.push({ id: was.id, field, was: was[field], now: now[field] });
        }
      }
      if (was.phone !== now.phone && was.phone !== null) {
        violations.push({ id: was.id, field: 'phone', was: was.phone, now: now.phone });
      }
    }

    return { ok: violations.length === 0, violations };
  }

  return { snapshotOf, verifySnapshot };
}

/** Route-caller's rails, and the default for any table without extra work columns. */
export const { snapshotOf, verifySnapshot } = makeSnapshotRails();
