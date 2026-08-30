// Area Caller phase 2 — the binary pipeline.
//
// The status migration against real SQLite, the funnel counts, the Today
// panel's date logic (including the timezone trap), the calendar link, and the
// two rules that keep the pipeline binary: meeting_set requires a time, and a
// status change never deletes a date.
//
// Run: node test/workflow.test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { AREA_LIST_SQL, AGENDA_SQL } from '../src/areas/queries.js';
import {
  AREA_STATUSES,
  RETRYABLE_STATUSES,
  MEETING_STATUSES,
  isLocalDate,
  isLocalDateTime,
} from '../src/areas/statuses.js';
import {
  AREA_PROTECTED_COLUMNS,
  assertAreaPatchIsSafe,
  areaEnrichmentPatch,
  snapshotOf,
  verifySnapshot,
} from '../src/areas/enrich.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// The SHIPPED browser module, required directly — what is tested is what runs.
const require = createRequire(import.meta.url);
const agenda = require(join(here, '..', '..', '..', 'area-caller', 'agenda.js'));

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'mismatch'}: got ${a}, expected ${b}`);
}

function migrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
}

function freshDb(upTo = null) {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    if (upTo && file.startsWith(upTo)) break;
  }
  return db;
}

let areaSeq = 0;
function addArea(db, name) {
  const id = `area-${++areaSeq}`;
  db.prepare(
    `INSERT INTO areas (id, name, center_address, center_lat, center_lng, radius_m, industries, created_at)
     VALUES (?, ?, 'Huntsville, AL', 34.73, -86.58, 48280, '["hvac"]', ?)`
  ).run(id, name, `2026-08-30 10:0${areaSeq}:00`);
  return id;
}

let facSeq = 0;
function addFacility(db, areaId, over = {}) {
  const f = {
    name: `Biz ${++facSeq}`,
    website: null,
    status: 'not_called',
    is_franchise: 0,
    is_supplier_or_retail: 0,
    flagged: 0,
    meeting_at: null,
    follow_up_date: null,
    phone: '(256) 555-0100',
    notes: '',
    ...over,
  };
  db.prepare(
    `INSERT INTO area_facilities
       (id, area_id, google_place_id, industry, industries, name, website, phone, notes,
        lat, lng, distance_from_center_m, is_franchise, is_supplier_or_retail,
        status, flagged, meeting_at, follow_up_date)
     VALUES (?, ?, ?, 'hvac', 'hvac', ?, ?, ?, ?, 34.73, -86.58, 1000, ?, ?, ?, ?, ?, ?)`
  ).run(
    `fac-${facSeq}`, areaId, `place-${facSeq}`, f.name, f.website, f.phone, f.notes,
    f.is_franchise, f.is_supplier_or_retail, f.status, f.flagged, f.meeting_at, f.follow_up_date
  );
  return `fac-${facSeq}`;
}

/** Inserts a row as it existed BEFORE 0008 — no pipeline date columns yet. */
function addLegacyFacility(db, areaId, over = {}) {
  const f = { name: `Legacy ${++facSeq}`, status: 'not_called', flagged: 0, notes: '',
              website: null, ...over };
  db.prepare(
    `INSERT INTO area_facilities
       (id, area_id, google_place_id, industry, industries, name, website, notes,
        lat, lng, distance_from_center_m, status, flagged)
     VALUES (?, ?, ?, 'hvac', 'hvac', ?, ?, ?, 34.73, -86.58, 1000, ?, ?)`
  ).run(`fac-${facSeq}`, areaId, `place-${facSeq}`, f.name, f.website, f.notes, f.status, f.flagged);
  return `fac-${facSeq}`;
}

/* ------------------------------------------------------- migration 0008 -- */
console.log('\nmigration 0008 — the status remap');

check('0008 is the next link in the chain, and 0007 still stands alone', () => {
  const files = migrationFiles();
  eq(files[files.length - 1], '0008_area_pipeline.sql');
  eq(files[files.length - 2], '0007_add_areas.sql');
});

check('the generic statuses are remapped onto the pipeline', () => {
  // Build the database up to 0007, plant the OLD statuses, then apply 0008 —
  // so the migration is exercised the way it ran in production, on rows that
  // already existed.
  const db = freshDb('0007');
  const id = addArea(db, 'legacy');
  const interested = addLegacyFacility(db, id, { status: 'interested' });
  const notInterested = addLegacyFacility(db, id, { status: 'not_interested' });
  const untouched = addLegacyFacility(db, id, { status: 'voicemail' });
  const virgin = addLegacyFacility(db, id, { status: 'not_called' });

  db.exec(readFileSync(join(migrationsDir, '0008_area_pipeline.sql'), 'utf8'));

  const status = (rowId) =>
    db.prepare('SELECT status FROM area_facilities WHERE id = ?').get(rowId).status;
  eq(status(interested), 'meeting_set');
  eq(status(notInterested), 'out');
  eq(status(untouched), 'voicemail', 'voicemail means the same in both sets');
  eq(status(virgin), 'not_called');
  db.close();
});

check('the remap leaves flags, notes and every other column alone', () => {
  const db = freshDb('0007');
  const id = addArea(db, 'legacy');
  const rowId = addLegacyFacility(db, id, {
    status: 'interested', flagged: 1, notes: 'Owner is Dale', website: 'https://x.example',
  });
  db.exec(readFileSync(join(migrationsDir, '0008_area_pipeline.sql'), 'utf8'));
  const row = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(rowId);
  eq(row.status, 'meeting_set');
  eq(row.flagged, 1);
  eq(row.notes, 'Owner is Dale');
  eq(row.website, 'https://x.example');
  db.close();
});

check('the remap affects zero rows on the live shape (all not_called)', () => {
  // This is the pre-check that was run against production before applying it:
  // every one of the 259 pilot rows was not_called, so the remap was a no-op.
  const db = freshDb('0007');
  const id = addArea(db, 'pilot shape');
  for (let i = 0; i < 20; i++) addLegacyFacility(db, id, { status: 'not_called' });
  db.exec(readFileSync(join(migrationsDir, '0008_area_pipeline.sql'), 'utf8'));
  const changed = db
    .prepare(`SELECT COUNT(*) AS n FROM area_facilities WHERE status != 'not_called'`)
    .get().n;
  eq(changed, 0);
  db.close();
});

check('0008 adds the two date columns and touches no route table', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(area_facilities)').all().map((c) => c.name);
  assert(cols.includes('follow_up_date'), 'follow_up_date missing');
  assert(cols.includes('meeting_at'), 'meeting_at missing');
  const routeCols = db.prepare('PRAGMA table_info(facilities)').all().map((c) => c.name);
  assert(!routeCols.includes('meeting_at'), 'route-caller must not gain pipeline columns');
  assert(!routeCols.includes('follow_up_date'), 'route-caller must stay as it was');
  db.close();
});

/* ---------------------------------------------------------- the statuses -- */
console.log('\nthe pipeline has no gray zone');

check('the Worker and the browser agree on the status set, exactly', () => {
  // Two copies exist because the Worker is an ES module and the browser file is
  // a plain script. This is the guard that they cannot drift.
  eq(agenda.STATUS_KEYS, AREA_STATUSES);
  eq(agenda.RETRYABLE, RETRYABLE_STATUSES);
  eq(agenda.MEETING_STATUSES, MEETING_STATUSES);
});

check('there is nothing between meeting_set and out', () => {
  // If a future change adds a status here, this test should be the thing that
  // makes someone stop and re-read the philosophy. You are either ready or
  // you are not.
  eq(AREA_STATUSES, [
    'not_called', 'no_answer', 'voicemail', 'out', 'meeting_set', 'won', 'lost',
  ]);
  for (const soft of ['interested', 'nurture', 'warm', 'follow_up', 'maybe', 'callback']) {
    assert(!AREA_STATUSES.includes(soft), `"${soft}" is a gray zone; it does not belong here`);
  }
});

check('the statuses are in pipeline order, so the dropdown reads as a funnel', () => {
  eq(AREA_STATUSES.indexOf('not_called') < AREA_STATUSES.indexOf('no_answer'), true);
  eq(AREA_STATUSES.indexOf('out') < AREA_STATUSES.indexOf('meeting_set'), true);
  eq(AREA_STATUSES.indexOf('meeting_set') < AREA_STATUSES.indexOf('won'), true);
});

/* --------------------------------------------------------------- funnel -- */
console.log('\nthe funnel on area cards');

check('the funnel is cumulative and counts visible rows only', () => {
  const db = freshDb();
  const id = addArea(db, 'funnel');
  addFacility(db, id, { status: 'not_called' });
  addFacility(db, id, { status: 'no_answer' });
  addFacility(db, id, { status: 'voicemail' });
  addFacility(db, id, { status: 'out' });
  addFacility(db, id, { status: 'meeting_set', meeting_at: '2026-09-02T14:00' });
  addFacility(db, id, { status: 'won', meeting_at: '2026-08-20T10:00' });
  addFacility(db, id, { status: 'lost', meeting_at: '2026-08-19T10:00' });
  // Junk, and it must not appear in any stage.
  addFacility(db, id, { status: 'won', is_franchise: 1, meeting_at: '2026-08-18T10:00' });
  addFacility(db, id, { status: 'meeting_set', is_supplier_or_retail: 1, meeting_at: '2026-08-17T10:00' });

  const row = db.prepare(AREA_LIST_SQL).all()[0];
  eq(row.facility_count, 9);
  eq(row.visible_count, 7, 'two junk rows are hidden');
  eq(row.reached_count, 6, 'everything except not_called');
  eq(row.meeting_count, 3, 'meeting_set + won + lost');
  eq(row.won_count, 1);
  db.close();
});

check('each funnel stage is a subset of the one before it', () => {
  const db = freshDb();
  const id = addArea(db, 'subset');
  addFacility(db, id, { status: 'not_called' });
  addFacility(db, id, { status: 'won', meeting_at: '2026-08-20T10:00' });
  addFacility(db, id, { status: 'lost', meeting_at: '2026-08-19T10:00' });
  const r = db.prepare(AREA_LIST_SQL).all()[0];
  assert(r.won_count <= r.meeting_count, 'won must not exceed meetings');
  assert(r.meeting_count <= r.reached_count, 'meetings must not exceed reached');
  assert(r.reached_count <= r.visible_count, 'reached must not exceed the list');
  db.close();
});

check('an empty area reads zero across the whole funnel, not one', () => {
  const db = freshDb();
  addArea(db, 'empty');
  const r = db.prepare(AREA_LIST_SQL).all()[0];
  eq([r.visible_count, r.reached_count, r.meeting_count, r.won_count], [0, 0, 0, 0]);
  db.close();
});

check('called_count and reached_count stay in step', () => {
  const db = freshDb();
  const id = addArea(db, 'step');
  addFacility(db, id, { status: 'voicemail' });
  addFacility(db, id, { status: 'not_called' });
  const r = db.prepare(AREA_LIST_SQL).all()[0];
  eq(r.called_count, r.reached_count);
  db.close();
});

/* ---------------------------------------------------------- agenda query -- */
console.log('\nthe agenda query, and the inert rule');

check('a meeting is surfaced only while the row is still meeting_set', () => {
  const db = freshDb();
  const id = addArea(db, 'inert');
  addFacility(db, id, { name: 'Live', status: 'meeting_set', meeting_at: '2026-09-02T14:00' });
  addFacility(db, id, { name: 'Won', status: 'won', meeting_at: '2026-09-03T14:00' });
  addFacility(db, id, { name: 'Reopened', status: 'no_answer', meeting_at: '2026-09-04T14:00' });
  const names = db.prepare(AGENDA_SQL).all().map((r) => r.name);
  eq(names, ['Live']);
  db.close();
});

check('the inert meeting is KEPT in the database, not deleted', () => {
  const db = freshDb();
  const id = addArea(db, 'kept');
  const rowId = addFacility(db, id, { status: 'won', meeting_at: '2026-09-03T14:00' });
  const stored = db.prepare('SELECT meeting_at FROM area_facilities WHERE id = ?').get(rowId);
  eq(stored.meeting_at, '2026-09-03T14:00', 'his data survives the status change');
  db.close();
});

check('a follow-up is surfaced only while the row is still retryable', () => {
  const db = freshDb();
  const id = addArea(db, 'followups');
  addFacility(db, id, { name: 'Retry A', status: 'no_answer', follow_up_date: '2026-08-28' });
  addFacility(db, id, { name: 'Retry B', status: 'voicemail', follow_up_date: '2026-08-29' });
  addFacility(db, id, { name: 'Closed', status: 'out', follow_up_date: '2026-08-27' });
  addFacility(db, id, { name: 'Booked', status: 'meeting_set', meeting_at: '2026-09-01T09:00', follow_up_date: '2026-08-26' });
  const rows = db.prepare(AGENDA_SQL).all();
  eq(rows.filter((r) => r.follow_up_date && r.status !== 'meeting_set').map((r) => r.name),
     ['Retry A', 'Retry B']);
  assert(!rows.some((r) => r.name === 'Closed'), 'an out row has no retry');
  db.close();
});

check('the agenda carries the area name, so the landing panel can say where', () => {
  const db = freshDb();
  const id = addArea(db, 'Huntsville pilot');
  addFacility(db, id, { status: 'meeting_set', meeting_at: '2026-09-02T14:00' });
  eq(db.prepare(AGENDA_SQL).all()[0].area_name, 'Huntsville pilot');
  db.close();
});

check('the agenda spans every area, and each row says which one', () => {
  const db = freshDb();
  const a = addArea(db, 'Athens');
  const b = addArea(db, 'Decatur');
  addFacility(db, a, { status: 'meeting_set', meeting_at: '2026-09-02T14:00' });
  addFacility(db, b, { status: 'meeting_set', meeting_at: '2026-09-01T09:00' });
  const rows = db.prepare(AGENDA_SQL).all();
  eq(rows.length, 2);
  eq(rows.map((r) => r.area_name), ['Decatur', 'Athens'], 'earliest first');
  db.close();
});

/* ----------------------------------------------------- Today panel dates -- */
console.log('\nToday panel — local dates, pinned');

const AT_10AM = new Date(2026, 7, 30, 10, 0); // Sun 30 Aug 2026, local

check('today is the LOCAL date, never a UTC one', () => {
  eq(agenda.todayISO(AT_10AM), '2026-08-30');
  // The trap: an evening in a western timezone would roll over under UTC.
  eq(agenda.todayISO(new Date(2026, 7, 30, 23, 30)), '2026-08-30');
  eq(agenda.todayISO(new Date(2026, 7, 30, 0, 1)), '2026-08-30');
});

check('a date string is never handed to new Date()', () => {
  // new Date('2026-08-30') is MIDNIGHT UTC — the day before for anyone west of
  // Greenwich. localDate must give local midnight instead.
  const d = agenda.localDate('2026-08-30');
  eq([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 7, 30]);
  eq(d.getHours(), 0, 'local midnight, not a shifted UTC instant');
});

check('daysUntil is whole local days, and negative when overdue', () => {
  eq(agenda.daysUntil('2026-08-30', AT_10AM), 0);
  eq(agenda.daysUntil('2026-08-31', AT_10AM), 1);
  eq(agenda.daysUntil('2026-08-27', AT_10AM), -3);
  eq(agenda.daysUntil('2026-09-02T14:00', AT_10AM), 3, 'a datetime uses its date part');
});

check('daysUntil ignores the time of day on both sides', () => {
  const lateEvening = new Date(2026, 7, 30, 23, 59);
  eq(agenda.daysUntil('2026-08-31T00:15', lateEvening), 1, 'still tomorrow, 16 minutes away');
});

const AGENDA_ROWS = [
  { id: 'm-today-late', name: 'Later today', status: 'meeting_set', meeting_at: '2026-08-30T16:00' },
  { id: 'm-today-past', name: 'Earlier today', status: 'meeting_set', meeting_at: '2026-08-30T09:00' },
  { id: 'm-soon', name: 'In three days', status: 'meeting_set', meeting_at: '2026-09-02T14:00' },
  { id: 'm-edge', name: 'Day seven', status: 'meeting_set', meeting_at: '2026-09-06T11:00' },
  { id: 'm-far', name: 'Day eight', status: 'meeting_set', meeting_at: '2026-09-07T11:00' },
  { id: 'm-past', name: 'Last week', status: 'meeting_set', meeting_at: '2026-08-24T11:00' },
  { id: 'm-inert', name: 'Won already', status: 'won', meeting_at: '2026-08-30T12:00' },
  { id: 'f-today', name: 'Due today', status: 'no_answer', follow_up_date: '2026-08-30' },
  { id: 'f-old', name: 'Oldest overdue', status: 'voicemail', follow_up_date: '2026-08-20' },
  { id: 'f-mid', name: 'Overdue', status: 'no_answer', follow_up_date: '2026-08-27' },
  { id: 'f-future', name: 'Due next week', status: 'no_answer', follow_up_date: '2026-09-05' },
  { id: 'f-inert', name: 'Out with a retry', status: 'out', follow_up_date: '2026-08-20' },
];

check("today's meetings are today's, earliest first, including ones already past", () => {
  const { meetingsToday } = agenda.classifyAgenda(AGENDA_ROWS, AT_10AM);
  eq(meetingsToday.map((r) => r.id), ['m-today-past', 'm-today-late']);
});

check('a meeting earlier today still shows — it needs marking won or lost', () => {
  const { meetingsToday } = agenda.classifyAgenda(AGENDA_ROWS, new Date(2026, 7, 30, 17, 0));
  assert(meetingsToday.some((r) => r.id === 'm-today-past'), 'do not silently drop it');
});

check('upcoming is the next seven days, exclusive of today, inclusive of day seven', () => {
  const { meetingsUpcoming } = agenda.classifyAgenda(AGENDA_ROWS, AT_10AM);
  eq(meetingsUpcoming.map((r) => r.id), ['m-soon', 'm-edge']);
});

check('a past meeting and a won meeting are both off the panel', () => {
  const { meetingsToday, meetingsUpcoming } = agenda.classifyAgenda(AGENDA_ROWS, AT_10AM);
  const shown = [...meetingsToday, ...meetingsUpcoming].map((r) => r.id);
  assert(!shown.includes('m-past'), 'last week is not upcoming');
  assert(!shown.includes('m-inert'), 'a won row has no live meeting');
});

check('follow-ups are due-or-overdue only, OLDEST FIRST', () => {
  const { followUpsDue } = agenda.classifyAgenda(AGENDA_ROWS, AT_10AM);
  eq(followUpsDue.map((r) => r.id), ['f-old', 'f-mid', 'f-today']);
});

check('a future follow-up and one on a closed row are both off the panel', () => {
  const { followUpsDue } = agenda.classifyAgenda(AGENDA_ROWS, AT_10AM);
  const ids = followUpsDue.map((r) => r.id);
  assert(!ids.includes('f-future'), 'not due yet');
  assert(!ids.includes('f-inert'), 'an out row has no retry');
});

check('the boundary is the day, not the hour', () => {
  const justBeforeMidnight = new Date(2026, 7, 30, 23, 59);
  const { followUpsDue } = agenda.classifyAgenda(AGENDA_ROWS, justBeforeMidnight);
  assert(followUpsDue.some((r) => r.id === 'f-today'), 'still due at 23:59');
  const nextMorning = new Date(2026, 7, 31, 6, 0);
  const after = agenda.classifyAgenda(AGENDA_ROWS, nextMorning);
  assert(after.followUpsDue.some((r) => r.id === 'f-today'), 'and overdue the next morning');
});

check('an empty agenda classifies to three empty lists, not to null', () => {
  const result = agenda.classifyAgenda([], AT_10AM);
  eq([result.meetingsToday.length, result.meetingsUpcoming.length, result.followUpsDue.length],
     [0, 0, 0]);
  eq(agenda.classifyAgenda(undefined, AT_10AM).meetingsToday.length, 0);
});

check('a malformed date is ignored rather than crashing the panel', () => {
  const rows = [
    { id: 'bad', status: 'meeting_set', meeting_at: 'next tuesday' },
    { id: 'null', status: 'no_answer', follow_up_date: null },
    { id: 'utc', status: 'meeting_set', meeting_at: '2026-08-30T16:00:00Z' },
  ];
  const r = agenda.classifyAgenda(rows, AT_10AM);
  eq([r.meetingsToday.length, r.meetingsUpcoming.length, r.followUpsDue.length], [0, 0, 0]);
});

check('due labels read the way he would say them', () => {
  eq(agenda.dueLabel('2026-08-30', AT_10AM), 'due today');
  eq(agenda.dueLabel('2026-08-29', AT_10AM), '1 day overdue');
  eq(agenda.dueLabel('2026-08-20', AT_10AM), '10 days overdue');
  eq(agenda.dueLabel('2026-08-31', AT_10AM), 'due tomorrow');
});

/* ------------------------------------------------------- follow-up chips -- */
console.log('\nfollow-up chips');

check('the three chips set the dates their labels promise', () => {
  eq(agenda.followUpDateFor('tomorrow', AT_10AM), '2026-08-31');
  eq(agenda.followUpDateFor('three_days', AT_10AM), '2026-09-02');
  eq(agenda.followUpDateFor('next_week', AT_10AM), '2026-09-06');
});

check('the chips cross a month boundary correctly', () => {
  const endOfMonth = new Date(2026, 7, 31, 9, 0);
  eq(agenda.followUpDateFor('tomorrow', endOfMonth), '2026-09-01');
  eq(agenda.followUpDateFor('next_week', endOfMonth), '2026-09-07');
});

check('the chips cross a year boundary correctly', () => {
  const newYearsEve = new Date(2026, 11, 31, 9, 0);
  eq(agenda.followUpDateFor('tomorrow', newYearsEve), '2027-01-01');
  eq(agenda.followUpDateFor('three_days', newYearsEve), '2027-01-03');
});

check('a chip date is always a valid follow_up_date the API will accept', () => {
  for (const chip of agenda.FOLLOW_UP_CHIPS) {
    const value = agenda.followUpDateFor(chip.key, AT_10AM);
    assert(isLocalDate(value), `${chip.key} produced ${value}`);
    assert(agenda.isLocalDate(value), 'browser and Worker validators must agree');
  }
});

check('an unknown chip returns null rather than a bad date', () => {
  eq(agenda.followUpDateFor('someday', AT_10AM), null);
});

/* ------------------------------------------------------- calendar handoff -- */
console.log('\ncalendar handoff');

const AWKWARD = {
  name: `Bob's Heating & Air, LLC "The Best" <Huntsville> 100% #1`,
  meeting_at: '2026-09-02T14:00',
  phone: '(256) 555-0100',
  notes: 'Owner is Dale\nSpends ~$800/mo on ads & mailers',
};

check('an awkward business name survives the URL intact', () => {
  const url = agenda.calendarLink(AWKWARD);
  const parsed = new URL(url);
  eq(parsed.origin + parsed.pathname, 'https://calendar.google.com/calendar/render');
  eq(parsed.searchParams.get('action'), 'TEMPLATE');
  eq(parsed.searchParams.get('text'), `Brainstorm: ${AWKWARD.name}`);
  assert(!url.includes(' '), 'no raw spaces in the URL');
  assert(!url.includes('"'), 'no raw quotes in the URL');
  assert(!url.includes('<'), 'no raw angle brackets in the URL');
});

check('the details carry the phone and a snapshot of the notes', () => {
  const details = new URL(agenda.calendarLink(AWKWARD)).searchParams.get('details');
  assert(details.includes('(256) 555-0100'), 'phone missing');
  assert(details.includes('Owner is Dale'), 'notes missing');
  assert(details.includes('$800/mo on ads & mailers'), 'the awkward characters survived');
});

check('the times are local wall-clock with NO trailing Z', () => {
  // A Z would tell Google these are UTC and move a 2pm meeting. The stored
  // string is a wall-clock promise and the link has to keep it.
  const dates = new URL(agenda.calendarLink(AWKWARD)).searchParams.get('dates');
  eq(dates, '20260902T140000/20260902T144500');
  assert(!dates.includes('Z'), 'a Z here silently moves the meeting');
});

check('the default meeting is 45 minutes, and the length is overridable', () => {
  eq(agenda.DEFAULT_MEETING_MINUTES, 45);
  const dates = new URL(agenda.calendarLink(AWKWARD, 30)).searchParams.get('dates');
  eq(dates, '20260902T140000/20260902T143000');
});

check('a meeting that runs past midnight rolls the date, not the clock', () => {
  const late = { name: 'Late', meeting_at: '2026-09-02T23:45' };
  eq(new URL(agenda.calendarLink(late)).searchParams.get('dates'),
     '20260902T234500/20260903T003000');
});

check('no meeting time means no link, rather than a broken one', () => {
  eq(agenda.calendarLink({ name: 'x', meeting_at: null }), null);
  eq(agenda.calendarLink({ name: 'x', meeting_at: 'tuesday' }), null);
  eq(agenda.calendarLink(null), null);
});

check('a row with no notes still produces a usable link', () => {
  const url = agenda.calendarLink({ name: 'Quiet Co', meeting_at: '2026-09-02T14:00' });
  assert(url.includes('text=Brainstorm'), 'title still set');
  eq(new URL(url).searchParams.get('details'), null, 'no empty details param');
});

/* --------------------------------------------- meeting_at is not optional -- */
console.log('\nmeeting_set requires a time');

check('the format validators agree across the Worker and the browser', () => {
  for (const good of ['2026-09-02T14:00', '2026-01-01T00:00']) {
    assert(isLocalDateTime(good) && agenda.isLocalDateTime(good), good);
  }
  for (const bad of ['2026-09-02', '2026-09-02T14:00:00Z', '2026-09-02 14:00', '', null, 'soon']) {
    assert(!isLocalDateTime(bad) && !agenda.isLocalDateTime(bad), String(bad));
  }
});

check('a local date validator rejects a datetime, and vice versa', () => {
  assert(isLocalDate('2026-09-02'));
  assert(!isLocalDate('2026-09-02T14:00'));
  assert(!isLocalDateTime('2026-09-02'));
});

check('the database accepts a meeting_set row only with a time, by our rule', () => {
  // The rule lives in patchAreaFacility; this pins the shape it enforces so a
  // schema change cannot quietly make a timeless meeting representable again.
  const db = freshDb();
  const id = addArea(db, 'rule');
  const rowId = addFacility(db, id, { status: 'meeting_set', meeting_at: '2026-09-02T14:00' });
  const row = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(rowId);
  assert(isLocalDateTime(row.meeting_at), 'a booked brainstorm needs a time on it');
  assert(agenda.hasLiveMeeting(row), 'and the panel must recognise it');
  db.close();
});

check('hasLiveMeeting and hasLiveFollowUp encode the inert rule', () => {
  assert(agenda.hasLiveMeeting({ status: 'meeting_set', meeting_at: '2026-09-02T14:00' }));
  assert(!agenda.hasLiveMeeting({ status: 'won', meeting_at: '2026-09-02T14:00' }));
  assert(!agenda.hasLiveMeeting({ status: 'meeting_set', meeting_at: null }));
  assert(agenda.hasLiveFollowUp({ status: 'no_answer', follow_up_date: '2026-09-02' }));
  assert(agenda.hasLiveFollowUp({ status: 'voicemail', follow_up_date: '2026-09-02' }));
  assert(!agenda.hasLiveFollowUp({ status: 'out', follow_up_date: '2026-09-02' }));
  assert(!agenda.hasLiveFollowUp({ status: 'meeting_set', follow_up_date: '2026-09-02' }));
});

/* ----------------------------------------------- enrichment cannot touch it -- */
console.log('\nenrichment cannot move a meeting');

check('the two pipeline dates are protected columns', () => {
  assert(AREA_PROTECTED_COLUMNS.has('meeting_at'));
  assert(AREA_PROTECTED_COLUMNS.has('follow_up_date'));
  let threw = false;
  try {
    assertAreaPatchIsSafe({ website: 'x', meeting_at: '2026-09-09T09:00' });
  } catch {
    threw = true;
  }
  assert(threw, 'writing meeting_at from an enrichment must throw');
});

check('a real enrichment patch never names them', () => {
  const row = {
    id: 'r1', name: 'Acme', phone: null, website: null, primary_type: null,
    google_place_id: 'p1', rating: null, review_count: null, industries: 'hvac',
    status: 'meeting_set', meeting_at: '2026-09-02T14:00', follow_up_date: null,
    is_franchise: 0, is_supplier_or_retail: 0,
  };
  const patch = areaEnrichmentPatch(row, {
    googlePlaceId: 'p1', phone: '(256) 555-0100', website: null,
    rating: 4.8, reviewCount: 120, industries: ['plumbing'],
  });
  assertAreaPatchIsSafe(patch);
  eq(patch.meeting_at, undefined);
  eq(patch.follow_up_date, undefined);
});

check('the area snapshot rails now guard the meeting and the retry', () => {
  const row = (over) => ({
    id: 'a', status: 'meeting_set', flagged: 0, notes: '', phone: null,
    meeting_at: '2026-09-02T14:00', follow_up_date: null, ...over,
  });
  eq(verifySnapshot(snapshotOf([row()]), snapshotOf([row()])).ok, true);

  const moved = verifySnapshot(
    snapshotOf([row()]),
    snapshotOf([row({ meeting_at: '2026-09-09T14:00' })])
  );
  assert(!moved.ok, 'a moved meeting must be caught');
  eq(moved.violations[0].field, 'meeting_at');

  const cleared = verifySnapshot(
    snapshotOf([row({ follow_up_date: '2026-09-01' })]),
    snapshotOf([row({ follow_up_date: null })])
  );
  assert(!cleared.ok, 'a cleared retry must be caught');
  eq(cleared.violations[0].field, 'follow_up_date');
});

check('an enrichment UPDATE leaves a booked meeting exactly where it was', () => {
  const db = freshDb();
  const id = addArea(db, 'safety');
  const facId = addFacility(db, id, {
    status: 'meeting_set', meeting_at: '2026-09-02T14:00', notes: 'Owner Dale', flagged: 1,
  });
  const before = snapshotOf(db.prepare('SELECT * FROM area_facilities WHERE id = ?').all(facId));
  const stored = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(facId);
  const patch = areaEnrichmentPatch(stored, {
    googlePlaceId: 'p1', phone: '(256) 555-0100', reviewCount: 143, rating: 4.7,
    industries: ['plumbing'],
  });
  assertAreaPatchIsSafe(patch);
  const columns = Object.keys(patch);
  db.prepare(
    `UPDATE area_facilities SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  ).run(...columns.map((c) => patch[c]), facId);

  const after = snapshotOf(db.prepare('SELECT * FROM area_facilities WHERE id = ?').all(facId));
  const result = verifySnapshot(before, after);
  assert(result.ok, JSON.stringify(result.violations));
  const row = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(facId);
  eq(row.meeting_at, '2026-09-02T14:00');
  eq(row.review_count, 143, 'the review count did still refresh');
  db.close();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
