// Junk classification for the trades. Flags only — the rows stay in D1 and the
// UI's Restore brings a whole category back in one tap. Same bar as
// route-caller: when unsure whether to hide, DON'T.
//
// Two categories, and they are junk for different reasons:
//
// - FRANCHISES already have corporate marketing. Vertizin sells a website to a
//   business that owns its own marketing decisions; a One Hour Heating
//   franchisee does not make that decision.
// - SUPPLIERS AND BIG-BOX RETAIL are not customers at all. Ferguson, Johnstone
//   and Winsupply are where her prospects buy parts — a networking channel, and
//   a different conversation.

import { makeListMatcher, normalizeName } from '../shared/names.js';

/**
 * National trade franchises, as an explicit brand list.
 *
 * NAME PATTERNS ARE NOT SAFE HERE and the deciding evidence is one row:
 * "Roto-Rooter" is a national franchise, "Rooter Man of Athens LLC" is
 * somebody's independent shop. A `/rooter/` pattern flags both, and the second
 * one is exactly the established owner-operated business Vertizin sells to.
 * The same trap sits under "one hour", "benjamin franklin", "aire" and "mr".
 * So this is a list of brands, expanded from real data as route-caller's
 * childcare list was — never a pattern.
 *
 * Seeded from the national trade franchise groups: Neighborly (Mr. Rooter, Aire
 * Serv, Mr. Electric, Mr. Handyman, The Grounds Guys, Window Genie, Rainbow
 * Restoration, Five Star Painting, Precision Garage Door), Authority Brands
 * (Benjamin Franklin Plumbing, One Hour Heating & Air, Mister Sparky), plus
 * Roto-Rooter, ARS/Rescue Rooter, ServiceMaster, ServPro, TruGreen, Terminix
 * and Orkin.
 */
const FRANCHISE_BRANDS = [
  'roto rooter',
  'roto-rooter',
  'mr rooter',
  'mister rooter',
  'rescue rooter',
  'ars rescue',
  'benjamin franklin plumbing',
  'one hour heating',
  'one hour air',
  'aire serv',
  'mister sparky',
  'mr electric',
  'mr handyman',
  'mr appliance',
  'the grounds guys',
  'window genie',
  'rainbow restoration',
  'five star painting',
  'five star bath',
  'precision garage door',
  'precision door service',
  'servicemaster',
  'servpro',
  'trugreen',
  'terminix',
  'orkin',
  'chem dry',
  'chem-dry',
  'stanley steemer',
  'bath fitter',
  're-bath',
  'rebath',
  'molly maid',
  'anytime plumbing franchise',
  '1-800-plumber',
  '1 800 plumber',
  'plumbing paramedics',
  'wind river environmental',
  'zoom drain',
  'drain doctor',
  'best choice roofing',
  'erie home',
  'leaf home',
  'leaffilter',
  'champion windows',
  'renewal by andersen',
  'sears home services',
  'american residential services',
];

export const isTradeFranchise = makeListMatcher(FRANCHISE_BRANDS);

/**
 * Supply houses and big-box retail, by BRAND and by SHAPE.
 *
 * Unlike the franchise list, a shape rule is safe here and worth having,
 * because supply houses announce themselves: a residential HVAC contractor is
 * not named "X HVAC Supply", and a company called "Gulf Coast Plumbing Supply"
 * is not buying a lead-generation website. "Ferguson" alone is deliberately NOT
 * a brand needle — "Ferguson & Sons Heating" is a real independent shop — so
 * the Ferguson entries all carry their trading suffix.
 */
const SUPPLIER_BRANDS = [
  'ferguson plumbing',
  'ferguson bath',
  'ferguson hvac',
  'ferguson waterworks',
  'ferguson enterprises',
  'johnstone supply',
  'winsupply',
  'winnelson',
  'noland company',
  'hajoca',
  'morrison supply',
  'coburn supply',
  'mingledorff',
  'baker distributing',
  'carrier enterprise',
  'united refrigeration',
  'gustave a larson',
  'watsco',
  'abc supply',
  'srs distribution',
  'beacon building products',
  'gulfeagle supply',
  'home depot',
  'lowes home improvement',
  "lowe's home improvement",
  'tractor supply',
  'ace hardware',
  'grainger',
  'menards',
  'harbor freight',
  'sherwin williams',
  'sutherlands',
];

const supplierBrandMatch = makeListMatcher(SUPPLIER_BRANDS);

/** Shapes: a supply house names itself one. */
const SUPPLIER_SHAPES = [
  /\b(plumbing|hvac|heating|cooling|electrical|refrigeration|building|roofing|pipe|waterworks|contractor'?s?)\s+supply\b/i,
  /\bsupply\s+(company|co|house|corp)\b/i,
  /\bwholesale\b/i,
  /\bdistribut(ing|ors?|ion)\b/i,
  /\bbuilding (materials|supplies)\b/i,
];

/**
 * Google types that are unambiguously retail or wholesale. Type-only, and it
 * fails open: a row with no primaryType is kept, exactly as route-caller's
 * deny-list does.
 */
const SUPPLIER_TYPES = new Set([
  'hardware_store',
  'home_improvement_store',
  'wholesaler',
  'warehouse_store',
  'department_store',
  'discount_store',
  'furniture_store',
  'building_materials_supplier',
  'plumbing_supply_store',
  'electrical_supply_store',
]);

export function isSupplierOrRetail(name, primaryType = null) {
  if (SUPPLIER_TYPES.has(primaryType)) return true;
  if (supplierBrandMatch(name)) return true;
  return SUPPLIER_SHAPES.some((re) => re.test(name || ''));
}

/** Exported for the tests and for expanding the lists from real pilot data. */
export const FRANCHISE_BRAND_COUNT = FRANCHISE_BRANDS.length;
export const SUPPLIER_BRAND_COUNT = SUPPLIER_BRANDS.length;
export { normalizeName };
