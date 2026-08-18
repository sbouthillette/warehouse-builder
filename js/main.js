// main.js — app controller: tabs, forms, tables, wiring to model + renderers
(function () {
  const store = window.WarehouseStore;
  let currentTab = 'warehouse';
  let editingZoneId = null;
  let editingWallId = null;
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
      window.ZonesPlanView.resetView(zonesPlanDraftPayload());
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

  // ---------------- Admin-only UI: Export/Import JSON + Manage Access ----------------
  // Both are gated on whether the signed-in email is an admin in the
  // allowed_emails table (see lib/allowlist.js / api/auth/me.js). Everyone
  // else who's signed in can still see and edit warehouse data normally —
  // this just hides the raw project-file shortcut and the access-list
  // editor. It's a UI convenience, not a hard security boundary: the
  // underlying warehouse data is already visible to any signed-in user
  // through the app itself.
  (async function applyAdminOnlyUI() {
    let isAdmin = false;
    let email = null;
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const me = await res.json();
        isAdmin = !!me.isAdmin;
        email = me.email || null;
      }
    } catch (err) {
      console.error('Could not determine admin status', err);
    }
    if (isAdmin) {
      document.getElementById('btnExport').hidden = false;
      document.getElementById('importJsonLabel').hidden = false;
      document.getElementById('btnManageAccess').hidden = false;
      document.getElementById('btnVisitorLog').hidden = false;
      document.getElementById('btnReplayTour').hidden = false;
      // Guest-only button (see index.html) — admins get Import JSON in
      // this spot instead.
      document.getElementById('btnVisitWebsite').hidden = true;
    }
    // Prefill the Calendly popup (see setupScheduleDemoButton below) with
    // who's asking, once we know it — Calendly's own booking form still
    // asks for name/email regardless, this just saves a retype.
    window.__scheduleDemoPrefillEmail = email || null;
  })();

  // Admin-only: replay the first-time guided tour (js/tour.js) on demand,
  // rather than needing to clear localStorage to see it again.
  document.getElementById('btnReplayTour').addEventListener('click', () => {
    if (window.SpatialisTour) window.SpatialisTour.start({ force: true });
  });

  // ---------------- "Schedule a Full Demo" (Calendly) ----------------
  // Opens a real scheduler (Calendly's popup widget) against the Spatialis
  // OS calendar, rather than drafting an email — see README.md, "Set up
  // Schedule a Full Demo", for how the button's href gets pointed at an
  // actual Calendly event. Nothing is booked by the click itself: Calendly
  // opens its own scheduling UI, and a visitor still has to pick a slot
  // and explicitly confirm inside it — so this doesn't need a separate
  // "are you sure" step of its own the way the old mailto button did.
  (function setupScheduleDemoButton() {
    const trigger = document.getElementById('btnScheduleDemo');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      const opts = { url: trigger.href };
      if (window.__scheduleDemoPrefillEmail) {
        opts.prefill = { email: window.__scheduleDemoPrefillEmail };
      }
      if (window.Calendly && typeof window.Calendly.initPopupWidget === 'function') {
        window.Calendly.initPopupWidget(opts);
      } else {
        // The widget script didn't load (offline, blocked by an ad
        // blocker, etc.) — fall back to a plain navigation to the same
        // Calendly page in a new tab rather than doing nothing.
        window.open(trigger.href, '_blank', 'noopener');
      }
    });

    // Calendly's embedded popup posts this message to the page the moment
    // a booking actually completes — before the visitor even closes the
    // popup (see developer.calendly.com/embed-api). That's how the admin-
    // only Visitor Log can show who's actually scheduled a demo, not just
    // who clicked the button: this fires only on a real completed
    // booking, not on opening the scheduler or picking a time. Bound once
    // here (not inside the click handler) so it isn't re-registered on
    // every click. Can't see bookings made through the plain-navigation
    // fallback above (a real new tab, no message-passing back here).
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data.event !== 'string' || e.data.event.indexOf('calendly.') !== 0) return;
      if (e.data.event !== 'calendly.event_scheduled') return;
      fetch('/api/record-demo-scheduled', { method: 'POST' }).catch((err) => {
        console.error('Could not record the demo booking', err);
      });
    });
  })();

  // ---------------- Manage Access modal (admin-only) ----------------
  (function setupAccessModal() {
    const modal = document.getElementById('accessModal');
    const tbody = document.getElementById('accessTableBody');
    const errorEl = document.getElementById('accessError');
    const addForm = document.getElementById('accessAddForm');
    const addEmailInput = document.getElementById('accessAddEmail');
    const addAdminCheckbox = document.getElementById('accessAddIsAdmin');

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    async function loadAccessList() {
      tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
      clearError();
      try {
        const res = await fetch('/api/admin/allowed-emails');
        const list = await res.json();
        if (!res.ok) throw new Error(list.error || 'Failed to load the access list.');
        renderAccessTable(list);
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="3">Couldn’t load the access list.</td></tr>';
        showError(err.message);
      }
    }

    function renderAccessTable(list) {
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3">No one on the list yet.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map((row) => `
        <tr data-email="${escapeHtml(row.email)}">
          <td>${escapeHtml(row.email)}</td>
          <td><input type="checkbox" class="access-admin-toggle" ${row.isAdmin ? 'checked' : ''} /></td>
          <td><button type="button" class="icon-btn access-remove-btn" title="Remove">✕</button></td>
        </tr>
      `).join('');
    }

    tbody.addEventListener('change', async (e) => {
      if (!e.target.classList.contains('access-admin-toggle')) return;
      const row = e.target.closest('tr');
      const email = row.dataset.email;
      const isAdmin = e.target.checked;
      clearError();
      try {
        const res = await fetch('/api/admin/allowed-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, isAdmin })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Could not update that entry.');
      } catch (err) {
        e.target.checked = !isAdmin; // revert the checkbox
        showError(err.message);
      }
    });

    tbody.addEventListener('click', async (e) => {
      if (!e.target.classList.contains('access-remove-btn')) return;
      const row = e.target.closest('tr');
      const email = row.dataset.email;
      if (!confirm(`Remove ${email} from the access list? They'll be signed out of the app immediately.`)) return;
      clearError();
      try {
        const res = await fetch(`/api/admin/allowed-emails?email=${encodeURIComponent(email)}`, { method: 'DELETE' });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Could not remove that entry.');
        row.remove();
      } catch (err) {
        showError(err.message);
      }
    });

    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = addEmailInput.value.trim();
      const isAdmin = addAdminCheckbox.checked;
      if (!email) return;
      clearError();
      try {
        const res = await fetch('/api/admin/allowed-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, isAdmin })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Could not add that address.');
        addEmailInput.value = '';
        addAdminCheckbox.checked = false;
        await loadAccessList();
      } catch (err) {
        showError(err.message);
      }
    });

    document.getElementById('btnManageAccess').addEventListener('click', () => {
      modal.hidden = false;
      loadAccessList();
    });
    document.getElementById('btnCloseAccessModal').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  })();

  // ---------------- Visitor Log modal (admin-only) ----------------
  // Answers "I emailed people the app URL — who actually visited?" by
  // showing, per invited address, how many times they've signed in and
  // when (see api/admin/login-history.js / sql/login_events.sql).
  (function setupVisitorLogModal() {
    const modal = document.getElementById('visitorLogModal');
    const tbody = document.getElementById('visitorLogTableBody');
    const errorEl = document.getElementById('visitorLogError');
    let lastList = [];

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    function formatDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return isNaN(d) ? '—' : d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    }

    async function loadVisitorLog() {
      tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
      clearError();
      try {
        const res = await fetch('/api/admin/login-history');
        const list = await res.json();
        if (!res.ok) throw new Error(list.error || 'Failed to load the visitor log.');
        lastList = list;
        renderVisitorLogTable(list);
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7">Couldn’t load the visitor log.</td></tr>';
        showError(err.message);
      }
    }

    function renderVisitorLogTable(list) {
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7">No one on the access list yet.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map((row) => `
        <tr>
          <td style="text-align:left">${escapeHtml(row.email)}${row.isAdmin ? ' <span class="hint" style="display:inline;margin:0;">(admin)</span>' : ''}</td>
          <td>${formatDate(row.invitedAt)}</td>
          <td>${row.visitCount > 0 ? row.visitCount : '<span class="visitor-log-never">Never</span>'}</td>
          <td>${formatDate(row.firstVisit)}</td>
          <td>${formatDate(row.lastVisit)}</td>
          <td>${row.demoCount > 0 ? row.demoCount : '<span class="visitor-log-never">—</span>'}</td>
          <td>${formatDate(row.lastDemo)}</td>
        </tr>
      `).join('');
    }

    document.getElementById('btnVisitorLog').addEventListener('click', () => {
      modal.hidden = false;
      loadVisitorLog();
    });
    document.getElementById('btnCloseVisitorLogModal').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
    document.getElementById('btnRefreshVisitorLog').addEventListener('click', () => loadVisitorLog());

    // Every individual sign-in (not the on-screen table's per-address
    // summary) as a downloadable .xlsx — mirrors the "Export Location List
    // (.xlsx)" pattern elsewhere in the app (same SheetJS library, already
    // loaded via the <script> tag in index.html).
    document.getElementById('btnExportVisitorLog').addEventListener('click', async (e) => {
      if (typeof XLSX === 'undefined') { alert('The Excel library did not load — check your connection and try again.'); return; }
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Exporting…';
      clearError();
      try {
        const res = await fetch('/api/admin/login-history?format=events');
        const events = await res.json();
        if (!res.ok) throw new Error(events.error || 'Failed to load the visit log.');
        if (events.length === 0) {
          showError('No sign-ins recorded yet — nothing to export.');
          return;
        }
        const rows = events.map((ev) => ({
          'Email': ev.email,
          'Admin': ev.isAdmin ? 'Yes' : 'No',
          'Signed In At': formatDate(ev.loggedInAt),
          'User Agent': ev.userAgent || '',
          'IP': ev.ip || '',
          'Demos Scheduled': ev.demoCount || 0
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Visits');
        const stamp = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `spatialis_visitor_log_${stamp}.xlsx`);
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    document.getElementById('btnCopyNeverVisited').addEventListener('click', async (e) => {
      const neverVisited = lastList.filter((row) => !row.visitCount).map((row) => row.email);
      clearError();
      if (neverVisited.length === 0) {
        showError('Everyone on the access list has visited at least once.');
        return;
      }
      const btn = e.currentTarget;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(neverVisited.join(', '));
        btn.textContent = 'Copied!';
      } catch (err) {
        showError('Could not copy to clipboard — your browser may be blocking it.');
      }
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  })();

  // ---------------- Photo lightbox (quasi-fullscreen product photo) ------
  // Any <img class="lightbox-trigger"> anywhere in the app opens here at
  // full size — the click-a-box-in-3D info panel photo, Items-tab table
  // thumbnails, and the Add Item form's upload preview. Delegated on
  // document rather than bound per-image, since the info panel's photos are
  // rebuilt from scratch (innerHTML) every time a different box is clicked.
  (function setupPhotoLightbox() {
    const overlay = document.getElementById('photoLightbox');
    const img = document.getElementById('photoLightboxImg');
    if (!overlay || !img) return;

    function open(src, alt) {
      if (!src) return;
      img.src = src;
      img.alt = alt || '';
      overlay.hidden = false;
    }
    function close() {
      overlay.hidden = true;
      img.src = '';
    }

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('.lightbox-trigger');
      if (!trigger || trigger.tagName !== 'IMG' || !trigger.src) return;
      open(trigger.src, trigger.alt);
    });
    document.getElementById('btnClosePhotoLightbox').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  })();

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
      '#tab-doors .split-params-col, #tab-bays .split-params-col, #tab-racks .split-params-col, ' +
      '#tab-items .split-params-col'
    ).forEach((col) => {
      col.querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = locked; });
    });
    document.querySelectorAll(
      '#zonesTable .icon-btn, #doorsTable .icon-btn, #bayTable .icon-btn, #racksTable .icon-btn, ' +
      '#inventoryTable .icon-btn, #itemsTable .icon-btn, #locationBarcodesTable .icon-btn'
    ).forEach((el) => { el.disabled = locked; });
    // Location Barcodes table lives directly on the Inventory tab (not
    // inside a .split-params-col), so its inline barcode inputs need their
    // own disabled toggle here.
    document.querySelectorAll('#locationBarcodesTable .barcode-input').forEach((el) => { el.disabled = locked; });
    const fillBarcodesBtn = document.getElementById('btnFillBarcodesFromCode');
    if (fillBarcodesBtn) fillBarcodesBtn.disabled = locked;
    const clearBarcodesBtn = document.getElementById('btnClearAllBarcodes');
    if (clearBarcodesBtn) clearBarcodesBtn.disabled = locked;
    const delBtn = document.getElementById('btnDeleteWarehouse');
    if (delBtn) delBtn.disabled = locked;
    // Inventory tab isn't a split-editor form — Export is read-only and
    // stays enabled even when locked; only the mutating controls (Import,
    // Clear) get disabled.
    const importInv = document.getElementById('fileImportInventory');
    if (importInv) {
      importInv.disabled = locked;
      // The input itself is visually hidden (a <label class="btn"> wraps
      // it) — disabling the input alone blocks the click, but toggle the
      // label's own disabled look too so it doesn't look clickable.
      if (importInv.closest('.file-btn')) importInv.closest('.file-btn').classList.toggle('is-disabled', locked);
    }
    const clearInv = document.getElementById('btnClearInventory');
    if (clearInv) clearInv.disabled = locked;
    document.querySelectorAll('#formAddInventory input, #formAddInventory select, #formAddInventory button')
      .forEach((el) => { el.disabled = locked; });
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
    mezzFormPopulated = false; // a different warehouse loaded — re-populate mezzanine fields from it
    renderMezzanineGate();
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
    renderMezzanineGate(); // first save transitions the mezzanine form from gated to visible
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

  // ---------------- Mezzanine (part of Tab 1: Warehouse Shell) ----------------
  // A raised second floor with its own rectangular footprint — needs a saved
  // warehouse shell to attach to (setMezzanine requires store.data.warehouse),
  // so the form is gated the same way Zones/Doors/etc. gate on "add a rack
  // first" style prerequisites.
  let mezzFormPopulated = false; // avoid clobbering in-progress edits on every renderAll()
  function renderMezzanineGate() {
    const hasWarehouse = !!store.data.warehouse;
    const gate = document.getElementById('mezzanineGate');
    const form = document.getElementById('formMezzanine');
    if (!gate || !form) return;
    gate.classList.toggle('show', !hasWarehouse);
    gate.textContent = 'Save the warehouse shell above before configuring a mezzanine.';
    form.hidden = !hasWarehouse;
    if (hasWarehouse && !mezzFormPopulated) {
      const mz = store.data.warehouse.mezzanine || Model.normalizeMezzanine(null);
      document.getElementById('mezzEnabled').checked = !!mz.enabled;
      document.getElementById('mezzHeight').value = mz.heightMm;
      document.getElementById('mezzThickness').value = mz.deckThicknessMm;
      document.getElementById('mezzX').value = mz.x;
      document.getElementById('mezzY').value = mz.y;
      document.getElementById('mezzWidth').value = mz.width;
      document.getElementById('mezzDepth').value = mz.depth;
      mezzFormPopulated = true;
    }
  }

  document.getElementById('formMezzanine').addEventListener('submit', (e) => {
    e.preventDefault();
    store.setMezzanine({
      enabled: document.getElementById('mezzEnabled').checked,
      heightMm: document.getElementById('mezzHeight').value,
      deckThicknessMm: document.getElementById('mezzThickness').value,
      x: document.getElementById('mezzX').value,
      y: document.getElementById('mezzY').value,
      width: document.getElementById('mezzWidth').value,
      depth: document.getElementById('mezzDepth').value
    });
  });

  // ---------------- Tab 2: Zones, Obstacles & Walls ----------------
  // All three record types (flat zones, raised obstacles, interior walls)
  // share one form and one plan preview/table — the Kind select decides
  // which shape the rest of the form represents at any moment, and which
  // Store methods (addZone/updateZone vs addWall/updateWall) get called on
  // submit. editingZoneId and editingWallId are mutually exclusive — loading
  // one into the form always clears the other, so the submit handler can
  // tell unambiguously what's being edited.
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

  // Swaps the form to match whichever Kind is selected: Obstacles are
  // raised (need a height) and use a different type vocabulary than flat
  // Zones; Walls replace the type/width/length/color fields entirely with
  // an end point and a thickness, and reuse the X/Y fields as a start point
  // instead of an offset. Only obstacles may be round; switching away from
  // Obstacle forces shape='rect'.
  function updateZoneKindUI() {
    const kind = zoneKindSelect.value;
    const isWall = kind === 'wall';
    const isObstacle = kind === 'obstacle';

    document.getElementById('zoneNameLabelText').textContent =
      isWall ? 'Wall Name' : (isObstacle ? 'Obstacle Name' : 'Zone Name');

    document.getElementById('zoneTypeLabel').hidden = isWall;
    document.getElementById('zoneType').required = !isWall;

    document.getElementById('zoneShapeLabel').hidden = !isObstacle;
    if (!isObstacle) zoneShapeSelect.value = 'rect';

    document.getElementById('zoneXLabelText').textContent = isWall ? 'Start X (m)' : 'X offset (m)';
    document.getElementById('zoneYLabelText').textContent = isWall ? 'Start Y (m)' : 'Y offset (m)';

    document.getElementById('zoneWidthLabel').hidden = isWall;
    document.getElementById('zoneWidth').required = !isWall;

    document.getElementById('wallEndXLabel').hidden = !isWall;
    document.getElementById('wallEndX').required = isWall;
    document.getElementById('wallEndYLabel').hidden = !isWall;
    document.getElementById('wallEndY').required = isWall;
    document.getElementById('wallThicknessLabel').hidden = !isWall;
    document.getElementById('wallThicknessField').required = isWall;

    document.getElementById('zoneHeightLabel').hidden = kind === 'zone';
    document.getElementById('zoneHeight').required = kind !== 'zone';
    document.getElementById('zoneHeightLabelText').textContent = isWall ? 'Height (m)' : 'Height (m) — how tall it stands';

    document.getElementById('zoneColorLabel').hidden = isWall;

    const noun = isWall ? 'Wall' : (isObstacle ? 'Obstacle' : 'Zone');
    const editing = isWall ? editingWallId : editingZoneId;
    formZone.querySelector('button[type=submit]').textContent = editing ? `Update ${noun}` : `Add ${noun}`;
    updateZoneShapeUI();
  }

  // A round obstacle (e.g. a column) is defined by a single diameter — swap
  // the Width field's label to "Diameter" and hide the Length field, which
  // stays in sync with Width behind the scenes (see getDraftShape and
  // Store._normalizeZonePayload). Length also stays hidden for Wall, which
  // doesn't use it at all (see updateZoneKindUI above).
  function updateZoneShapeUI() {
    const kind = zoneKindSelect.value;
    const isWall = kind === 'wall';
    const isRound = kind === 'obstacle' && zoneShapeSelect.value === 'round';
    document.getElementById('zoneWidthLabelText').textContent = isRound ? 'Diameter (m)' : 'Width — X axis (m)';
    document.getElementById('zoneLengthLabel').hidden = isWall || isRound;
    document.getElementById('zoneLength').required = !isWall && !isRound;
  }

  zoneKindSelect.addEventListener('change', () => {
    const kind = zoneKindSelect.value;
    populateZoneTypeOptions(kind);
    document.getElementById('zoneColor').value = kind === 'obstacle' ? '#5f5e5a' : '#BC5C92';
    document.getElementById('zoneHeight').value = kind === 'wall' ? ((store.data.warehouse && store.data.warehouse.height) || 3) : 2;
    updateZoneKindUI();
    renderZonesPlanPreview();
  });

  zoneShapeSelect.addEventListener('change', () => {
    updateZoneShapeUI();
    renderZonesPlanPreview();
  });

  // True if this zone/obstacle sits entirely within the warehouse shell —
  // used for both the live draft preview (red highlight) and to hard-block
  // Add/Update. Mirrors isRackFootprintValid's role for racks.
  function isZoneFootprintValid(z) {
    const wh = store.data.warehouse;
    if (!wh || !wh.shape || wh.shape.length < 3) return false;
    return Model.zoneFullyInsidePolygon(z, wh.shape);
  }

  // True if this wall's centerline sits entirely within the warehouse shell
  // — used for both the live draft preview (red highlight) and to hard-block
  // Add/Update. Mirrors isZoneFootprintValid's role for zones/obstacles.
  function isWallValid(w) {
    const wh = store.data.warehouse;
    if (!wh || !wh.shape || wh.shape.length < 3) return false;
    return Model.wallFullyInsidePolygon(w, wh.shape);
  }

  // Reads the current (unsaved) form values into a plain zone/obstacle- or
  // wall-shaped draft, tagged with which one it is — the Kind select
  // decides which shape the rest of the form currently represents. Used for
  // both the live plan-preview highlight and (rebuilt from raw field values
  // again) the Add/Update submit handler.
  function getDraftShape() {
    const kind = zoneKindSelect.value;
    if (kind === 'wall') {
      const draft = {
        x1: Number(document.getElementById('zoneX').value) || 0,
        y1: Number(document.getElementById('zoneY').value) || 0,
        x2: Number(document.getElementById('wallEndX').value) || 0,
        y2: Number(document.getElementById('wallEndY').value) || 0,
        thickness: Number(document.getElementById('wallThicknessField').value) || 0.15,
        height: Number(document.getElementById('zoneHeight').value) || 3
      };
      draft.valid = isWallValid(draft);
      return { recordType: 'wall', draft };
    }
    const num = (id, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const shape = kind === 'obstacle' && zoneShapeSelect.value === 'round' ? 'round' : 'rect';
    const width = num('zoneWidth', 1);
    const draft = {
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
    draft.valid = isZoneFootprintValid(draft);
    return { recordType: 'zone', draft };
  }

  // Wraps getDraftShape's result in the { zone: ... } / { wall: ... } shape
  // PlanView.render()/resetView() expect — shared by the live-preview
  // listeners, the toolbar Fit button, and the tab-switch handler in
  // switchTab() above.
  function zonesPlanDraftPayload() {
    const { recordType, draft } = getDraftShape();
    return recordType === 'wall' ? { wall: draft } : { zone: draft };
  }

  function renderZonesPlanPreview() {
    if (window.ZonesPlanView) window.ZonesPlanView.render(zonesPlanDraftPayload());
  }

  const zoneLiveFields = [
    'zoneType', 'zoneX', 'zoneY', 'zoneWidth', 'zoneLength', 'zoneHeight', 'zoneColor',
    'wallEndX', 'wallEndY', 'wallThicknessField'
  ];
  zoneLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderZonesPlanPreview);
  });

  // Populates the form with an existing zone/obstacle's values and puts the
  // form into edit mode for it — used by both the name-cell click and the
  // pencil edit button (same pattern as Bay Builder).
  function loadZoneIntoForm(z) {
    editingWallId = null; // the form now represents a zone/obstacle, not a wall
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

  // Populates the form with an existing wall's values and puts the form
  // into edit mode for it — same pattern as loadZoneIntoForm above, just
  // targeting the Wall-mode fields.
  function loadWallIntoForm(w) {
    editingZoneId = null; // the form now represents a wall, not a zone/obstacle
    zoneKindSelect.value = 'wall';
    populateZoneTypeOptions('wall');
    document.getElementById('zoneName').value = w.name;
    document.getElementById('zoneX').value = w.x1;
    document.getElementById('zoneY').value = w.y1;
    document.getElementById('wallEndX').value = w.x2;
    document.getElementById('wallEndY').value = w.y2;
    document.getElementById('wallThicknessField').value = w.thickness;
    document.getElementById('zoneHeight').value = w.height;
    editingWallId = w.id;
    document.getElementById('btnCancelZoneEdit').hidden = false;
    updateZoneKindUI();
    renderZonesPlanPreview();
  }

  function exitEditMode() {
    editingZoneId = null;
    editingWallId = null;
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
    document.getElementById('wallEndX').value = 5;
    document.getElementById('wallEndY').value = 0;
    document.getElementById('wallThicknessField').value = 0.15;
    updateZoneKindUI();
    renderZonesPlanPreview();
  }

  document.getElementById('btnCancelZoneEdit').addEventListener('click', () => {
    exitEditMode();
    resetZoneForm();
  });

  document.getElementById('btnFitZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.resetView(zonesPlanDraftPayload());
  });
  document.getElementById('btnZoomInZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.zoomIn();
  });
  document.getElementById('btnZoomOutZonesPlan').addEventListener('click', () => {
    if (window.ZonesPlanView) window.ZonesPlanView.zoomOut();
  });

  // Some browsers restore a <select>'s previously-chosen option on reload
  // (bfcache / session restore) without firing a 'change' event, which would
  // leave zoneKind showing e.g. "Wall" while the form's shown/hidden fields
  // stay stuck in whatever state they were in when this script last ran
  // (typically "zone"). Force both selects back to their default option on
  // every load so the DOM value and the visible field state always start in
  // sync, then derive the UI from that known value.
  zoneKindSelect.value = 'zone';
  zoneShapeSelect.value = 'rect';
  populateZoneTypeOptions('zone');
  updateZoneKindUI();

  // Belt-and-suspenders: some browsers apply the restored value AFTER this
  // script block finishes (a later microtask/task), in which case the code
  // above would already be too early. 'pageshow' fires on every render of
  // the page, including bfcache restores, and running after that point
  // catches the case where restoration happens later than expected.
  window.addEventListener('pageshow', () => {
    if (zoneKindSelect.value !== 'zone' || zoneShapeSelect.value !== 'rect') {
      zoneKindSelect.value = 'zone';
      zoneShapeSelect.value = 'rect';
      populateZoneTypeOptions('zone');
      updateZoneKindUI();
      renderZonesPlanPreview();
    }
  });

  formZone.addEventListener('submit', (e) => {
    e.preventDefault();
    const kind = zoneKindSelect.value;
    if (kind === 'wall') {
      const payload = {
        name: document.getElementById('zoneName').value,
        x1: document.getElementById('zoneX').value,
        y1: document.getElementById('zoneY').value,
        x2: document.getElementById('wallEndX').value,
        y2: document.getElementById('wallEndY').value,
        thickness: document.getElementById('wallThicknessField').value,
        height: document.getElementById('zoneHeight').value
      };
      if (!isWallValid(payload)) {
        alert('This wall falls outside the warehouse shell (or crosses its outline). Adjust its start/end points so the whole wall sits inside before saving.');
        return;
      }
      if (editingWallId) store.updateWall(editingWallId, payload);
      else store.addWall(payload);
      exitEditMode();
      resetZoneForm();
      return;
    }
    const payload = {
      name: document.getElementById('zoneName').value,
      kind,
      shape: zoneShapeSelect.value,
      type: document.getElementById('zoneType').value,
      x: document.getElementById('zoneX').value,
      y: document.getElementById('zoneY').value,
      width: document.getElementById('zoneWidth').value,
      length: document.getElementById('zoneLength').value,
      height: document.getElementById('zoneHeight').value,
      color: document.getElementById('zoneColor').value
    };
    if (!isZoneFootprintValid(payload)) {
      const noun = payload.kind === 'obstacle' ? 'obstacle' : 'zone';
      alert(`This ${noun} falls outside the warehouse shell. Adjust its position or size so it fits entirely within the outline before saving.`);
      return;
    }
    if (editingZoneId) store.updateZone(editingZoneId, payload);
    else store.addZone(payload);
    exitEditMode();
    resetZoneForm();
  });

  function renderZonesGate() {
    const wh = store.data.warehouse;
    document.getElementById('zonesGate').classList.toggle('show', !wh);
    document.getElementById('zonesGate').textContent = 'Define the warehouse shell (Tab 1) before adding zones, obstacles, or walls.';
    document.getElementById('zonesUI').hidden = !wh;
  }

  // Neutral swatch color for wall rows in the merged table below — matches
  // the fixed gray used to draw walls in the 2D plan (canvas2d.js WALL_COLOR)
  // and the 3D view (three3d.js WALL_COLOR_3D), since walls (unlike zones/
  // obstacles) don't have a user-editable color field.
  const WALL_TABLE_COLOR = '#5f5e5a';

  // Renders the merged Zones/Obstacles/Walls table — one row per zone or
  // obstacle (unchanged from before) followed by one row per interior wall.
  // Both record types share the same click-to-edit / pencil / delete
  // pattern; only walls skip the Convert button, since converting a line
  // segment into a rectangle (or vice versa) isn't a meaningful operation.
  function renderZonesTable() {
    const tbody = document.querySelector('#zonesTable tbody');
    tbody.innerHTML = '';
    store.data.zones.forEach((z) => {
      const tr = document.createElement('tr');
      tr.dataset.id = z.id;
      tr.innerHTML = `
        <td class="name-cell" data-act="view" data-rt="zone" data-id="${z.id}" title="Click to edit"><span class="swatch" style="background:${z.color}"></span>${escapeHtml(z.name)}</td>
        <td>${z.kind === 'obstacle' ? 'Obstacle' : 'Zone'}</td>
        <td>${escapeHtml(z.type)}${z.kind === 'obstacle' && z.shape === 'round' ? ' (Round)' : ''}</td>
        <td>${z.x}, ${z.y}</td>
        <td>${z.width} × ${z.length} m</td>
        <td>${z.kind === 'obstacle' ? z.height + ' m' : '—'}</td>
        <td>
          <button class="icon-btn" data-act="convert" data-rt="zone" data-id="${z.id}" title="Convert to ${z.kind === 'obstacle' ? 'Zone' : 'Obstacle'}">⇄</button>
          <button class="icon-btn" data-act="edit" data-rt="zone" data-id="${z.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-rt="zone" data-id="${z.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    (store.data.walls || []).forEach((w) => {
      const tr = document.createElement('tr');
      tr.dataset.id = w.id;
      tr.innerHTML = `
        <td class="name-cell" data-act="view" data-rt="wall" data-id="${w.id}" title="Click to edit"><span class="swatch" style="background:${WALL_TABLE_COLOR}"></span>${escapeHtml(w.name)}</td>
        <td>Wall</td>
        <td>—</td>
        <td>(${w.x1}, ${w.y1}) → (${w.x2}, ${w.y2})</td>
        <td>Thickness ${w.thickness} m</td>
        <td>${w.height} m</td>
        <td>
          <button class="icon-btn" data-act="edit" data-rt="wall" data-id="${w.id}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-rt="wall" data-id="${w.id}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.rt === 'wall') {
        if (confirm('Delete this wall? Any doors mounted on it will be deleted too.')) store.deleteWall(b.dataset.id);
      } else if (confirm('Delete this zone/obstacle?')) {
        store.deleteZone(b.dataset.id);
      }
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
    tbody.querySelectorAll('[data-act="view"], [data-act="edit"]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.dataset.rt === 'wall') {
        const w = store.data.walls.find((ww) => ww.id === el.dataset.id);
        if (!w) return;
        loadWallIntoForm(w);
      } else {
        const z = store.data.zones.find((zz) => zz.id === el.dataset.id);
        if (!z) return;
        loadZoneIntoForm(z);
      }
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

  // Populates the Wall dropdown from the current warehouse shape's edges
  // PLUS every interior wall (Tab 3) — shell edges in one optgroup, interior
  // walls in another. Option values disambiguate the two: a plain index
  // ("0", "1", ...) means a shell edge; an "int:<id>" value means an
  // interior wall. Called whenever the Doors tab is shown and whenever the
  // shell or the wall list changes, since either can add/remove/resize walls.
  function renderWallOptions() {
    const wh = store.data.warehouse;
    const shellWalls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
    const interiorWalls = store.data.walls || [];
    const prevValue = doorWallSelect.value;
    let html = '';
    if (shellWalls.length) {
      html += `<optgroup label="Exterior (Shell)">${shellWalls.map((w) =>
        `<option value="${w.index}">Wall ${w.index + 1} — ${w.length.toFixed(1)} m</option>`
      ).join('')}</optgroup>`;
    }
    if (interiorWalls.length) {
      html += `<optgroup label="Interior Walls">${interiorWalls.map((w) => {
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        return `<option value="int:${w.id}">${escapeHtml(w.name)} — ${len.toFixed(1)} m</option>`;
      }).join('')}</optgroup>`;
    }
    doorWallSelect.innerHTML = html;
    const values = new Set([
      ...shellWalls.map((w) => String(w.index)),
      ...interiorWalls.map((w) => `int:${w.id}`)
    ]);
    if (values.has(prevValue)) doorWallSelect.value = prevValue;
  }

  // Resolves the Doors form's currently-selected wall dropdown value to
  // { wallKind, wallIndex?, wallId?, segment: {length, ...} } — shared by
  // getDraftDoor (live preview) and the submit handler (fit-length
  // validation), so both agree on exactly what "the selected wall" means.
  function resolveSelectedWall() {
    const val = doorWallSelect.value;
    if (val === '') return null;
    if (val.startsWith('int:')) {
      const wallId = val.slice(4);
      const w = (store.data.walls || []).find((ww) => ww.id === wallId);
      if (!w) return null;
      const length = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 0.0001;
      return { wallKind: 'interior', wallId, segment: { length } };
    }
    const wh = store.data.warehouse;
    const shellWalls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
    const wall = shellWalls[Number(val)];
    if (!wall) return null;
    return { wallKind: 'shell', wallIndex: Number(val), segment: wall };
  }

  // Reads the current (unsaved) Doors form values into a plain door-like
  // object, for the live plan-preview highlight as the user fills it in.
  function getDraftDoor() {
    const sel = resolveSelectedWall();
    if (!sel) return null;
    const draft = {
      wallKind: sel.wallKind,
      offset: Number(document.getElementById('doorOffset').value) || 0,
      width: Number(document.getElementById('doorWidth').value) || 0.1,
      height: Number(document.getElementById('doorHeight').value) || 0.1,
      type: doorTypeSelect.value,
      label: document.getElementById('doorLabel').value || 'Door'
    };
    if (sel.wallKind === 'interior') draft.wallId = sel.wallId;
    else draft.wallIndex = sel.wallIndex;
    return draft;
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
    doorWallSelect.value = d.wallKind === 'interior' ? `int:${d.wallId}` : String(d.wallIndex);
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
      const sel = resolveSelectedWall();
      if (!sel) { alert('Pick a wall first.'); return; }
      const offset = Number(document.getElementById('doorOffset').value) || 0;
      const width = Number(document.getElementById('doorWidth').value) || 0;
      if (offset + width > sel.segment.length + 0.001) {
        const wallLabel = sel.wallKind === 'interior' ? 'This wall' : `Wall ${sel.wallIndex + 1}`;
        alert(`This door doesn't fit — ${wallLabel} is only ${sel.segment.length.toFixed(1)} m long from that starting position.`);
        return;
      }
      const payload = {
        label: document.getElementById('doorLabel').value,
        type: doorTypeSelect.value,
        wallKind: sel.wallKind,
        wallIndex: sel.wallIndex,
        wallId: sel.wallId,
        offset: document.getElementById('doorOffset').value,
        width: document.getElementById('doorWidth').value,
        height: document.getElementById('doorHeight').value
      };
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
    const shellWalls = wh && wh.shape ? Model.wallSegments(wh.shape) : [];
    store.data.doors.forEach((d) => {
      let wallLabel;
      if (d.wallKind === 'interior') {
        const w = (store.data.walls || []).find((ww) => ww.id === d.wallId);
        wallLabel = w ? escapeHtml(w.name) : 'Interior wall (missing)';
      } else {
        const wall = shellWalls[d.wallIndex];
        wallLabel = wall ? `Wall ${d.wallIndex + 1}` : `Wall ${d.wallIndex + 1} (missing)`;
      }
      const tr = document.createElement('tr');
      tr.dataset.id = d.id;
      tr.innerHTML = `
        <td class="name-cell" data-act="view" data-id="${d.id}" title="Click to edit"><span class="swatch" style="background:${DOOR_COLORS[d.type]}"></span>${escapeHtml(d.label)}</td>
        <td>${d.type === 'garage' ? 'Garage / Dock' : 'Regular'}</td>
        <td>${wallLabel}</td>
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

  // ---------------- Ground/Mezzanine floor toggle (Racks & Aisles + 2D Plan) ----------------
  // Shared across both plan views (and the Racks table) so switching floor
  // in one place keeps the whole app consistent about which floor you're
  // looking at, rather than each view tracking it independently.
  let currentFloor = 'ground';
  function setCurrentFloor(floor) {
    currentFloor = floor === 'mezzanine' ? 'mezzanine' : 'ground';
    document.querySelectorAll('.floor-toggle-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.floor === currentFloor);
    });
    if (window.Canvas2D) window.Canvas2D.setFloor(currentFloor);
    if (window.RacksPlanView) window.RacksPlanView.setFloor(currentFloor);
    renderRacksTable();
    renderRacksPlanPreview();
  }
  document.querySelectorAll('.floor-toggle-btn').forEach((b) => {
    b.addEventListener('click', () => setCurrentFloor(b.dataset.floor));
  });

  function renderFloorToggleVisibility() {
    const mz = store.data.warehouse && store.data.warehouse.mezzanine;
    const show = !!(mz && mz.enabled);
    document.querySelectorAll('.floor-toggle').forEach((el) => { el.hidden = !show; });
    const rackFloorLabel = document.getElementById('rackFloorLabel');
    if (rackFloorLabel) rackFloorLabel.hidden = !show;
    // Mezzanine turned off entirely — fall back to Ground so nothing stays
    // stuck on a hidden, unreachable floor view.
    if (!show && currentFloor !== 'ground') setCurrentFloor('ground');
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
  // hard-block Add/Update Rack. A mezzanine-floor rack is checked against
  // the mezzanine's own (usually smaller) rectangular footprint instead of
  // the full warehouse outline, since that deck is what's actually holding it up.
  function isRackFootprintValid(x, y, rotation, lengthM, depthM, floor) {
    const wh = store.data.warehouse;
    if (!wh || !wh.shape || wh.shape.length < 3) return false;
    const corners = Model.rackCorners({ x, y, rotation, lengthM, depthM });
    if (floor === 'mezzanine') {
      const mz = wh.mezzanine;
      if (!mz || !mz.enabled) return false;
      const mzPoly = [
        { x: mz.x, y: mz.y }, { x: mz.x + mz.width, y: mz.y },
        { x: mz.x + mz.width, y: mz.y + mz.depth }, { x: mz.x, y: mz.y + mz.depth }
      ];
      return Model.rectFullyInsidePolygon(corners, mzPoly);
    }
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
    const floorEl = document.getElementById('rackFloor');
    const floor = floorEl && !floorEl.closest('label').hidden ? floorEl.value : 'ground';
    return {
      x, y,
      lengthM: fp.lengthM,
      depthM: fp.depthM,
      rotation,
      pickingSide: document.getElementById('rackPickingSide').value || 'south',
      name: document.getElementById('rackName').value || '',
      valid: isRackFootprintValid(x, y, rotation, fp.lengthM, fp.depthM, floor)
    };
  }

  function renderRacksPlanPreview() {
    if (window.RacksPlanView) window.RacksPlanView.render({ rack: getDraftRack() });
  }

  const rackLiveFields = ['rackName', 'rackBayTemplate', 'rackBayCount', 'rackRotation', 'rackX', 'rackY', 'rackPickingSide', 'rackFloor'];
  rackLiveFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderRacksPlanPreview);
  });
  // Choosing a floor in the form switches the whole app's floor view to
  // match, so the plan preview (and validity check) reflect the right
  // outline/footprint as you place the rack.
  document.getElementById('rackFloor').addEventListener('change', (e) => setCurrentFloor(e.target.value));

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
    document.getElementById('rackFloor').value = currentFloor;
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
    const mzEnabled = !!(store.data.warehouse && store.data.warehouse.mezzanine && store.data.warehouse.mezzanine.enabled);
    const floor = mzEnabled ? (document.getElementById('rackFloor').value || 'ground') : 'ground';
    const fp = store.rackFootprint({ bayTemplateId, bayCount });
    if (!isRackFootprintValid(x, y, rotation, fp.lengthM, fp.depthM, floor)) {
      const boundary = floor === 'mezzanine' ? "the mezzanine's footprint" : 'the warehouse shell';
      alert(`This rack falls outside ${boundary}. Adjust its position, rotation, or bay count so it fits entirely within the outline before saving.`);
      return;
    }
    const payload = {
      name: document.getElementById('rackName').value,
      bayTemplateId,
      bayCount,
      rotation,
      floor,
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
    // Only the currently-selected floor's racks are listed — keeps this
    // table in sync with what the plan preview above is actually showing.
    store.data.racks.filter((r) => (r.floor || 'ground') === currentFloor).forEach((r) => {
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
      document.getElementById('rackFloor').value = r.floor || 'ground';
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

  // ---------------- Tab 7: Inventory (simulated ERP/WMS feed) ----------------
  function renderInventoryGate() {
    const hasRacks = store.data.racks.length > 0;
    document.getElementById('inventoryGate').classList.toggle('show', !hasRacks);
    document.getElementById('inventoryGate').textContent = 'Add at least one rack (Tab 5) before tracking inventory.';
    document.getElementById('inventoryUI').hidden = !hasRacks;
  }

  function renderInventorySummary() {
    const el = document.getElementById('inventorySummary');
    if (!el) return;
    const total = store.listLocations().length;
    const occupied = store.data.inventory.length;
    el.innerHTML = `<strong>${occupied}</strong> of <strong>${total}</strong> location(s) occupied` +
      (total ? ` (${Math.round((occupied / total) * 100)}%)` : '');
  }

  function renderInventoryTable() {
    const tbody = document.querySelector('#inventoryTable tbody');
    tbody.innerHTML = '';
    store.data.inventory.forEach((inv) => {
      const contents = Array.isArray(inv.contents) ? inv.contents : [];
      const contentsSummary = contents.map((line) => `${line.partNumber} (${line.quantity})`).join(', ');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(inv.code)}</td>
        <td>${escapeHtml(inv.rackName || '')}</td>
        <td>${escapeHtml(inv.bayLabel || '')}</td>
        <td>${inv.levelNumber ?? ''}</td>
        <td>${escapeHtml(inv.locationLabel || '')}</td>
        <td>${escapeHtml(store.getLocationBarcode(inv.code))}</td>
        <td>${escapeHtml(inv.lpn || '')}</td>
        <td>${escapeHtml(contentsSummary)}</td>
        <td><button class="icon-btn" data-act="del" data-id="${inv.id}" title="Remove">✕</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => {
      store.setInventory(store.data.inventory.filter((inv) => inv.id !== b.dataset.id));
    }));
  }

  // Location Code dropdown for the "Add Inventory Manually" form. Lists
  // every addressable location (same source as the Excel export), marking
  // ones that already have contents as "(pallet)" or "(boxes)" — matches
  // the LPN-present-vs-blank distinction store.addInventoryLine() enforces,
  // so it's obvious up front whether picking that location means "add
  // another part number to the pallet already there" (needs its LPN) or
  // "pile on another box" (leave LPN blank), or that it's blocked outright.
  function renderInventoryLocationOptions() {
    const select = document.getElementById('invAddLocationCode');
    if (!select) return;
    const current = select.value;
    const occupiedByCode = new Map(store.data.inventory.map((inv) => [inv.code, inv]));
    select.innerHTML = '';
    store.listLocations().forEach((loc) => {
      const opt = document.createElement('option');
      opt.value = loc.code;
      const occ = occupiedByCode.get(loc.code);
      opt.textContent = occ ? `${loc.code} (${occ.lpn ? `pallet ${occ.lpn}` : 'boxes'})` : loc.code;
      select.appendChild(opt);
    });
    if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  }

  // Part Number suggestions for the same form, sourced from the Items
  // catalog (Tab 9) so manual entry doesn't require retyping/copy-pasting
  // a part number that's already on file — purely a convenience, any value
  // can still be typed in.
  function renderItemCatalogDatalist() {
    const datalist = document.getElementById('itemCatalogDatalist');
    if (!datalist) return;
    datalist.innerHTML = (store.data.itemCatalog || []).map((it) =>
      `<option value="${escapeHtml(it.partNumber)}">${escapeHtml(it.description || '')}</option>`
    ).join('');
  }

  // ---------------- Add Inventory Manually (part of Tab 7: Inventory) ----
  (function setupAddInventoryForm() {
    const form = document.getElementById('formAddInventory');
    const errorEl = document.getElementById('invAddError');
    if (!form) return;

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearError();
      const code = document.getElementById('invAddLocationCode').value;
      const lpn = document.getElementById('invAddLpn').value.trim();
      const partNumber = document.getElementById('invAddPartNumber').value.trim();
      const quantity = Number(document.getElementById('invAddQuantity').value) || 1;

      const loc = store.listLocations().find((l) => l.code === code);
      if (!loc) { showError('Pick a location — none are defined yet (add a rack on Tab 5 first).'); return; }
      if (!partNumber) { showError('Enter a part number.'); return; }
      if (quantity < 1) { showError('Quantity must be at least 1.'); return; }

      const result = store.addInventoryLine(loc, { lpn, partNumber, quantity });
      if (!result.ok) { showError(result.error); return; }

      // Leave the location AND LPN as entered (adding another part number
      // to the same pallet — or piling on another box, LPN left blank — is
      // a common next action; re-submitting as-is repeats cleanly) and only
      // clear the per-item fields.
      document.getElementById('invAddPartNumber').value = '';
      document.getElementById('invAddQuantity').value = '1';
      document.getElementById('invAddPartNumber').focus();
    });
  })();

  document.getElementById('btnExportLocations').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') { alert('The Excel library did not load — check your connection and try again.'); return; }
    const locations = store.listLocations();
    if (!locations.length) { alert('No storage locations yet — add racks and bay templates first.'); return; }
    const occupiedByCode = new Map(store.data.inventory.map((inv) => [inv.code, inv]));
    const rows = [];
    locations.forEach((loc) => {
      const existing = occupiedByCode.get(loc.code);
      const base = {
        'Location Code': loc.code,
        'Rack': loc.rackName,
        'Bay': loc.bayLabel,
        'Level': loc.levelNumber,
        'Position': loc.locationLabel,
        'Level Type': loc.levelType,
        // Pre-filled with the location's own code as a suggested barcode if
        // none has been assigned yet — overwrite with a custom value, or
        // leave as-is to use the location code as the barcode.
        'Barcode': store.getLocationBarcode(loc.code) || loc.code
      };
      if (existing && Array.isArray(existing.contents) && existing.contents.length) {
        // One row per content line — a mixed pallet with several SKUs
        // exports as several rows sharing the same Location Code + LPN.
        // To add a mixed pallet by hand, copy a row and give the copy the
        // same Location Code and LPN but a different Part Number/Quantity.
        existing.contents.forEach((line) => {
          rows.push({ ...base, 'LPN': existing.lpn || '', 'Part Number': line.partNumber, 'Quantity': line.quantity });
        });
      } else {
        rows.push({ ...base, 'LPN': '', 'Part Number': '', 'Quantity': '' });
      }
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Locations');
    const whName = (store.data.warehouse?.name || 'warehouse').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    XLSX.writeFile(wb, `${whName}_locations.xlsx`);
  });

  document.getElementById('fileImportInventory').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') { alert('The Excel library did not load — check your connection and try again.'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const byCode = new Map(store.listLocations().map((loc) => [loc.code, loc]));

        // Barcodes are processed independent of occupancy — only if the
        // sheet actually has a Barcode column at all (older exports from
        // before this feature won't have one; in that case leave every
        // existing barcode untouched rather than wiping them out). A row
        // with the column present but blank is treated as "clear this
        // location's barcode" — deliberate, since the export always fills
        // it with a value, so a blank means the user cleared it in Excel.
        const hasBarcodeColumn = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], 'Barcode');
        let barcodeChanges = 0;
        if (hasBarcodeColumn) {
          const barcodeUpdates = new Map(); // code -> barcode ('' = clear)
          rows.forEach((row) => {
            const code = String(row['Location Code'] || '').trim();
            if (!code || !byCode.has(code)) return;
            barcodeUpdates.set(code, String(row['Barcode'] || '').trim());
          });
          if (barcodeUpdates.size) {
            const merged = new Map((store.data.locationBarcodes || []).map((b) => [b.code, b.barcode]));
            barcodeUpdates.forEach((barcode, code) => {
              if (barcode) merged.set(code, barcode); else merged.delete(code);
            });
            store.setLocationBarcodes([...merged.entries()].map(([code, barcode]) => ({ code, barcode })));
            barcodeChanges = barcodeUpdates.size;
          }
        }

        // Group spreadsheet rows by Location Code first — a mixed pallet
        // spans multiple rows sharing the same code (and ideally the same LPN).
        const groups = new Map(); // code -> array of raw rows
        let unmatchedRows = 0;
        rows.forEach((row) => {
          const code = String(row['Location Code'] || '').trim();
          if (!code) return;
          const partNumber = String(row['Part Number'] || '').trim();
          if (!partNumber) return; // blank part number = location left empty
          if (!byCode.has(code)) { unmatchedRows++; return; }
          if (!groups.has(code)) groups.set(code, []);
          groups.get(code).push(row);
        });

        const matched = [];
        const lpnLocations = new Map(); // lpn -> Set of codes it appears at (blank LPNs aren't tracked here — see below)
        let mismatchedLpnGroups = 0;
        let boxesOnlyCount = 0;

        groups.forEach((groupRows, code) => {
          const loc = byCode.get(code);
          // Resolve one canonical LPN for the group: first non-blank value
          // wins. Left blank on purpose when the sheet has none — that's
          // not a data gap to paper over, it's meaningful: a blank LPN
          // means loose boxes piled in that location rather than one
          // palletized unit load, and the 3D view (three3d.js) renders it
          // that way. Don't fall back to the location code here.
          const lpnValues = groupRows.map((r) => String(r['LPN'] || '').trim()).filter(Boolean);
          const uniqueLpns = [...new Set(lpnValues)];
          const lpn = uniqueLpns[0] || '';
          if (uniqueLpns.length > 1) mismatchedLpnGroups++; // rows disagree on LPN — kept the first, flagged below
          if (!lpn) boxesOnlyCount++;

          const contents = groupRows.map((r) => ({
            partNumber: String(r['Part Number'] || '').trim(),
            quantity: Number(r['Quantity']) || 1
          })).filter((line) => line.partNumber);
          if (!contents.length) return;

          // Duplicate-LPN detection only makes sense for actual pallet
          // IDs — plenty of locations legitimately share a blank LPN (each
          // is just its own pile of loose boxes, not the same unit load).
          if (lpn) {
            if (!lpnLocations.has(lpn)) lpnLocations.set(lpn, new Set());
            lpnLocations.get(lpn).add(code);
          }

          matched.push({
            id: Model.uid('inv'),
            code: loc.code,
            rackId: loc.rackId,
            rackName: loc.rackName,
            bayIndex: loc.bayIndex,
            bayLabel: loc.bayLabel,
            levelIndex: loc.levelIndex,
            levelNumber: loc.levelNumber,
            locationIndex: loc.locationIndex,
            locationLabel: loc.locationLabel,
            lpn,
            contents
          });
        });

        const duplicateLpns = [...lpnLocations.entries()].filter(([, codes]) => codes.size > 1).length;

        store.setInventory(matched);
        let msg = `Imported ${matched.length} occupied location(s).`;
        if (unmatchedRows) msg += ` ${unmatchedRows} row(s) had a location code that doesn't match the current model (renamed rack? changed bay count?) and were skipped — try re-exporting the location list.`;
        if (mismatchedLpnGroups) msg += ` ${mismatchedLpnGroups} location(s) had rows with different LPN values for the same location — used the first one found for each.`;
        if (boxesOnlyCount) msg += ` ${boxesOnlyCount} location(s) had no LPN filled in — imported as loose boxes rather than a pallet.`;
        if (duplicateLpns) msg += ` Warning: ${duplicateLpns} LPN(s) appear at more than one location — an LPN should normally be a single physical unit load in one place.`;
        if (barcodeChanges) msg += ` Updated barcodes for ${barcodeChanges} location(s).`;
        alert(msg);
      } catch (err) {
        alert('Could not read that file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  });

  document.getElementById('btnClearInventory').addEventListener('click', () => {
    if (!store.data.inventory.length) return;
    if (confirm('Clear all inventory data? This only clears the simulated occupancy — racks and bays are unaffected.')) {
      store.clearInventory();
    }
  });

  // ---------------- Location Barcodes (part of Tab 7: Inventory) ----------------
  // A barcode identifies the physical LOCATION (a decal on the rack), not
  // whatever's currently stored there — so, unlike the occupancy table
  // above, this lists every location whether occupied or not.
  function renderLocationBarcodesTable() {
    const tbody = document.querySelector('#locationBarcodesTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    store.listLocations().forEach((loc) => {
      const tr = document.createElement('tr');
      const barcode = store.getLocationBarcode(loc.code);
      tr.innerHTML = `
        <td>${escapeHtml(loc.code)}</td>
        <td>${escapeHtml(loc.rackName || '')}</td>
        <td>${escapeHtml(loc.bayLabel || '')}</td>
        <td>${loc.levelNumber ?? ''}</td>
        <td>${escapeHtml(loc.locationLabel || '')}</td>
        <td><input type="text" class="barcode-input" data-code="${escapeHtml(loc.code)}" value="${escapeHtml(barcode)}" placeholder="—" /></td>
        <td><button class="icon-btn" data-act="usecode" data-code="${escapeHtml(loc.code)}" title="Use location code as barcode">↺</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.barcode-input').forEach((input) => {
      input.addEventListener('change', () => {
        store.setLocationBarcode(input.dataset.code, input.value);
      });
    });
    tbody.querySelectorAll('[data-act="usecode"]').forEach((b) => b.addEventListener('click', () => {
      store.setLocationBarcode(b.dataset.code, b.dataset.code);
    }));
    applyLockUI(); // rebuilt rows above start out enabled — re-apply if locked
  }

  document.getElementById('btnFillBarcodesFromCode').addEventListener('click', () => {
    const records = store.listLocations().map((loc) => ({
      code: loc.code,
      barcode: store.getLocationBarcode(loc.code) || loc.code
    }));
    store.setLocationBarcodes(records);
  });

  document.getElementById('btnClearAllBarcodes').addEventListener('click', () => {
    if (!store.data.locationBarcodes.length) return;
    if (confirm('Clear all location barcodes? This does not affect inventory or racks.')) {
      store.setLocationBarcodes([]);
    }
  });

  // ---------------- Tab 9: Items (catalog: description + photo per part number) ----------------
  const formItem = document.getElementById('formItem');
  const itemPartNumberInput = document.getElementById('itemPartNumber');
  const itemImageInput = document.getElementById('itemImage');
  const itemImagePreviewWrap = document.getElementById('itemImagePreviewWrap');
  const itemImagePreview = document.getElementById('itemImagePreview');
  let stagedItemImageDataUrl = null; // set by choosing a file (downscaled) or cleared via Remove Photo
  let editingItemPartNumber = null;  // non-null while editing an existing item

  // Downscales an uploaded image to a small thumbnail before it's stored —
  // keeps the warehouse JSON a reasonable size even with several item photos.
  function downscaleImageFile(file, maxDim) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => reject(new Error('Could not read that image.'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  itemImageInput.addEventListener('change', async () => {
    const file = itemImageInput.files[0];
    if (!file) return;
    try {
      stagedItemImageDataUrl = await downscaleImageFile(file, 300);
      itemImagePreview.src = stagedItemImageDataUrl;
      itemImagePreviewWrap.hidden = false;
    } catch (err) {
      alert(err.message);
    } finally {
      itemImageInput.value = '';
    }
  });

  document.getElementById('btnRemoveItemImage').addEventListener('click', () => {
    stagedItemImageDataUrl = null;
    itemImagePreview.src = '';
    itemImagePreviewWrap.hidden = true;
  });

  function resetItemForm() {
    editingItemPartNumber = null;
    formItem.reset();
    stagedItemImageDataUrl = null;
    itemImagePreviewWrap.hidden = true;
    itemPartNumberInput.disabled = false;
    formItem.querySelector('button[type=submit]').textContent = 'Add Item';
    document.getElementById('btnCancelItemEdit').hidden = true;
  }

  document.getElementById('btnCancelItemEdit').addEventListener('click', resetItemForm);

  formItem.addEventListener('submit', (e) => {
    e.preventDefault();
    const partNumber = itemPartNumberInput.value.trim();
    if (!partNumber) return;
    if (!editingItemPartNumber && store.getItem(partNumber)) {
      if (!confirm(`"${partNumber}" already exists in the catalog — overwrite it?`)) return;
    }
    store.setItem(partNumber, {
      description: document.getElementById('itemDescription').value.trim(),
      imageDataUrl: stagedItemImageDataUrl
    });
    resetItemForm();
  });

  function renderItemsTable() {
    const tbody = document.querySelector('#itemsTable tbody');
    tbody.innerHTML = '';
    (store.data.itemCatalog || []).forEach((it) => {
      const tr = document.createElement('tr');
      const photoCell = it.imageDataUrl
        ? `<img src="${it.imageDataUrl}" class="item-thumb lightbox-trigger" alt="" />`
        : `<div class="item-thumb-placeholder"></div>`;
      tr.innerHTML = `
        <td>${photoCell}</td>
        <td>${escapeHtml(it.partNumber)}</td>
        <td>${escapeHtml(it.description || '')}</td>
        <td>
          <button class="icon-btn" data-act="edit" data-pn="${escapeHtml(it.partNumber)}" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" data-pn="${escapeHtml(it.partNumber)}" title="Delete">✕</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => {
      const it = store.getItem(b.dataset.pn);
      if (!it) return;
      editingItemPartNumber = it.partNumber;
      itemPartNumberInput.value = it.partNumber;
      itemPartNumberInput.disabled = true; // the part number is the catalog key — edit description/photo, not identity
      document.getElementById('itemDescription').value = it.description || '';
      stagedItemImageDataUrl = it.imageDataUrl || null;
      if (stagedItemImageDataUrl) {
        itemImagePreview.src = stagedItemImageDataUrl;
        itemImagePreviewWrap.hidden = false;
      } else {
        itemImagePreviewWrap.hidden = true;
      }
      formItem.querySelector('button[type=submit]').textContent = 'Update Item';
      document.getElementById('btnCancelItemEdit').hidden = false;
      formItem.scrollIntoView({ behavior: 'smooth' });
    }));
    tbody.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm(`Remove "${b.dataset.pn}" from the item catalog?`)) return;
      store.deleteItem(b.dataset.pn);
      if (editingItemPartNumber === b.dataset.pn) resetItemForm();
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
    renderMezzanineGate();
    renderZonesGate();
    renderZonesTable();
    renderDoorsGate();
    renderWallOptions();
    renderDoorsTable();
    renderBayTable();
    renderRackTemplateOptions();
    renderRacksGate();
    renderFloorToggleVisibility();
    renderRacksTable();
    renderInventoryGate();
    renderInventorySummary();
    renderInventoryLocationOptions();
    renderItemCatalogDatalist();
    renderInventoryTable();
    renderLocationBarcodesTable();
    renderItemsTable();
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
