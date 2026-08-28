// Runs the Worker's real route-list SQL against a real SQLite database built
// from the real migration files. Run: node test/queries.test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_LIST_SQL } from '../src/queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures.push(label);
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/** A fresh database with every migration applied, in order. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  return db;
}

let routeSeq = 0;
function addRoute(db, name) {
  const id = `route-${++routeSeq}`;
  db.prepare(
    `INSERT INTO routes (id, name, start_address, end_address, polyline, created_at)
     VALUES (?, ?, 'a', 'b', 'xx', ?)`
  ).run(id, name, `2026-08-28 10:0${routeSeq}:00`);
  return id;
}

let facSeq = 0;
function addFacility(db, routeId, overrides = {}) {
  const row = {
    name: `Facility ${++facSeq}`,
    source: 'google',
    is_school_program: 0,
    is_franchise: 0,
    is_home_daycare: 0,
    playground_unlikely: 0,
    status: 'not_called',
    flagged: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO facilities
       (id, route_id, name, source, is_school_program, is_franchise,
        is_home_daycare, playground_unlikely, status, flagged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `fac-${facSeq}`, routeId, row.name, row.source, row.is_school_program,
    row.is_franchise, row.is_home_daycare, row.playground_unlikely, row.status, row.flagged
  );
}

const listRoutes = (db) => db.prepare(ROUTE_LIST_SQL).all();

console.log('migrations');
check('every migration applies to a fresh database', () => {
  const db = freshDb();
  const cols = db.prepare("SELECT name FROM pragma_table_info('facilities')").all().map((c) => c.name);
  for (const expected of [
    'is_school_program', 'is_franchise', 'is_home_daycare', 'playground_unlikely',
    'website', 'primary_type', 'status', 'flagged', 'notes',
  ]) {
    assert(cols.includes(expected), `facilities.${expected} missing`);
  }
  const routeCols = db.prepare("SELECT name FROM pragma_table_info('routes')").all().map((c) => c.name);
  assert(routeCols.includes('corridor_m'), 'routes.corridor_m missing');
});

console.log('visible_count');
check('visible_count is the total minus every hidden category', () => {
  const db = freshDb();
  const route = addRoute(db, 'Mixed');
  addFacility(db, route); // plain
  addFacility(db, route); // plain
  addFacility(db, route, { is_school_program: 1 });
  addFacility(db, route, { is_franchise: 1 });
  addFacility(db, route, { is_home_daycare: 1 });
  addFacility(db, route, { playground_unlikely: 1 });
  const [row] = listRoutes(db);
  assert(row.facility_count === 6, `facility_count ${row.facility_count}`);
  assert(row.visible_count === 2, `visible_count ${row.visible_count}`);
});
check('a row in two hidden categories is only subtracted once', () => {
  const db = freshDb();
  const route = addRoute(db, 'Overlap');
  addFacility(db, route);
  addFacility(db, route, { is_school_program: 1, is_franchise: 1, playground_unlikely: 1 });
  const [row] = listRoutes(db);
  assert(row.facility_count === 2 && row.visible_count === 1, `got ${row.visible_count}`);
});
check('a route with no facilities reports zeroes, not nulls', () => {
  const db = freshDb();
  addRoute(db, 'Empty');
  const [row] = listRoutes(db);
  assert(row.facility_count === 0, `facility_count ${row.facility_count}`);
  assert(row.visible_count === 0, `visible_count should be 0, got ${row.visible_count}`);
  assert(row.called_count === 0, `called_count should be 0, got ${row.called_count}`);
  assert(row.flagged_count === 0, `flagged_count should be 0, got ${row.flagged_count}`);
});
check('every facility hidden means a visible_count of zero', () => {
  const db = freshDb();
  const route = addRoute(db, 'All hidden');
  addFacility(db, route, { is_school_program: 1 });
  addFacility(db, route, { is_franchise: 1 });
  const [row] = listRoutes(db);
  assert(row.facility_count === 2 && row.visible_count === 0, `got ${row.visible_count}`);
});

console.log('called_count follows the visible set');
check('a call on a HIDDEN row does not count toward progress', () => {
  // Decided and documented: progress must agree with the denominator she sees.
  // Counting a hidden row's call would let a card read "2 of 1 called".
  const db = freshDb();
  const route = addRoute(db, 'Called but hidden');
  addFacility(db, route, { status: 'no_answer' }); // visible + called
  addFacility(db, route, { status: 'interested', is_school_program: 1 }); // hidden + called
  addFacility(db, route); // visible + not called
  const [row] = listRoutes(db);
  assert(row.facility_count === 3, `facility_count ${row.facility_count}`);
  assert(row.visible_count === 2, `visible_count ${row.visible_count}`);
  assert(row.called_count === 1, `called_count should ignore the hidden call, got ${row.called_count}`);
  assert(row.called_count <= row.visible_count, 'progress can never exceed its denominator');
});
check('flagged_count follows the same rule', () => {
  const db = freshDb();
  const route = addRoute(db, 'Flagged');
  addFacility(db, route, { flagged: 1 });
  addFacility(db, route, { flagged: 1, is_franchise: 1 });
  const [row] = listRoutes(db);
  assert(row.flagged_count === 1, `flagged_count ${row.flagged_count}`);
});
check('every call status other than not_called counts', () => {
  const db = freshDb();
  const route = addRoute(db, 'Statuses');
  for (const status of ['no_answer', 'voicemail', 'interested', 'not_interested']) {
    addFacility(db, route, { status });
  }
  addFacility(db, route, { status: 'not_called' });
  const [row] = listRoutes(db);
  assert(row.called_count === 4, `called_count ${row.called_count}`);
  assert(row.visible_count === 5, `visible_count ${row.visible_count}`);
});

console.log('multiple routes');
check('counts do not leak between routes, newest first', () => {
  const db = freshDb();
  const a = addRoute(db, 'First');
  const b = addRoute(db, 'Second');
  addFacility(db, a, { status: 'voicemail' });
  addFacility(db, a, { is_franchise: 1 });
  addFacility(db, b);
  addFacility(db, b);
  addFacility(db, b, { is_school_program: 1, status: 'interested' });
  const rows = listRoutes(db);
  assert(rows.length === 2, `expected 2 routes, got ${rows.length}`);
  assert(rows[0].name === 'Second', 'newest route first');
  const second = rows[0];
  const first = rows[1];
  assert(second.facility_count === 3 && second.visible_count === 2, 'second route counts');
  assert(second.called_count === 0, 'its only call is on a hidden row');
  assert(first.facility_count === 2 && first.visible_count === 1, 'first route counts');
  assert(first.called_count === 1, 'first route call counted');
});
check('legacy rows with NULL flags count as visible', () => {
  // Columns added by later migrations default to 0, but a row written before
  // one landed can hold NULL; COALESCE keeps those on her list.
  const db = freshDb();
  const route = addRoute(db, 'Legacy');
  addFacility(db, route);
  db.exec("UPDATE facilities SET playground_unlikely = NULL, is_school_program = NULL");
  const [row] = listRoutes(db);
  assert(row.visible_count === 1, `NULL flags must not hide a row, got ${row.visible_count}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
