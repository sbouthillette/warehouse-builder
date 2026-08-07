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
    version: 1,
    warehouse: null, // { id, name, originX:0, originY:0, width, length, height }
    zones: [],        // [{ id, name, x, y, width, length, color, type }]
    bayTemplates: [],  // [{ id, name, upright:{width,depth,height}, beam:{height,width,thickness}, baySpacing, levels:{count, baseHeight, spacing}, maxWeightPerLevelKg }]
    racks: []          // [{ id, name, bayTemplateId, bayCount, x, y, rotation, aisleWidth, maxWeightKg }]
  };
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
    this.notify();
  }

  // ---- Warehouse shell -----------------------------------------------
  setWarehouse({ name, width, length, height }) {
    this.data.warehouse = {
      id: this.data.warehouse?.id || uid('wh'),
      name: name || 'Warehouse',
      originX: 0,
      originY: 0,
      width: Number(width),
      length: Number(length),
      height: Number(height)
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
      color: zone.color || '#4f8ef7',
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
window.WarehouseModel = { uid, emptyProject };
