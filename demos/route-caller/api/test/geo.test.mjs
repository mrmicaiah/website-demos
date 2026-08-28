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
  chunkSamples,
  mergeChunkResults,
  splitElements,
  buildQuery,
  CHUNK_SIZE,
} from '../src/overpass.js';
import {
  mergeCandidates,
  placeOnRoute,
  byDriveOrder,
  partitionRetail,
  isRetailNonChildcare,
  summarizeExcluded,
  hasPlaygroundWithin,
} from '../src/pipeline.js';
import {
  isFranchise,
  isHomeDaycare,
  normalizeName,
  isSchoolProgram,
  isPlaygroundUnlikely,
} from '../src/heuristics.js';

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

console.log('exclusion metrics');
check('effective counts distinct in-corridor rows, raw counts candidates', () => {
  // One store returned by three overlapping sample-point searches, a second
  // store found once, and a third that sits outside the 16 km corridor.
  const excluded = [
    { name: 'Target', primaryType: 'department_store', lat: 39.2, lng: -77.0, source: 'google', tags: {} },
    { name: 'Target', primaryType: 'department_store', lat: 39.2, lng: -77.0, source: 'google', tags: {} },
    { name: 'Target', primaryType: 'department_store', lat: 39.2001, lng: -77.0, source: 'google', tags: {} },
    { name: 'Roses Discount Store', primaryType: 'discount_store', lat: 39.6, lng: -77.01, source: 'google', tags: {} },
    { name: 'Faraway Mall', primaryType: 'shopping_mall', lat: 39.5, lng: -75.0, source: 'google', tags: {} },
  ];
  const summary = summarizeExcluded(excluded, index, 16000);
  assert(summary.raw === 5, `raw should count every candidate, got ${summary.raw}`);
  assert(summary.effective === 2, `effective should be 2 (Target + Roses), got ${summary.effective}`);
  assert(summary.effective < summary.raw, 'effective must not overstate the raw count');
});
check('the type breakdown counts raw candidates, not deduped rows', () => {
  const { types } = summarizeExcluded(
    [
      { name: 'Target', primaryType: 'department_store', lat: 39.2, lng: -77.0, tags: {} },
      { name: 'Target', primaryType: 'department_store', lat: 39.2, lng: -77.0, tags: {} },
      { name: 'Publix', primaryType: 'grocery_store', lat: 39.3, lng: -77.0, tags: {} },
    ],
    index,
    16000
  );
  assert(types.department_store === 2, `got ${JSON.stringify(types)}`);
  assert(types.grocery_store === 1, `got ${JSON.stringify(types)}`);
});
check('a candidate with no primaryType is bucketed as unknown, never dropped from the tally', () => {
  const { types, raw } = summarizeExcluded(
    [{ name: 'Mystery', lat: 39.2, lng: -77.0, tags: {} }],
    index,
    16000
  );
  assert(raw === 1 && types.unknown === 1, `got ${JSON.stringify(types)}`);
});
check('nothing excluded reports zeroes, not undefined', () => {
  const summary = summarizeExcluded([], index, 16000);
  assert(summary.raw === 0 && summary.effective === 0, 'both counts zero');
  assert(Object.keys(summary.types).length === 0, 'empty breakdown');
});

console.log('primary_type');
check('primaryType survives placement onto the route', () => {
  const placed = placeOnRoute(
    [
      { name: 'Little Acorns', primaryType: 'child_care_agency', lat: 39.2, lng: -77.0, source: 'google', tags: {} },
      { name: 'Ardent Preschool', lat: 39.3, lng: -77.0, source: 'osm', tags: {} },
    ],
    index,
    16000
  );
  assert(placed.find((f) => f.source === 'google').primaryType === 'child_care_agency');
  assert(placed.find((f) => f.source === 'osm').primaryType === null, 'OSM rows carry null, not undefined');
});
check('a merged row keeps the Google type when OSM contributed the base record', () => {
  const merged = mergeCandidates([
    [{ name: 'O2B Kids Madison', lat: 39.2, lng: -77.0, phone: null, source: 'osm', tags: {} }],
    [{ name: 'O2B Kids Madison', lat: 39.2005, lng: -77.0, phone: '(256) 449-8558', primaryType: 'child_care_agency', source: 'google', tags: {} }],
  ]);
  assert(merged.length === 1, 'the two records merged');
  assert(merged[0].source === 'both', 'source recorded as both');
  assert(
    merged[0].primaryType === 'child_care_agency',
    `type should survive the merge, got ${merged[0].primaryType}`
  );
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

console.log('school / Head Start flag');
check('specific school types flag on their own', () => {
  assert(isSchoolProgram('Beecher Road Elementary School', {}, 'primary_school'));
  assert(isSchoolProgram('Gales Ferry School', {}, 'primary_school'));
  assert(isSchoolProgram('Barnard Environmental Science & Technology School', {}, 'primary_school'));
  assert(isSchoolProgram('Central High', {}, 'secondary_school'));
});
check('a bare `school` type is NOT enough on its own', () => {
  // It caught Montessoris and parochial schools far more often than public ones.
  assert(!isSchoolProgram('Whitby School', {}, 'school'));
  assert(!isSchoolProgram('The Bright School', {}, 'school'));
  assert(!isSchoolProgram('Friendship School', {}, 'school'));
  assert(!isSchoolProgram('Barnum School', {}, 'school'));
});
check('a bare `school` type flags when a public name agrees', () => {
  assert(isSchoolProgram('Whitesburg Elementary School', {}, 'school'));
  assert(isSchoolProgram('Jasper Head Start Center', {}, 'school'));
  assert(isSchoolProgram('Central City Schools', {}, 'school'));
});
check('child care types are never flagged by type', () => {
  assert(!isSchoolProgram('West Madison Pre-K School', {}, 'preschool'));
  assert(!isSchoolProgram('Little Acorns', {}, 'child_care_agency'));
});
check('OSM amenity=school is flagged', () => {
  assert(isSchoolProgram('Ridgecrest', { amenity: 'school' }));
  assert(!isSchoolProgram('Ardent Preschool', { amenity: 'kindergarten' }));
  assert(!isSchoolProgram('Learning Zone', { amenity: 'childcare' }));
});
check('Head Start is flagged by name, case-insensitively', () => {
  assert(isSchoolProgram('Decatur City Head Start'));
  assert(isSchoolProgram('HEAD START of North Alabama'));
  assert(isSchoolProgram('head start program'));
  assert(isSchoolProgram('Madison County Head-Start'));
});
check('public school name patterns are flagged', () => {
  const flagged = [
    'Lincoln Elementary School',
    'Martin Luther King Junior Elementary School',
    'Whitesburg Elementary',
    'Bob Jones High School',
    'Liberty Middle School',
    'Huntsville City Schools',
    'Madison County Schools',
    'Decatur Board of Education',
    'PS 118 Public School',
  ];
  for (const name of flagged) {
    assert(isSchoolProgram(name), `${name} should be flagged`);
  }
});
check('a school word alongside a child care word is NOT flagged on name alone', () => {
  const keepVisible = [
    'ABC Learning Academy',
    'Little Scholars Elementary Prep Daycare',
    'St Paul\u2019s Lutheran Church & Preschool',
    'Central Park Baptist Childcare Center',
    'Elementary Steps Child Care',
    'Head Start Learning Center',
    'Bright Beginnings Elementary Academy',
  ];
  for (const name of keepVisible) {
    assert(!isSchoolProgram(name), `${name} should stay visible`);
  }
});
check('private schools are prospects and are never flagged, whatever the type says', () => {
  // Her decision after the first cut hid forty rows on one route, most private.
  const prospects = [
    ['Elm City Montessori School', 'school'],
    ["The Children's School", 'primary_school'],
    ['Alphabet Academy, North Campus', 'school'],
    ['All Saints Catholic School - Preschool to Grade 8', 'school'],
    ['Hamden Hall Country Day School', 'primary_school'],
    ['N Stonington Christian Academy', 'primary_school'],
    ['Bi-Cultural Hebrew Academy of Connecticut', 'school'],
    ['Grace Lutheran School', 'school'],
    ['Our Lady of Mercy Preparatory Academy', 'school'],
    ['Seven Acres Montessori', 'school'],
    ['Little Scholars Elementary Prep Daycare', 'primary_school'],
  ];
  for (const [name, type] of prospects) {
    assert(!isSchoolProgram(name, {}, type), `${name} (${type}) must stay on her list`);
  }
});
check('the public rows she actually wants hidden are still flagged', () => {
  const hide = [
    ['Beecher Road Elementary School', 'primary_school'],
    ['Lulac Head Start Inc', 'child_care_agency'],
    ['Guilford Lakes Elementary School', 'primary_school'],
    ['Martin Luther King Junior Elementary School', 'primary_school'],
    ['Huntsville City Schools', null],
    ['Decatur Board of Education', null],
  ];
  for (const [name, type] of hide) {
    assert(isSchoolProgram(name, {}, type), `${name} (${type}) should be hidden`);
  }
});
check('ordinary child care names are untouched', () => {
  const untouched = [
    'Academy For Academics & Arts Middle',
    'Sunny Days Learning Center',
    'KinderCare Learning Center',
    'Montessori School Of Madison',
    'KLA Schools of Huntsville',
    'Growing in Grace Childcare',
    'Boys & Girls Clubs of North Alabama',
  ];
  for (const name of untouched) {
    assert(!isSchoolProgram(name), `${name} should stay visible`);
  }
});
check('placeOnRoute sets is_school_program alongside the other flags', () => {
  const placed = placeOnRoute(
    [
      { name: 'Whitesburg Elementary School', lat: 39.2, lng: -77.0, source: 'google', primaryType: 'primary_school', tags: {} },
      { name: 'Sunny Days Learning Center', lat: 39.3, lng: -77.0, source: 'google', primaryType: 'child_care_agency', tags: {} },
    ],
    index,
    16000
  );
  const school = placed.find((f) => f.name.includes('Whitesburg'));
  const daycare = placed.find((f) => f.name.includes('Sunny'));
  assert(school.is_school_program === 1, 'school flagged');
  assert(daycare.is_school_program === 0, 'daycare not flagged');
  assert(school.is_franchise === 0 && school.is_home_daycare === 0, 'flags are independent');
});


console.log('playground signals');
check('shapes with no outdoor play are marked unlikely', () => {
  const unlikely = [
    ['Kumon Math and Reading Center of Madison', null],
    ['Mathnasium of Huntsville', null],
    ['Sylvan Learning of Decatur', null],
    ['Bright Star Tutoring', null],
    ['Elite Test Prep', null],
    ['Russian School of Mathematics - RSM Stamford', 'school'],
    ['Huntsville School of Dance', null],
    ['Ballet Arts of Madison', null],
    ['Tiger Martial Arts', null],
    ['Elite Taekwondo', null],
    ['Goldfish Swim School', null],
    ['Vivace School of Music', null],
  ];
  for (const [name, type] of unlikely) {
    assert(isPlaygroundUnlikely(name, type), `${name} should be marked unlikely`);
  }
});
check('it NEVER fires on her core market types, whatever the name says', () => {
  assert(!isPlaygroundUnlikely('Kumon Kids Childcare', 'child_care_agency'));
  assert(!isPlaygroundUnlikely('Dance & Play Preschool', 'preschool'));
  assert(!isPlaygroundUnlikely('Little Ballet Academy', 'child_care_agency'));
  assert(!isPlaygroundUnlikely('Martial Arts Daycare', 'preschool'));
});
check('a child care word in the name is enough doubt to keep the row', () => {
  assert(!isPlaygroundUnlikely('Ballet & Beyond Daycare', null));
  assert(!isPlaygroundUnlikely('Karate Kids Child Care', null));
  assert(!isPlaygroundUnlikely('Swim School Preschool', null));
});
check('real prospects are not marked unlikely', () => {
  const keep = [
    ['Sunny Days Learning Center', 'child_care_agency'],
    ['YMCA of Huntsville', 'gym'],
    ['Gymnastics World', null],
    ['Boys & Girls Clubs of North Alabama', null],
    ['St Paul Lutheran Church Preschool', 'preschool'],
    ['Bright Beginnings Academy', null],
  ];
  for (const [name, type] of keep) {
    assert(!isPlaygroundUnlikely(name, type), `${name} should stay visible`);
  }
});
check('a mapped playground within 100 m sets the nearby signal', () => {
  const facility = { lat: 39.2, lng: -77.0 };
  // ~55 m north
  assert(hasPlaygroundWithin(facility, [{ lat: 39.20050, lng: -77.0 }]), 'within 100 m');
  // ~333 m north
  assert(!hasPlaygroundWithin(facility, [{ lat: 39.2030, lng: -77.0 }]), 'beyond 100 m');
  assert(!hasPlaygroundWithin(facility, []), 'no playgrounds mapped at all');
  assert(!hasPlaygroundWithin({ lat: null, lng: null }, [{ lat: 39.2, lng: -77.0 }]), 'no coords');
});
check('the nearby signal picks the closest of several playgrounds', () => {
  const facility = { lat: 39.2, lng: -77.0 };
  const playgrounds = [
    { lat: 39.25, lng: -77.0 },
    { lat: 39.2008, lng: -77.0 },
    { lat: 39.3, lng: -77.0 },
  ];
  assert(hasPlaygroundWithin(facility, playgrounds), 'one of them is close enough');
});
check('placeOnRoute sets both playground columns', () => {
  const placed = placeOnRoute(
    [
      { name: 'Sunny Days Learning Center', lat: 39.2, lng: -77.0, source: 'google', primaryType: 'child_care_agency', tags: {} },
      { name: 'Kumon of Ashland', lat: 39.3, lng: -77.0, source: 'google', primaryType: null, tags: {} },
    ],
    index,
    16000,
    [{ lat: 39.2004, lng: -77.0 }]
  );
  const daycare = placed.find((f) => f.name.includes('Sunny'));
  const kumon = placed.find((f) => f.name.includes('Kumon'));
  assert(daycare.is_playground_nearby === 1, 'playground mapped next door');
  assert(daycare.is_playground_unlikely === 0, 'core market never unlikely');
  assert(kumon.is_playground_nearby === 0, 'no playground near the Kumon');
  assert(kumon.is_playground_unlikely === 1, 'tutoring is unlikely');
});

console.log('website capture');
check('website survives placement and merging', () => {
  const merged = mergeCandidates([
    [{ name: 'O2B Kids', lat: 39.2, lng: -77.0, phone: null, website: null, source: 'osm', tags: {} }],
    [{ name: 'O2B Kids', lat: 39.2005, lng: -77.0, phone: '(256) 449-8558', website: 'https://o2bkids.com', source: 'google', tags: {} }],
  ]);
  assert(merged.length === 1 && merged[0].website === 'https://o2bkids.com', 'website carried through merge');
  const placed = placeOnRoute(merged, index, 16000);
  assert(placed[0].website === 'https://o2bkids.com', 'and through placement');
});
check('a missing website is null, not undefined — no website is a real signal', () => {
  const placed = placeOnRoute(
    [{ name: 'Little Acorns', lat: 39.2, lng: -77.0, source: 'osm', tags: {} }],
    index,
    16000
  );
  assert(placed[0].website === null, `expected null, got ${placed[0].website}`);
});

console.log('overpass chunking');
check('the corridor splits into chunks of at most CHUNK_SIZE', () => {
  const points = Array.from({ length: 25 }, (_, i) => ({ lat: 39 + i * 0.05, lng: -77 }));
  const chunks = chunkSamples(points, CHUNK_SIZE);
  const expected = Math.ceil(25 / CHUNK_SIZE);
  assert(chunks.length === expected, `25 points at ${CHUNK_SIZE} per chunk should be ${expected}, got ${chunks.length}`);
  assert(chunks.every((c) => c.length <= CHUNK_SIZE), 'no chunk exceeds the size');
  assert(chunks.flat().length === 25, 'every point appears exactly once');
  assert(chunks.flat()[0] === points[0], 'order preserved');
  assert(chunks.flat()[24] === points[24], 'last point kept');
});
check('chunking handles exact multiples, remainders and short routes', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ lat: 39 + i, lng: -77 }));
  assert(chunkSamples(make(18), 9).length === 2, 'exact multiple');
  assert(chunkSamples(make(19), 9).length === 3, 'remainder gets its own chunk');
  assert(chunkSamples(make(19), 9)[2].length === 1, 'remainder chunk holds the leftover');
  assert(chunkSamples(make(4), 9).length === 1, 'short route is one chunk');
  assert(chunkSamples([], 9).length === 0, 'no points, no chunks');
  assert(chunkSamples(null, 9).length === 0, 'null is tolerated');
});
check('the subrequest budget holds for a worst-case route', () => {
  // 2 geocode + 1 routing + 25 Places nearby + 1 Places text, then chunks.
  const googleCalls = 2 + 1 + 25 + 1;
  const chunks = chunkSamples(Array.from({ length: 25 }, () => ({ lat: 39, lng: -77 })), CHUNK_SIZE).length;
  assert(chunks === 7, `expected 7 chunks at size ${CHUNK_SIZE}, got ${chunks}`);
  assert(googleCalls + chunks === 36, `expected 36 typical, got ${googleCalls + chunks}`);
  assert(
    googleCalls + chunks * 2 < 50,
    `worst case ${googleCalls + chunks * 2} must stay under the 50-subrequest cap`
  );
});
check('each chunk queries only its own points', () => {
  const points = [
    { lat: 39.0, lng: -77.0 },
    { lat: 40.0, lng: -76.0 },
  ];
  const [chunk] = chunkSamples(points, 1);
  const query = buildQuery(chunk, 16000);
  assert(query.includes('39.00000,-77.00000'), 'its own point is in the query');
  assert(!query.includes('40.00000'), "the next chunk's point is not");
  assert(query.includes('leisure"="playground'), 'playgrounds still requested');
});

console.log('cross-chunk dedupe');
check('an element returned by two overlapping chunks appears once', () => {
  const shared = { externalId: 'osm-node-1', name: 'Shared Daycare', lat: 39.2, lng: -77.0 };
  const merged = mergeChunkResults([
    { facilities: [shared, { externalId: 'osm-node-2', name: 'A', lat: 39.1, lng: -77 }], playgrounds: [] },
    { facilities: [{ ...shared }, { externalId: 'osm-node-3', name: 'B', lat: 39.3, lng: -77 }], playgrounds: [] },
  ]);
  assert(merged.facilities.length === 3, `expected 3 unique, got ${merged.facilities.length}`);
  assert(merged.facilities.filter((f) => f.externalId === 'osm-node-1').length === 1, 'shared row once');
});
check('playgrounds dedupe across chunks by element id', () => {
  const merged = mergeChunkResults([
    { facilities: [], playgrounds: [{ id: 'osm-way-9', lat: 39.2, lng: -77 }] },
    { facilities: [], playgrounds: [{ id: 'osm-way-9', lat: 39.2, lng: -77 }, { id: 'osm-way-10', lat: 39.3, lng: -77 }] },
  ]);
  assert(merged.playgrounds.length === 2, `expected 2, got ${merged.playgrounds.length}`);
});
check('merging tolerates failed chunks and empty results', () => {
  const merged = mergeChunkResults([
    { facilities: [{ externalId: 'osm-node-1', name: 'Only One', lat: 39.2, lng: -77 }], playgrounds: [] },
    undefined,
    { facilities: [], playgrounds: [] },
  ]);
  assert(merged.facilities.length === 1, 'the surviving chunk still contributes');
  assert(merged.playgrounds.length === 0, 'no playgrounds, no crash');
  const empty = mergeChunkResults([]);
  assert(empty.facilities.length === 0 && empty.playgrounds.length === 0, 'nothing in, nothing out');
});
check('elements split into facilities and playgrounds, ways use their center', () => {
  const { facilities, playgrounds } = splitElements([
    { type: 'node', id: 1, lat: 39.2, lon: -77.0, tags: { amenity: 'childcare', name: 'Little Acorns' } },
    { type: 'way', id: 2, center: { lat: 39.21, lon: -77.01 }, tags: { leisure: 'playground' } },
    { type: 'node', id: 3, lat: 39.22, lon: -77.0, tags: { amenity: 'childcare' } },
    { type: 'node', id: 4, tags: { amenity: 'childcare', name: 'No Coords' } },
  ]);
  assert(facilities.length === 1, `unnamed and coordless rows dropped, got ${facilities.length}`);
  assert(facilities[0].externalId === 'osm-node-1', 'stable external id');
  assert(playgrounds.length === 1 && playgrounds[0].id === 'osm-way-2', 'way playground kept via center');
  assert(playgrounds[0].lat === 39.21, 'center coords used');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
