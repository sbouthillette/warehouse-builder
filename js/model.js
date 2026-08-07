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
    version: 2,
    warehouse: null, // { id, name, height, shape:[{x,y}, ...] } — shape is an ordered polygon outline, metres
    zones: [],        // [{ id, name, x, y, width, length, color, type }]
    bayTemplates: [],  // [{ id, name, upright:{width,depth,height}, beam:{height,width,thickness}, baySpacing, levels:{count, baseHeight, spacing}, maxWeightPerLevelKg }]
    racks: []          // [{ id, name, bayTemplateId, bayCount, x, y, rotation, aisleWidth, maxWeightKg }]
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
    this.notify();
  }

  clearWarehouseShell() {
    this.data.warehouse = null;
    this.data.zones = [];
    this.data.racks = [];
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

  // ---- Bay templates -------------------------------------------------
  addBayTemplate(tpl) {
    const t = {
      id: uid('bay'),
      name: tpl.name || 'Bay Template',
      upright: {
        width: Number(tpl.upright.width),
        depth: Number(tpl.upright.depth),
        height: Number(tpl.upright.height)
      },
      beam: {
        height: Number(tpl.beam.height),
        width: Number(tpl.beam.width),
        thickness: Number(tpl.beam.thickness)
      },
      baySpacing: Number(tpl.baySpacing),
      levels: {
        count: Number(tpl.levels.count),
        baseHeight: Number(tpl.levels.baseHeight),
        spacing: Number(tpl.levels.spacing)
      },
      maxWeightPerLevelKg: Number(tpl.maxWeightPerLevelKg) || 0
    };
    this.data.bayTemplates.push(t);
    this.notify();
    return t;
  }

  updateBayTemplate(id, patch) {
    const t = this.data.bayTemplates.find((tt) => tt.id === id);
    if (!t) return;
    Object.assign(t, patch);
    this.notify();
  }

  deleteBayTemplate(id) {
    this.data.bayTemplates = this.data.bayTemplates.filter((t) => t.id !== id);
    // orphan racks referencing this template are left as-is but will be flagged in UI
    this.notify();
  }

  // ---- Racks -------------------------------------------------------------
  addRack(rack) {
    const r = {
      id: uid('rack'),
      name: rack.name || 'Rack',
      bayTemplateId: rack.bayTemplateId,
      bayCount: Number(rack.bayCount),
      x: Number(rack.x),
      y: Number(rack.y),
      rotation: Number(rack.rotation) || 0, // 0 or 90 degrees
      aisleWidth: Number(rack.aisleWidth) || 0, // metres, gap to next rack in row
      maxWeightKg: Number(rack.maxWeightKg) || 0 // per-bay max weight capacity
    };
    this.data.racks.push(r);
    this.notify();
    return r;
  }

  updateRack(id, patch) {
    const r = this.data.racks.find((rr) => rr.id === id);
    if (!r) return;
    Object.assign(r, patch);
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
      depthM: tpl.upright.depth / 1000,
      heightM: tpl.upright.height / 1000
    };
  }
}

// Export a single shared instance
window.WarehouseStore = new Store();
window.WarehouseModel = { uid, emptyProject, rectanglePoints, lShapePoints, polygonBounds, polygonArea, normalizeWarehouse };