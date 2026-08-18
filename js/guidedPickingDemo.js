// guidedPickingDemo.js — "Guided Picking" concept preview.
//
// IMPORTANT: this is a demo aid, not a real feature. Nothing in this file
// reads inventory with the intent to mutate it, calls any Store method that
// changes data, or persists anything. "Confirm Pick" advances a scripted
// walkthrough — it does not deduct inventory, scan a barcode, or touch the
// database. The pick list IS built from the current warehouse's real
// inventory (so it looks authentic rather than canned), and product photos
// are the real ones uploaded on the Create Items tab when available — but
// that's the only thing "real" about it. The walking route drawn on the 2D
// plan is a lightweight demo-grade approximation (see buildRoute below),
// not an actual path-planning algorithm.
//
// Shows a phone-frame mockup of what a picker's handheld screen could look
// like, paired with the actual 2D plan (a second, independent PlanView
// instance in "minimal" mode — see canvas2d.js) highlighting the current
// task's target location and the planned walking route via the
// pickHighlight/pickRoute draft keys added there for this purpose.

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
  let currentRoute = null; // { legs: [{ taskIndex, points, distanceM }, ...] } — see buildRoute
  let demoPhase = 'intro'; // 'intro' | 'generating' | 'task' | 'done'
  let taskIndex = 0;
  let demoStartedAt = null;
  let pulsePhase = 0;
  let rafId = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- Product thumbnails ----------------
  // Real photos when the item has one uploaded (Create Items tab —
  // item.imageDataUrl); otherwise a colored placeholder tile (hashed from
  // the part number, so the same SKU always gets the same color) rather
  // than one generic box icon for everything.
  const THUMB_COLORS = ['#F2A93C', '#E2572E', '#BC5C92', '#2F8F4E', '#3E7CB1', '#C97E0D'];
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function productThumbHtml(t, sizeClass) {
    if (t.imageDataUrl) {
      return `<img src="${t.imageDataUrl}" class="picker-thumb ${sizeClass}" alt="${escapeHtml(t.description)}" />`;
    }
    const color = THUMB_COLORS[hashStr(t.partNumber || t.description || '') % THUMB_COLORS.length];
    return `<div class="picker-thumb picker-thumb-placeholder ${sizeClass}" style="background:${color}22;color:${color};border-color:${color}55;">📦</div>`;
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
          description: (item && item.description) || c.partNumber,
          imageDataUrl: (item && item.imageDataUrl) || null
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

  // ---------------- Route calculation (2D plan path) ----------------
  // A lightweight, demo-grade routing approximation — NOT a real path
  // planner. Each task's "stand point" is a spot in the aisle directly in
  // front of its target bay, derived from the rack's real picking-edge
  // geometry (Model.rackPickingEdge), so the route line always terminates
  // exactly where the pulsing pick highlight appears. Consecutive stops in
  // the same aisle connect with a straight line; stops in different aisles
  // connect with a simple 2-segment elbow (walk along the current aisle,
  // then turn), so the path reads as something a person could actually
  // walk instead of a diagonal cutting through rack rows.
  function computeStartPoint() {
    const wh = store.data.warehouse;
    const bounds = Model.polygonBounds(wh.shape);
    const doors = store.data.doors || [];
    if (doors.length) {
      const dp = Model.doorPoints(wh.shape, store.data.walls, doors[0]);
      if (dp) return { x: (dp.start.x + dp.end.x) / 2, y: (dp.start.y + dp.end.y) / 2, axis: 'h' };
    }
    return { x: bounds.minX + 1.5, y: bounds.minY + 1.5, axis: 'h' };
  }

  function standPointForTask(t) {
    const rack = store.data.racks.find((r) => r.id === t.rackId);
    if (!rack) return null;
    const fp = store.rackFootprint(rack);
    const edge = Model.rackPickingEdge({
      x: rack.x, y: rack.y, rotation: rack.rotation,
      lengthM: fp.lengthM, depthM: fp.depthM, pickingSide: rack.pickingSide
    });
    const bayCount = Math.max(1, rack.bayCount);
    const bayIdx = Math.max(0, Math.min(bayCount - 1, t.bayIndex || 0));
    const frac = (bayIdx + 0.5) / bayCount;
    const faceX = edge.p1.x + (edge.p2.x - edge.p1.x) * frac;
    const faceY = edge.p1.y + (edge.p2.y - edge.p1.y) * frac;
    const standOff = Math.max(0.8, Math.min((rack.aisleWidth || 3) / 2, 1.6));
    return {
      x: faceX + edge.nx * standOff,
      y: faceY + edge.ny * standOff,
      axis: edge.ny !== 0 ? 'h' : 'v' // 'h' = aisle runs along X at a fixed Y, 'v' = along Y at a fixed X
    };
  }

  function legPoints(a, b) {
    const sameAisle = a.axis === b.axis &&
      Math.abs(a.axis === 'h' ? a.y - b.y : a.x - b.x) < 0.05;
    if (sameAisle) return [a, b];
    const elbow = a.axis === 'h' ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    return [a, elbow, b];
  }

  function pathLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
      d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return d;
  }

  function buildRoute(taskList) {
    let prev = computeStartPoint();
    const legs = [];
    taskList.forEach((t, i) => {
      const stand = standPointForTask(t);
      const dest = stand || prev;
      const pts = legPoints(prev, dest);
      legs.push({ taskIndex: i, points: pts, distanceM: pathLength(pts) });
      prev = dest;
    });
    return { legs };
  }

  function allRoutePoints(route) {
    const pts = [];
    (route.legs || []).forEach((leg) => leg.points.forEach((p) => pts.push(p)));
    return pts;
  }

  // ---------------- Live 2D plan panel (separate, minimal-mode PlanView instance) ----------------
  function ensurePlanView() {
    if (!planView && planCanvas && window.PlanView) {
      planView = window.PlanView.create(planCanvas, { minimal: true });
    }
  }
  function updatePlanOverlay() {
    if (!planView || demoPhase !== 'task') return;
    const t = tasks[taskIndex];
    if (!t) return;
    planView.render({
      pickHighlight: { rackId: t.rackId, bayIndex: t.bayIndex, phase: pulsePhase },
      pickRoute: currentRoute ? { legs: currentRoute.legs, activeLegIndex: taskIndex, phase: pulsePhase } : null
    });
  }
  function clearPlanOverlay() {
    if (!planView) return;
    planView.render({ pickHighlight: null, pickRoute: null });
  }
  function startPulseLoop() {
    stopPulseLoop();
    const tick = () => {
      pulsePhase += 0.08;
      updatePlanOverlay();
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
      ${productThumbHtml(t, 'picker-thumb-sm')}
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
    clearPlanOverlay();
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

  function renderTask(index) {
    demoPhase = 'task';
    taskIndex = index;
    const t = tasks[index];
    const leg = currentRoute && currentRoute.legs[index];
    const legDist = leg ? Math.max(1, Math.round(leg.distanceM)) : null;
    setScreenMode('dark');
    pickerScreenEl.innerHTML = `
      <div class="picker-task-progress">Task ${index + 1} of ${tasks.length}</div>
      <div class="picker-leg-label">🧭 Leg ${index + 1} of ${tasks.length}${legDist != null ? ` · ~${legDist}m walk` : ''}</div>
      <div class="picker-location-big">${escapeHtml(t.code)}</div>
      <div class="picker-location-sub">Rack ${escapeHtml(t.rackName)} · ${escapeHtml(t.bayLabel)} · Level ${t.levelNumber} · Pos ${escapeHtml(t.locationLabel || '1')}</div>
      <div class="picker-item-card">
        ${productThumbHtml(t, 'picker-thumb-md')}
        <div class="picker-item-info">
          <div class="picker-item-name">${escapeHtml(t.description)}</div>
          <div class="picker-item-sku">${escapeHtml(t.partNumber)}</div>
        </div>
        <div class="picker-item-qty">×${t.quantity}</div>
      </div>
      <div class="picker-cta-wrap">
        <button type="button" class="picker-cta" id="pickerConfirmBtn">Confirm Pick</button>
      </div>`;
    document.getElementById('pickerConfirmBtn').addEventListener('click', confirmPick);
    startPulseLoop();
  }

  function renderDone() {
    demoPhase = 'done';
    stopPulseLoop();
    setScreenMode('dark');
    // Leave the full route on the plan, shown as fully "walked" (muted),
    // rather than abruptly blanking it — a small satisfying wrap-up beat.
    if (planView && currentRoute) {
      planView.render({ pickHighlight: null, pickRoute: { legs: currentRoute.legs, activeLegIndex: tasks.length, phase: 0 } });
    }
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
    currentRoute = buildRoute(tasks);
    renderGenerating();
    // Zoom the plan to just the planned route (not the whole warehouse) and
    // show it in full right away, so "Generating your route…" pays off with
    // an actual path rather than a blank map.
    if (planView) {
      planView.fitToPoints(allRoutePoints(currentRoute), 2.5, {
        pickRoute: { legs: currentRoute.legs, activeLegIndex: 0, phase: pulsePhase },
        pickHighlight: null
      });
    }
    setTimeout(() => {
      if (modal.hidden) return; // closed mid-transition — don't render into a hidden modal
      renderTask(0);
    }, 1300);
  }

  function confirmPick() {
    const btn = document.getElementById('pickerConfirmBtn');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('picker-cta-picked');
      btn.textContent = '✓ Picked';
    }
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
    currentRoute = null;
    taskIndex = 0;
    demoStartedAt = null;
    if (planView) planView.resetView();
    renderIntro();
  }

  // ---------------- Open / close ----------------
  function openDemo() {
    tasks = buildTaskList();
    currentRoute = null;
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
