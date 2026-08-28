// Enrichment matching and safety rules. These protect a route the caller is
// actively working, so they are tested directly rather than inferred.
// Run: node test/enrich.test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchCandidates,
  enrichmentPatch,
  assertPatchIsSafe,
  PROTECTED_COLUMNS,
  snapshotOf,
  verifySnapshot,
} from '../src/enrich.js';

const here = dirname(fileURLToPath(import.meta.url));
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
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const row = (over = {}) => ({
  id: 'row-1', route_id: 'r', name: 'Sunny Days Learning Center',
  lat: 39.2, lng: -77.0, phone: null, website: null, primary_type: null,
  google_place_id: null, playground_nearby: 0, is_school_program: 0,
  is_franchise: 0, is_home_daycare: 0, playground_unlikely: 0,
  status: 'not_called', flagged: 0, notes: '', ...over,
});
const cand = (over = {}) => ({
  name: 'Sunny Days Learning Center', lat: 39.2, lng: -77.0,
  phone: null, website: null, primaryType: null, googlePlaceId: null, ...over,
});

console.log('matching');
check('the Google place id matches outright, even if the name drifted', () => {
  const existing = [row({ google_place_id: 'ChIJ_abc', name: 'Sunny Days Learning Ctr' })];
  const { updates, inserts } = matchCandidates([cand({ googlePlaceId: 'ChIJ_abc', name: 'Sunny Days Learning Center' })], existing);
  assert(updates.length === 1 && inserts.length === 0, 'matched on the stable key');
  assert(updates[0].matchedBy === 'place_id');
});
check('legacy rows with no place id fall back to name within 150 m', () => {
  const existing = [row()];
  const { updates, inserts } = matchCandidates([cand({ lat: 39.2009 })], existing); // ~100 m
  assert(updates.length === 1 && inserts.length === 0, 'matched on name + geo');
  assert(updates[0].matchedBy === 'name_geo');
});
check('the same name far away is a new facility, not a match', () => {
  const { updates, inserts } = matchCandidates([cand({ lat: 39.4 })], [row()]);
  assert(updates.length === 0 && inserts.length === 1, 'inserted instead');
});
check('an unseen facility inserts', () => {
  const { updates, inserts } = matchCandidates([cand({ name: 'Brand New Preschool' })], [row()]);
  assert(inserts.length === 1 && updates.length === 0);
  assert(inserts[0].name === 'Brand New Preschool');
});
check('an AMBIGUOUS match updates nothing and is reported', () => {
  // Two stored rows with the same name inside the radius: guessing would write
  // one facility's data onto the other's row, on a route she is calling.
  const existing = [
    row({ id: 'a', lat: 39.2 }),
    row({ id: 'b', lat: 39.2005 }),
  ];
  const { updates, inserts, ambiguous } = matchCandidates([cand()], existing);
  assert(updates.length === 0, 'nothing updated');
  assert(inserts.length === 0, 'and nothing inserted either');
  assert(ambiguous.length === 1, 'reported for review');
  assert(ambiguous[0].rows.length === 2, 'both candidates named');
});
check('one existing row is never claimed by two candidates', () => {
  const existing = [row()];
  const { updates, inserts } = matchCandidates([cand(), cand()], existing);
  assert(updates.length === 1, `expected one update, got ${updates.length}`);
  assert(inserts.length === 0, 'the duplicate does not become a new row');
});

console.log('what an update may write');
check('an existing row keeps its id, status, flags and notes', () => {
  const existing = row({ status: 'interested', flagged: 1, notes: 'Ask for Denise' });
  const patch = enrichmentPatch(existing, cand({ website: 'https://x.test' }), false);
  assert(patch.website === 'https://x.test', 'website filled');
  for (const column of ['id', 'status', 'flagged', 'notes', 'name']) {
    assert(!(column in patch), `${column} must never be written`);
  }
  assertPatchIsSafe(patch);
});
check('protected columns are rejected, not just omitted', () => {
  let threw = false;
  try {
    assertPatchIsSafe({ website: 'x', status: 'interested' });
  } catch {
    threw = true;
  }
  assert(threw, 'a patch touching status must throw');
  assert(PROTECTED_COLUMNS.has('notes') && PROTECTED_COLUMNS.has('flagged'));
});
check('phone fills from NULL but is NEVER overwritten', () => {
  const filled = enrichmentPatch(row({ phone: null }), cand({ phone: '(256) 555-0100' }), false);
  assert(filled.phone === '(256) 555-0100', 'NULL phone filled');
  const kept = enrichmentPatch(row({ phone: '(256) 555-9999' }), cand({ phone: '(256) 555-0100' }), false);
  assert(kept === null || !('phone' in kept), 'an existing number is never replaced');
});
check('website and primary_type fill only from NULL', () => {
  const kept = enrichmentPatch(
    row({ website: 'https://old.test', primary_type: 'preschool' }),
    cand({ website: 'https://new.test', primaryType: 'child_care_agency' }),
    false
  );
  assert(kept === null || !('website' in kept), 'website not overwritten');
  assert(kept === null || !('primary_type' in kept), 'primary_type not overwritten');
});
check('playground_nearby only ever goes 0 to 1', () => {
  const gained = enrichmentPatch(row({ playground_nearby: 0 }), cand(), true);
  assert(gained.playground_nearby === 1, 'gained the signal');
  const held = enrichmentPatch(row({ playground_nearby: 1 }), cand(), false);
  assert(held === null || !('playground_nearby' in held), 'a bad Overpass day cannot clear it');
});
check('a row with nothing to gain produces no write at all', () => {
  const nothing = enrichmentPatch(
    row({ phone: '(256) 555-1111', website: 'https://x.test', primary_type: 'child_care_agency', google_place_id: 'ChIJ_x' }),
    cand({ phone: '(256) 555-2222', website: 'https://y.test', primaryType: 'preschool', googlePlaceId: 'ChIJ_x' }),
    false
  );
  assert(nothing === null, 'no patch, no UPDATE');
});

console.log('classifier re-run');
check('a newly captured primary_type can change a flag', () => {
  // Stored with no type, so the bare name never flagged. Google now says
  // primary_school, which under the current boundary is school-age.
  const stored = row({ name: 'Gales Ferry School', primary_type: null, is_school_program: 0 });
  const before = enrichmentPatch(stored, cand({ name: 'Gales Ferry School' }), false);
  assert(before === null || before.is_school_program === undefined, 'nothing to change yet');
  const after = enrichmentPatch(stored, cand({ name: 'Gales Ferry School', primaryType: 'primary_school' }), false);
  assert(after.primary_type === 'primary_school', 'type captured');
  assert(after.is_school_program === 1, 'and the flag follows it');
});
check('the early-childhood veto still wins during a re-run', () => {
  const stored = row({ name: 'Applebrook Country Day School', primary_type: null });
  const patch = enrichmentPatch(stored, cand({ name: 'Applebrook Country Day School', primaryType: 'child_care_agency' }), false);
  assert(patch.primary_type === 'child_care_agency');
  assert(patch.is_school_program === undefined || patch.is_school_program === 0, 'stays her prospect');
});

console.log('snapshot verification');
check('an untouched snapshot verifies', () => {
  const rows = [row({ id: 'a', status: 'interested', notes: 'call back' }), row({ id: 'b' })];
  const result = verifySnapshot(snapshotOf(rows), snapshotOf(rows));
  assert(result.ok && result.violations.length === 0);
});
check('a mutated status is CAUGHT', () => {
  const before = snapshotOf([row({ id: 'a', status: 'interested' })]);
  const after = snapshotOf([row({ id: 'a', status: 'not_called' })]);
  const result = verifySnapshot(before, after);
  assert(!result.ok, 'must fail');
  assert(result.violations[0].field === 'status', 'names the field');
});
check('mutated notes and flags are caught', () => {
  const before = snapshotOf([row({ id: 'a', notes: 'Ask for Denise', flagged: 1 })]);
  const after = snapshotOf([row({ id: 'a', notes: '', flagged: 0 })]);
  const result = verifySnapshot(before, after);
  assert(!result.ok, 'must fail');
  const fields = result.violations.map((v) => v.field).sort();
  assert(fields.join(',') === 'flagged,notes', `got ${fields}`);
});
check('a disappeared row is caught — enrichment never deletes', () => {
  const result = verifySnapshot(snapshotOf([row({ id: 'a' })]), []);
  assert(!result.ok && result.violations[0].now === 'missing');
});
check('a phone filled from NULL is allowed; a changed one is not', () => {
  const gained = verifySnapshot(
    snapshotOf([row({ id: 'a', phone: null })]),
    snapshotOf([row({ id: 'a', phone: '(256) 555-0100' })])
  );
  assert(gained.ok, 'NULL to value is the one permitted change');
  const overwritten = verifySnapshot(
    snapshotOf([row({ id: 'a', phone: '(256) 555-1111' })]),
    snapshotOf([row({ id: 'a', phone: '(256) 555-2222' })])
  );
  assert(!overwritten.ok && overwritten.violations[0].field === 'phone', 'overwrite caught');
});

console.log('against real SQLite');
check('an UPDATE built from a patch leaves her columns untouched', () => {
  const db = new DatabaseSync(':memory:');
  const dir = join(here, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  db.exec("INSERT INTO routes (id,name,start_address,end_address,polyline) VALUES ('r','R','a','b','x')");
  db.prepare(
    `INSERT INTO facilities (id,route_id,name,source,phone,status,flagged,notes,lat,lng)
     VALUES ('f1','r','Sunny Days','google',NULL,'interested',1,'Ask for Denise',39.2,-77.0)`
  ).run();

  const stored = db.prepare('SELECT * FROM facilities WHERE id = ?').get('f1');
  const patch = enrichmentPatch(stored, cand({
    name: 'Sunny Days', phone: '(256) 555-0100', website: 'https://x.test',
    primaryType: 'child_care_agency', googlePlaceId: 'ChIJ_abc',
  }), true);
  assertPatchIsSafe(patch);

  const cols = Object.keys(patch);
  db.prepare(`UPDATE facilities SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => patch[c]), 'f1');

  const after = db.prepare('SELECT * FROM facilities WHERE id = ?').get('f1');
  assert(after.status === 'interested', 'status survived');
  assert(after.flagged === 1, 'flag survived');
  assert(after.notes === 'Ask for Denise', 'notes survived');
  assert(after.name === 'Sunny Days', 'name survived');
  assert(after.phone === '(256) 555-0100', 'NULL phone filled');
  assert(after.website === 'https://x.test', 'website gained');
  assert(after.google_place_id === 'ChIJ_abc', 'place id captured');
  assert(after.playground_nearby === 1, 'playground signal gained');
  const verified = verifySnapshot(snapshotOf([stored]), snapshotOf([after]));
  assert(verified.ok, 'snapshot verifies after a real UPDATE');
});
check('verification catches a deliberate mutation through the database', () => {
  const db = new DatabaseSync(':memory:');
  const dir = join(here, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  db.exec("INSERT INTO routes (id,name,start_address,end_address,polyline) VALUES ('r','R','a','b','x')");
  db.exec("INSERT INTO facilities (id,route_id,name,source,status,notes) VALUES ('f1','r','X','google','voicemail','keep me')");
  const before = snapshotOf(db.prepare('SELECT * FROM facilities').all());
  // A rogue write of exactly the kind the rail exists to catch.
  db.exec("UPDATE facilities SET status='not_called', notes='' WHERE id='f1'");
  const result = verifySnapshot(before, snapshotOf(db.prepare('SELECT * FROM facilities').all()));
  assert(!result.ok, 'the rail must fire');
  assert(result.violations.length === 2, `expected 2 violations, got ${result.violations.length}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
