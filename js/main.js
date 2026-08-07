// main.js — app controller: tabs, forms, tables, wiring to model + renderers
(function () {
  const store = window.WarehouseStore;
  let currentTab = 'warehouse';
  let editingZoneId = null;
  let editingBayId = null;
  let editingRackId = null;

  // ---------------- Tabs ----------------
  const tabButtons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tab) {
    currentTab = tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'plan2d' && window.Canvas2D) window.Canvas2D.render();
    if (tab === 'view3d' && window.ThreeView) window.ThreeView.render(store);
  }

  // ---------------- Top bar actions (Export / Import current warehouse) ----------------
  document.getElementById('btnExport').addEventListener('click', () => {
    if (!store.currentId) { alert('No warehouse is open.'); return; }
    const json = store.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const whName = (store.data.warehouse?.name || 'warehouse').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    a.href = url;
    a.download = `${whName}_digital_twin.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('fileImport').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await store.importJSON(reader.result);
        await refreshWarehouseList(store.currentId);
        if (window.Canvas2D) window.Canvas2D.resetView();
      } catch (err) {
        alert('Invalid project file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---------------- Save status indicator ----------------
  const saveStatusEl = document.getElementById('saveStatus');
  store.onSaveState((state) => {
    const map = {
      idle: ['—', ''],
      pending: ['Unsaved changes…', 'var(--text-dim)'],
      saving: ['Saving…', 'var(--text-dim)'],
      saved: ['Saved', 'var(--accent-2)'],
      error: ['Save failed — retrying on next edit', 'var(--danger)']
    };
    const [text, color] = map[state] || map.idle;
    saveStatusEl.textContent = text;
    saveStatusEl.style.color = color;
  });

  // ---------------- Warehouse switcher ----------------
  const picker = document.getElementById('warehousePicker');
  const emptyState = document.getElementById('emptyState');
  const mainLayout = document.getElementById('mainLayout');

  async function refreshWarehouseList(selectId) {
    let list = [];
    try {
      list = await store.listWarehouses();
    } catch (err) {
      console.error(err);
      picker.innerHTML = '<option value="">Unavailable</option>';
      showEmptyState({
        title: 'Can’t reach the database',
        body: 'The /api/warehouses endpoint didn’t respond. Make sure the Postgres database is provisioned and you’re running this via `vercel dev` or a Vercel deployment — the API routes need a server, not a static file host.',
        showCreateButton: false
      });
      return list;
    }
    picker.innerHTML = '';
    list.forEach((w) => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      picker.appendChild(opt);
    });
    const idToSelect = selectId || store.currentId || (list[0] && list[0].id);
    if (idToSelect) picker.value = idToSelect;
    if (list.length === 0) {
      showEmptyState({
        title: 'No warehouses yet',
        body: 'Create your first warehouse to start building its digital twin. It’s saved to your database as you go.',
        showCreateButton: true
      });
    } else {
      toggleEmptyState(false);
    }
    return list;
  }

  function toggleEmptyState(isEmpty) {
    emptyState.hidden = !isEmpty;
    mainLayout.style.display = isEmpty ? 'none' : 'flex';
    document.querySelector('.switcherbar').style.display = isEmpty ? 'none' : 'flex';
  }

  function showEmptyState({ title, body, showCreateButton }) {
    emptyState.querySelector('h2').textContent = title;
    emptyState.querySelector('.hint').textContent = body;
    document.getElementById('btnFirstWarehouse').hidden = !showCreateButton;
    toggleEmptyState(true);
  }

  picker.addEventListener('change', async () => {
    if (!picker.value) return;
    try {
      await store.loadWarehouse(picker.value);
      if (window.Canvas2D) window.Canvas2D.resetView();
      switchTab('warehouse');
    } catch (err) {
      alert('Failed to load warehouse: ' + err.message);
    }
  });

  async function createAndOpenWarehouse() {
    try {
      await store.createWarehouse();
      await refreshWarehouseList(store.currentId);
      toggleEmptyState(false);
      switchTab('warehouse');
    } catch (err) {
      alert('Failed to create warehouse: ' + err.message + '\n\nMake sure the database is provisioned and the app is running via `vercel dev` or is deployed on Vercel (the /api routes need a server).');
    }
  }

  document.getElementById('btnNewWarehouse').addEventListener('click', createAndOpenWarehouse);
  document.getElementById('btnFirstWarehouse').addEventListener('click', createAndOpenWarehouse);

  document.getElementById('btnDeleteWarehouse').addEventListener('click', async () => {
    if (!store.currentId) return;
    const name = store.data.warehouse?.name || 'this warehouse';
    if (!confirm(`Delete "${name}"? This cannot be undone (export first if you want a backup).`)) return;
    const idToDelete = store.currentId;
    await store.deleteWarehouse(idToDelete);
    const list = await refreshWarehouseList();
    if (list.length > 0) {
      await store.loadWarehouse(list[0].id);
      if (window.Canvas2D) window.Canvas2D.resetView();
    }
  });

  // ---------------- Tab 1: Warehouse ----------------
  const formWarehouse = document.getElementById('formWarehouse');
  formWarehouse.addEventListener('submit', (e) => {
    e.preventDefault();
    store.setWarehouse({
      name: document.getElementById('whName').value,
      width: document.getElementById('whWidth').value,
      length: document.getElementById('whLength').value,
      height: document.getElementById('whHeight').value
    });
    if (window.Canvas2D) window.Canvas2D.resetView();
    refreshWarehouseList(store.currentId); // picker label reflects the (possibly renamed) warehouse
  });

  function renderWarehouseSummary() {
    const wh = store.data.warehouse;
    const summary = document.getElementById('warehouseSummary');
    if (!wh) {
      summary.innerHTML = '<em>No warehouse defined yet.</em>';
      return;
    }
    document.getElementById('whName').value = wh.name;
    document.getElementById('whWidth').value = wh.width;
    document.getElementById('whLength').value = wh.length;
    document.getElementById('whHeight').value = wh.height;
    summary.innerHTML = `
      <div><b>${escapeHtml(wh.name)}</b></div>
      <div>Origin: (0, 0) m &nbsp;|&nbsp; Footprint: ${wh.width} m × ${wh.length} m &nbsp;|&nbsp; Clear height: ${wh.height} m</div>
      <div>Floor area: ${(wh.width * wh.length).toLocaleString()} m²</div>
    `;
  }

  // ---------------- Tab 2: Zones ----------------
  const formZone = document.getElementById('formZone');
  formZone.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('zoneName').value,
      type: document.getElementById('zoneType').value,
      x: document.getElementById('zoneX').value,
      y: document.getElementById('zoneY').value,
      width: document.getElementById('zoneWidth').value,
      length: document.getElementById('zoneLength').value,
      color: document.getElementById('zoneColor').value
    };
    if (editingZoneId) {
      store.updateZone(editingZoneId, payload);
      editingZoneId = null;
      formZone.querySelector('button[type=submit]').textContent = 'Add Zone';
    } else {
      store.addZone(payload);
    }
    formZone.reset();
    document.getElementById('zoneColor').value = '#4f8ef7';
  });

  function renderZonesGate() {
    const wh = store.data.warehouse;
    document.getElementById('zonesGate').classList.toggle('show', !wh);
    document.getElementById('zonesGate').textContent = 'Define the warehouse shell (Tab 1) before adding zones.';
    document.getElementById('zonesUI').hidden = !wh;
  }

  function renderZonesTable() {
    const tbody = document.querySelector('#zonesTable tbody');
    tbody.innerHTML = '';
    store.data.zones.forEach((z) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="swatch" style="background:${z.color}"></span>${escapeHtml(z.name)}</td>
        <td>${escapeHtml(z.type)}</td>
        <td>${z.x}</td><td>${z.y}</td><td>${z.width}</td><td>${z.length}</td>
        <td>
          <button class="icon-btn" data-act="edit" data-id="${z.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${z.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Delete this zone?')) store.deleteZone(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => {
      const z = store.data.zones.find((zz) => zz.id === b.dataset.id);
      if (!z) return;
      editingZoneId = z.id;
      document.getElementById('zoneName').value = z.name;
      document.getElementById('zoneType').value = z.type;
      document.getElementById('zoneX').value = z.x;
      document.getElementById('zoneY').value = z.y;
      document.getElementById('zoneWidth').value = z.width;
      document.getElementById('zoneLength').value = z.length;
      document.getElementById('zoneColor').value = z.color;
      formZone.querySelector('button[type=submit]').textContent = 'Update Zone';
      formZone.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Tab 3: Bay Builder ----------------
  const formBay = document.getElementById('formBay');
  formBay.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('bayName').value,
      upright: {
        width: document.getElementById('uprightWidth').value,
        depth: document.getElementById('uprightDepth').value,
        height: document.getElementById('uprightHeight').value
      },
      beam: {
        height: document.getElementById('beamHeight').value,
        width: document.getElementById('beamWidth').value,
        thickness: document.getElementById('beamThickness').value
      },
      baySpacing: document.getElementById('baySpacing').value,
      levels: {
        count: document.getElementById('levelCount').value,
        baseHeight: document.getElementById('levelBase').value,
        spacing: document.getElementById('levelSpacing').value
      },
      maxWeightPerLevelKg: document.getElementById('bayMaxWeight').value
    };
    if (editingBayId) {
      store.updateBayTemplate(editingBayId, payload);
      editingBayId = null;
      formBay.querySelector('button[type=submit]').textContent = 'Save Bay Template';
    } else {
      store.addBayTemplate(payload);
    }
    formBay.reset();
    // restore sensible defaults after reset
    document.getElementById('uprightWidth').value = 90;
    document.getElementById('uprightDepth').value = 900;
    document.getElementById('uprightHeight').value = 7000;
    document.getElementById('beamHeight').value = 100;
    document.getElementById('beamWidth').value = 2700;
    document.getElementById('beamThickness').value = 50;
    document.getElementById('baySpacing').value = 2700;
    document.getElementById('levelCount').value = 4;
    document.getElementById('levelBase').value = 150;
    document.getElementById('levelSpacing').value = 1600;
    document.getElementById('bayMaxWeight').value = 1000;
  });

  function renderBayTable() {
    const tbody = document.querySelector('#bayTable tbody');
    tbody.innerHTML = '';
    store.data.bayTemplates.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(t.name)}</td>
        <td>${t.upright.width}×${t.upright.depth}×${t.upright.height}</td>
        <td>${t.beam.height}×${t.beam.width}×${t.beam.thickness}</td>
        <td>${t.baySpacing} mm</td>
        <td>${t.levels.count} (base ${t.levels.baseHeight}, step ${t.levels.spacing})</td>
        <td>${t.maxWeightPerLevelKg}</td>
        <td>
          <button class="icon-btn" data-act="edit" data-id="${t.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${t.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Delete this bay template? Racks using it will keep referencing it but show as unresolved.')) store.deleteBayTemplate(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => {
      const t = store.data.bayTemplates.find((tt) => tt.id === b.dataset.id);
      if (!t) return;
      editingBayId = t.id;
      document.getElementById('bayName').value = t.name;
      document.getElementById('uprightWidth').value = t.upright.width;
      document.getElementById('uprightDepth').value = t.upright.depth;
      document.getElementById('uprightHeight').value = t.upright.height;
      document.getElementById('beamHeight').value = t.beam.height;
      document.getElementById('beamWidth').value = t.beam.width;
      document.getElementById('beamThickness').value = t.beam.thickness;
      document.getElementById('baySpacing').value = t.baySpacing;
      document.getElementById('levelCount').value = t.levels.count;
      document.getElementById('levelBase').value = t.levels.baseHeight;
      document.getElementById('levelSpacing').value = t.levels.spacing;
      document.getElementById('bayMaxWeight').value = t.maxWeightPerLevelKg;
      formBay.querySelector('button[type=submit]').textContent = 'Update Bay Template';
      formBay.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Tab 4: Racks ----------------
  const formRack = document.getElementById('formRack');
  const rackTemplateSelect = document.getElementById('rackBayTemplate');

  formRack.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('rackName').value,
      bayTemplateId: rackTemplateSelect.value,
      bayCount: document.getElementById('rackBayCount').value,
      rotation: document.getElementById('rackRotation').value,
      x: document.getElementById('rackX').value,
      y: document.getElementById('rackY').value,
      aisleWidth: document.getElementById('rackAisle').value,
      maxWeightKg: document.getElementById('rackMaxWeight').value
    };
    if (editingRackId) {
      store.updateRack(editingRackId, payload);
      editingRackId = null;
      formRack.querySelector('button[type=submit]').textContent = 'Add Rack';
    } else {
      store.addRack(payload);
    }
  });

  document.getElementById('btnAutoRow').addEventListener('click', () => {
    const last = store.data.racks[store.data.racks.length - 1];
    if (!last) { alert('Add at least one rack first, then use auto-place.'); return; }
    const fp = store.rackFootprint(last);
    if (last.rotation === 0 || Number(last.rotation) === 0) {
      document.getElementById('rackX').value = round2(last.x + fp.lengthM);
      document.getElementById('rackY').value = last.y;
    } else {
      document.getElementById('rackX').value = last.x;
      document.getElementById('rackY').value = round2(last.y + fp.lengthM);
    }
    document.getElementById('rackRotation').value = String(last.rotation);
  });

  document.getElementById('btnAutoNewRow').addEventListener('click', () => {
    const last = store.data.racks[store.data.racks.length - 1];
    if (!last) { alert('Add at least one rack first, then use auto-place.'); return; }
    const fp = store.rackFootprint(last);
    const aisle = Number(last.aisleWidth) || 0;
    if (Number(last.rotation) === 0) {
      document.getElementById('rackX').value = last.x;
      document.getElementById('rackY').value = round2(last.y + fp.depthM + aisle);
    } else {
      document.getElementById('rackX').value = round2(last.x + fp.depthM + aisle);
      document.getElementById('rackY').value = last.y;
    }
    document.getElementById('rackRotation').value = String(last.rotation);
  });

  function round2(n) { return Math.round(n * 100) / 100; }

  function renderRackTemplateOptions() {
    const current = rackTemplateSelect.value;
    rackTemplateSelect.innerHTML = '';
    store.data.bayTemplates.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      rackTemplateSelect.appendChild(opt);
    });
    if (current) rackTemplateSelect.value = current;
  }

  function renderRacksGate() {
    const hasTpl = store.data.bayTemplates.length > 0;
    document.getElementById('racksGate').classList.toggle('show', !hasTpl);
    document.getElementById('racksGate').textContent = 'Create at least one Bay Template (Tab 3) before building racks.';
    document.getElementById('racksUI').hidden = !hasTpl;
  }

  function renderRacksTable() {
    const tbody = document.querySelector('#racksTable tbody');
    tbody.innerHTML = '';
    store.data.racks.forEach((r) => {
      const tpl = store.getRackTemplate(r);
      const fp = store.rackFootprint(r);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td>${tpl ? escapeHtml(tpl.name) : '<em>missing</em>'}</td>
        <td>${r.bayCount}</td>
        <td>${fp.lengthM.toFixed(2)} × ${fp.depthM.toFixed(2)} × ${fp.heightM.toFixed(2)}</td>
        <td>${r.x}, ${r.y}</td>
        <td>${r.rotation}°</td>
        <td>${r.aisleWidth}</td>
        <td>${r.maxWeightKg}</td>
        <td>
          <button class="icon-btn" data-act="edit" data-id="${r.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${r.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Delete this rack?')) store.deleteRack(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => {
      const r = store.data.racks.find((rr) => rr.id === b.dataset.id);
      if (!r) return;
      editingRackId = r.id;
      document.getElementById('rackName').value = r.name;
      rackTemplateSelect.value = r.bayTemplateId;
      document.getElementById('rackBayCount').value = r.bayCount;
      document.getElementById('rackRotation').value = r.rotation;
      document.getElementById('rackX').value = r.x;
      document.getElementById('rackY').value = r.y;
      document.getElementById('rackAisle').value = r.aisleWidth;
      document.getElementById('rackMaxWeight').value = r.maxWeightKg;
      formRack.querySelector('button[type=submit]').textContent = 'Update Rack';
      formRack.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Legend (2D tab) ----------------
  function renderLegend() {
    const legend = document.getElementById('planLegend');
    legend.innerHTML = `
      <span class="chip"><span class="swatch" style="background:#4f8ef7"></span>Warehouse outline</span>
      <span class="chip"><span class="swatch" style="background:#f7c56a"></span>Racks</span>
      <span class="chip">Zones shown in their own color</span>
    `;
  }

  // ---------------- helpers ----------------
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- global re-render on any data change ----------------
  function renderAll() {
    renderWarehouseSummary();
    renderZonesGate();
    renderZonesTable();
    renderBayTable();
    renderRackTemplateOptions();
    renderRacksGate();
    renderRacksTable();
    renderLegend();
    if (currentTab === 'plan2d' && window.Canvas2D) window.Canvas2D.render();
    if (currentTab === 'view3d' && window.ThreeView) window.ThreeView.render(store);
  }

  store.onChange(renderAll);
  renderAll();

  // ---------------- Startup: load the warehouse list, open the most recent ----------------
  (async function init() {
    const list = await refreshWarehouseList();
    if (list.length > 0) {
      try {
        await store.loadWarehouse(list[0].id);
        if (window.Canvas2D) window.Canvas2D.resetView();
      } catch (err) {
        console.error(err);
      }
    }
  })();
})();
