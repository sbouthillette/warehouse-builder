// model.js — Warehouse Builder data model + cloud persistence (Vercel Postgres via /api/warehouses)
// All linear dimensions are stored in millimetres (mm) internally EXCEPT
// warehouse/zone/rack X,Y positions and warehouse width/length/height, which
// are stored in metres (m) since they describe the building footprint.
// Bay/beam/upright dimensions are stored in millimetres since they are
// typically specified that way for racking components.
//
// Each "warehouse" a user builds is a separate row in the `warehouses` table,
// identified by a UUID. The Store below always holds the currently-open
// project's data in memory (this.data) plus its row id (this.currentId), and
// debounces PUT requests to persist edits shortly after they happen.

const API_BASE = '/api/warehouses';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Password lock helpers (SHA-256 via the browser's SubtleCrypto) -------
// Never store the raw password — only a salted digest, so a copy of the
// project JSON (e.g. an exported file) doesn't reveal it in plain text.
async function digestHex(str) {
  const bytes = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyProject() {
  return {
    version: 3,
    // Optional password lock on the whole project — a soft protection
    // against casual browsing/accidental edits, not real access control
    // (there's no server-side auth; the API has no concept of a logged-in
    // user). `locked` gates the app's own UI: opening a locked warehouse
    // prompts for the password before it's shown. passwordHash is a SHA-256
    // digest of `${passwordSalt}:${password}`, never the raw password.
    locked: false,
    passwordHash: null,
    passwordSalt: null,
    warehouse: null, // { id, name, height, shape:[{x,y}, ...] } — shape is an ordered polygon outline, metres
    // zones: [{ id, name, kind, type, x, y, width, length, color, height }]
    //   kind — 'zone' (flat functional area: storage/staging/picking/etc.,
    //     no height, rendered as a flat translucent tint) or 'obstacle' (a
    //     raised physical object — column, fixed equipment — pickers must
    //     route around; rendered as a solid extruded box using `height`, in
    //     metres). `height` is 0/unused for kind:'zone'.
    zones: [],
    // bayTemplates: [{ id, name,
    //   upright: {width, thickness, height} — a single post's own profile (mm)
    //   frameDepth — distance between the front and back post of a frame, i.e. rack depth (mm)
    //   beam: {height, width, thickness},
    //   baySpacing,
    //   levels: { count, baseHeight, spacing, groundLevel },
    //     - groundLevel: true means the bottom level rests directly on the
    //       floor with no beam (baseHeight is ignored); false means the
    //       bottom level is a raised beam at `baseHeight` mm above the floor.
    //     - spacing is the CLEAR OPENING (mm) between consecutive beam faces
    //       — i.e. from the top of one beam (or the floor, for the gap to the
    //       first raised beam) to the bottom of the next one.
    //   maxWeightPerLevelKg }]
    bayTemplates: [],
    // racks: [{ id, name, bayTemplateId, bayCount, x, y, rotation, aisleWidth, maxWeightKg,
    //   bays: [{ id, label, palletCount }] — one entry per bay, in order }]
    racks: [],
    // doors: [{ id, label, wallIndex, offset, width, height, type }]
    //   wallIndex — index into the warehouse shape's edges; edge i runs from
    //     shape[i] to shape[(i+1) % shape.length].
    //   offset — distance (m) along that wall, from its start vertex, to the
    //     door opening's start (near) edge.
    //   width/height — door opening size (m).
    //   type — 'garage' (wide/tall drive-in or dock door) or 'regular' (pedestrian door).
    doors: [],
    // inventory: [{ id, code, rackId, bayIndex, levelIndex, locationIndex,
    //   lpn, contents: [{ partNumber, quantity }] }] — one entry per
    //   OCCUPIED discrete storage location (see Store.listLocations()/
    //   buildLocationCode below for what a location is and how `code` is
    //   derived). `lpn` (License Plate Number) identifies the physical unit
    //   load — pallet/tote/carton — sitting in that location; `contents` is
    //   one or more part-number/quantity lines, since one LPN can be a mixed
    //   pallet carrying several SKUs. Populated by importing an .xlsx
    //   inventory file from the Inventory tab (one spreadsheet row per
    //   content line, grouped by matching Location Code + LPN); simulates a
    //   live ERP/WMS feed without an actual integration. rackId/bayIndex/
    //   levelIndex/locationIndex are resolved at import time by matching
    //   `code` against the model's current locations — if the model changes
    //   later (renamed rack, different bay count) an entry can go stale/
    //   unmatched on the next re-import, but a stale entry already in this
    //   array still renders fine as long as its ids still resolve.
    inventory: []
  };
}

// ---- Polygon shape helpers (shared by model, 2D plan, 3D view, and the shape editor UI) ----

function rectanglePoints(width, length) {
  const W = Number(width) || 0, L = Number(length) || 0;
  return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }];
}

// Produces a 6-point L-shaped outline: a WxL bounding rectangle with a
// notchWidth x notchDepth rectangular notch removed from the given corner.
function lShapePoints(width, length, notchWidth, notchDepth, corner) {
  const W = Number(width) || 0, L = Number(length) || 0;
  const nw = Math.min(Math.max(Number(notchWidth) || 0, 0), Math.max(W - 0.01, 0));
  const nd = Math.min(Math.max(Number(notchDepth) || 0, 0), Math.max(L - 0.01, 0));
  switch (corner) {
    case 'top-left':
      return [
        { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L },
        { x: nw, y: L }, { x: nw, y: L - nd }, { x: 0, y: L - nd }
      ];
    case 'bottom-right':
      return [
        { x: 0, y: 0 }, { x: W - nw, y: 0 }, { x: W - nw, y: nd },
        { x: W, y: nd }, { x: W, y: L }, { x: 0, y: L }
      ];
    case 'bottom-left':
      return [
        { x: nw, y: 0 }, { x: W, y: 0 }, { x: W, y: L },
        { x: 0, y: L }, { x: 0, y: nd }, { x: nw, y: nd }
      ];
    case 'top-right':
    default:
      return [
        { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L - nd },
        { x: W - nw, y: L - nd }, { x: W - nw, y: L }, { x: 0, y: L }
      ];
  }
}

function polygonBounds(points) {
  if (!points || !points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, length: 0 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, length: maxY - minY };
}

// Breaks a polygon outline into its wall edges — edge i runs from
// shape[i] to shape[(i+1) % shape.length] — with each edge's length (m) and
// direction angle (radians, atan2 of dy,dx in warehouse XY space). Shared by
// the Doors UI (wall picker), and the 2D/3D renderers (door placement).
function wallSegments(shape) {
  if (!shape || shape.length < 2) return [];
  return shape.map((p, i) => {
    const p2 = shape[(i + 1) % shape.length];
    const dx = p2.x - p.x, dy = p2.y - p.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    return { index: i, p1: { x: p.x, y: p.y }, p2: { x: p2.x, y: p2.y }, length, angle };
  });
}

// Resolves a door's opening to actual warehouse-space (m) start/end points
// along its wall, clamped to the wall's current length (in case the shell
// was edited after the door was placed). Returns null if the door's wall no
// longer exists. `angle` is the wall's direction (radians), reused for
// rotating the door's visual representation in the 3D view.
function doorPoints(shape, door) {
  const walls = wallSegments(shape);
  const wall = walls[door.wallIndex];
  if (!wall) return null;
  const len = wall.length || 0.0001;
  const t0 = Math.min(Math.max(door.offset, 0), len);
  const t1 = Math.min(Math.max(door.offset + door.width, 0), len);
  const ux = (wall.p2.x - wall.p1.x) / len;
  const uy = (wall.p2.y - wall.p1.y) / len;
  return {
    start: { x: wall.p1.x + ux * t0, y: wall.p1.y + uy * t0 },
    end: { x: wall.p1.x + ux * t1, y: wall.p1.y + uy * t1 },
    mid: { x: wall.p1.x + ux * (t0 + t1) / 2, y: wall.p1.y + uy * (t0 + t1) / 2 },
    angle: wall.angle
  };
}

// Upgrades/sanitizes a door record's field types — used both for freshly
// submitted form payloads and for legacy saved projects that predate a field.
function normalizeDoor(d) {
  if (!d) return d;
  d.wallIndex = Number(d.wallIndex) || 0;
  d.offset = Number(d.offset) || 0;
  d.width = Number(d.width) || 1;
  d.height = Number(d.height) || 2.1;
  d.type = d.type === 'garage' ? 'garage' : 'regular';
  d.label = d.label || (d.type === 'garage' ? 'Garage Door' : 'Door');
  return d;
}

// ---- Rack placement / picking-side geometry helpers -----------------------

// Standard ray-casting point-in-polygon test (m, warehouse space). Points
// exactly on an edge are unreliable with this test alone — see
// pointNearPolygonBoundary below, used alongside it.
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx, py = a.y + t * dy;
  return Math.hypot(pt.x - px, pt.y - py);
}

// True if `pt` sits within `eps` metres of any edge of the polygon —
// treated as "on the boundary" (and therefore acceptable) rather than
// ambiguously in/out, since a rack is often placed flush against a wall.
function pointNearPolygonBoundary(pt, poly, eps) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSegment(pt, poly[j], poly[i]) <= eps) return true;
  }
  return false;
}

// True if segments p1-p2 and p3-p4 cross each other (proper intersection;
// collinear/touching edges are not flagged, which is fine here since flush
// alignment against a wall is expected and handled by the boundary check
// above rather than this crossing test).
function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x); }
  const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Computes the 4 corners (warehouse-space, m, in order) of a rack's
// footprint rectangle from its anchor (x,y — the low corner), rotation
// (0 = length along X, 90 = length along Y) and lengthM/depthM (from
// Store.rackFootprint). Shared by the fits-inside-the-shell check and the
// picking-side edge calculation below.
function rackCorners({ x, y, rotation, lengthM, depthM }) {
  const rot = Number(rotation) === 90;
  const w = rot ? depthM : lengthM;
  const h = rot ? lengthM : depthM;
  const x0 = Number(x) || 0, y0 = Number(y) || 0;
  return [
    { x: x0, y: y0 }, { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }
  ];
}

// True if the given rectangle (4 corners, in order) lies entirely within
// the polygon: every corner is inside it (or right on its boundary), and no
// rectangle edge crosses a polygon edge (catches a rectangle that pokes
// through a concave notch in an L-shaped shell without any corner itself
// leaving the polygon). Used to keep racks fully inside the warehouse shell.
function rectFullyInsidePolygon(corners, polygon) {
  if (!polygon || polygon.length < 3) return false;
  const eps = 0.01; // 1 cm tolerance for "flush against the wall"
  for (const c of corners) {
    if (!pointInPolygon(c, polygon) && !pointNearPolygonBoundary(c, polygon, eps)) return false;
  }
  const polyEdges = wallSegments(polygon);
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    for (const edge of polyEdges) {
      if (segmentsIntersect(a, b, edge.p1, edge.p2)) return false;
    }
  }
  return true;
}

// Resolves a rack's chosen picking side ('north'/'south'/'east'/'west' —
// world-space cardinal directions, independent of the rack's own rotation)
// to the warehouse-space line segment along that edge of its footprint,
// plus the outward-facing unit normal. Used to draw a consistent
// picking-access indicator in both the 2D plan and 3D view.
function rackPickingEdge({ x, y, rotation, lengthM, depthM, pickingSide }) {
  const rot = Number(rotation) === 90;
  const w = rot ? depthM : lengthM;
  const h = rot ? lengthM : depthM;
  const x0 = Number(x) || 0, y0 = Number(y) || 0;
  const x1 = x0 + w, y1 = y0 + h;
  switch (pickingSide) {
    case 'north': return { p1: { x: x0, y: y1 }, p2: { x: x1, y: y1 }, nx: 0, ny: 1 };
    case 'east': return { p1: { x: x1, y: y0 }, p2: { x: x1, y: y1 }, nx: 1, ny: 0 };
    case 'west': return { p1: { x: x0, y: y0 }, p2: { x: x0, y: y1 }, nx: -1, ny: 0 };
    case 'south':
    default: return { p1: { x: x0, y: y0 }, p2: { x: x1, y: y0 }, nx: 0, ny: -1 };
  }
}

// Shoelace formula — absolute area in m² regardless of winding direction.
function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i], p2 = points[(i + 1) % points.length];
    sum += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(sum) / 2;
}

// Upgrades a legacy zone record — predating the Obstacles feature — to have
// the `kind`/`height` fields, defaulting to a flat 'zone' (unchanged
// behavior/appearance) rather than a raised 'obstacle'.
function normalizeZone(z) {
  if (!z) return z;
  if (z.kind !== 'obstacle') z.kind = 'zone';
  if (z.height == null) z.height = 0;
  // Upgrades a legacy zone/obstacle — predating the round-obstacle feature —
  // to have the `shape` field. Only obstacles can be round; flat zones are
  // always rectangular.
  if (z.kind !== 'obstacle' || z.shape !== 'round') z.shape = 'rect';
  return z;
}

// Upgrades a legacy rectangle-only warehouse ({width, length}, no shape) to
// the polygon format, in place. Older saved projects (pre-polygon feature)
// hit this path once when loaded; saving afterwards persists the migration.
function normalizeWarehouse(wh) {
  if (!wh) return wh;
  if (!wh.shape && wh.width != null && wh.length != null) {
    wh.shape = rectanglePoints(wh.width, wh.length);
  }
  return wh;
}

// Generates a default set of bay identifiers, e.g. for a freshly-created
// rack or one that predates the per-bay identifier feature.
function defaultBays(count) {
  const n = Math.max(0, Number(count) || 0);
  return Array.from({ length: n }, (_, i) => ({ id: uid('slot'), label: `Bay ${i + 1}`, palletCount: 1 }));
}

// Generates default location labels for a level with `count` discrete
// pick/pallet locations across its width: a single location gets no label
// (an unlabeled open shelf, today's pre-feature behavior); 2+ locations get
// "A", "B", "C", ... (falling back to numbers past 26).
function generateLocationLabels(count) {
  const n = Math.max(1, Math.round(Number(count)) || 1);
  if (n === 1) return [''];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: n }, (_, i) => (i < letters.length ? letters[i] : String(i + 1)));
}

// Builds the human-readable code that identifies one discrete storage
// location (RACK-BAY-Ln-POSITION), used both for the exported location list
// and to match inventory rows back to a real location on import. Assumes
// rack names and bay labels are kept reasonably unique within the
// warehouse — a real WMS location code has the same assumption.
function slugLocationPart(s) {
  return String(s ?? '').trim().replace(/\s+/g, '').toUpperCase() || 'X';
}
function buildLocationCode(rackName, bayLabel, levelIndex, locationLabel) {
  return `${slugLocationPart(rackName)}-${slugLocationPart(bayLabel)}-L${levelIndex + 1}-${slugLocationPart(locationLabel || '1')}`;
}

// Normalizes one level entry of a bay template's `levels` array.
//   clearHeight — for level 0: height (mm) above the floor to this level's
//     beam (ignored if restsOnFloor); for level i>0: the CLEAR OPENING (mm)
//     between the previous level's beam and this one's — i.e. each level's
//     height is independently configurable, not a single uniform spacing.
//   restsOnFloor — only meaningful for level 0: true means the bottom level
//     sits directly on the floor with no beam.
//   locations — how many discrete pick/pallet locations span this level's
//     width (e.g. 2 for "A"/"B" pallet positions, 5-6 for small-item
//     picking shelves); always >= 1.
//   levelType — 'pallet' (default, matches all pre-existing data): open
//     front/back load beams only, nothing spanning the middle — pallets sit
//     on the beam edges. 'shelf': a continuous solid deck across the full
//     depth, for loose stock/cartons that aren't palletized and need a
//     full supporting surface rather than two edge rails.
function normalizeBayLevel(lv, index) {
  return {
    id: (lv && lv.id) || uid('level'),
    clearHeight: Number(lv && lv.clearHeight) || (index === 0 ? 150 : 1600),
    restsOnFloor: index === 0 ? !!(lv && lv.restsOnFloor) : false,
    locations: Math.max(1, Math.round(Number(lv && lv.locations)) || 1),
    levelType: (lv && lv.levelType === 'shelf') ? 'shelf' : 'pallet'
  };
}

// Upgrades a legacy bay template — where a single "upright" box spanned the
// whole rack depth (upright.depth) — into the front/back-post model: the
// post itself gets a small profile thickness, and the old depth value
// becomes frameDepth (distance between the two posts), which keeps the
// rack's footprint identical to before the migration. Also upgrades a
// legacy `levels` object ({count, baseHeight, spacing, groundLevel} —
// applying uniformly to every level) into the current per-level array,
// preserving the exact same elevations and defaulting every upgraded level
// to a single unlabeled location (matching pre-upgrade behavior exactly).
function normalizeBayTemplate(t) {
  if (!t) return t;
  if (t.frameDepth == null && t.upright && t.upright.depth != null) {
    t.frameDepth = t.upright.depth;
    t.upright = { width: t.upright.width, thickness: 60, height: t.upright.height };
  }
  if (t.levels && !Array.isArray(t.levels)) {
    const old = t.levels;
    const count = Math.max(1, Math.round(Number(old.count)) || 1);
    const levels = [];
    for (let i = 0; i < count; i++) {
      levels.push({
        id: uid('level'),
        clearHeight: i === 0 ? (Number(old.baseHeight) || 0) : (Number(old.spacing) || 0),
        restsOnFloor: i === 0 ? !!old.groundLevel : false,
        locations: 1,
        levelType: 'pallet' // matches pre-upgrade rendering exactly
      });
    }
    t.levels = levels;
  } else if (Array.isArray(t.levels)) {
    t.levels = t.levels.map((lv, i) => normalizeBayLevel(lv, i));
  }
  return t;
}

// Computes the elevation (mm, above the floor) of each level's beam in a bay
// template, from its per-level `clearHeight`/`restsOnFloor`/`locations`
// (see normalizeBayLevel above). Returns one entry per level:
//   { index, bottomY, topY, hasBeam, locations, levelType } — bottomY/topY
//   in mm above the floor; hasBeam is false only for a floor-resting bottom
//   level (no beam/shelf mesh); levelType is 'pallet' or 'shelf'.
function computeLevelElevations(tpl) {
  const levels = Array.isArray(tpl.levels) ? tpl.levels : [];
  const bH = Number(tpl.beam.height) || 0;

  const out = [];
  let prevTop = 0; // top face of the previous support; the floor starts at 0
  levels.forEach((lv, i) => {
    const locations = Math.max(1, Math.round(Number(lv.locations)) || 1);
    const levelType = lv.levelType === 'shelf' ? 'shelf' : 'pallet';
    if (i === 0 && lv.restsOnFloor) {
      out.push({ index: i, bottomY: 0, topY: 0, hasBeam: false, locations, levelType });
      prevTop = 0;
      return;
    }
    const clear = Number(lv.clearHeight) || 0;
    const bottomY = i === 0 ? clear : prevTop + clear;
    const topY = bottomY + bH;
    out.push({ index: i, bottomY, topY, hasBeam: true, locations, levelType });
    prevTop = topY;
  });
  return out;
}

// Ensures a rack has a `bays` array matching its bayCount (generates one for
// racks saved before the per-bay identifier feature, and pads/trims it if
// bayCount was edited without going through the UI's own sync logic).
const PICKING_SIDES = ['north', 'south', 'east', 'west'];

function normalizeRack(r) {
  if (!r) return r;
  const count = Number(r.bayCount) || 0;
  if (!Array.isArray(r.bays)) {
    r.bays = defaultBays(count);
  } else if (r.bays.length !== count) {
    const bays = r.bays.slice(0, count);
    while (bays.length < count) bays.push({ id: uid('slot'), label: `Bay ${bays.length + 1}`, palletCount: 1 });
    r.bays = bays;
  }
  // Legacy racks predate the picking-side feature — default to 'south'
  // (an arbitrary but valid choice) rather than leaving it unset.
  if (!PICKING_SIDES.includes(r.pickingSide)) r.pickingSide = 'south';
  return r;
}

class Store {
  constructor() {
    this.data = emptyProject();
    this.currentId = null;      // UUID of the currently open warehouse row, or null
    this.listeners = [];        // fn(data) — called on any in-memory data change
    this.saveListeners = [];    // fn(state) — 'idle' | 'pending' | 'saving' | 'saved' | 'error'
    this.saveTimer = null;
    this.saveState = 'idle';
  }

  onChange(fn) { this.listeners.push(fn); }
  onSaveState(fn) { this.saveListeners.push(fn); }

  notify() {
    this.listeners.forEach((fn) => fn(this.data));
    this.scheduleSave();
  }

  setSaveState(state) {
    this.saveState = state;
    this.saveListeners.forEach((fn) => fn(state));
  }

  scheduleSave() {
    if (!this.currentId) return; // no row to persist to yet
    this.setSaveState('pending');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 600);
  }

  async persist() {
    if (!this.currentId) return;
    this.setSaveState('saving');
    try {
      const res = await fetch(`${API_BASE}/${this.currentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: this.data })
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      this.setSaveState('saved');
    } catch (e) {
      console.warn('Failed to save warehouse', e);
      this.setSaveState('error');
    }
  }

  // ---- Multi-warehouse project management --------------------------------
  async listWarehouses() {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error(`Failed to list warehouses (${res.status})`);
    return res.json();
  }

  async createWarehouse() {
    const res = await fetch(API_BASE, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to create warehouse (${res.status})`);
    const row = await res.json();
    this.currentId = row.id;
    this.data = { ...emptyProject(), ...row.data };
    this.setSaveState('saved');
    this.listeners.forEach((fn) => fn(this.data));
    return row;
  }

  async loadWarehouse(id) {
    const res = await fetch(`${API_BASE}/${id}`);
    if (!res.ok) throw new Error(`Failed to load warehouse (${res.status})`);
    const row = await res.json();
    this.currentId = row.id;
    this.data = { ...emptyProject(), ...row.data };
    this.data.warehouse = normalizeWarehouse(this.data.warehouse);
    this.data.bayTemplates = (this.data.bayTemplates || []).map(normalizeBayTemplate);
    this.data.racks = (this.data.racks || []).map(normalizeRack);
    this.data.doors = (this.data.doors || []).map(normalizeDoor);
    this.data.zones = (this.data.zones || []).map(normalizeZone);
    this.data.inventory = Array.isArray(this.data.inventory) ? this.data.inventory : [];
    this.setSaveState('saved');
    this.listeners.forEach((fn) => fn(this.data));
    return row;
  }

  async deleteWarehouse(id) {
    if (id === this.currentId && this.isLocked()) return; // safety net — UI disables this button when locked
    const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Failed to delete warehouse (${res.status})`);
    if (this.currentId === id) {
      this.currentId = null;
      this.data = emptyProject();
      this.setSaveState('idle');
      this.listeners.forEach((fn) => fn(this.data));
    }
  }

  // ---- Password lock (see digestHex/randomSaltHex above for caveats) -----
  isLocked() {
    return !!(this.data && this.data.locked);
  }

  async lockProject(password) {
    const salt = randomSaltHex();
    const hash = await digestHex(`${salt}:${password}`);
    this.data.locked = true;
    this.data.passwordHash = hash;
    this.data.passwordSalt = salt;
    this.notify();
  }

  async verifyPassword(password) {
    if (!this.data.passwordHash || !this.data.passwordSalt) return false;
    const hash = await digestHex(`${this.data.passwordSalt}:${password}`);
    return hash === this.data.passwordHash;
  }

  async unlockProject(password) {
    const ok = await this.verifyPassword(password);
    if (!ok) return false;
    this.data.locked = false;
    this.data.passwordHash = null;
    this.data.passwordSalt = null;
    this.notify();
    return true;
  }

  closeWarehouse() {
    this.currentId = null;
    this.data = emptyProject();
    this.setSaveState('idle');
    this.listeners.forEach((fn) => fn(this.data));
  }

  // ---- Export / import (operate on the currently open project) -----------
  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  }

  async importJSON(json) {
    const parsed = JSON.parse(json);
    await this.createWarehouse();
    this.data = { ...emptyProject(), ...parsed };
    this.data.warehouse = normalizeWarehouse(this.data.warehouse);
    this.data.bayTemplates = (this.data.bayTemplates || []).map(normalizeBayTemplate);
    this.data.racks = (this.data.racks || []).map(normalizeRack);
    this.data.doors = (this.data.doors || []).map(normalizeDoor);
    this.data.zones = (this.data.zones || []).map(normalizeZone);
    this.data.inventory = Array.isArray(this.data.inventory) ? this.data.inventory : [];
    this.notify();
  }

  // ---- Warehouse shell -----------------------------------------------
  // shape: ordered array of {x, y} vertices (metres) tracing the outline —
  // supports rectangles, L-shapes, or any irregular/non-90° polygon.
  setWarehouse({ name, height, shape }) {
    if (this.isLocked()) return; // safety net — the UI already disables these controls when locked
    this.data.warehouse = {
      id: this.data.warehouse?.id || uid('wh'),
      name: name || 'Warehouse',
      height: Number(height),
      shape: (shape || []).map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    };
    // Keep doors valid if the shell was edited: drop any whose wall no
    // longer exists (fewer edges than before), and clamp position/width so
    // they still fit within a wall that got shorter.
    const walls = wallSegments(this.data.warehouse.shape);
    this.data.doors = (this.data.doors || [])
      .filter((d) => d.wallIndex < walls.length)
      .map((d) => {
        const wall = walls[d.wallIndex];
        d.width = Math.min(d.width, wall.length);
        const maxOffset = Math.max(0, wall.length - d.width);
        d.offset = Math.min(Math.max(d.offset, 0), maxOffset);
        return d;
      });
    this.notify();
  }

  clearWarehouseShell() {
    if (this.isLocked()) return;
    this.data.warehouse = null;
    this.data.zones = [];
    this.data.racks = [];
    this.data.doors = [];
    this.notify();
  }

  // ---- Zones & Obstacles ---------------------------------------------
  // Normalizes a raw form payload into a correctly-typed zone/obstacle
  // record. Shared by add and update so both paths store consistent types.
  _normalizeZonePayload(zone, existing) {
    const src = (key) => (zone[key] !== undefined ? zone[key] : existing && existing[key]);
    const kind = src('kind') === 'obstacle' ? 'obstacle' : 'zone';
    // Only obstacles can be round (a round column, tank, etc.); flat zones
    // are always rectangular.
    const shape = kind === 'obstacle' && src('shape') === 'round' ? 'round' : 'rect';
    const width = Number(src('width')) || 0;
    // A round obstacle is defined by a single diameter (stored in `width`) —
    // keep `length` in sync with it so any code still treating a zone as a
    // width×length bounding box (legacy exports, table display) sees a
    // sensible square footprint rather than a stale/mismatched value.
    const length = shape === 'round' ? width : (Number(src('length')) || 0);
    return {
      name: src('name') || (kind === 'obstacle' ? 'Obstacle' : 'Zone'),
      kind,
      shape,
      type: src('type') || (kind === 'obstacle' ? 'Column' : 'Storage'),
      x: Number(src('x')) || 0,
      y: Number(src('y')) || 0,
      width,
      length,
      // height only matters for obstacles (raised); flat zones stay at 0.
      height: kind === 'obstacle' ? (Number(src('height')) || 0.1) : 0,
      color: src('color') || (kind === 'obstacle' ? '#5f5e5a' : '#BC5C92')
    };
  }

  addZone(zone) {
    if (this.isLocked()) return null;
    const z = { id: uid('zone'), ...this._normalizeZonePayload(zone, null) };
    this.data.zones.push(z);
    this.notify();
    return z;
  }

  updateZone(id, patch) {
    if (this.isLocked()) return;
    const z = this.data.zones.find((zz) => zz.id === id);
    if (!z) return;
    Object.assign(z, this._normalizeZonePayload(patch, z));
    this.notify();
  }

  deleteZone(id) {
    if (this.isLocked()) return;
    this.data.zones = this.data.zones.filter((z) => z.id !== id);
    this.notify();
  }

  // ---- Doors ---------------------------------------------------------
  // wallIndex references an edge of the current warehouse shape (see
  // wallSegments()); offset/width/height are in metres.
  addDoor(door) {
    if (this.isLocked()) return null;
    const d = normalizeDoor({
      id: uid('door'),
      label: door.label,
      wallIndex: door.wallIndex,
      offset: door.offset,
      width: door.width,
      height: door.height,
      type: door.type
    });
    this.data.doors.push(d);
    this.notify();
    return d;
  }

  updateDoor(id, patch) {
    if (this.isLocked()) return;
    const d = this.data.doors.find((dd) => dd.id === id);
    if (!d) return;
    Object.assign(d, normalizeDoor({ ...d, ...patch }));
    this.notify();
  }

  deleteDoor(id) {
    if (this.isLocked()) return;
    this.data.doors = this.data.doors.filter((d) => d.id !== id);
    this.notify();
  }

  // ---- Bay templates -------------------------------------------------
  // Normalizes a raw form payload (strings/booleans from input elements)
  // into a correctly-typed bay template record. Shared by add and update so
  // both paths store consistent types.
  _normalizeBayPayload(tpl, existing) {
    const src = (key) => (tpl[key] !== undefined ? tpl[key] : existing && existing[key]);
    const upright = tpl.upright || (existing && existing.upright) || {};
    const beam = tpl.beam || (existing && existing.beam) || {};
    const existingUpright = existing ? existing.upright : {};
    const existingBeam = existing ? existing.beam : {};
    const rawLevels = tpl.levels !== undefined ? tpl.levels : ((existing && existing.levels) || []);
    const levels = (Array.isArray(rawLevels) ? rawLevels : []).map((lv, i) => normalizeBayLevel(lv, i));
    return {
      name: src('name') || 'Bay Template',
      upright: {
        width: Number(upright.width !== undefined ? upright.width : existingUpright.width),
        thickness: Number(upright.thickness !== undefined ? upright.thickness : existingUpright.thickness),
        height: Number(upright.height !== undefined ? upright.height : existingUpright.height)
      },
      frameDepth: Number(src('frameDepth')),
      beam: {
        height: Number(beam.height !== undefined ? beam.height : existingBeam.height),
        width: Number(beam.width !== undefined ? beam.width : existingBeam.width),
        thickness: Number(beam.thickness !== undefined ? beam.thickness : existingBeam.thickness)
      },
      baySpacing: Number(src('baySpacing')),
      levels: levels.length ? levels : [normalizeBayLevel({}, 0)],
      maxWeightPerLevelKg: Number(src('maxWeightPerLevelKg')) || 0
    };
  }

  addBayTemplate(tpl) {
    if (this.isLocked()) return null;
    const t = { id: uid('bay'), ...this._normalizeBayPayload(tpl, null) };
    this.data.bayTemplates.push(t);
    this.notify();
    return t;
  }

  updateBayTemplate(id, patch) {
    if (this.isLocked()) return;
    const t = this.data.bayTemplates.find((tt) => tt.id === id);
    if (!t) return;
    Object.assign(t, this._normalizeBayPayload(patch, t));
    this.notify();
  }

  deleteBayTemplate(id) {
    if (this.isLocked()) return;
    this.data.bayTemplates = this.data.bayTemplates.filter((t) => t.id !== id);
    // orphan racks referencing this template are left as-is but will be flagged in UI
    this.notify();
  }

  // ---- Racks -------------------------------------------------------------
  addRack(rack) {
    if (this.isLocked()) return null;
    const bayCount = Number(rack.bayCount);
    const r = {
      id: uid('rack'),
      name: rack.name || 'Rack',
      bayTemplateId: rack.bayTemplateId,
      bayCount,
      x: Number(rack.x),
      y: Number(rack.y),
      rotation: Number(rack.rotation) || 0, // 0 or 90 degrees
      aisleWidth: Number(rack.aisleWidth) || 0, // metres, gap to next rack in row
      maxWeightKg: Number(rack.maxWeightKg) || 0, // per-bay max weight capacity
      // which world-space side (N/S/E/W) pickers access the rack from
      pickingSide: PICKING_SIDES.includes(rack.pickingSide) ? rack.pickingSide : 'south',
      // one identifier per bay opening; the UI keeps this in sync with bayCount
      bays: Array.isArray(rack.bays) && rack.bays.length === bayCount ? rack.bays : defaultBays(bayCount)
    };
    this.data.racks.push(r);
    this.notify();
    return r;
  }

  updateRack(id, patch) {
    if (this.isLocked()) return;
    const r = this.data.racks.find((rr) => rr.id === id);
    if (!r) return;
    Object.assign(r, patch);
    normalizeRack(r); // keep bays[] in sync if bayCount changed without an explicit bays[] patch
    this.notify();
  }

  deleteRack(id) {
    if (this.isLocked()) return;
    this.data.racks = this.data.racks.filter((r) => r.id !== id);
    // drop any inventory that pointed at locations on this rack — they'd
    // otherwise be silent orphans that never render again
    this.data.inventory = (this.data.inventory || []).filter((inv) => inv.rackId !== id);
    this.notify();
  }

  getRackTemplate(rack) {
    return this.data.bayTemplates.find((t) => t.id === rack.bayTemplateId) || null;
  }

  // Computes footprint (in metres) of a rack: { lengthM, depthM, heightM }
  // length = along the row direction (rotation 0 = along X, 90 = along Y)
  rackFootprint(rack) {
    const tpl = this.getRackTemplate(rack);
    if (!tpl) return { lengthM: 0, depthM: 0, heightM: 0 };
    const uprightCount = rack.bayCount + 1;
    const lengthMm = uprightCount * tpl.upright.width + rack.bayCount * tpl.baySpacing;
    return {
      lengthM: lengthMm / 1000,
      depthM: tpl.frameDepth / 1000,
      heightM: tpl.upright.height / 1000
    };
  }

  // ---- Inventory (simulated ERP/WMS occupancy) ---------------------------
  // Flattens every rack currently in the warehouse down to its individual
  // addressable storage locations — one entry per discrete position within
  // a level (an "A"/"B" pallet slot, a single-location shelf, etc.). This is
  // the location master: the Inventory tab exports it as a spreadsheet
  // (Part Number left blank) for someone to fill in and re-import, and
  // re-derives it fresh at import time to match rows back to real
  // rackId/bayIndex/levelIndex/locationIndex by exact `code` match.
  listLocations() {
    const out = [];
    this.data.racks.forEach((rack) => {
      const tpl = this.getRackTemplate(rack);
      if (!tpl) return;
      const levelElevations = computeLevelElevations(tpl);
      for (let bayIndex = 0; bayIndex < rack.bayCount; bayIndex++) {
        const bay = rack.bays && rack.bays[bayIndex];
        const bayLabel = bay ? bay.label : `Bay ${bayIndex + 1}`;
        levelElevations.forEach((lv, levelIndex) => {
          const labels = generateLocationLabels(lv.locations);
          labels.forEach((locationLabel, locationIndex) => {
            out.push({
              code: buildLocationCode(rack.name, bayLabel, levelIndex, locationLabel),
              rackId: rack.id,
              rackName: rack.name,
              bayIndex,
              bayLabel,
              levelIndex,
              levelNumber: levelIndex + 1,
              locationIndex,
              locationLabel: locationLabel || '1',
              levelType: lv.levelType
            });
          });
        });
      }
    });
    return out;
  }

  // Replaces the whole inventory list at once — used after an import, where
  // every row has already been matched/resolved against listLocations().
  setInventory(records) {
    if (this.isLocked()) return;
    this.data.inventory = Array.isArray(records) ? records : [];
    this.notify();
  }

  clearInventory() {
    if (this.isLocked()) return;
    this.data.inventory = [];
    this.notify();
  }
}

// Export a single shared instance
window.WarehouseStore = new Store();
window.WarehouseModel = {
  uid, emptyProject, rectanglePoints, lShapePoints, polygonBounds, polygonArea,
  normalizeWarehouse, normalizeBayTemplate, normalizeRack, defaultBays,
  computeLevelElevations, wallSegments, doorPoints, normalizeDoor, normalizeZone,
  pointInPolygon, rackCorners, rectFullyInsidePolygon, rackPickingEdge,
  generateLocationLabels, normalizeBayLevel
};
