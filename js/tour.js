// js/tour.js — first-time guided tour of the core "build a warehouse"
// workflow. Auto-starts once per browser for a guest who's never seen it
// (tracked via localStorage — this is a real deployed app, not a Claude
// artifact, so localStorage is the right tool here), and is replayable by
// admins anytime via the "Replay Tour" button (index.html topbar, wired in
// main.js) without having to clear their browser storage.
//
// Deliberately NOT a persistent "Take a Tour" button for guests — that was
// a scoping decision (auto-start only), not an oversight.
//
// Deliberately skips admin-only surfaces (Manage Access, Visitor Log) and
// the deeper tabs (Doors, Zones, Create Items) — this walks the core
// "empty room to a stocked, viewable warehouse" path in a few steps, not
// every tab in the app.
(function () {
  const TOUR_SEEN_KEY = 'spatialis_tour_v1_seen';
  const TOUR_MUTE_KEY = 'spatialis_tour_voice_muted';
  const SPOTLIGHT_PAD = 8;

  // Each step optionally switches to `tab` (by clicking the real nav
  // button, so all of that tab's own render/resize logic in main.js runs
  // normally) and optionally spotlights `target` (a CSS selector). A step
  // with neither is a plain centered/backdrop-only caption.
  const STEPS = [
    {
      title: 'Welcome to the Dynamic Spatial Model',
      body: "This is a live, interactive demo — not a mockup. In just a few minutes, you can recreate your own warehouse here, and on the full platform, connect it to your live inventory. It's more than a visual: the Dynamic Spatial Model builds a mathematical model of your warehouse that AI can read and reuse to power advanced analysis and automation."
    },
    {
      target: '.tabs',
      title: 'Your build path',
      body: 'Tabs 3 through 9 walk you through building a warehouse from scratch — shell, bays, racks, doors, zones, inventory, and items. Tabs 1 and 2 show you the result in 3D and 2D as you go.'
    },
    {
      tab: 'warehouse',
      target: '#shapePreview',
      title: '1. Warehouse Shell',
      body: "Start by drawing the building's outer footprint. Use a quick-start shape like a rectangle or an L-shape, or draw any custom polygon from scratch. Everything else gets built inside this outline."
    },
    {
      tab: 'bays',
      target: '#bayPreviewContainer',
      title: '2. Bay Builder',
      body: "Design a single rack bay as a reusable template — uprights, beams, and as many levels as you need. Configure each level independently: pallet storage or picking shelves for loose items, each with its own clear height, weight limit, and number of positions (two pallet slots, five or six picking shelves — whatever that level actually holds). Duplicate the finished template to build out full racks."
    },
    {
      tab: 'racks',
      target: '#racksPlanCanvas',
      title: '3. Racks & Aisles',
      body: "For each rack, set its origin coordinates (X, Y), pick a Bay Template, and choose how many bays to place — then repeat to add rack after rack until the whole warehouse is racked out. Each bay gets its own label in the order it's placed; reverse that order anytime if you'd rather number from the other end."
    },
    {
      tab: 'inventory',
      target: '#formAddInventory',
      title: '4. Add Inventory',
      body: "For the purpose of the demo, to add inventory, pick a location, then add what's stored there: a Part Number and Quantity, plus an LPN if it's a palletized unit load — leave the LPN blank to pile in loose boxes instead. This occupancy data is what brings the 3D view to life."
    },
    {
      tab: 'view3d',
      target: '#threeContainer',
      title: '5. See it come alive',
      body: 'This is the Dynamic Spatial Model — a live 3D twin of everything you just built. You can zoom in and out and orbit around the model. Click any pallet to see what it is storing and some data about the product or products contained at that location.'
    },
    {
      target: '#btnNewWarehouse',
      title: 'Try it yourself',
      body: 'Click "+ New Warehouse" anytime to start your own from scratch — your own footprint, bays, racks, and inventory, saved to your account as you go. Everything you just saw was built exactly this way.'
    },
    {
      target: '#btnScheduleDemo',
      title: "That's the core workflow",
      body: "There's more — doors, zones, mezzanines, location barcodes — but that's the shape of it. When you're ready for the full platform, schedule a full demo."
    }
  ];

  let stepIndex = 0;
  let active = false;
  let repositionHandlerBound = false;

  const backdrop = document.getElementById('tourBackdrop');
  const spotlight = document.getElementById('tourSpotlight');
  const card = document.getElementById('tourCard');
  const eyebrowEl = document.getElementById('tourEyebrow');
  const titleEl = document.getElementById('tourTitle');
  const bodyEl = document.getElementById('tourBody');
  const dotsEl = document.getElementById('tourDots');
  const btnSkip = document.getElementById('btnTourSkip');
  const btnBack = document.getElementById('btnTourBack');
  const btnNext = document.getElementById('btnTourNext');
  const btnMute = document.getElementById('btnTourMute');
  const muteIconEl = document.getElementById('tourMuteIcon');
  const voiceSelect = document.getElementById('tourVoiceSelect');

  // Some deployments/pages this script might load on won't have the tour
  // markup (e.g. a stripped-down page) — bail quietly rather than throw.
  if (!backdrop || !spotlight || !card || !btnNext) return;

  function markSeen() {
    try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (err) { /* private browsing, etc. — fine to skip */ }
  }
  function hasSeenTour() {
    try { return !!localStorage.getItem(TOUR_SEEN_KEY); } catch (err) { return false; }
  }

  // ---- Voice narration (Web Speech API) ----------------------------------
  // Fully client-side (no network dependency, no API cost) — reads each
  // step's title + body aloud as it's shown. Some browsers (notably Safari)
  // block the very first speechSynthesis.speak() call unless it happens
  // inside a real user-gesture handler, so the *auto-started* first-time
  // tour's opening step may silently fail to speak — that's expected and
  // harmless; the mute button click itself is a user gesture, so toggling
  // it (or clicking Next/Back) reliably unblocks speech from then on.
  const synthAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  let muted = false;
  try { muted = localStorage.getItem(TOUR_MUTE_KEY) === '1'; } catch (err) { /* fine to default unmuted */ }

  function updateMuteButton() {
    if (!btnMute) return;
    btnMute.classList.toggle('is-muted', muted);
    btnMute.setAttribute('aria-pressed', String(muted));
    btnMute.title = muted ? 'Unmute narration' : 'Mute narration';
    btnMute.setAttribute('aria-label', muted ? 'Unmute tour narration' : 'Mute tour narration');
    if (muteIconEl) muteIconEl.textContent = muted ? '🔇' : '🔊';
  }

  function stopSpeech() {
    if (synthAvailable) { try { window.speechSynthesis.cancel(); } catch (err) { /* ignore */ } }
  }

  function speakStep(step) {
    if (!synthAvailable || muted || !step) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(`${step.title}. ${step.body}`);
      utter.rate = 1;
      utter.pitch = 1;
      if (selectedVoice) utter.voice = selectedVoice;
      window.speechSynthesis.speak(utter);
    } catch (err) { /* speech is a nice-to-have — never let it break the tour */ }
  }

  if (!synthAvailable && btnMute) {
    btnMute.hidden = true;
  } else {
    updateMuteButton();
  }

  // ---- Voice selection ----------------------------------------------------
  // The browser's silent default voice (whatever getVoices()[0] happens to
  // be) is often the flattest, most "robotic" one available — real, more
  // natural-sounding voices (OS-bundled premium/enhanced voices, or
  // Chrome's remote "Google ..." voices) usually exist on the same device
  // but just aren't picked automatically. We rank the available voices and
  // default to the best-sounding one, while still letting the user pick a
  // different one from the dropdown if they prefer.
  //
  // This key is intentionally shared with js/guidedPickingDemo.js's
  // pick-to-voice narration (both files write/read the same localStorage
  // entry) — pick a voice here once and the picking demo's narration uses
  // it too, rather than each surface needing its own picker.
  const TOUR_VOICE_KEY = 'spatialis_narration_voice_uri';
  let voices = [];
  let selectedVoice = null;
  let selectedVoiceURI = null;
  try { selectedVoiceURI = localStorage.getItem(TOUR_VOICE_KEY) || null; } catch (err) { /* fine to skip */ }

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
    if (v.localService === false) score += 1; // remote/cloud voices tend to sound less robotic
    return score;
  }

  function refreshVoices() {
    if (!synthAvailable || !voiceSelect) return;
    try { voices = window.speechSynthesis.getVoices() || []; } catch (err) { voices = []; }
    const english = voices.filter((v) => /^en/i.test(v.lang || ''));
    const pool = (english.length ? english : voices).slice();
    if (pool.length <= 1) { voiceSelect.hidden = true; return; }

    const sorted = pool.sort((a, b) => scoreVoice(b) - scoreVoice(a));
    voiceSelect.innerHTML = sorted
      .map((v) => `<option value="${v.voiceURI}">${v.name}${v.lang ? ' (' + v.lang + ')' : ''}</option>`)
      .join('');
    voiceSelect.hidden = false;

    // Prefer a previously-chosen voice if it's still available on this
    // device/browser; otherwise fall back to the best-scored one.
    const remembered = selectedVoiceURI && sorted.find((v) => v.voiceURI === selectedVoiceURI);
    selectedVoice = remembered || sorted[0];
    if (selectedVoice) voiceSelect.value = selectedVoice.voiceURI;
  }

  if (synthAvailable) {
    refreshVoices();
    // Most browsers (Chrome especially) load the real voice list
    // asynchronously — the very first getVoices() call right after page
    // load often returns []. This event fires once the full list is ready.
    try { window.speechSynthesis.onvoiceschanged = refreshVoices; } catch (err) { /* older Safari lacks this */ }
  }

  if (voiceSelect) {
    voiceSelect.addEventListener('change', () => {
      const v = voices.find((x) => x.voiceURI === voiceSelect.value);
      if (!v) return;
      selectedVoice = v;
      selectedVoiceURI = v.voiceURI;
      try { localStorage.setItem(TOUR_VOICE_KEY, selectedVoiceURI); } catch (err) { /* fine to skip persisting */ }
      // Changing the dropdown is a real user gesture, and immediately
      // re-reading the current step is the clearest way to preview the
      // new voice.
      if (active && !muted) speakStep(STEPS[stepIndex]);
    });
  }

  function resolveTarget(step) {
    if (!step.target) return null;
    let el = document.querySelector(step.target);
    // Fall back to the tab button itself if the real target is missing or
    // collapsed to zero size (e.g. a gated panel that's hidden until
    // prerequisite data exists) — still better than spotlighting nothing.
    const usable = (e) => e && e.getClientRects().length > 0;
    if (!usable(el) && step.tab) el = document.querySelector(`.tab-btn[data-tab="${step.tab}"]`);
    return usable(el) ? el : null;
  }

  function positionSpotlight(target) {
    if (!target) {
      spotlight.classList.remove('show');
      backdrop.classList.add('show');
      return;
    }
    backdrop.classList.remove('show');
    const r = target.getBoundingClientRect();
    spotlight.style.top = Math.max(0, r.top - SPOTLIGHT_PAD) + 'px';
    spotlight.style.left = Math.max(0, r.left - SPOTLIGHT_PAD) + 'px';
    spotlight.style.width = (r.width + SPOTLIGHT_PAD * 2) + 'px';
    spotlight.style.height = (r.height + SPOTLIGHT_PAD * 2) + 'px';
    spotlight.classList.add('show');
  }

  function renderStep() {
    const step = STEPS[stepIndex];
    if (step.tab) {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${step.tab}"]`);
      if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
    }
    // Give the tab switch (and any resize-dependent canvas/3D re-render it
    // triggers) a beat to settle before measuring anything.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const target = resolveTarget(step);
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
        positionSpotlight(target);
        eyebrowEl.textContent = `Step ${stepIndex + 1} of ${STEPS.length}`;
        titleEl.textContent = step.title;
        bodyEl.textContent = step.body;
        dotsEl.innerHTML = STEPS.map((_, i) => `<span class="tour-dot${i === stepIndex ? ' active' : ''}"></span>`).join('');
        btnBack.hidden = stepIndex === 0;
        btnNext.textContent = stepIndex === STEPS.length - 1 ? 'Finish' : 'Next';
        card.classList.add('show');
        speakStep(step);
      }, 60);
    });
  }

  function reposition() {
    if (!active) return;
    positionSpotlight(resolveTarget(STEPS[stepIndex]));
  }

  function start(opts) {
    const force = !!(opts && opts.force);
    if (!force && hasSeenTour()) return;
    stepIndex = 0;
    active = true;
    markSeen();
    if (!repositionHandlerBound) {
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
      repositionHandlerBound = true;
    }
    renderStep();
  }

  function end() {
    active = false;
    stopSpeech();
    card.classList.remove('show');
    spotlight.classList.remove('show');
    backdrop.classList.remove('show');
  }

  btnNext.addEventListener('click', () => {
    if (stepIndex >= STEPS.length - 1) { end(); return; }
    stepIndex += 1;
    renderStep();
  });
  btnBack.addEventListener('click', () => {
    if (stepIndex === 0) return;
    stepIndex -= 1;
    renderStep();
  });
  btnSkip.addEventListener('click', end);
  if (btnMute) {
    btnMute.addEventListener('click', () => {
      muted = !muted;
      try { localStorage.setItem(TOUR_MUTE_KEY, muted ? '1' : '0'); } catch (err) { /* fine to skip persisting */ }
      updateMuteButton();
      if (muted) stopSpeech();
      // Clicking the button is a genuine user gesture, so use it to
      // (re)start narration immediately — this is also what unblocks
      // speechSynthesis in browsers that silently dropped the very first,
      // auto-started utterance.
      else if (active) speakStep(STEPS[stepIndex]);
    });
  }

  // Exposed for the admin-only "Replay Tour" button (js/main.js).
  window.SpatialisTour = { start, end };

  // Auto-start for a first-time guest, but only once the app has actually
  // finished loading a warehouse into view (not while the "no warehouses
  // yet" empty state is showing, and not before login/data-fetch settles).
  // Polls briefly rather than hooking into main.js's internals directly.
  function waitForAppReady(cb) {
    const mainLayout = document.getElementById('mainLayout');
    const emptyState = document.getElementById('emptyState');
    if (!mainLayout) return;
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      const ready = mainLayout.style.display !== 'none' && (!emptyState || emptyState.hidden);
      if (ready) { clearInterval(iv); cb(); }
      else if (tries > 150) { clearInterval(iv); } // ~30s — give up quietly, don't loop forever
    }, 200);
  }

  if (!hasSeenTour()) {
    waitForAppReady(() => { setTimeout(() => start(), 600); });
  }
})();
