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
    if (tab === 'warehouse') renderShapePreview(); // function declaration below is hoisted within this closure
    if (tab === 'bays') renderBayPreview(); // function declaration below is hoisted within this closure
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
        resetWarehouseFormFromStore();
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
      pending: ['Unsaved changes…', 'var(--ink-secondary)'],
      saving: ['Saving…', 'var(--ink-secondary)'],
      saved: ['Saved', 'var(--status-success-text)'],
      error: ['Save failed — retrying on next edit', 'var(--status-danger-text)']
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
      resetWarehouseFormFromStore();
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
      resetWarehouseFormFromStore();
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
      resetWarehouseFormFromStore();
      if (window.Canvas2D) window.Canvas2D.resetView();
    }
  });

  // ---------------- Tab 1: Warehouse Shell (polygon outline editor) ----------------
  const Model = window.WarehouseModel;
  let draftShape = Model.rectanglePoints(50, 30); // in-progress, unsaved outline being edited

  function defaultDraftShape() {
    return Model.rectanglePoints(50, 30);
  }

  // Pulls the currently-open warehouse's saved shape into the draft editor.
  // Only called when a *different* warehouse is loaded/created — never on
  // routine store updates — so it doesn't clobber in-progress edits.
  function resetWarehouseFormFromStore() {
    const wh = store.data.warehouse;
    document.getElementById('whName').value = wh?.name || '';
    document.getElementById('whHeight').value = wh?.height ?? 10;
    draftShape = wh?.shape ? wh.shape.map((p) => ({ x: p.x, y: p.y })) : defaultDraftShape();
    renderVertexTable();
    renderShapePreview();
  }

  function renderVertexTable() {
    const tbody = document.querySelector('#vertexTable tbody');
    tbody.innerHTML = '';
    draftShape.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><input type="number" step="0.01" class="vx" value="${p.x}" /></td>
        <td><input type="number" step="0.01" class="vy" value="${p.y}" /></td>
        <td>
          <button class="icon-btn" data-act="up" title="Move up">↑</button>
          <button class="icon-btn" data-act="down" title="Move down">↓</button>
          <button class="icon-btn" data-act="del" title="Remove point">✕</button>
        </td>`;
      tbody.appendChild(tr);

      tr.querySelector('.vx').addEventListener('input', (e) => {
        draftShape[i].x = Number(e.target.value) || 0;
        renderShapePreview();
      });
      tr.querySelector('.vy').addEventListener('input', (e) => {
        draftShape[i].y = Number(e.target.value) || 0;
        renderShapePreview();
      });
      tr.querySelector('[data-act="up"]').addEventListener('click', () => {
        if (i === 0) return;
        [draftShape[i - 1], draftShape[i]] = [draftShape[i], draftShape[i - 1]];
        renderVertexTable(); renderShapePreview();
      });
      tr.querySelector('[data-act="down"]').addEventListener('click', () => {
        if (i === draftShape.length - 1) return;
        [draftShape[i + 1], draftShape[i]] = [draftShape[i], draftShape[i + 1]];
        renderVertexTable(); renderShapePreview();
      });
      tr.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (draftShape.length <= 3) { alert('A shape needs at least 3 points.'); return; }
        draftShape.splice(i, 1);
        renderVertexTable(); renderShapePreview();
      });
    });
  }

  function renderShapePreview() {
    const canvas = document.getElementById('shapePreview');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (draftShape.length < 2) return;

    const bounds = Model.polygonBounds(draftShape);
    const pad = 30;
    const scale = Math.max(0.01, Math.min((w - pad * 2) / (bounds.width || 1), (h - pad * 2) / (bounds.length || 1)));
    const toScreen = (p) => ({
      sx: pad + (p.x - bounds.minX) * scale,
      sy: h - pad - (p.y - bounds.minY) * scale
    });

    ctx.beginPath();
    draftShape.forEach((p, i) => {
      const s = toScreen(p);
      if (i === 0) ctx.moveTo(s.sx, s.sy); else ctx.lineTo(s.sx, s.sy);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(201,126,13,0.18)'; // primary-2 tint
    ctx.fill();
    ctx.strokeStyle = '#C97E0D'; // primary-2
    ctx.lineWidth = 2;
    ctx.stroke();

    draftShape.forEach((p, i) => {
      const s = toScreen(p);
      ctx.fillStyle = '#F2A93C'; // primary
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5f5e5a'; // ink-secondary
      ctx.font = '10px sans-serif';
      ctx.fillText(String(i + 1), s.sx + 6, s.sy - 6);
    });

    if (bounds.minX <= 0 && 0 <= bounds.maxX && bounds.minY <= 0 && 0 <= bounds.maxY) {
      const s = toScreen({ x: 0, y: 0 });
      ctx.fillStyle = '#E2572E'; // secondary-2
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  document.getElementById('btnAddVertex').addEventListener('click', () => {
    const last = draftShape[draftShape.length - 1] || { x: 0, y: 0 };
    draftShape.push({ x: last.x, y: last.y });
    renderVertexTable(); renderShapePreview();
  });

  document.getElementById('btnGenRect').addEventListener('click', () => {
    const w = Number(document.getElementById('genRectWidth').value) || 1;
    const l = Number(document.getElementById('genRectLength').value) || 1;
    draftShape = Model.rectanglePoints(w, l);
    renderVertexTable(); renderShapePreview();
  });

  document.getElementById('btnGenL').addEventListener('click', () => {
    const w = Number(document.getElementById('genLWidth').value) || 1;
    const l = Number(document.getElementById('genLLength').value) || 1;
    const nw = Number(document.getElementById('genLNotchWidth').value) || 0;
    const nd = Number(document.getElementById('genLNotchDepth').value) || 0;
    const corner = document.getElementById('genLCorner').value;
    draftShape = Model.lShapePoints(w, l, nw, nd, corner);
    renderVertexTable(); renderShapePreview();
  });

  document.getElementById('btnSaveWarehouse').addEventListener('click', () => {
    if (draftShape.length < 3) { alert('A shape needs at least 3 points.'); return; }
    store.setWarehouse({
      name: document.getElementById('whName').value || 'Warehouse',
      height: document.getElementById('whHeight').value,
      shape: draftShape
    });
    if (window.Canvas2D) window.Canvas2D.resetView();
    refreshWarehouseList(store.currentId); // picker label reflects the (possibly renamed) warehouse
  });

  function renderWarehouseSummary() {
    const wh = store.data.warehouse;
    const summary = document.getElementById('warehouseSummary');
    if (!wh) {
      summary.innerHTML = '<em>No warehouse shell saved yet — build one above.</em>';
      return;
    }
    const bounds = Model.polygonBounds(wh.shape);
    const area = Model.polygonArea(wh.shape);
    summary.innerHTML = `
      <div><b>${escapeHtml(wh.name)}</b></div>
      <div>${wh.shape.length}-point outline &nbsp;|&nbsp; Bounding box: ${bounds.width.toFixed(1)} m × ${bounds.length.toFixed(1)} m &nbsp;|&nbsp; Clear height: ${wh.height} m</div>
      <div>Floor area: ${area.toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</div>
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
    document.getElementById('zoneColor').value = '#BC5C92';
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
  let lastSavedBayId = null; // used to scroll/highlight the saved row in the table below
  formBay.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: document.getElementById('bayName').value,
        upright: {
          width: document.getElementById('uprightWidth').value,
          thickness: document.getElementById('uprightThickness').value,
          height: document.getElementById('uprightHeight').value
        },
        frameDepth: document.getElementById('frameDepth').value,
        beam: {
          height: document.getElementById('beamHeight').value,
          width: document.getElementById('beamWidth').value,
          thickness: document.getElementById('beamThickness').value
        },
        baySpacing: document.getElementById('baySpacing').value,
        levels: {
          count: document.getElementById('levelCount').value,
          baseHeight: document.getElementById('levelBase').value,
          spacing: document.getElementById('levelSpacing').value,
          groundLevel: document.getElementById('levelGroundLevel').checked
        },
        maxWeightPerLevelKg: document.getElementById('bayMaxWeight').value
      };
      if (editingBayId) {
        store.updateBayTemplate(editingBayId, payload);
        lastSavedBayId = editingBayId;
        editingBayId = null;
        formBay.querySelector('button[type=submit]').textContent = 'Save Bay Template';
      } else {
        const created = store.addBayTemplate(payload);
        lastSavedBayId = created.id;
      }
      formBay.reset();
      // restore sensible defaults after reset
      document.getElementById('uprightWidth').value = 90;
      document.getElementById('uprightThickness').value = 60;
      document.getElementById('uprightHeight').value = 7000;
      document.getElementById('frameDepth').value = 900;
      document.getElementById('beamHeight').value = 100;
      document.getElementById('beamWidth').value = 2700;
      document.getElementById('beamThickness').value = 50;
      document.getElementById('baySpacing').value = 2700;
      document.getElementById('levelCount').value = 4;
      document.getElementById('levelBase').value = 150;
      document.getElementById('levelSpacing').value = 1600;
      document.getElementById('levelGroundLevel').checked = false;
      document.getElementById('bayMaxWeight').value = 1000;
      updateLevelBaseFieldState();
      renderBayPreview();
      // Visible confirmation: the saved-templates table lives below the fold
      // (under the split-editor row), so without this, saving can look like
      // nothing happened even though it worked.
      requestAnimationFrame(() => {
        const row = document.querySelector(`#bayTable tbody tr[data-id="${lastSavedBayId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('row-flash');
          setTimeout(() => row.classList.remove('row-flash'), 1500);
        }
      });
    } catch (err) {
      console.error('Failed to save bay template', err);
      alert('Could not save the bay template: ' + err.message);
    }
  });

  // Base Level Height only applies when the bottom level is a raised beam —
  // grey it out (and skip it in the draft/payload math) when the bottom
  // level is set to rest directly on the floor instead.
  function updateLevelBaseFieldState() {
    const grounded = document.getElementById('levelGroundLevel').checked;
    document.getElementById('levelBase').disabled = grounded;
  }
  document.getElementById('levelGroundLevel').addEventListener('change', () => {
    updateLevelBaseFieldState();
    renderBayPreview();
  });
  updateLevelBaseFieldState();

  // Reads the current (unsaved) Bay Builder form values into a plain object
  // shaped like a bay template, for live 3D preview as the user types.
  function getDraftBayTemplate() {
    const num = (id, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
      upright: {
        width: num('uprightWidth', 90),
        thickness: num('uprightThickness', 60),
        height: num('uprightHeight', 7000)
      },
      frameDepth: num('frameDepth', 900),
      beam: {
        height: num('beamHeight', 100),
        width: num('beamWidth', 2700),
        thickness: num('beamThickness', 50)
      },
      baySpacing: num('baySpacing', 2700),
      levels: {
        count: Math.max(1, Math.round(num('levelCount', 4))),
        baseHeight: num('levelBase', 150) || 0,
        spacing: num('levelSpacing', 1600),
        groundLevel: document.getElementById('levelGroundLevel').checked
      }
    };
  }

  function renderBayPreview() {
    if (window.BayPreview3D) window.BayPreview3D.render(getDraftBayTemplate());
  }

  const bayLiveFields = [
    'uprightWidth', 'uprightThickness', 'uprightHeight', 'frameDepth',
    'beamHeight', 'beamWidth', 'beamThickness',
    'baySpacing', 'levelCount', 'levelBase', 'levelSpacing'
  ];
  bayLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderBayPreview);
  });

  // Populates the form with an existing template's values (used by both the
  // name-cell click, for a quick look, and the edit button). `enterEditMode`
  // controls whether Save Bay Template will overwrite this template (edit)
  // or just leave the values loaded for viewing/tweaking into a new one.
  function loadBayTemplateIntoForm(t, enterEditMode) {
    document.getElementById('bayName').value = t.name;
    document.getElementById('uprightWidth').value = t.upright.width;
    document.getElementById('uprightThickness').value = t.upright.thickness;
    document.getElementById('uprightHeight').value = t.upright.height;
    document.getElementById('frameDepth').value = t.frameDepth;
    document.getElementById('beamHeight').value = t.beam.height;
    document.getElementById('beamWidth').value = t.beam.width;
    document.getElementById('beamThickness').value = t.beam.thickness;
    document.getElementById('baySpacing').value = t.baySpacing;
    document.getElementById('levelCount').value = t.levels.count;
    document.getElementById('levelBase').value = t.levels.baseHeight;
    document.getElementById('levelSpacing').value = t.levels.spacing;
    document.getElementById('levelGroundLevel').checked = !!t.levels.groundLevel;
    updateLevelBaseFieldState();
    document.getElementById('bayMaxWeight').value = t.maxWeightPerLevelKg;
    if (enterEditMode) {
      editingBayId = t.id;
      formBay.querySelector('button[type=submit]').textContent = 'Update Bay Template';
    }
    renderBayPreview();
  }

  function renderBayTable() {
    const tbody = document.querySelector('#bayTable tbody');
    tbody.innerHTML = '';
    store.data.bayTemplates.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      tr.innerHTML = `
        <td class="bay-name-cell" data-act="view" data-id="${t.id}" title="Click to view this bay in the 3D preview">${escapeHtml(t.name)}</td>
        <td>${t.upright.width}×${t.upright.thickness}×${t.upright.height}</td>
        <td>${t.frameDepth} mm</td>
        <td>${t.beam.height}×${t.beam.width}×${t.beam.thickness}</td>
        <td>${t.baySpacing} mm</td>
        <td>${t.levels.count} (${t.levels.groundLevel ? 'bottom on floor' : `base ${t.levels.baseHeight}mm`}, clear ${t.levels.spacing}mm)</td>
        <td>${t.maxWeightPerLevelKg}</td>
        <td>
          <button class="icon-btn" data-act="edit" data-id="${t.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${t.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this bay template? Racks using it will keep referencing it but show as unresolved.')) store.deleteBayTemplate(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="view"]').forEach((cell) => cell.addEventListener('click', () => {
      const t = store.data.bayTemplates.find((tt) => tt.id === cell.dataset.id);
      if (!t) return;
      loadBayTemplateIntoForm(t, false);
      if (window.matchMedia('(max-width: 1100px)').matches) formBay.scrollIntoView({ behavior: 'smooth' });
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = store.data.bayTemplates.find((tt) => tt.id === b.dataset.id);
      if (!t) return;
      loadBayTemplateIntoForm(t, true);
      formBay.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Tab 4: Racks ----------------
  const formRack = document.getElementById('formRack');
  const rackTemplateSelect = document.getElementById('rackBayTemplate');
  const rackBayCountInput = document.getElementById('rackBayCount');

  // Per-bay identifiers (label + pallet positions), kept in sync with "# of Bays".
  let draftBays = Model.defaultBays(Number(rackBayCountInput.value) || 0);

  function renderBaySlotsTable() {
    const tbody = document.querySelector('#baySlotsTable tbody');
    tbody.innerHTML = '';
    draftBays.forEach((slot, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><input type="text" class="slotLabel" value="${escapeHtml(slot.label)}" /></td>
        <td><input type="number" class="slotPallets" min="1" step="1" value="${slot.palletCount}" /></td>`;
      tbody.appendChild(tr);
      tr.querySelector('.slotLabel').addEventListener('input', (e) => { slot.label = e.target.value; });
      tr.querySelector('.slotPallets').addEventListener('input', (e) => { slot.palletCount = Number(e.target.value) || 1; });
    });
  }

  function syncBaySlotsToCount() {
    const count = Math.max(0, Number(rackBayCountInput.value) || 0);
    if (draftBays.length === count) return;
    const next = draftBays.slice(0, count);
    while (next.length < count) next.push({ id: Model.uid('slot'), label: `Bay ${next.length + 1}`, palletCount: 1 });
    draftBays = next;
    renderBaySlotsTable();
  }

  rackBayCountInput.addEventListener('input', syncBaySlotsToCount);
  renderBaySlotsTable();

  formRack.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('rackName').value,
      bayTemplateId: rackTemplateSelect.value,
      bayCount: rackBayCountInput.value,
      rotation: document.getElementById('rackRotation').value,
      x: document.getElementById('rackX').value,
      y: document.getElementById('rackY').value,
      aisleWidth: document.getElementById('rackAisle').value,
      maxWeightKg: document.getElementById('rackMaxWeight').value,
      bays: draftBays
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
      rackBayCountInput.value = r.bayCount;
      document.getElementById('rackRotation').value = r.rotation;
      document.getElementById('rackX').value = r.x;
      document.getElementById('rackY').value = r.y;
      document.getElementById('rackAisle').value = r.aisleWidth;
      document.getElementById('rackMaxWeight').value = r.maxWeightKg;
      draftBays = Array.isArray(r.bays) && r.bays.length === r.bayCount
        ? r.bays.map((b) => ({ ...b }))
        : Model.defaultBays(r.bayCount);
      renderBaySlotsTable();
      formRack.querySelector('button[type=submit]').textContent = 'Update Rack';
      formRack.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Legend (2D tab) ----------------
  function renderLegend() {
    const legend = document.getElementById('planLegend');
    legend.innerHTML = `
      <span class="chip"><span class="swatch" style="background:#C97E0D"></span>Warehouse outline</span>
      <span class="chip"><span class="swatch" style="background:#F2A93C"></span>Racks</span>
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
  renderVertexTable();
  renderShapePreview();
  renderBayPreview();

  // ---------------- Startup: load the warehouse list, open the most recent ----------------
  (async function init() {
    const list = await refreshWarehouseList();
    if (list.length > 0) {
      try {
        await store.loadWarehouse(list[0].id);
        resetWarehouseFormFromStore();
        if (window.Canvas2D) window.Canvas2D.resetView();
      } catch (err) {
        console.error(err);
      }
    }
  })();
})();
