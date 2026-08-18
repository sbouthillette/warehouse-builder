// guidedPickingDemo.js — "Guided Picking" concept preview.
//
// IMPORTANT: this is a demo aid, not a real feature. Nothing in this file
// reads inventory with the intent to mutate it, calls any Store method that
// changes data, or persists anything. "Confirm Pick" advances a scripted
// walkthrough — it does not deduct inventory, scan a barcode, or touch the
// database. The pick list IS built from the current warehouse's real
// inventory (so it looks authentic rather than canned), but that's the only
// thing "real" about it.
//
// Shows a phone-frame mockup of what a picker's handheld screen could look
// like, paired with the actual 2D plan (a second, independent PlanView
// instance — see canvas2d.js) highlighting the current task's target
// location via the pickHighlight draft key added there for this purpose.

(function () {
  const store = window.WarehouseStore;
  const Model = window.WarehouseModel;

  const openBtn = document.getElementById('btnGuidedPickingDemo');
  const modal = document.getElementById('guidedPickingModal');
  if (!openBtn || !modal) return; // markup not present — nothing to wire up

  const closeBtn = document.getElementById('btnCloseGuidedPickingModal');
  const emptyEl = document.getElementById('guidedPickingEmpty');
  const bodyEl = document.getElementById('guidedPickingBody');
  const pickerScreenEl = document.getElementById('pickerScreen');
  const planCanvas = document.getElementById('guidedPickingPlanCanvas');

  let planView = null;
  let tasks = [];
  let demoPhase = 'intro'; // 'intro' | 'generating' | 'task' | 'done'
  let taskIndex = 0;
  let demoStartedAt = null;
  let pulsePhase = 0;
  let rafId = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- Task list, built from real (but not mutated) inventory ----------------
  // One task per {occupied location, part number} pair — a location with
  // three part numbers on it yields three tasks. Capped and shuffled so a
  // warehouse with a lot of inventory still gets a short, presentable demo
  // rather than a 200-item marathon.
  const MAX_TASKS = 5;
  function buildTaskList() {
    const inv = store.data.inventory || [];
    const catalogByPn = new Map((store.data.itemCatalog || []).map((it) => [it.partNumber, it]));
    const candidates = [];
    inv.forEach((line) => {
      (line.contents || []).forEach((c) => {
        const item = catalogByPn.get(c.partNumber);
        candidates.push({
          code: line.code,
          rackId: line.rackId,
          rackName: line.rackName,
          bayIndex: line.bayIndex,
          bayLabel: line.bayLabel,
          levelNumber: line.levelNumber,
          locationLabel: line.locationLabel,
          partNumber: c.partNumber,
          quantity: c.quantity,
          description: (item && item.description) || c.partNumber
        });
      });
    });
    // Fisher-Yates — a different-feeling task order each time the demo is
    // opened, without needing real "pick optimization" logic behind it.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
    }
    return candidates.slice(0, MAX_TASKS);
  }

  // ---------------- Live 2D plan panel (separate PlanView instance) ----------------
  function ensurePlanView() {
    if (!planView && planCanvas && window.PlanView) {
      planView = window.PlanView.create(planCanvas);
    }
  }
  function updatePlanHighlight() {
    if (!planView || demoPhase !== 'task') return;
    const t = tasks[taskIndex];
    if (!t) return;
    planView.render({ pickHighlight: { rackId: t.rackId, bayIndex: t.bayIndex, phase: pulsePhase } });
  }
  function clearPlanHighlight() {
    if (!planView) return;
    planView.render({ pickHighlight: null });
  }
  function startPulseLoop() {
    stopPulseLoop();
    const tick = () => {
      pulsePhase += 0.08;
      updatePlanHighlight();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  function stopPulseLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ---------------- Screens ----------------
  function setScreenMode(mode) {
    pickerScreenEl.classList.remove('picker-screen-light', 'picker-screen-dark');
    pickerScreenEl.classList.add(mode === 'dark' ? 'picker-screen-dark' : 'picker-screen-light');
  }

  function taskCardHtml(t) {
    return `<div class="picker-task-card">
      <span class="picker-task-dot"></span>
      <div class="picker-task-info">
        <div class="picker-task-name">${escapeHtml(t.description)}</div>
        <div class="picker-task-meta">${escapeHtml(t.code)}</div>
      </div>
      <div class="picker-task-qty">×${t.quantity}</div>
    </div>`;
  }

  function renderIntro() {
    demoPhase = 'intro';
    stopPulseLoop();
    clearPlanHighlight();
    setScreenMode('light');
    pickerScreenEl.innerHTML = `
      <div class="picker-header">
        <p class="picker-subtitle">Today</p>
        <h3 class="picker-title">My Picking Tasks</h3>
      </div>
      <div class="picker-screen-scroll">
        <div class="picker-task-list">${tasks.map(taskCardHtml).join('')}</div>
      </div>
      <div class="picker-cta-wrap">
        <button type="button" class="picker-cta" id="pickerStartBtn">Start Picking (${tasks.length})</button>
      </div>`;
    document.getElementById('pickerStartBtn').addEventListener('click', startPicking);
  }

  function renderGenerating() {
    demoPhase = 'generating';
    stopPulseLoop();
    clearPlanHighlight();
    setScreenMode('dark');
    pickerScreenEl.innerHTML = `
      <div class="picker-generating">
        <div class="picker-spinner"></div>
        <div>
          <div class="picker-title" style="font-size:18px;">Generating your route…</div>
          <p class="picker-subtitle">Optimizing ${tasks.length} stop${tasks.length === 1 ? '' : 's'}</p>
        </div>
      </div>`;
  }

  // Decorative route abstraction only — the REAL target location is shown
  // precisely on the 2D plan alongside the phone. This is just flavor, the
  // same way the reference design used a stylized dot-grid rather than a
  // literal mini floor plan on a 3-inch screen.
  function routeDotsHtml(index) {
    const total = 15;
    const current = (index * 7 + 4) % total;
    const path = new Set([0, 1, 2].map((i) => (current - i - 1 + total) % total));
    let html = '';
    for (let i = 0; i < total; i++) {
      if (i === current) html += '<span class="picker-route-dot picker-route-dot-current"></span>';
      else if (path.has(i)) html += '<span class="picker-route-dot picker-route-dot-path"></span>';
      else html += '<span class="picker-route-dot"></span>';
    }
    return html;
  }

  function renderTask(index) {
    demoPhase = 'task';
    taskIndex = index;
    const t = tasks[index];
    setScreenMode('dark');
    pickerScreenEl.innerHTML = `
      <div class="picker-task-progress">Task ${index + 1} of ${tasks.length}</div>
      <div class="picker-location-big">${escapeHtml(t.code)}</div>
      <div class="picker-location-sub">Rack ${escapeHtml(t.rackName)} · ${escapeHtml(t.bayLabel)} · Level ${t.levelNumber} · Pos ${escapeHtml(t.locationLabel || '1')}</div>
      <div class="picker-route-map">${routeDotsHtml(index)}</div>
      <div class="picker-item-card">
        <div class="picker-item-icon">📦</div>
        <div class="picker-item-info">
          <div class="picker-item-name">${escapeHtml(t.description)}</div>
          <div class="picker-item-sku">${escapeHtml(t.partNumber)}</div>
        </div>
        <div class="picker-item-qty">×${t.quantity}</div>
      </div>
      <div class="picker-cta-wrap">
        <button type="button" class="picker-cta" id="pickerConfirmBtn">Confirm Pick</button>
      </div>
      <div class="picker-checkmark-overlay" id="pickerCheckmark"><div class="picker-checkmark-circle">✓</div></div>`;
    document.getElementById('pickerConfirmBtn').addEventListener('click', confirmPick);
    startPulseLoop();
  }

  function renderDone() {
    demoPhase = 'done';
    stopPulseLoop();
    clearPlanHighlight();
    setScreenMode('dark');
    const elapsedS = Math.max(1, Math.round((Date.now() - (demoStartedAt || Date.now())) / 1000));
    const totalQty = tasks.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
    pickerScreenEl.innerHTML = `
      <div class="picker-done">
        <div class="picker-done-icon">✓</div>
        <h3 class="picker-done-title">All Picks Complete</h3>
        <p class="picker-done-summary">${tasks.length} item${tasks.length === 1 ? '' : 's'} picked (${totalQty} units) across ${tasks.length} location${tasks.length === 1 ? '' : 's'} in ${elapsedS}s.</p>
        <div class="picker-cta-wrap" style="width:100%;">
          <button type="button" class="picker-cta" id="pickerRestartBtn">Restart Demo</button>
        </div>
      </div>`;
    document.getElementById('pickerRestartBtn').addEventListener('click', restartDemo);
  }

  function startPicking() {
    demoStartedAt = Date.now();
    renderGenerating();
    setTimeout(() => {
      if (modal.hidden) return; // closed mid-transition — don't render into a hidden modal
      renderTask(0);
    }, 1300);
  }

  function confirmPick() {
    const overlay = document.getElementById('pickerCheckmark');
    if (overlay) overlay.classList.add('show');
    setTimeout(() => {
      if (modal.hidden) return;
      if (taskIndex < tasks.length - 1) {
        renderTask(taskIndex + 1);
      } else {
        renderDone();
      }
    }, 650);
  }

  function restartDemo() {
    tasks = buildTaskList();
    taskIndex = 0;
    demoStartedAt = null;
    renderIntro();
  }

  // ---------------- Open / close ----------------
  function openDemo() {
    tasks = buildTaskList();
    taskIndex = 0;
    demoStartedAt = null;
    modal.hidden = false;
    if (!tasks.length) {
      emptyEl.classList.add('show');
      bodyEl.style.display = 'none';
      return;
    }
    emptyEl.classList.remove('show');
    bodyEl.style.display = '';
    ensurePlanView();
    if (planView) planView.resetView();
    renderIntro();
  }

  function closeDemo() {
    modal.hidden = true;
    stopPulseLoop();
  }

  openBtn.addEventListener('click', openDemo);
  if (closeBtn) closeBtn.addEventListener('click', closeDemo);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDemo(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDemo(); });
})();
