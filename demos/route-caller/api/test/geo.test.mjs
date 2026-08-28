// Unit checks for the corridor math + merge logic. Run: node test/geo.test.mjs

import {
  decodePolyline,
  haversineMeters,
  simplifyByDistance,
  buildRouteIndex,
  nearestOnRoute,
  samplePointsAlong,
} from '../src/geo.js';
import {
  mergeCandidates,
  placeOnRoute,
  byDriveOrder,
  partitionRetail,
  isRetailNonChildcare,
} from '../src/pipeline.js';
import { isFranchise, isHomeDaycare, normalizeName } from '../src/heuristics.js';

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

function near(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || ''} expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

console.log('polyline');
check('decodes the reference Google polyline', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert(pts.length === 3, `expected 3 points, got ${pts.length}`);
  near(pts[0].lat, 38.5, 1e-6, 'p0.lat');
  near(pts[0].lng, -120.2, 1e-6, 'p0.lng');
  near(pts[1].lat, 40.7, 1e-6, 'p1.lat');
  near(pts[1].lng, -120.95, 1e-6, 'p1.lng');
  near(pts[2].lat, 43.252, 1e-6, 'p2.lat');
  near(pts[2].lng, -126.453, 1e-6, 'p2.lng');
});
check('empty input yields no points', () => {
  assert(decodePolyline('').length === 0);
  assert(decodePolyline(null).length === 0);
});

console.log('distance');
check('one degree of latitude is ~111.19 km', () => {
  near(haversineMeters({ lat: 40, lng: -77 }, { lat: 41, lng: -77 }), 111195, 200);
});
check('known city pair (DC to Baltimore ~56 km)', () => {
  near(
    haversineMeters({ lat: 38.9072, lng: -77.0369 }, { lat: 39.2904, lng: -76.6122 }),
    56100,
    900
  );
});
check('identical points are zero apart', () => {
  assert(haversineMeters({ lat: 5, lng: 5 }, { lat: 5, lng: 5 }) === 0);
});

// A due-north route along the -77 meridian, from lat 39 to lat 40.
const meridian = [
  { lat: 39.0, lng: -77.0 },
  { lat: 39.5, lng: -77.0 },
  { lat: 40.0, lng: -77.0 },
];
const index = buildRouteIndex(meridian);

console.log('route index');
check('route length is the sum of its legs', () => {
  near(index.lengthMeters, 111195, 300, 'length');
});

console.log('distance from route');
check('a point offset east of the corridor measures the perpendicular gap', () => {
  // 0.01 deg of longitude at lat 39.5 ≈ 858 m
  const { distanceMeters } = nearestOnRoute(index, { lat: 39.5, lng: -76.99 });
  near(distanceMeters, 858, 12, 'offset');
});
check('a point on the line is at zero distance', () => {
  const { distanceMeters } = nearestOnRoute(index, { lat: 39.25, lng: -77.0 });
  near(distanceMeters, 0, 1, 'on-line');
});
check('a point past the end clamps to the endpoint, not the infinite line', () => {
  const { distanceMeters, positionMeters } = nearestOnRoute(index, { lat: 40.1, lng: -77.0 });
  near(distanceMeters, 11119, 60, 'beyond-end distance');
  near(positionMeters, index.lengthMeters, 1, 'beyond-end position');
});
check('a point before the start clamps to the start', () => {
  const { positionMeters } = nearestOnRoute(index, { lat: 38.8, lng: -77.0 });
  near(positionMeters, 0, 1, 'before-start position');
});

console.log('position along route');
check('the midpoint projects to half the route length', () => {
  const { positionMeters } = nearestOnRoute(index, { lat: 39.5, lng: -77.02 });
  near(positionMeters, index.lengthMeters / 2, 60, 'midpoint');
});
check('projection is monotonic in drive order', () => {
  const a = nearestOnRoute(index, { lat: 39.1, lng: -77.01 }).positionMeters;
  const b = nearestOnRoute(index, { lat: 39.6, lng: -77.01 }).positionMeters;
  const c = nearestOnRoute(index, { lat: 39.9, lng: -77.01 }).positionMeters;
  assert(a < b && b < c, `expected increasing positions, got ${a}, ${b}, ${c}`);
});
check('an L-shaped route measures along the path, not as the crow flies', () => {
  const corner = buildRouteIndex([
    { lat: 39.0, lng: -77.0 },
    { lat: 39.5, lng: -77.0 },
    { lat: 39.5, lng: -76.0 },
  ]);
  const { positionMeters } = nearestOnRoute(corner, { lat: 39.5, lng: -76.5 });
  const firstLeg = haversineMeters({ lat: 39.0, lng: -77.0 }, { lat: 39.5, lng: -77.0 });
  const halfSecond =
    haversineMeters({ lat: 39.5, lng: -77.0 }, { lat: 39.5, lng: -76.0 }) / 2;
  near(positionMeters, firstLeg + halfSecond, 400, 'L-route position');
});

console.log('simplify + sampling');
check('simplify keeps the endpoints and drops dense infill', () => {
  const dense = [];
  for (let i = 0; i <= 100; i++) dense.push({ lat: 39 + i * 0.001, lng: -77 });
  const simple = simplifyByDistance(dense, 200);
  assert(simple.length < dense.length, 'expected fewer points');
  assert(simple[0].lat === dense[0].lat, 'first point kept');
  assert(simple[simple.length - 1].lat === dense[dense.length - 1].lat, 'last point kept');
  for (let i = 1; i < simple.length - 1; i++) {
    assert(haversineMeters(simple[i - 1], simple[i]) >= 199, 'spacing respected');
  }
});
check('sampling spans the route at roughly the requested interval', () => {
  const samples = samplePointsAlong(index, 8000, 25);
  assert(samples.length >= 13 && samples.length <= 16, `got ${samples.length} samples`);
  near(samples[0].lat, 39.0, 1e-6, 'starts at route start');
  near(samples[samples.length - 1].lat, 40.0, 1e-6, 'ends at route end');
  for (let i = 1; i < samples.length; i++) {
    assert(haversineMeters(samples[i - 1], samples[i]) <= 8600, 'gap within interval');
  }
});
check('sampling never exceeds the subrequest cap', () => {
  const long = buildRouteIndex([
    { lat: 25.76, lng: -80.19 },
    { lat: 40.71, lng: -74.0 },
  ]);
  const samples = samplePointsAlong(long, 8000, 25);
  assert(samples.length <= 25, `got ${samples.length}`);
  near(samples[samples.length - 1].lat, 40.71, 1e-6, 'still ends at the destination');
});

console.log('merge + corridor filter');
check('same name within 150 m merges and keeps the phone number', () => {
  const merged = mergeCandidates([
    [{ name: 'Sunny Days Learning Center', lat: 39.2, lng: -77.0, phone: null, source: 'osm', tags: {} }],
    [{ name: 'Sunny Days Learning Center', lat: 39.2009, lng: -77.0, phone: '(555) 111-2222', source: 'google', tags: {} }],
  ]);
  assert(merged.length === 1, `expected 1 merged record, got ${merged.length}`);
  assert(merged[0].phone === '(555) 111-2222', 'phone preferred');
  assert(merged[0].source === 'both', `source should be both, got ${merged[0].source}`);
});
check('same name far apart stays two facilities', () => {
  const merged = mergeCandidates([
    [{ name: 'Little Acorns', lat: 39.2, lng: -77.0, source: 'google', tags: {} }],
    [{ name: 'Little Acorns', lat: 39.4, lng: -77.0, source: 'google', tags: {} }],
  ]);
  assert(merged.length === 2, `expected 2, got ${merged.length}`);
});
check('facilities beyond the corridor are discarded and the rest come back in drive order', () => {
  const placed = placeOnRoute(
    [
      { name: 'Far Away Daycare', lat: 39.5, lng: -75.0, source: 'google', tags: {} },
      { name: 'North Preschool', lat: 39.9, lng: -77.01, source: 'google', tags: {} },
      { name: 'South Preschool', lat: 39.1, lng: -77.01, source: 'google', tags: {} },
    ],
    index,
    16000
  );
  assert(placed.length === 2, `expected 2 in corridor, got ${placed.length}`);
  assert(placed[0].name === 'South Preschool', 'drive order');
  assert(placed[1].name === 'North Preschool', 'drive order');
  assert(placed[0].distance_from_route_m < 1000, 'distance recorded');
});

check('facilities clamped to the same position sort closest-to-route first', () => {
  // All three sit beside the start of the route, so they clamp to position 0
  // and only distance off route can order them.
  const placed = placeOnRoute(
    [
      { name: 'Far Side Daycare', lat: 38.95, lng: -76.90, source: 'google', tags: {} },
      { name: 'Near Side Daycare', lat: 38.98, lng: -77.00, source: 'google', tags: {} },
      { name: 'Middle Daycare', lat: 38.96, lng: -76.95, source: 'google', tags: {} },
    ],
    index,
    16000
  );
  assert(placed.length === 3, `expected 3, got ${placed.length}`);
  assert(
    placed.every((f) => f.position_along_route_m === 0),
    'all three should clamp to the route start'
  );
  assert(
    placed.map((f) => f.name).join(' < ') ===
      'Near Side Daycare < Middle Daycare < Far Side Daycare',
    `got ${placed.map((f) => `${f.name}@${f.distance_from_route_m}m`).join(', ')}`
  );
});
check('a tie on position and distance falls back to name', () => {
  const rows = [
    { name: 'Zebra Learning', position_along_route_m: 0, distance_from_route_m: 500 },
    { name: 'Acorn Learning', position_along_route_m: 0, distance_from_route_m: 500 },
  ];
  assert(rows.slice().sort(byDriveOrder)[0].name === 'Acorn Learning', 'name breaks the last tie');
  assert(byDriveOrder(rows[0], rows[0]) === 0, 'a row equals itself');
});
check('position still outranks distance', () => {
  const early = { name: 'B', position_along_route_m: 1000, distance_from_route_m: 9000 };
  const late = { name: 'A', position_along_route_m: 2000, distance_from_route_m: 100 };
  assert(byDriveOrder(early, late) < 0, 'earlier on the route wins regardless of offset');
});

console.log('retail deny-list');
check('a big-box store typed as retail is excluded', () => {
  assert(isRetailNonChildcare({ name: 'Target', primaryType: 'department_store' }));
  assert(isRetailNonChildcare({ name: 'Kroger', primaryType: 'supermarket' }));
  assert(isRetailNonChildcare({ name: 'Parkway Place', primaryType: 'shopping_mall' }));
});
check('churches, YMCAs, community centres and schools are always kept', () => {
  const keepers = [
    { name: 'St Paul’s Lutheran Church & Preschool', primaryType: 'church' },
    { name: 'Grace Baptist Church', primaryType: 'place_of_worship' },
    { name: 'YMCA of Huntsville', primaryType: 'gym' },
    { name: 'Heart of the Valley YMCA', primaryType: 'fitness_center' },
    { name: 'Northside Community Center', primaryType: 'community_center' },
    { name: 'Whitesburg Elementary School', primaryType: 'primary_school' },
    { name: 'Decatur City Head Start', primaryType: 'school' },
    { name: 'Little Acorns', primaryType: 'child_care_agency' },
    { name: 'Bright Beginnings', primaryType: 'preschool' },
  ];
  for (const row of keepers) {
    assert(!isRetailNonChildcare(row), `${row.name} (${row.primaryType}) should be kept`);
  }
});
check('anything without a primaryType is kept — the filter fails open', () => {
  // OSM candidates and lean-mask Google responses have no primaryType.
  assert(!isRetailNonChildcare({ name: 'Learning Zone', source: 'osm' }));
  assert(!isRetailNonChildcare({ name: 'Learning Zone', primaryType: null }));
  assert(!isRetailNonChildcare({}));
  assert(!isRetailNonChildcare(undefined));
});
check('the name is never consulted', () => {
  // A real child care centre that happens to be called Target Learning stays in;
  // a Target typed as a department store goes, whatever it is called.
  assert(!isRetailNonChildcare({ name: 'Target Learning Academy', primaryType: 'preschool' }));
  assert(isRetailNonChildcare({ name: 'Sunny Days Learning Center', primaryType: 'department_store' }));
});
check('partitionRetail splits the list and reports what it dropped', () => {
  const { kept, excluded } = partitionRetail([
    { name: 'Target', primaryType: 'department_store' },
    { name: 'St Paul’s Church Preschool', primaryType: 'church' },
    { name: 'Ardent Preschool', source: 'osm' },
    { name: 'YMCA of Huntsville', primaryType: 'gym' },
    { name: 'Publix', primaryType: 'grocery_store' },
  ]);
  assert(kept.length === 3, `expected 3 kept, got ${kept.length}`);
  assert(excluded.length === 2, `expected 2 excluded, got ${excluded.length}`);
  assert(excluded.map((r) => r.name).join(',') === 'Target,Publix', 'the right rows dropped');
  assert(!kept.some((r) => r.primaryType === 'department_store'), 'no retail survived');
});

console.log('heuristics');
check('national chains are flagged as franchises', () => {
  assert(isFranchise('KinderCare Learning Center #302'));
  assert(isFranchise('The Goddard School of Ashburn'));
  assert(!isFranchise('Sunny Days Learning Center'));
});
check('in-home providers are flagged', () => {
  assert(isHomeDaycare("Maria's Family Child Care"));
  assert(isHomeDaycare('Anywhere', { building: 'house' }));
  assert(!isHomeDaycare('Bright Beginnings Academy', { building: 'commercial' }));
});
check('name normalization strips punctuation and corporate suffixes', () => {
  assert(normalizeName('The Little Acorns, LLC.') === 'little acorns');
  assert(normalizeName('A & B Childcare') === 'a and b childcare');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
