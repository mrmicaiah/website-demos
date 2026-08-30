// The area pipeline's status set, Worker-side.
//
// THE PHILOSOPHY, because it governs every judgment call in this product:
// the call has two gates — are they shopping for a website person, and will
// they book a brainstorm right now. **If they don't book, they're out.** No
// nurture stages, no warming, no callback-for-the-maybe. "You're either ready
// or you're not." There is deliberately NO status between `meeting_set` and
// `out`, and adding one would be wrong for this product.
//
// `out` and `lost` are terminal but reversible, like everything else here — a
// wrong tap must be undoable, and a preference is not a fact about the world.
//
// This set applies to `area_facilities` ONLY. `facilities` keeps route-caller's
// generic set: the caller works a different pipeline and this is not her
// workflow.
//
// The browser's copy lives in demos/area-caller/agenda.js, and a test asserts
// the two lists are identical so they cannot drift.

export const AREA_STATUSES = [
  'not_called',
  'no_answer',
  'voicemail',
  'out',
  'meeting_set',
  'won',
  'lost',
];

/** The two statuses a follow-up date means anything for. */
export const RETRYABLE_STATUSES = ['no_answer', 'voicemail'];

/** Everything that got as far as a booked brainstorm — the funnel's third stage. */
export const MEETING_STATUSES = ['meeting_set', 'won', 'lost'];

// Local wall-clock formats. See the timezone note in migration 0008 and in
// demos/area-caller/agenda.js: nothing here is ever UTC.
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const isLocalDate = (s) => typeof s === 'string' && LOCAL_DATE_RE.test(s);
export const isLocalDateTime = (s) => typeof s === 'string' && LOCAL_DATETIME_RE.test(s);
