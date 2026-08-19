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
  const muteBtn = document.getElementById('btnPickerMute');
  const muteIconEl = document.getElementById('pickerMuteIcon');

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

  // ---------------- Pick-to-voice narration (Web Speech API) ----------------
  // Real warehouse "pick-to-voice" systems speak each pick instruction to
  // the operator over a headset and listen for a spoken confirmation back —
  // this demo can't listen, but speaking the instruction and a short
  // acknowledgment on Confirm recreates the same call-and-response feel.
  // Fully client-side; never lets a speech failure interrupt the demo.
  //
  // The chosen voice is intentionally shared with js/tour.js (same
  // localStorage key) — picking a more natural-sounding voice once, from
  // either surface, applies everywhere. Mute state is kept separate per
  // surface, since a visitor may want the tour narrated but the picking
  // demo silent (or vice versa) depending on what they're showing someone.
  const PICKER_MUTE_KEY = 'spatialis_picker_voice_muted';
  const SHARED_VOICE_KEY = 'spatialis_narration_voice_uri';
  const synthAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  let voiceMuted = false;
  try { voiceMuted = localStorage.getItem(PICKER_MUTE_KEY) === '1'; } catch (err) { /* fine to default unmuted */ }
  let narrationVoice = null;

  const PREFERRED_VOICE_HINTS = [
    'natural', 'neural', 'premium', 'enhanced', 'siri',
    'google us english', 'google uk english',
    'samantha', 'ava', 'allison', 'susan', 'nicky', 'zoe', 'evan', 'tom',
    'aria', 'jenny', 'guy', 'sonia', 'ryan', 'libby'
  ];
  const NOVELTY_VOICE_HINTS = [
    'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
    'good news', 'hysterical', 'organ', 'pipe organ', 'trinoids', 'whisper',
    'zarvox', 'albert', 'fred', 'jester', 'wobble', 'eloquence', 'junior',
    'kathy', 'ralph', 'grandma', 'grandpa', 'rocko', 'shelley'
  ];
  function scoreVoice(v) {
    const name = (v.name || '').toLowerCase();
    let score = 0;
    if (/^en(-|_|$)/i.test(v.lang || '')) score += 5;
    if (PREFERRED_VOICE_HINTS.some((h) => name.includes(h))) score += 10;
    if (NOVELTY_VOICE_HINTS.some((h) => name.includes(h))) score -= 20;
    if (v.localService === false) score += 1;
    return score;
  }
  function refreshNarrationVoice() {
    if (!synthAvailable) return;
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (err) { voices = []; }
    if (!voices.length) return;
    const english = voices.filter((v) => /^en/i.test(v.lang || ''));
    const pool = (english.length ? english : voices).slice();
    let savedURI = null;
    try { savedURI = localStorage.getItem(SHARED_VOICE_KEY) || null; } catch (err) { /* fine to skip */ }
    const remembered = savedURI && pool.find((v) => v.voiceURI === savedURI);
    narrationVoice = remembered || pool.sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
  }
  if (synthAvailable) {
    refreshNarrationVoice();
    try { window.speechSynthesis.addEventListener('voiceschanged', refreshNarrationVoice); } catch (err) { /* older Safari lacks this */ }
  }

  function updateMuteButton() {
    if (!muteBtn) return;
    muteBtn.classList.toggle('is-muted', voiceMuted);
    muteBtn.setAttribute('aria-pressed', String(voiceMuted));
    muteBtn.title = voiceMuted ? 'Unmute pick-to-voice narration' : 'Mute pick-to-voice narration';
    muteBtn.setAttribute('aria-label', muteBtn.title);
    if (muteIconEl) muteIconEl.textContent = voiceMuted ? '🔇' : '🔊';
  }
  if (!synthAvailable && muteBtn) {
    muteBtn.hidden = true;
  } else {
    updateMuteButton();
  }
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      voiceMuted = !voiceMuted;
      try { localStorage.setItem(PICKER_MUTE_KEY, voiceMuted ? '1' : '0'); } catch (err) { /* fine to skip persisting */ }
      updateMuteButton();
      if (voiceMuted && synthAvailable) { try { window.speechSynthesis.cancel(); } catch (err) { /* ignore */ } }
    });
  }

  function speak(text) {
    if (!synthAvailable || voiceMuted || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1;
      utter.pitch = 1;
      if (narrationVoice) utter.voice = narrationVoice;
      window.speechSynthesis.speak(utter);
    } catch (err) { /* speech is a nice-to-have — never let it break the demo */ }
  }
  function stopSpeech() {
    if (synthAvailable) { try { window.speechSynthesis.cancel(); } catch (err) { /* ignore */ } }
  }
  function pickInstructionText(t) {
    const posPart = t.locationLabel ? `, position ${t.locationLabel}` : '';
    return `Go to ${t.rackName}, ${t.bayLabel}, level ${t.levelNumber}${posPart}. Pick ${t.quantity} of ${t.description}.`;
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
  // exactly where the pulsing pick highlight appears.
  //
  // Rather than guessing a route from each point's aisle orientation (which
  // breaks down whenever the two points face different directions — e.g.
  // the picker's floor-level start point vs. a rack whose picking side is
  // east/west instead of north/south — every leg is chosen by generating a
  // handful of candidate paths and picking the first one that's actually
  // verified clear of every rack's footprint, using the same rectangle
  // geometry the racks are drawn with. This is what guarantees the route
  // never gets drawn cutting through a rack, instead of just usually
  // avoiding it.
  function computeRackRectsWorld() {
    return (store.data.racks || []).map((r) => {
      const fp = store.rackFootprint(r);
      const rot = r.rotation === 90;
      const w = rot ? fp.depthM : fp.lengthM;
      const h = rot ? fp.lengthM : fp.depthM;
      return { x0: r.x, x1: r.x + w, y0: r.y, y1: r.y + h };
    });
  }

  function computeRackBoundsWorld(rackRects) {
    if (!rackRects.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    rackRects.forEach((r) => {
      minX = Math.min(minX, r.x0); maxX = Math.max(maxX, r.x1);
      minY = Math.min(minY, r.y0); maxY = Math.max(maxY, r.y1);
    });
    return { minX, maxX, minY, maxY };
  }

  function computeStartPoint() {
    const wh = store.data.warehouse;
    const bounds = Model.polygonBounds(wh.shape);
    const doors = store.data.doors || [];
    if (doors.length) {
      const dp = Model.doorPoints(wh.shape, store.data.walls, doors[0]);
      if (dp) return { x: (dp.start.x + dp.end.x) / 2, y: (dp.start.y + dp.end.y) / 2 };
    }
    return { x: bounds.minX + 1.5, y: bounds.minY + 1.5 };
  }

  // Finds where the picker should stand for a given bay — deliberately NOT
  // built from Model.rackPickingEdge's p1→p2 span. That span only covers
  // the full bay layout when the picking side's axis matches the rack's
  // rotation (south/north on an unrotated rack, east/west on a rotated
  // one); for the opposite pairing it's only as long as the rack's depth
  // (~1m), so interpolating a bay fraction across it collapses every bay
  // toward the same corner regardless of index — the route would then
  // consistently under/overshoot the real target the further the bay was
  // from that corner. Instead this computes the target bay's center
  // exactly the way the pulsing pick highlight itself is positioned (see
  // drawPickHighlight in canvas2d.js — bays subdivide along the rack's own
  // length axis, independent of picking side), then steps out from the
  // rack's chosen picking face by the aisle stand-off. That keeps the two
  // always in agreement regardless of how picking side and rotation combine.
  function standPointForTask(t) {
    const rack = store.data.racks.find((r) => r.id === t.rackId);
    if (!rack) return null;
    const fp = store.rackFootprint(rack);
    const rot = rack.rotation === 90;
    const w = rot ? fp.depthM : fp.lengthM;
    const h = rot ? fp.lengthM : fp.depthM;
    const x0 = rack.x, y0 = rack.y, x1 = rack.x + w, y1 = rack.y + h;
    const bayCount = Math.max(1, rack.bayCount);
    const bayIdx = Math.max(0, Math.min(bayCount - 1, t.bayIndex || 0));
    const frac0 = bayIdx / bayCount, frac1 = (bayIdx + 1) / bayCount;
    const bayCenterX = rot ? (x0 + x1) / 2 : x0 + w * (frac0 + frac1) / 2;
    const bayCenterY = rot ? y0 + h * (frac0 + frac1) / 2 : (y0 + y1) / 2;

    const standOff = Math.max(0.8, Math.min((rack.aisleWidth || 3) / 2, 1.6));
    switch (rack.pickingSide) {
      case 'north': return { x: bayCenterX, y: y1 + standOff };
      case 'east': return { x: x1 + standOff, y: bayCenterY };
      case 'west': return { x: x0 - standOff, y: bayCenterY };
      case 'south':
      default: return { x: bayCenterX, y: y0 - standOff };
    }
  }

  // Liang-Barsky segment-vs-rectangle clip test, inset slightly so a point
  // that legitimately sits right at a rack's edge (the aisle stand-off)
  // isn't flagged as touching it.
  function segmentCrossesRect(p1, p2, rect) {
    const inset = 0.05;
    const rx0 = rect.x0 + inset, rx1 = rect.x1 - inset;
    const ry0 = rect.y0 + inset, ry1 = rect.y1 - inset;
    if (rx1 <= rx0 || ry1 <= ry0) return false;
    let t0 = 0, t1 = 1;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const checks = [[-dx, p1.x - rx0], [dx, rx1 - p1.x], [-dy, p1.y - ry0], [dy, ry1 - p1.y]];
    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
    }
    return t0 < t1;
  }

  function pathCrossingCount(points, rackRects) {
    let crossings = 0;
    for (let i = 1; i < points.length; i++) {
      rackRects.forEach((rect) => { if (segmentCrossesRect(points[i - 1], points[i], rect)) crossings++; });
    }
    return crossings;
  }

  const TRANSFER_MARGIN = 1.2; // clearance beyond the rack rows' outer edge, in metres

  // Candidate paths from a to b, cheapest/simplest first: a direct line, an
  // "L" bent one way, an "L" bent the other way, then four corridor routes
  // that each go the long way around — out past one end of every rack row
  // (west/east/south/north of the combined rack footprint, well outside
  // it) — so at least one candidate is always geometrically guaranteed
  // clear of every rack regardless of orientation.
  function candidatePaths(a, b, rackBounds) {
    const candidates = [
      [a, b],
      [a, { x: b.x, y: a.y }, b],
      [a, { x: a.x, y: b.y }, b]
    ];
    if (rackBounds) {
      const west = rackBounds.minX - TRANSFER_MARGIN, east = rackBounds.maxX + TRANSFER_MARGIN;
      const south = rackBounds.minY - TRANSFER_MARGIN, north = rackBounds.maxY + TRANSFER_MARGIN;
      candidates.push([a, { x: west, y: a.y }, { x: west, y: b.y }, b]);
      candidates.push([a, { x: east, y: a.y }, { x: east, y: b.y }, b]);
      candidates.push([a, { x: a.x, y: south }, { x: b.x, y: south }, b]);
      candidates.push([a, { x: a.x, y: north }, { x: b.x, y: north }, b]);
    }
    return candidates;
  }

  function bestSafePath(a, b, rackRects, rackBounds) {
    const candidates = candidatePaths(a, b, rackBounds);
    for (const c of candidates) {
      if (pathCrossingCount(c, rackRects) === 0) return c;
    }
    // Unusual layout where every candidate clips something — fall back to
    // whichever crosses the fewest rack edges rather than always picking
    // the same (possibly worst) option.
    let best = candidates[0], bestCrossings = Infinity;
    candidates.forEach((c) => {
      const crossings = pathCrossingCount(c, rackRects);
      if (crossings < bestCrossings) { bestCrossings = crossings; best = c; }
    });
    return best;
  }

  function pathLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
      d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return d;
  }

  function buildRoute(taskList) {
    const rackRects = computeRackRectsWorld();
    const rackBounds = computeRackBoundsWorld(rackRects);
    let prev = computeStartPoint();
    const legs = [];
    taskList.forEach((t, i) => {
      const stand = standPointForTask(t);
      const dest = stand || prev;
      const pts = bestSafePath(prev, dest, rackRects, rackBounds);
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

  function totalRouteDistance(route) {
    return (route.legs || []).reduce((sum, leg) => sum + (leg.distanceM || 0), 0);
  }

  // ---------------- Mini route preview (drawn directly on the phone) ----------------
  // A compact inline SVG rendering of the same route data, scaled to its own
  // small viewBox — shown on the "My Picking Tasks" screen so the picker
  // sees the planned path before committing to Start Picking, not just
  // after. Numbered stops match task order; the live 2D plan alongside the
  // phone shows the same route at full warehouse scale.
  function miniRouteMapSvg(route) {
    if (!route || !route.legs.length) return '';
    const pts = allRoutePoints(route);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach((p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    const pad = 1.5;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(0.5, maxX - minX), h = Math.max(0.5, maxY - minY);
    const VBW = 300, VBH = 130;
    const scale = Math.min(VBW / w, VBH / h);
    const offX = (VBW - w * scale) / 2, offY = (VBH - h * scale) / 2;
    const toSvg = (p) => ({
      sx: offX + (p.x - minX) * scale,
      sy: VBH - (offY + (p.y - minY) * scale) // flip Y — world up = screen up
    });

    let paths = '';
    route.legs.forEach((leg) => {
      const svgPts = leg.points.map(toSvg);
      const d = svgPts.map((p, i) => (i === 0 ? 'M' : 'L') + p.sx.toFixed(1) + ',' + p.sy.toFixed(1)).join(' ');
      paths += `<path d="${d}" fill="none" stroke="#BC5C92" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 4" opacity="0.75"/>`;
    });

    let markers = '';
    route.legs.forEach((leg, i) => {
      const end = toSvg(leg.points[leg.points.length - 1]);
      markers += `<circle cx="${end.sx.toFixed(1)}" cy="${end.sy.toFixed(1)}" r="8" fill="#BC5C92" stroke="#fff" stroke-width="1.5"/>` +
        `<text x="${end.sx.toFixed(1)}" y="${(end.sy + 3.5).toFixed(1)}" font-size="9" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif">${i + 1}</text>`;
    });
    const start = toSvg(route.legs[0].points[0]);
    markers += `<circle cx="${start.sx.toFixed(1)}" cy="${start.sy.toFixed(1)}" r="5" fill="#1a1a18" stroke="#fff" stroke-width="1.5"/>`;

    return `<svg viewBox="0 0 ${VBW} ${VBH}" class="picker-route-preview-svg" preserveAspectRatio="xMidYMid meet">${paths}${markers}</svg>`;
  }

  // Turn-by-turn style mini-map shown on the active pick screen itself —
  // "like Google Maps for each leg": zoomed to the CURRENT leg (not the
  // whole route), with a white "you are here" dot at the start, a plum pin
  // at this leg's destination, the current leg drawn bold, and the rest of
  // the route sketched faint underneath for context.
  function legPreviewSvg(route, activeIndex) {
    if (!route || !route.legs[activeIndex]) return '';
    const activeLeg = route.legs[activeIndex];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    activeLeg.points.forEach((p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    const pad = 2;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(0.5, maxX - minX), h = Math.max(0.5, maxY - minY);
    const VBW = 300, VBH = 96;
    const scale = Math.min(VBW / w, VBH / h);
    const offX = (VBW - w * scale) / 2, offY = (VBH - h * scale) / 2;
    const toSvg = (p) => ({
      sx: offX + (p.x - minX) * scale,
      sy: VBH - (offY + (p.y - minY) * scale)
    });

    let paths = '';
    route.legs.forEach((leg) => {
      const svgPts = leg.points.map(toSvg);
      const d = svgPts.map((p, i) => (i === 0 ? 'M' : 'L') + p.sx.toFixed(1) + ',' + p.sy.toFixed(1)).join(' ');
      const isActive = leg.taskIndex === activeIndex;
      const isDone = leg.taskIndex < activeIndex;
      const stroke = isActive ? '#BC5C92' : (isDone ? 'rgba(255,255,255,0.28)' : 'rgba(188,92,146,0.4)');
      const width = isActive ? 3.5 : 2;
      const dash = isActive ? '' : ' stroke-dasharray="3 4"';
      paths += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    });

    const here = toSvg(activeLeg.points[0]);
    const target = toSvg(activeLeg.points[activeLeg.points.length - 1]);
    const markers =
      `<circle cx="${here.sx.toFixed(1)}" cy="${here.sy.toFixed(1)}" r="5" fill="#fff" stroke="#1a1a18" stroke-width="1.5"/>` +
      `<circle cx="${target.sx.toFixed(1)}" cy="${target.sy.toFixed(1)}" r="7" fill="#BC5C92" stroke="#fff" stroke-width="1.5"/>`;

    return `<svg viewBox="0 0 ${VBW} ${VBH}" class="picker-leg-map-svg" preserveAspectRatio="xMidYMid meet">${paths}${markers}</svg>`;
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
    stopSpeech();
    setScreenMode('light');
    const dist = currentRoute ? Math.round(totalRouteDistance(currentRoute)) : null;
    const routePreviewHtml = currentRoute ? `
      <div class="picker-route-preview">
        <div class="picker-route-preview-label">Planned route · ${tasks.length} stop${tasks.length === 1 ? '' : 's'}${dist != null ? ` · ~${dist}m` : ''}</div>
        ${miniRouteMapSvg(currentRoute)}
      </div>` : '';
    pickerScreenEl.innerHTML = `
      <div class="picker-header">
        <p class="picker-subtitle">Today</p>
        <h3 class="picker-title">My Picking Tasks</h3>
      </div>
      <div class="picker-screen-scroll">
        ${routePreviewHtml}
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
      <div class="picker-leg-map">${legPreviewSvg(currentRoute, index)}</div>
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
    speak(pickInstructionText(t));
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
    speak('All picks complete. Nice work.');
  }

  function startPicking() {
    demoStartedAt = Date.now();
    // currentRoute is already computed (built alongside the task list, so
    // it can be previewed on the phone and the plan before Start is even
    // clicked) — just switch the plan's active leg from "preview" (-1) to
    // the first task.
    renderGenerating();
    if (planView && currentRoute) {
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
    speak('Picked.');
    setTimeout(() => {
      if (modal.hidden) return;
      if (taskIndex < tasks.length - 1) {
        renderTask(taskIndex + 1);
      } else {
        renderDone();
      }
    }, 650);
  }

  // Builds the task list + route together, and — if the plan view exists —
  // fits it to the route and shows the full path in "preview" state
  // (activeLegIndex -1, so every leg renders in the same muted "upcoming"
  // style — nothing is "active" or "done" yet since picking hasn't
  // started). Shared by openDemo and restartDemo so both land on the same
  // "here's your planned route" view before Start Picking is clicked.
  function loadTasksAndPreviewRoute() {
    tasks = buildTaskList();
    currentRoute = tasks.length ? buildRoute(tasks) : null;
    taskIndex = 0;
    demoStartedAt = null;
    if (planView && currentRoute) {
      planView.fitToPoints(allRoutePoints(currentRoute), 2.5, {
        pickRoute: { legs: currentRoute.legs, activeLegIndex: -1, phase: 0 },
        pickHighlight: null
      });
    } else if (planView) {
      planView.resetView();
    }
  }

  function restartDemo() {
    stopSpeech();
    loadTasksAndPreviewRoute();
    renderIntro();
  }

  // ---------------- Open / close ----------------
  function openDemo() {
    modal.hidden = false;
    ensurePlanView();
    loadTasksAndPreviewRoute();
    if (!tasks.length) {
      emptyEl.classList.add('show');
      bodyEl.style.display = 'none';
      return;
    }
    emptyEl.classList.remove('show');
    bodyEl.style.display = '';
    renderIntro();
  }

  function closeDemo() {
    modal.hidden = true;
    stopPulseLoop();
    stopSpeech();
  }

  openBtn.addEventListener('click', openDemo);
  if (closeBtn) closeBtn.addEventListener('click', closeDemo);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDemo(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDemo(); });

  // Debug/test hook only — not used by the demo itself. Lets an external
  // script inspect the current route without needing its own copy of the
  // routing math.
  window.__guidedPickingDebug = { getRoute: () => currentRoute, getTasks: () => tasks };
})();
