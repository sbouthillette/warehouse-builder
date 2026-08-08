// main.js — app controller: tabs, forms, tables, wiring to model + renderers
(function () {
  const store = window.WarehouseStore;
  let currentTab = 'warehouse';
  let editingZoneId = null;
  let editingDoorId = null;
  let editingBayId = null;
  let editingRackId = null;

  // Standard rack/door colors, shared by the 2D plan, 3D view, and table swatches.
  const DOOR_COLORS = { garage: '#7C8892', regular: '#8B5E34' };

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
    if (tab === 'plan2d' && window.Canvas2D) window.Canvas2D.resetView(); // always re-fit when the tab is opened
    if (tab === 'view3d' && window.ThreeView) window.ThreeView.render(store);
    if (tab === 'warehouse') renderShapePreview(); // function declaration below is hoisted within this closure
    if (tab === 'bays') renderBayPreview(); // function declaration below is hoisted within this closure
    if (tab === 'doors') { // function declarations below are hoisted within this closure
      renderWallOptions();
      if (window.DoorsPlanView) window.DoorsPlanView.resetView({ door: getDraftDoor() });
    }
    if (tab === 'zones' && window.ZonesPlanView) { // function declaration below is hoisted within this closure
      window.ZonesPlanView.resetView({ zone: getDraftZoneOrObstacle() });
    }
    if (tab === 'racks' && window.RacksPlanView) { // function declaration below is hoisted within this closure
      window.RacksPlanView.resetView({ rack: getDraftRack() });
    }
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
      opt.textContent = (w.locked ? '🔒 ' : '') + w.name;
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

  // ---------------- Lock / unlock the currently open warehouse ----------------
  // Locking puts the warehouse into read-only mode: it stays fully visible —
  // 2D plan, 3D view, every table — but every editing control is disabled
  // and the Store itself refuses to persist changes (see the isLocked()
  // guards in model.js), so nothing can slip through. Unlocking (with the
  // password) is the only way to make it editable again. This is a soft
  // protection enforced by this app's own UI, not the server — /api/warehouses
  // has no concept of a logged-in user — so it deters accidental edits or
  // casual browsing, not a determined actor going around the UI.
  function renderLockButton() {
    const btn = document.getElementById('btnToggleLock');
    if (!btn || !store.currentId) { if (btn) btn.hidden = !store.currentId; return; }
    btn.hidden = false;
    const locked = store.isLocked();
    btn.textContent = locked ? '🔓 Unlock' : '🔒 Lock';
  }

  // Disables every control that adds/edits/deletes data while the currently
  // open warehouse is locked — the 5 editing forms (Warehouse Shell's is a
  // plain .split-params-col, not a <form>, so we target that class directly
  // rather than a form id), each item table's Edit/Delete/Convert buttons,
  // and the top-level Delete Warehouse button. Viewing (tables, 2D plan, 3D
  // view, zoom/rotate/fit controls — none of which live inside these
  // containers) stays fully interactive either way.
  function applyLockUI() {
    const locked = store.isLocked();
    document.body.classList.toggle('warehouse-locked', locked);
    const banner = document.getElementById('lockBanner');
    if (banner) banner.hidden = !(locked && store.currentId);
    document.querySelectorAll(
      '#tab-warehouse .split-params-col, #tab-zones .split-params-col, ' +
      '#tab-doors .split-params-col, #tab-bays .split-params-col, #tab-racks .split-params-col'
    ).forEach((col) => {
      col.querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = locked; });
    });
    document.querySelectorAll(
      '#zonesTable .icon-btn, #doorsTable .icon-btn, #bayTable .icon-btn, #racksTable .icon-btn'
    ).forEach((el) => { el.disabled = locked; });
    const delBtn = document.getElementById('btnDeleteWarehouse');
    if (delBtn) delBtn.disabled = locked;
  }

  document.getElementById('btnToggleLock').addEventListener('click', async () => {
    if (!store.currentId) return;
    if (store.isLocked()) {
      const pw = prompt('Enter the password to unlock this warehouse:');
      if (pw === null) return;
      const ok = await store.unlockProject(pw);
      if (!ok) { alert('Incorrect password.'); return; }
      alert('Warehouse unlocked — editing is enabled again.');
    } else {
      const pw = prompt('Set a password to lock this warehouse:');
      if (pw === null) return;
      if (!pw.trim()) { alert('Password cannot be empty.'); return; }
      const confirmPw = prompt('Confirm the password:');
      if (confirmPw !== pw) { alert('Passwords did not match — nothing was locked.'); return; }
      await store.lockProject(pw);
      alert('Warehouse locked — it’s now read-only. Enter the password and click Unlock to make changes again.');
    }
    renderLockButton();
    applyLockUI();
    refreshWarehouseList(store.currentId); // picker's 🔒 icon reflects the new state
  });

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
    applyLockUI(); // rebuilt rows above start out enabled — re-apply if locked
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

    // Wall numbers ("W1", "W2", ...) at the midpoint of each edge, matching
    // the wall details table below and the "Wall 1"/"Wall 2" references used
    // when placing doors. Offset a little off the line (perpendicular, in
    // screen space) so the label doesn't sit directly on top of the stroke.
    Model.wallSegments(draftShape).forEach((wall) => {
      const a = toScreen(wall.p1), b = toScreen(wall.p2);
      const midX = (a.sx + b.sx) / 2, midY = (a.sy + b.sy) / 2;
      const sdx = b.sx - a.sx, sdy = b.sy - a.sy;
      const slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
      const nx = -sdy / slen, ny = sdx / slen;
      const labelX = midX + nx * 13, labelY = midY + ny * 13;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const text = `W${wall.index + 1}`;
      ctx.font = 'bold 11px sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillRect(labelX - tw / 2 - 3, labelY - 9, tw + 6, 14);
      ctx.fillStyle = '#C97E0D'; // primary-2 — matches the outline color
      ctx.textAlign = 'center';
      ctx.fillText(text, labelX, labelY + 2);
      ctx.textAlign = 'left';
    });

    if (bounds.minX <= 0 && 0 <= bounds.maxX && bounds.minY <= 0 && 0 <= bounds.maxY) {
      const s = toScreen({ x: 0, y: 0 });
      ctx.fillStyle = '#E2572E'; // secondary-2
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 3, 0, Math.PI * 2); ctx.fill();
    }

    renderWallDetailsTable();
  }

  // Wall-by-wall breakdown of the shape currently being edited (origin,
  // end point, length, angle) — walking the outline in the same order/
  // direction it was traced, matching how doors reference "Wall 1", "Wall 2"
  // etc. Recomputed live from draftShape, same as the preview canvas.
  function renderWallDetailsTable() {
    const tbody = document.querySelector('#wallDetailsTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (draftShape.length < 2) return;
    const walls = Model.wallSegments(draftShape);
    walls.forEach((wall) => {
      const angleDeg = (wall.angle * 180) / Math.PI;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>Wall ${wall.index + 1}</td>
        <td>${wall.p1.x.toFixed(2)}, ${wall.p1.y.toFixed(2)}</td>
        <td>${wall.p2.x.toFixed(2)}, ${wall.p2.y.toFixed(2)}</td>
        <td>${wall.length.toFixed(2)}</td>
        <td>${angleDeg.toFixed(1)}</td>`;
      tbody.appendChild(tr);
    });
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

  // ---------------- Tab 2: Zones & Obstacles ----------------
  const formZone = document.getElementById('formZone');
  const zoneKindSelect = document.getElementById('zoneKind');
  const zoneShapeSelect = document.getElementById('zoneShape');

  const ZONE_TYPE_OPTIONS = {
    zone: ['Storage', 'Staging', 'Picking', 'Dock', 'Office', 'Other'],
    obstacle: ['Column', 'Equipment', 'Fixed Structure', 'Other']
  };

  function populateZoneTypeOptions(kind, selected) {
    const select = document.getElementById('zoneType');
    const options = ZONE_TYPE_OPTIONS[kind] || ZONE_TYPE_OPTIONS.zone;
    select.innerHTML = options.map((o) => `<option${o === selected ? ' selected' : ''}>${o}</option>`).join('');
  }

  // Obstacles are raised (need a height) and use a different type vocabulary
  // than flat zones — swap the form to match whichever Kind is selected.
  // Only obstacles may be round; switching back to Zone forces shape='rect'.
  function updateZoneKindUI() {
    const kind = zoneKindSelect.value;
    document.getElementById('zoneHeightLabel').hidden = kind !== 'obstacle';
    document.getElementById('zoneHeight').required = kind === 'obstacle';
    document.getElementById('zoneShapeLabel').hidden = kind !== 'obstacle';
    if (kind !== 'obstacle') zoneShapeSelect.value = 'rect';
    const noun = kind === 'obstacle' ? 'Obstacle' : 'Zone';
    formZone.querySelector('button[type=submit]').textContent = editingZoneId ? `Update ${noun}` : `Add ${noun}`;
    updateZoneShapeUI();
  }

  // A round obstacle (e.g. a column) is defined by a single diameter — swap
  // the Width field's label to "Diameter" and hide the Length field, which
  // stays in sync with Width behind the scenes (see getDraftZoneOrObstacle
  // and Store._normalizeZonePayload).
  function updateZoneShapeUI() {
    const isRound = zoneKindSelect.value === 'obstacle' && zoneShapeSelect.value === 'round';
    document.getElementById('zoneWidthLabelText').textContent = isRound ? 'Diameter (m)' : 'Width — X axis (m)';
    document.getElementById('zoneLengthLabel').hidden = isRound;
    document.getElementById('zoneLength').required = !isRound;
  }

  zoneKindSelect.addEventListener('change', () => {
    const kind = zoneKindSelect.value;
    populateZoneTypeOptions(kind);
    document.getElementById('zoneColor').value = kind === 'obstacle' ? '#5f5e5a' : '#BC5C92';
    updateZoneKindUI();
    renderZonesPlanPreview();
  });

  zoneShapeSelect.addEventListener('change', () => {
    updateZoneShapeUI();
    renderZonesPlanPreview();
  });

  function getDraftZoneOrObstacle() {
    const num = (id, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const kind = zoneKindSelect.value;
    const shape = kind === 'obstacle' && zoneShapeSelect.value === 'round' ? 'round' : 'rect';
    const width = num('zoneWidth', 1);
    return {
      kind,
      shape,
      type: document.getElementById('zoneType').value,
      x: Number(document.getElementById('zoneX').value) || 0,
      y: Number(document.getElementById('zoneY').value) || 0,
      width,
      length: shape === 'round' ? width : num('zoneLength', 1),
      height: num('zoneHeight', 2),
      color: document.getElementById('zoneColor').value
    };
  }

  function renderZonesPlanPreview() {
    if (window.ZonesPlanView) window.ZonesPlanView.render({ zone: getDraftZoneOrObstacle() });
  }

  const zoneLiveFields = ['zoneType', 'zoneX', 'zoneY', 'zoneWidth', 'zoneLength', 'zoneHeight', 'zoneColor'];
  zoneLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderZonesPlanPreview);
  });

  // Populates the form with an existing zone/obstacle's values and puts the
  // form into edit mode for it — used by both the name-cell click and the
  // pencil edit button (same pattern as Bay Builder).
  function loadZoneIntoForm(z) {
    zoneKindSelect.value = z.kind;
    zoneShapeSelect.value = z.shape === 'round' ? 'round' : 'rect';
    populateZoneTypeOptions(z.kind, z.type);
    document.getElementById('zoneName').value = z.name;
    document.getElementById('zoneX').value = z.x;
    document.getElementById('zoneY').value = z.y;
    document.getElementById('zoneWidth').value = z.width;
    document.getElementById('zoneLength').value = z.length;
    document.getElementById('zoneHeight').value = z.height || 2;
    document.getElementById('zoneColor').value = z.color;
    editingZoneId = z.id;
    document.getElementById('btnCancelZoneEdit').hidden = false;
    updateZoneKindUI();
    renderZonesPlanPreview();
  }

  function exitZoneEditMode() {
    editingZoneId = null;
    document.getElementById('btnCancelZoneEdit').hidden = true;
    updateZoneKindUI();
  }

  function resetZoneForm() {
    formZone.reset();
    zoneKindSelect.value = 'zone';
    zoneShapeSelect.value = 'rect';
    populateZoneTypeOptions('zone');
    document.getElementById('zoneColor').value = '#BC5C92';
    document.getElementById('zoneHeight').value = 2;
    updateZoneKindUI();
    renderZonesPlanPreview();
  }

  document.getElementById('btnCancelZoneEdit').addEventListener('click', () => {
    exitZoneEditMode();
    resetZoneForm();
  });

  document.getElementById('btnFitZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.resetView({ zone: getDraftZoneOrObstacle() });
  });
  document.getElementById('btnZoomInZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.zoomIn();
  });
  document.getElementById('btnZoomOutZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.zoomOut();
  });

  populateZoneTypeOptions('zone');
  updateZoneKindUI();

  formZone.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('zoneName').value,
      kind: zoneKindSelect.value,
      shape: zoneShapeSelect.value,
      type: document.getElementById('zoneType').value,
      x: document.getElementById('zoneX').value,
      y: document.getElementById('zoneY').value,
      width: document.getElementById('zoneWidth').value,
      length: document.getElementById('zoneLength').value,
      height: document.getElementById('zoneHeight').value,
      color: document.getElementById('zoneColor').value
    };
    if (editingZoneId) {
      store.updateZone(editingZoneId, payload);
      exitZoneEditMode();
    } else {
      store.addZone(payload);
    }
    resetZoneForm();
  });

  function renderZonesGate() {
    const wh = store.data.warehouse;
    document.getElementById('zonesGate').classList.toggle('show', !wh);
    document.getElementById('zonesGate').textContent = 'Define the warehouse shell (Tab 1) before adding zones or obstacles.';
    document.getElementById('zonesUI').hidden = !wh;
  }

  function renderZonesTable() {
    const tbody = document.querySelector('#zonesTable tbody');
    tbody.innerHTML = '';
    store.data.zones.forEach((z) => {
      const tr = document.createElement('tr');
      tr.dataset.id = z.id;
      tr.innerHTML = `
        <td class="name-cell" data-act="view" data-id="${z.id}" title="Click to edit"><span class="swatch" style="background:${z.color}"></span>${escapeHtml(z.name)}</td>
        <td>${z.kind === 'obstacle' ? 'Obstacle' : 'Zone'}</td>
        <td>${z.kind === 'obstacle' ? (z.shape === 'round' ? 'Round' : 'Rectangle') : '—'}</td>
        <td>${escapeHtml(z.type)}</td>
        <td>${z.x}</td><td>${z.y}</td><td>${z.width}</td><td>${z.length}</td>
        <td>${z.kind === 'obstacle' ? z.height + ' m' : '—'}</td>
        <td>
          <button class="icon-btn" data-act="convert" data-id="${z.id}" title="Convert to ${z.kind === 'obstacle' ? 'Zone' : 'Obstacle'}">⇄</button>
          <button class="icon-btn" data-act="edit" data-id="${z.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${z.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this zone/obstacle?')) store.deleteZone(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="convert"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const z = store.data.zones.find((zz) => zz.id === b.dataset.id);
      if (!z) return;
      const newKind = z.kind === 'obstacle' ? 'zone' : 'obstacle';
      // Reset to the new kind's default type (the old type's vocabulary —
      // e.g. "Storage" — doesn't apply once it becomes an Obstacle, and vice
      // versa); other fields (position, footprint, color) carry over as-is.
      store.updateZone(z.id, { kind: newKind, type: newKind === 'obstacle' ? 'Column' : 'Storage' });
      // If the item being converted is currently open in the edit form, keep
      // the form in sync rather than leaving it showing the stale kind.
      if (editingZoneId === z.id) {
        const updated = store.data.zones.find((zz) => zz.id === z.id);
        if (updated) loadZoneIntoForm(updated);
      }
    }));
    tbody.querySelectorAll('[data-act="view"]').forEach((cell) => cell.addEventListener('click', () => {
      const z = store.data.zones.find((zz) => zz.id === cell.dataset.id);
      if (!z) return;
      loadZoneIntoForm(z);
      formZone.scrollIntoView({ behavior: 'smooth' });
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const z = store.data.zones.find((zz) => zz.id === b.dataset.id);
      if (!z) return;
      loadZoneIntoForm(z);
      formZone.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Tab 2.5: Doors ----------------
  const formDoor = document.getElementById('formDoor');
  const doorTypeSelect = document.getElementById('doorType');
  const doorWallSelect = document.getElementById('doorWall');

  // Sensible size presets per door type — always applied on type change, the
  // same "quick default" pattern used by the bay template reset defaults.
  const DOOR_PRESETS = {
    garage: { width: 3, height: 4 },
    regular: { width: 1, height: 2.1 }
  };
  doorTypeSelect.addEventListener('change', () => {
    const preset = DOOR_PRESETS[doorTypeSelect.value] || DOOR_PRESETS.regular;
    document.getElementById('doorWidth').value = preset.width;
    document.getElementById('doorHeight').value = preset.height;
    renderDoorsPlanPreview();
  });

  // Populates the Wall dropdown from the current warehouse shape's edges.
  // Called whenever the Doors tab is shown and whenever the shell changes,
  // since editing the outline can add/remove/resize walls.
  function renderWallOptions() {
    const wh = store.data.warehouse;
    const walls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
    const prevValue = doorWallSelect.value;
    doorWallSelect.innerHTML = walls.map((w) =>
      `<option value="${w.index}">Wall ${w.index + 1} — ${w.length.toFixed(1)} m</option>`
    ).join('');
    if (walls.some((w) => String(w.index) === prevValue)) doorWallSelect.value = prevValue;
  }

  // Reads the current (unsaved) Doors form values into a plain door-like
  // object, for the live plan-preview highlight as the user fills it in.
  function getDraftDoor() {
    if (doorWallSelect.value === '') return null;
    return {
      wallIndex: Number(doorWallSelect.value),
      offset: Number(document.getElementById('doorOffset').value) || 0,
      width: Number(document.getElementById('doorWidth').value) || 0.1,
      height: Number(document.getElementById('doorHeight').value) || 0.1,
      type: doorTypeSelect.value,
      label: document.getElementById('doorLabel').value || 'Door'
    };
  }

  function renderDoorsPlanPreview() {
    if (window.DoorsPlanView) window.DoorsPlanView.render({ door: getDraftDoor() });
  }

  const doorLiveFields = ['doorWall', 'doorOffset', 'doorWidth', 'doorHeight', 'doorLabel'];
  doorLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderDoorsPlanPreview);
  });

  // Populates the form with an existing door's values and puts the form
  // into edit mode for it — used by both the name-cell click and the pencil
  // edit button (same pattern as Bay Builder).
  function loadDoorIntoForm(d) {
    renderWallOptions();
    document.getElementById('doorLabel').value = d.label;
    doorTypeSelect.value = d.type;
    doorWallSelect.value = d.wallIndex;
    document.getElementById('doorOffset').value = d.offset;
    document.getElementById('doorWidth').value = d.width;
    document.getElementById('doorHeight').value = d.height;
    editingDoorId = d.id;
    formDoor.querySelector('button[type=submit]').textContent = 'Update Door';
    document.getElementById('btnCancelDoorEdit').hidden = false;
    renderDoorsPlanPreview();
  }

  function exitDoorEditMode() {
    editingDoorId = null;
    formDoor.querySelector('button[type=submit]').textContent = 'Add Door';
    document.getElementById('btnCancelDoorEdit').hidden = true;
  }

  document.getElementById('btnFitDoorsPlan').addEventListener('click', () => {
    if (window.DoorsPlanView) window.DoorsPlanView.resetView({ door: getDraftDoor() });
  });
  document.getElementById('btnZoomInDoorsPlan').addEventListener('click', () => {
    if (window.DoorsPlanView) window.DoorsPlanView.zoomIn();
  });
  document.getElementById('btnZoomOutDoorsPlan').addEventListener('click', () => {
    if (window.DoorsPlanView) window.DoorsPlanView.zoomOut();
  });

  document.getElementById('btnCancelDoorEdit').addEventListener('click', () => {
    exitDoorEditMode();
    formDoor.reset();
    doorTypeSelect.value = 'garage';
    document.getElementById('doorWidth').value = DOOR_PRESETS.garage.width;
    document.getElementById('doorHeight').value = DOOR_PRESETS.garage.height;
    document.getElementById('doorOffset').value = 0;
    renderDoorsPlanPreview();
  });

  formDoor.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const payload = {
        label: document.getElementById('doorLabel').value,
        type: doorTypeSelect.value,
        wallIndex: doorWallSelect.value,
        offset: document.getElementById('doorOffset').value,
        width: document.getElementById('doorWidth').value,
        height: document.getElementById('doorHeight').value
      };
      const wh = store.data.warehouse;
      const walls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
      const wall = walls[Number(payload.wallIndex)];
      if (!wall) { alert('Pick a wall first.'); return; }
      if (Number(payload.offset) + Number(payload.width) > wall.length + 0.001) {
        alert(`This door doesn't fit — Wall ${wall.index + 1} is only ${wall.length.toFixed(1)} m long from that starting position.`);
        return;
      }
      if (editingDoorId) {
        store.updateDoor(editingDoorId, payload);
        exitDoorEditMode();
      } else {
        store.addDoor(payload);
      }
      formDoor.reset();
      doorTypeSelect.value = 'garage';
      document.getElementById('doorWidth').value = DOOR_PRESETS.garage.width;
      document.getElementById('doorHeight').value = DOOR_PRESETS.garage.height;
      document.getElementById('doorOffset').value = 0;
      renderDoorsPlanPreview();
    } catch (err) {
      console.error('Failed to save door', err);
      alert('Could not save the door: ' + err.message);
    }
  });

  function renderDoorsGate() {
    const wh = store.data.warehouse;
    document.getElementById('doorsGate').classList.toggle('show', !wh);
    document.getElementById('doorsGate').textContent = 'Define the warehouse shell (Tab 1) before placing doors.';
    document.getElementById('doorsUI').hidden = !wh;
  }

  function renderDoorsTable() {
    const tbody = document.querySelector('#doorsTable tbody');
    tbody.innerHTML = '';
    const wh = store.data.warehouse;
    const walls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
    store.data.doors.forEach((d) => {
      const wall = walls[d.wallIndex];
      const tr = document.createElement('tr');
      tr.dataset.id = d.id;
      tr.innerHTML = `
        <td class="name-cell" data-act="view" data-id="${d.id}" title="Click to edit"><span class="swatch" style="background:${DOOR_COLORS[d.type]}"></span>${escapeHtml(d.label)}</td>
        <td>${d.type === 'garage' ? 'Garage / Dock' : 'Regular'}</td>
        <td>${wall ? `Wall ${d.wallIndex + 1}` : `Wall ${d.wallIndex + 1} (missing)`}</td>
        <td>${d.offset} m</td>
        <td>${d.width} m</td>
        <td>${d.height} m</td>
        <td>
          <button class="icon-btn" data-act="edit" data-id="${d.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-id="${d.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this door?')) store.deleteDoor(b.dataset.id);
    }));
    tbody.querySelectorAll('[data-act="view"]').forEach((cell) => cell.addEventListener('click', () => {
      const d = store.data.doors.find((dd) => dd.id === cell.dataset.id);
      if (!d) return;
      loadDoorIntoForm(d);
      formDoor.scrollIntoView({ behavior: 'smooth' });
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = store.data.doors.find((dd) => dd.id === b.dataset.id);
      if (!d) return;
      loadDoorIntoForm(d);
      formDoor.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  // ---------------- Tab 3: Bay Builder ----------------
  const formBay = document.getElementById('formBay');
  const levelCountInput = document.getElementById('levelCount');
  let lastSavedBayId = null; // used to scroll/highlight the saved row in the table below

  // Per-level configuration (clear height, ground-level flag, # of discrete
  // locations), kept in sync with "# of Levels" — mirrors the draftBays
  // pattern used for Racks & Aisles' per-bay identifiers table.
  let draftLevels = Array.from({ length: Math.max(1, Number(levelCountInput.value) || 4) }, (_, i) => Model.normalizeBayLevel({}, i));

  function renderLevelConfigTable() {
    const tbody = document.querySelector('#levelConfigTable tbody');
    tbody.innerHTML = '';
    draftLevels.forEach((lv, i) => {
      const tr = document.createElement('tr');
      const grounded = i === 0 && lv.restsOnFloor;
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${i === 0 ? `<input type="checkbox" class="lvGround" ${lv.restsOnFloor ? 'checked' : ''} />` : '—'}</td>
        <td><input type="number" class="lvHeight" min="0" step="1" value="${lv.clearHeight}" ${grounded ? 'disabled' : ''}
          title="${i === 0 ? "Height above the floor to this level's beam (mm)" : 'Clear opening above the beam below (mm)'}" /></td>
        <td><select class="lvType" title="Pallet: open front/back load beams only. Shelf: a continuous deck across the full depth, for loose stock or cartons.">
          <option value="pallet" ${lv.levelType === 'pallet' ? 'selected' : ''}>Pallet</option>
          <option value="shelf" ${lv.levelType === 'shelf' ? 'selected' : ''}>Shelf (loose stock)</option>
        </select></td>
        <td><input type="number" class="lvLocations" min="1" step="1" value="${lv.locations}"
          title="How many discrete pick/pallet locations span this level (1 = single unlabeled, 2 = A/B, etc.)" /></td>`;
      tbody.appendChild(tr);
      if (i === 0) {
        tr.querySelector('.lvGround').addEventListener('change', (e) => {
          lv.restsOnFloor = e.target.checked;
          renderLevelConfigTable();
          renderBayPreview();
        });
      }
      tr.querySelector('.lvHeight').addEventListener('input', (e) => {
        lv.clearHeight = Number(e.target.value) || 0;
        renderBayPreview();
      });
      tr.querySelector('.lvType').addEventListener('change', (e) => {
        lv.levelType = e.target.value === 'shelf' ? 'shelf' : 'pallet';
        renderBayPreview();
      });
      tr.querySelector('.lvLocations').addEventListener('input', (e) => {
        lv.locations = Math.max(1, Number(e.target.value) || 1);
        renderBayPreview();
      });
    });
    applyLockUI(); // rebuilt rows above start out enabled — re-apply if locked
  }

  function syncLevelsToCount() {
    const count = Math.max(1, Math.round(Number(levelCountInput.value)) || 1);
    if (draftLevels.length === count) return;
    const next = draftLevels.slice(0, count);
    while (next.length < count) next.push(Model.normalizeBayLevel({}, next.length));
    draftLevels = next;
    renderLevelConfigTable();
    renderBayPreview();
  }
  levelCountInput.addEventListener('input', syncLevelsToCount);
  renderLevelConfigTable();

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
        levels: draftLevels,
        maxWeightPerLevelKg: document.getElementById('bayMaxWeight').value
      };
      payload.name = payload.name.trim();
      const nameTaken = store.data.bayTemplates.some((t) =>
        t.id !== editingBayId && t.name.trim().toLowerCase() === payload.name.toLowerCase()
      );
      if (nameTaken) {
        alert(`A bay template named "${payload.name}" already exists. Choose a different name.`);
        return;
      }
      if (editingBayId) {
        store.updateBayTemplate(editingBayId, payload);
        lastSavedBayId = editingBayId;
        exitBayEditMode();
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
      levelCountInput.value = 4;
      draftLevels = Array.from({ length: 4 }, (_, i) => Model.normalizeBayLevel({}, i));
      renderLevelConfigTable();
      document.getElementById('bayMaxWeight').value = 1000;
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
      levels: draftLevels
    };
  }

  function renderBayPreview() {
    if (window.BayPreview3D) window.BayPreview3D.render(getDraftBayTemplate());
  }

  const bayLiveFields = [
    'uprightWidth', 'uprightThickness', 'uprightHeight', 'frameDepth',
    'beamHeight', 'beamWidth', 'beamThickness', 'baySpacing'
  ];
  bayLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderBayPreview);
  });

  // baypreview3d.js's render() already recomputes the camera's framing from
  // scratch on every call, so re-rendering the current draft is enough to
  // reset the (OrbitControls-manipulated) camera back to the fitted default.
  document.getElementById('btnFitBayPreview').addEventListener('click', renderBayPreview);
  document.getElementById('btnBayZoomIn').addEventListener('click', () => {
    if (window.BayPreview3D) window.BayPreview3D.zoomIn();
  });
  document.getElementById('btnBayZoomOut').addEventListener('click', () => {
    if (window.BayPreview3D) window.BayPreview3D.zoomOut();
  });
  document.getElementById('btnBayRotateLeft').addEventListener('click', () => {
    if (window.BayPreview3D) window.BayPreview3D.rotateLeft();
  });
  document.getElementById('btnBayRotateRight').addEventListener('click', () => {
    if (window.BayPreview3D) window.BayPreview3D.rotateRight();
  });

  // Populates the form with an existing template's values and puts the form
  // into edit mode for it — used by both the name-cell click and the pencil
  // edit button, so selecting a bay either way lets Save Bay Template update
  // that same template instead of creating a new one.
  function loadBayTemplateIntoForm(t) {
    document.getElementById('bayName').value = t.name;
    document.getElementById('uprightWidth').value = t.upright.width;
    document.getElementById('uprightThickness').value = t.upright.thickness;
    document.getElementById('uprightHeight').value = t.upright.height;
    document.getElementById('frameDepth').value = t.frameDepth;
    document.getElementById('beamHeight').value = t.beam.height;
    document.getElementById('beamWidth').value = t.beam.width;
    document.getElementById('beamThickness').value = t.beam.thickness;
    document.getElementById('baySpacing').value = t.baySpacing;
    draftLevels = Array.isArray(t.levels) && t.levels.length
      ? t.levels.map((lv, i) => Model.normalizeBayLevel(lv, i))
      : [Model.normalizeBayLevel({}, 0)];
    levelCountInput.value = draftLevels.length;
    renderLevelConfigTable();
    document.getElementById('bayMaxWeight').value = t.maxWeightPerLevelKg;
    editingBayId = t.id;
    formBay.querySelector('button[type=submit]').textContent = 'Update Bay Template';
    document.getElementById('btnCancelBayEdit').hidden = false;
    renderBayPreview();
  }

  function exitBayEditMode() {
    editingBayId = null;
    formBay.querySelector('button[type=submit]').textContent = 'Save Bay Template';
    document.getElementById('btnCancelBayEdit').hidden = true;
  }

  document.getElementById('btnCancelBayEdit').addEventListener('click', () => {
    exitBayEditMode();
    formBay.reset();
    document.getElementById('uprightWidth').value = 90;
    document.getElementById('uprightThickness').value = 60;
    document.getElementById('uprightHeight').value = 7000;
    document.getElementById('frameDepth').value = 900;
    document.getElementById('beamHeight').value = 100;
    document.getElementById('beamWidth').value = 2700;
    document.getElementById('beamThickness').value = 50;
    document.getElementById('baySpacing').value = 2700;
    levelCountInput.value = 4;
    draftLevels = Array.from({ length: 4 }, (_, i) => Model.normalizeBayLevel({}, i));
    renderLevelConfigTable();
    document.getElementById('bayMaxWeight').value = 1000;
    renderBayPreview();
  });

  function renderBayTable() {
    const tbody = document.querySelector('#bayTable tbody');
    tbody.innerHTML = '';
    store.data.bayTemplates.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      const heights = t.levels.map((lv, i) => (i === 0 && lv.restsOnFloor ? 'floor' : `${lv.clearHeight}`)).join('/');
      const locs = t.levels.map((lv) => lv.locations).join('/');
      tr.innerHTML = `
        <td class="bay-name-cell" data-act="view" data-id="${t.id}" title="Click to edit this bay">${escapeHtml(t.name)}</td>
        <td>${t.upright.width}×${t.upright.thickness}×${t.upright.height}</td>
        <td>${t.frameDepth} mm</td>
        <td>${t.beam.height}×${t.beam.width}×${t.beam.thickness}</td>
        <td>${t.baySpacing} mm</td>
        <td>${t.levels.length} level${t.levels.length === 1 ? '' : 's'} — H: ${heights}mm — Loc: ${locs}</td>
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
      loadBayTemplateIntoForm(t);
      if (window.matchMedia('(max-width: 1100px)').matches) formBay.scrollIntoView({ behavior: 'smooth' });
    }));
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = store.data.bayTemplates.find((tt) => tt.id === b.dataset.id);
      if (!t) return;
      loadBayTemplateIntoForm(t);
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
    applyLockUI(); // rebuilt rows above start out enabled — re-apply if locked
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

  // Flips which end of the rack "Bay 1" starts from — reverses the array
  // order (each slot keeps its own label/pallet count, they just swap ends),
  // so row #1 in the table always matches whichever bay now sits nearest the
  // origin dot in the plan preview.
  document.getElementById('btnReverseBayOrder').addEventListener('click', () => {
    draftBays.reverse();
    renderBaySlotsTable();
    renderRacksPlanPreview();
  });

  // True if a rack with this footprint sits entirely inside the warehouse
  // shell — used both for the live draft preview (red highlight) and to
  // hard-block Add/Update Rack.
  function isRackFootprintValid(x, y, rotation, lengthM, depthM) {
    const wh = store.data.warehouse;
    if (!wh || !wh.shape || wh.shape.length < 3) return false;
    const corners = Model.rackCorners({ x, y, rotation, lengthM, depthM });
    return Model.rectFullyInsidePolygon(corners, wh.shape);
  }

  // Reads the current (unsaved) Rack form values into a plain rack-footprint
  // object, for the live plan-preview highlight as the user fills it in.
  function getDraftRack() {
    const bayTemplateId = rackTemplateSelect.value;
    const bayCount = Number(rackBayCountInput.value) || 0;
    if (!bayTemplateId || bayCount <= 0) return null;
    const fp = store.rackFootprint({ bayTemplateId, bayCount });
    if (!fp.lengthM) return null;
    const x = Number(document.getElementById('rackX').value) || 0;
    const y = Number(document.getElementById('rackY').value) || 0;
    const rotation = Number(document.getElementById('rackRotation').value) || 0;
    return {
      x, y,
      lengthM: fp.lengthM,
      depthM: fp.depthM,
      rotation,
      pickingSide: document.getElementById('rackPickingSide').value || 'south',
      name: document.getElementById('rackName').value || '',
      valid: isRackFootprintValid(x, y, rotation, fp.lengthM, fp.depthM)
    };
  }

  function renderRacksPlanPreview() {
    if (window.RacksPlanView) window.RacksPlanView.render({ rack: getDraftRack() });
  }

  const rackLiveFields = ['rackName', 'rackBayTemplate', 'rackBayCount', 'rackRotation', 'rackX', 'rackY', 'rackPickingSide'];
  rackLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderRacksPlanPreview);
  });

  function exitRackEditMode() {
    editingRackId = null;
    formRack.querySelector('button[type=submit]').textContent = 'Add Rack';
    document.getElementById('btnCancelRackEdit').hidden = true;
  }

  document.getElementById('btnFitRacksPlan').addEventListener('click', () => {
    if (window.RacksPlanView) window.RacksPlanView.resetView({ rack: getDraftRack() });
  });
  document.getElementById('btnZoomInRacksPlan').addEventListener('click', () => {
    if (window.RacksPlanView) window.RacksPlanView.zoomIn();
  });
  document.getElementById('btnZoomOutRacksPlan').addEventListener('click', () => {
    if (window.RacksPlanView) window.RacksPlanView.zoomOut();
  });

  document.getElementById('btnCancelRackEdit').addEventListener('click', () => {
    exitRackEditMode();
    formRack.reset();
    document.getElementById('rackPickingSide').value = 'south';
    draftBays = Model.defaultBays(Number(rackBayCountInput.value) || 0);
    renderBaySlotsTable();
    renderRacksPlanPreview();
  });

  formRack.addEventListener('submit', (e) => {
    e.preventDefault();
    const bayTemplateId = rackTemplateSelect.value;
    const bayCount = Number(rackBayCountInput.value) || 0;
    const x = Number(document.getElementById('rackX').value) || 0;
    const y = Number(document.getElementById('rackY').value) || 0;
    const rotation = Number(document.getElementById('rackRotation').value) || 0;
    const fp = store.rackFootprint({ bayTemplateId, bayCount });
    if (!isRackFootprintValid(x, y, rotation, fp.lengthM, fp.depthM)) {
      alert('This rack falls outside the warehouse shell. Adjust its position, rotation, or bay count so it fits entirely within the outline before saving.');
      return;
    }
    const payload = {
      name: document.getElementById('rackName').value,
      bayTemplateId,
      bayCount,
      rotation,
      x,
      y,
      pickingSide: document.getElementById('rackPickingSide').value,
      aisleWidth: document.getElementById('rackAisle').value,
      maxWeightKg: document.getElementById('rackMaxWeight').value,
      bays: draftBays
    };
    if (editingRackId) {
      store.updateRack(editingRackId, payload);
      exitRackEditMode();
    } else {
      store.addRack(payload);
    }
    renderRacksPlanPreview();
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
    renderRacksPlanPreview();
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
    renderRacksPlanPreview();
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
        <td>${escapeHtml((r.pickingSide || 'south').replace(/^./, (c) => c.toUpperCase()))}</td>
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
      document.getElementById('rackPickingSide').value = r.pickingSide || 'south';
      document.getElementById('rackAisle').value = r.aisleWidth;
      document.getElementById('rackMaxWeight').value = r.maxWeightKg;
      draftBays = Array.isArray(r.bays) && r.bays.length === r.bayCount
        ? r.bays.map((b) => ({ ...b }))
        : Model.defaultBays(r.bayCount);
      renderBaySlotsTable();
      formRack.querySelector('button[type=submit]').textContent = 'Update Rack';
      document.getElementById('btnCancelRackEdit').hidden = false;
      formRack.scrollIntoView({ behavior: 'smooth' });
      renderRacksPlanPreview();
    }));
  }

  // ---------------- Legend (2D tab) ----------------
  function renderLegend() {
    const legend = document.getElementById('planLegend');
    legend.innerHTML = `
      <span class="chip"><span class="swatch" style="background:#C97E0D"></span>Warehouse outline</span>
      <span class="chip"><span class="swatch" style="background:#F2A93C"></span>Racks</span>
      <span class="chip"><span class="swatch" style="background:${DOOR_COLORS.garage}"></span>Garage/Dock Door</span>
      <span class="chip"><span class="swatch" style="background:${DOOR_COLORS.regular}"></span>Regular Door</span>
      <span class="chip"><span class="swatch" style="background:#2F8F4E"></span>Picking access side</span>
      <span class="chip">Zones shown in their own color</span>
    `;
  }

  document.getElementById('btnFitPlan').addEventListener('click', () => {
    if (window.Canvas2D) window.Canvas2D.resetView();
  });
  document.getElementById('btnZoomInPlan').addEventListener('click', () => {
    if (window.Canvas2D) window.Canvas2D.zoomIn();
  });
  document.getElementById('btnZoomOutPlan').addEventListener('click', () => {
    if (window.Canvas2D) window.Canvas2D.zoomOut();
  });

  // ---------------- Dynamic Spatial Model (3D) camera presets ----------------
  document.getElementById('btnView3dReset').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.resetView(store);
  });
  document.getElementById('btnView3dTop').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.topView(store);
  });
  document.getElementById('btnView3dIso').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.isometricView(store);
  });
  document.getElementById('btnView3dZoomIn').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.zoomIn();
  });
  document.getElementById('btnView3dZoomOut').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.zoomOut();
  });
  document.getElementById('btnView3dRotateLeft').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.rotateLeft();
  });
  document.getElementById('btnView3dRotateRight').addEventListener('click', () => {
    if (window.ThreeView) window.ThreeView.rotateRight();
  });
  document.getElementById('btnToggleLabels').addEventListener('click', () => {
    if (!window.ThreeView) return;
    const next = !window.ThreeView.labelsAreVisible();
    window.ThreeView.setLabelsVisible(next);
    document.getElementById('btnToggleLabels').textContent = next ? 'Hide Labels' : 'Show Labels';
  });

  // ---------------- helpers ----------------
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- global re-render on any data change ----------------
  function renderAll() {
    renderLockButton();
    renderWarehouseSummary();
    renderZonesGate();
    renderZonesTable();
    renderDoorsGate();
    renderWallOptions();
    renderDoorsTable();
    renderBayTable();
    renderRackTemplateOptions();
    renderRacksGate();
    renderRacksTable();
    renderLegend();
    if (currentTab === 'plan2d' && window.Canvas2D) window.Canvas2D.render();
    if (currentTab === 'view3d' && window.ThreeView) window.ThreeView.render(store);
    if (currentTab === 'doors') renderDoorsPlanPreview();
    if (currentTab === 'zones') renderZonesPlanPreview();
    if (currentTab === 'racks') renderRacksPlanPreview();
    // Runs last — after every table above has rebuilt its rows (and thus its
    // Edit/Delete/Convert buttons) from scratch — so the disabled state
    // always applies to the DOM that's actually on screen.
    applyLockUI();
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
