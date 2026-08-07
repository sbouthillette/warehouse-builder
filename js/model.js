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

function emptyProject() {
  return {
    version: 3,
    warehouse: null, // { id, name, height, shape:[{x,y}, ...] } — shape is an ordered polygon outline, metres
    zones: [],        // [{ id, name, x, y, width, length, color, type }]
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
    doors: []
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

// Upgrades a legacy bay template — where a single "upright" box spanned the
// whole rack depth (upright.depth) — into the front/back-post model: the
// post itself gets a small profile thickness, and the old depth value
// becomes frameDepth (distance between the two posts), which keeps the
// rack's footprint identical to before the migration.
function normalizeBayTemplate(t) {
  if (!t) return t;
  if (t.frameDepth == null && t.upright && t.upright.depth != null) {
    t.frameDepth = t.upright.depth;
    t.upright = { width: t.upright.width, thickness: 60, height: t.upright.height };
  }
  // Legacy templates predate the "ground level" option — default them to a
  // raised bottom level (their original behavior) rather than floor-resting.
  if (t.levels && t.levels.groundLevel == null) {
    t.levels.groundLevel = false;
  }
  return t;
}

// Computes the elevation (mm, above the floor) of each level's beam in a bay
// template. `levels.spacing` is the CLEAR OPENING between consecutive beam
// faces (and between the floor and the first raised beam, when the bottom
// level rests on the floor) — not a center-to-center or bottom-to-bottom
// distance. Returns one entry per level:
//   { index, bottomY, topY, hasBeam } — bottomY/topY in mm above the floor;
//   hasBeam is false only for a floor-resting bottom level (no beam mesh).
function computeLevelElevations(tpl) {
  const count = Math.max(1, Math.round(Number(tpl.levels.count)) || 1);
  const bH = Number(tpl.beam.height) || 0;
  const spacing = Number(tpl.levels.spacing) || 0;
  const baseHeight = Number(tpl.levels.baseHeight) || 0;
  const groundLevel = !!tpl.levels.groundLevel;

  const out = [];
  let prevTop = 0; // top face of the previous support; the floor starts at 0
  for (let i = 0; i < count; i++) {
    if (i === 0 && groundLevel) {
      out.push({ index: i, bottomY: 0, topY: 0, hasBeam: false });
      prevTop = 0;
      continue;
    }
    const bottomY = i === 0 ? baseHeight : prevTop + spacing;
    const topY = bottomY + bH;
    out.push({ index: i, bottomY, topY, hasBeam: true });
    prevTop = topY;
  }
  return out;
}

// Ensures a rack has a `bays` array matching its bayCount (generates one for
// racks saved before the per-bay identifier feature, and pads/trims it if
// bayCount was edited without going through the UI's own sync logic).
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
    this.setSaveState('saved');
    this.listeners.forEach((fn) => fn(this.data));
    return row;
  }

  async deleteWarehouse(id) {
    const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Failed to delete warehouse (${res.status})`);
    if (this.currentId === id) {
      this.currentId = null;
      this.data = emptyProject();
      this.setSaveState('idle');
      this.listeners.forEach((fn) => fn(this.data));
    }
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
    this.notify();
  }

  // ---- Warehouse shell -----------------------------------------------
  // shape: ordered array of {x, y} vertices (metres) tracing the outline —
  // supports rectangles, L-shapes, or any irregular/non-90° polygon.
  setWarehouse({ name, height, shape }) {
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
    this.data.warehouse = null;
    this.data.zones = [];
    this.data.racks = [];
    this.data.doors = [];
    this.notify();
  }

  // ---- Zones -------------------------------------------------------------
  addZone(zone) {
    const z = {
      id: uid('zone'),
      name: zone.name || 'Zone',
      x: Number(zone.x),
      y: Number(zone.y),
      width: Number(zone.width),
      length: Number(zone.length),
      color: zone.color || '#BC5C92',
      type: zone.type || 'Storage'
    };
    this.data.zones.push(z);
    this.notify();
    return z;
  }

  updateZone(id, patch) {
    const z = this.data.zones.find((zz) => zz.id === id);
    if (!z) return;
    Object.assign(z, patch);
    this.notify();
  }

  deleteZone(id) {
    this.data.zones = this.data.zones.filter((z) => z.id !== id);
    this.notify();
  }

  // ---- Doors ---------------------------------------------------------
  // wallIndex references an edge of the current warehouse shape (see
  // wallSegments()); offset/width/height are in metres.
  addDoor(door) {
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
    const d = this.data.doors.find((dd) => dd.id === id);
    if (!d) return;
    Object.assign(d, normalizeDoor({ ...d, ...patch }));
    this.notify();
  }

  deleteDoor(id) {
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
    const levels = tpl.levels || (existing && existing.levels) || {};
    const existingUpright = existing ? existing.upright : {};
    const existingBeam = existing ? existing.beam : {};
    const existingLevels = existing ? existing.levels : {};
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
      levels: {
        count: Number(levels.count !== undefined ? levels.count : existingLevels.count),
        baseHeight: Number(levels.baseHeight !== undefined ? levels.baseHeight : existingLevels.baseHeight) || 0,
        spacing: Number(levels.spacing !== undefined ? levels.spacing : existingLevels.spacing),
        groundLevel: !!(levels.groundLevel !== undefined ? levels.groundLevel : existingLevels.groundLevel)
      },
      maxWeightPerLevelKg: Number(src('maxWeightPerLevelKg')) || 0
    };
  }

  addBayTemplate(tpl) {
    const t = { id: uid('bay'), ...this._normalizeBayPayload(tpl, null) };
    this.data.bayTemplates.push(t);
    this.notify();
    return t;
  }

  updateBayTemplate(id, patch) {
    const t = this.data.bayTemplates.find((tt) => tt.id === id);
    if (!t) return;
    Object.assign(t, this._normalizeBayPayload(patch, t));
    this.notify();
  }

  deleteBayTemplate(id) {
    this.data.bayTemplates = this.data.bayTemplates.filter((t) => t.id !== id);
    // orphan racks referencing this template are left as-is but will be flagged in UI
    this.notify();
  }

  // ---- Racks -------------------------------------------------------------
  addRack(rack) {
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
      // one identifier per bay opening; the UI keeps this in sync with bayCount
      bays: Array.isArray(rack.bays) && rack.bays.length === bayCount ? rack.bays : defaultBays(bayCount)
    };
    this.data.racks.push(r);
    this.notify();
    return r;
  }

  updateRack(id, patch) {
    const r = this.data.racks.find((rr) => rr.id === id);
    if (!r) return;
    Object.assign(r, patch);
    normalizeRack(r); // keep bays[] in sync if bayCount changed without an explicit bays[] patch
    this.notify();
  }

  deleteRack(id) {
    this.data.racks = this.data.racks.filter((r) => r.id !== id);
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
}

// Export a single shared instance
window.WarehouseStore = new Store();
window.WarehouseModel = {
  uid, emptyProject, rectanglePoints, lShapePoints, polygonBounds, polygonArea,
  normalizeWarehouse, normalizeBayTemplate, normalizeRack, defaultBays,
  computeLevelElevations, wallSegments, doorPoints, normalizeDoor
};
