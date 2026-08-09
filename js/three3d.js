// three3d.js — 3D digital twin renderer using Three.js
// Coordinate mapping: warehouse X (m) -> three.js X, warehouse Y (m) -> three.js -Z,
// height (m) -> three.js Y (up). Bay/beam/upright dims are mm, converted to m (/1000).
// Z is NEGATED (not just equal to Y) so that, given the camera sits on the
// +X/+Z side looking back at the origin, warehouse Y=0 renders near/at the
// bottom of the view and increasing Y renders toward the top — matching the
// 2D plan's bottom-left-origin convention instead of the reverse.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const container = document.getElementById('threeContainer');
const infoPanel = document.getElementById('inventoryInfoPanel');

let renderer, scene, camera, controls, group;
let ready = false;
let lastStore = null; // set on each render(); used to look up item catalog entries for the click-info panel

// Every occupancy box (Inventory tab) built this render — the click handler
// raycasts against just these, not the whole scene, so clicking a beam or
// upright doesn't do anything. Rebuilt from scratch each render(); see
// clearGroup() below.
let inventoryBoxes = [];
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function escapeHtmlLocal(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showInventoryInfo(inv) {
  if (!infoPanel) return;
  const contents = Array.isArray(inv.contents) ? inv.contents : [];
  const catalog = (lastStore && lastStore.data && lastStore.data.itemCatalog) || [];
  const findItem = (pn) => catalog.find((it) => it.partNumber === pn) || null;
  // Each content line gets its own mini card: part number/quantity plus,
  // when the part number has a matching Items-tab catalog entry, its
  // description and photo.
  const contentsRows = contents.map((line) => {
    const item = findItem(line.partNumber);
    const photo = item && item.imageDataUrl ? `<img class="info-panel-photo" src="${item.imageDataUrl}" alt="" />` : '';
    const desc = item && item.description
      ? `<div class="info-panel-row"><span>Description</span><span>${escapeHtmlLocal(item.description)}</span></div>`
      : '';
    return `
      <div class="info-panel-row"><span>${escapeHtmlLocal(line.partNumber)}</span><span>Qty ${escapeHtmlLocal(line.quantity)}</span></div>
      ${desc}
      ${photo}
    `;
  }).join('<hr class="info-panel-divider" />');
  const barcode = lastStore && typeof lastStore.getLocationBarcode === 'function' ? lastStore.getLocationBarcode(inv.code) : '';
  const barcodeRow = barcode
    ? `<div class="info-panel-row"><span>Barcode</span><span>${escapeHtmlLocal(barcode)}</span></div>`
    : '';
  infoPanel.innerHTML = `
    <button type="button" class="info-panel-close" aria-label="Close">×</button>
    <div class="info-panel-title">LPN ${escapeHtmlLocal(inv.lpn)}</div>
    <div class="info-panel-row"><span>Location</span><span>${escapeHtmlLocal(inv.code)}</span></div>
    ${barcodeRow}
    <div class="info-panel-row"><span>Rack</span><span>${escapeHtmlLocal(inv.rackName)}</span></div>
    <div class="info-panel-row"><span>Bay</span><span>${escapeHtmlLocal(inv.bayLabel)}</span></div>
    <div class="info-panel-row"><span>Level</span><span>${escapeHtmlLocal(inv.levelNumber)}</span></div>
    <div class="info-panel-row"><span>Position</span><span>${escapeHtmlLocal(inv.locationLabel)}</span></div>
    <div class="info-panel-title" style="margin-top:10px;">Contents</div>
    ${contentsRows || '<div class="info-panel-row"><span>—</span><span></span></div>'}
  `;
  infoPanel.hidden = false;
  infoPanel.querySelector('.info-panel-close').addEventListener('click', hideInventoryInfo);
}

function hideInventoryInfo() {
  if (infoPanel) infoPanel.hidden = true;
}

// Click-to-inspect: raycasts from the click point through the camera against
// only the occupancy boxes, so clicking a box shows what's stored there.
// Clicking empty space (or a beam/upright/etc.) dismisses the panel.
function onCanvasClick(event) {
  if (!camera || !renderer || !inventoryBoxes.length) { hideInventoryInfo(); return; }
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(inventoryBoxes, false);
  if (hits.length && hits[0].object.userData.inventory) {
    showInventoryInfo(hits[0].object.userData.inventory);
  } else {
    hideInventoryInfo();
  }
}

function init() {
  if (!container) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f3f0); // surface — light viewport, matches the app chrome
  scene.fog = new THREE.Fog(0xf4f3f0, 60, 260);

  camera = new THREE.PerspectiveCamera(50, containerAspect(), 0.1, 2000);
  camera.position.set(30, 25, 30);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  resizeRenderer();
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  renderer.domElement.addEventListener('click', onCanvasClick);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(50, 80, 20);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xd9e6f7, 0.25); // cool fill light
  dir2.position.set(-40, 30, -40);
  scene.add(dir2);

  group = new THREE.Group();
  scene.add(group);

  window.addEventListener('resize', () => {
    resizeRenderer();
  });

  ready = true;
  animate();
}

function containerAspect() {
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  return w / Math.max(h, 1);
}

function resizeRenderer() {
  if (!renderer || !container) return;
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// Every text label (rack names, per-bay/per-location tags, zone/obstacle
// names, door names) is created through this one factory, so tracking every
// sprite it hands out here — and applying the current show/hide state to
// each new one — is enough to drive a single global "toggle labels" button
// without touching every individual build*() call site.
let labelsVisible = true;
let labelSprites = [];

function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256; canvas.height = 64;
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; // light chip so labels read on the light viewport
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = '#1a1a18'; // ink
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4, 1, 1);
  sprite.visible = labelsVisible;
  labelSprites.push(sprite);
  return sprite;
}

// Applies (or flips) the show/hide state to every label sprite created so
// far, and remembers it for labels created by future render() calls too.
function setLabelsVisible(visible) {
  labelsVisible = !!visible;
  labelSprites.forEach((s) => { s.visible = labelsVisible; });
}

function labelsAreVisible() {
  return labelsVisible;
}

// Adds one diagonal cross-brace between (x, y0, z0) and (x, y1, z1) — a thin
// box stretched and rotated to span the two points, mirroring the diagonal
// bracing real pallet-rack frames use between their front and back posts.
function addDiagonalBrace(parent, mat, x, y0, z0, y1, z1, w) {
  const dy = y1 - y0, dz = z1 - z0;
  const len = Math.sqrt(dy * dy + dz * dz);
  if (len < 0.02) return;
  const geo = new THREE.BoxGeometry(w, len, w * 0.5);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.atan2(dz, dy);
  mesh.position.set(x, (y0 + y1) / 2, (z0 + z1) / 2);
  parent.add(mesh);
}

function clearGroup() {
  labelSprites = []; // every sprite in here belongs to an object about to be disposed below
  inventoryBoxes = []; // same — cleared before the meshes they reference are gone
  hideInventoryInfo(); // whatever was clicked no longer exists once we rebuild
  while (group.children.length) {
    const obj = group.children.pop();
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
    group.remove(obj);
  }
}

// Builds the warehouse shell from an arbitrary polygon outline (rectangle,
// L-shape, or any irregular/non-90° shape) — a filled floor plus a wireframe
// outline (floor perimeter, ceiling perimeter, and verticals at each corner)
// rather than a solid box, so the racks/zones inside stay visible.
function buildWarehouseShell(wh) {
  const pts = wh.shape;
  if (!pts || pts.length < 3) return;

  // Floor fill. THREE.Shape lives in an XY plane; after rotating -90° about X
  // to lay it flat, using Vector2(x, y) here (no negation) makes the result
  // land at world (x, 0, -y) — matching the world Z = -warehouse Y convention
  // used by the outline lines, zones and racks below.
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
  const floorGeo = new THREE.ShapeGeometry(shape);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xe8e5dc, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // Outline: floor perimeter, ceiling perimeter, and a vertical at each corner.
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xC97E0D }); // primary-2
  const toV3 = (p, y) => new THREE.Vector3(p.x, y, -p.y);

  const floorLoop = pts.map((p) => toV3(p, 0));
  floorLoop.push(floorLoop[0].clone());
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(floorLoop), outlineMat));

  const ceilLoop = pts.map((p) => toV3(p, wh.height));
  ceilLoop.push(ceilLoop[0].clone());
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ceilLoop), outlineMat));

  pts.forEach((p) => {
    const vertGeo = new THREE.BufferGeometry().setFromPoints([toV3(p, 0), toV3(p, wh.height)]);
    group.add(new THREE.Line(vertGeo, outlineMat));
  });

  const bounds = window.WarehouseModel.polygonBounds(pts);
  const span = Math.max(bounds.width, bounds.length, 1);
  const grid = new THREE.GridHelper(span, Math.round(span), 0xc7c2b5, 0xdcd8cd);
  grid.position.set(bounds.minX + bounds.width / 2, 0.01, -(bounds.minY + bounds.length / 2));
  group.add(grid);
}

// Flat zones render as a translucent ground-level plane, unchanged. Obstacles
// (raised physical objects — columns, fixed equipment — pickers must route
// around) render as a solid extruded box using their height, with an edge
// outline for definition, matching the treatment given to doors.
function buildZones(zones) {
  zones.forEach((z) => {
    if (z.kind === 'obstacle') {
      const h = Math.max(z.height, 0.05);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(z.color), metalness: 0.15, roughness: 0.7 });
      // Round obstacles (e.g. a round column) use a cylinder — its axis is
      // already Three.js's Y (up) by default, so no extra rotation is
      // needed. `z.width` is the diameter (see model.js _normalizeZonePayload).
      const geo = z.shape === 'round'
        ? new THREE.CylinderGeometry(z.width / 2, z.width / 2, h, 32)
        : new THREE.BoxGeometry(z.width, h, z.length);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(z.x + z.width / 2, h / 2, -(z.y + z.length / 2));
      group.add(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x1a1a18 })
      );
      edges.position.copy(mesh.position);
      group.add(edges);

      const label = makeTextSprite(`${z.name} (${z.height}m)`);
      label.position.set(z.x + z.width / 2, h + 0.35, -(z.y + z.length / 2));
      label.scale.set(2.5, 0.65, 1);
      group.add(label);
      return;
    }

    const geo = new THREE.PlaneGeometry(z.width, z.length);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(z.color), transparent: true, opacity: 0.22, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(z.x + z.width / 2, 0.02, -(z.y + z.length / 2));
    group.add(mesh);

    const label = makeTextSprite(z.name);
    label.position.set(z.x + z.width / 2, 0.4, -(z.y + z.length / 2));
    label.scale.set(2.5, 0.65, 1);
    group.add(label);
  });
}

// Standard door colors — kept in sync with the same constants in main.js
// (table swatches) and canvas2d.js (2D plan).
const DOOR_COLORS = { garage: 0x7C8892, regular: 0x8B5E34 };

// Picking-side indicator color — kept in sync with the same constant in
// canvas2d.js (2D plan) and main.js (legend).
const PICKING_COLOR = 0x2F8F4E;

// Draws a colored floor line + outward-pointing cone along whichever side
// of a rack's footprint is marked as the picking-access side. `edge` is
// { p1, p2, nx, ny } in warehouse space (from Model.rackPickingEdge). Added
// directly to `group` in world space — not nested inside the rack's own
// (rotated/translated) local group — so it only ever needs the same
// world_X = warehouse_X, world_Z = -warehouse_Y convention already used for
// doors and zones, regardless of the rack's own rotation.
function buildPickingIndicator(edge) {
  if (!edge) return;
  const mat = new THREE.LineBasicMaterial({ color: PICKING_COLOR });
  const p1 = new THREE.Vector3(edge.p1.x, 0.05, -edge.p1.y);
  const p2 = new THREE.Vector3(edge.p2.x, 0.05, -edge.p2.y);
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), mat));

  const midX = (edge.p1.x + edge.p2.x) / 2, midY = (edge.p1.y + edge.p2.y) / 2;
  const coneGeo = new THREE.ConeGeometry(0.22, 0.55, 10);
  const coneMat = new THREE.MeshStandardMaterial({ color: PICKING_COLOR });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(midX + edge.nx * 0.5, 0.3, -(midY + edge.ny * 0.5));
  // Cones point +Y by default — rotate so it points outward (horizontally,
  // along the edge's normal) instead.
  const dir = new THREE.Vector3(edge.nx, 0, -edge.ny).normalize();
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  group.add(cone);
}

// Renders the mezzanine as a flat rectangular deck slab at its configured
// height, held up by a simple grid of corner/edge support columns down to
// the floor — enough to read as "a raised second floor" without modeling a
// full structural steel frame (which is out of scope for this tool).
function buildMezzanineDeck(mz) {
  if (!mz || !mz.enabled) return;
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x8A7CA8, metalness: 0.15, roughness: 0.7 });
  const columnMat = new THREE.MeshStandardMaterial({ color: 0x5B4E78, metalness: 0.3, roughness: 0.5 });

  const w = mz.width, d = mz.depth;
  const topY = mz.heightMm / 1000;
  const thickness = Math.max(mz.deckThicknessMm / 1000, 0.05);
  const cx = mz.x + w / 2, cz = -(mz.y + d / 2);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(w, thickness, d), deckMat);
  deck.position.set(cx, topY - thickness / 2, cz);
  group.add(deck);

  // Support columns: one at each corner, plus a mid-span column along the
  // longer edges every ~6m so a large deck doesn't look like it's floating
  // on four posts alone.
  const colSize = 0.15;
  const colGeo = new THREE.BoxGeometry(colSize, Math.max(topY - thickness, 0.1), colSize);
  const columnXs = [mz.x + colSize, mz.x + w - colSize];
  const spanX = w - 2 * colSize;
  if (spanX > 6) {
    const extra = Math.floor(spanX / 6);
    for (let i = 1; i <= extra; i++) columnXs.splice(1, 0, mz.x + colSize + (spanX * i) / (extra + 1));
  }
  const columnZs = [-(mz.y + colSize), -(mz.y + d - colSize)];
  columnXs.forEach((cxPos) => {
    columnZs.forEach((czPos) => {
      const col = new THREE.Mesh(colGeo.clone(), columnMat);
      col.position.set(cxPos, (topY - thickness) / 2, czPos);
      group.add(col);
    });
  });
}

// Renders each door as a colored panel set into its wall, sized to the
// door's width/height and rotated to match the wall's direction. Since the
// warehouse shell itself is a wireframe outline (no solid walls), this reads
// as a colored opening/panel along the wall line rather than a real cutout.
function buildDoors(doors, wh) {
  if (!doors || !doors.length) return;
  doors.forEach((d) => {
    const dp = window.WarehouseModel.doorPoints(wh.shape, d);
    if (!dp) return;
    const mat = new THREE.MeshStandardMaterial({
      color: DOOR_COLORS[d.type] || DOOR_COLORS.regular,
      metalness: 0.25, roughness: 0.55, side: THREE.DoubleSide
    });
    const geo = new THREE.BoxGeometry(d.width, d.height, 0.08);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(dp.mid.x, d.height / 2, -dp.mid.y);
    mesh.rotation.y = dp.angle;
    group.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x1a1a18 })
    );
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    group.add(edges);

    const label = makeTextSprite(d.label);
    label.position.set(dp.mid.x, d.height + 0.35, -dp.mid.y);
    label.scale.set(2, 0.5, 1);
    group.add(label);
  });
}

// Standard pallet dimensions — a 1165x1165mm footprint (the common
// "square" pallet size) with a 150mm base height. The footprint is a fixed
// real-world size (clamped down only if a location's slot is narrower than
// that, so it doesn't poke through an upright or a neighboring position);
// the base height is likewise fixed, matching a real pallet regardless of
// how tall the level above it happens to be.
const PALLET_FOOTPRINT_M = 1.165;
const PALLET_BASE_HEIGHT_M = 0.15;
// Small visual gap kept between the top of the goods box and the beam
// above, so a full-height box reads as "filling the shelf" without
// appearing to clip through the beam.
const TOP_CLEARANCE_M = 0.05;

// Builds a simple stylized pallet (three runner blocks + a deck board) at
// (cx, cz), resting on the floor at y=floorY, spanning footprint w x d, with
// the given total height. Returns the Y of the pallet's top face — where a
// goods box should sit.
function addPalletBase(parent, mat, cx, floorY, cz, w, d, totalH) {
  const runnerH = totalH * 0.75;
  const deckH = Math.max(totalH - runnerH, 0.01);
  const runnerW = Math.max(w * 0.08, 0.04);
  const runnerPositions = [cx - w / 2 + runnerW / 2, cx, cx + w / 2 - runnerW / 2];
  runnerPositions.forEach((rx) => {
    const runner = new THREE.Mesh(new THREE.BoxGeometry(runnerW, runnerH, d * 0.92), mat);
    runner.position.set(rx, floorY + runnerH / 2, cz);
    parent.add(runner);
  });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(w, deckH, d), mat);
  deck.position.set(cx, floorY + runnerH + deckH / 2, cz);
  parent.add(deck);
  return { topY: floorY + runnerH + deckH, deckMesh: deck };
}

function buildRacks(racks, store) {
  // Standard pallet-racking colors: blue upright frames, orange load beams,
  // steel-gray solid shelf decks (loose-stock levels), tan occupancy boxes
  // (simulated inventory — see the Inventory tab).
  const uprightMat = new THREE.MeshStandardMaterial({ color: 0x1F4E96, metalness: 0.35, roughness: 0.45 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xE8630A, metalness: 0.25, roughness: 0.5 });
  const braceMat = new THREE.MeshStandardMaterial({ color: 0x2E5AA8, metalness: 0.3, roughness: 0.5 });
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x9BA3AE, metalness: 0.2, roughness: 0.65 });
  const occupiedMat = new THREE.MeshStandardMaterial({ color: 0xC9A063, metalness: 0.05, roughness: 0.85 });
  const palletMat = new THREE.MeshStandardMaterial({ color: 0xB08A5B, metalness: 0.02, roughness: 0.95 });

  // Keyed by rackId|bayIndex|levelIndex|locationIndex — matches how
  // Store.listLocations() enumerates the same locations, so a location's
  // key here always lines up with the one an import matched against.
  const invByKey = new Map(
    (store.data.inventory || []).map((inv) => [`${inv.rackId}|${inv.bayIndex}|${inv.levelIndex}|${inv.locationIndex}`, inv])
  );

  // A mezzanine rack rests on top of the deck rather than the floor — its
  // whole group gets lifted by the deck's top elevation. If the mezzanine
  // isn't (or is no longer) enabled, mezzanine-floor racks are skipped
  // entirely rather than drawn stacked on the ground, which would look like
  // a modeling error rather than "this floor is currently switched off".
  const mz = store.data.warehouse && store.data.warehouse.mezzanine;
  const mezzDeckTopM = mz ? mz.heightMm / 1000 : 0;

  racks.forEach((rack) => {
    if (rack.floor === 'mezzanine' && !(mz && mz.enabled)) return;
    const tpl = store.getRackTemplate(rack);
    if (!tpl) return;

    const uW = tpl.upright.width / 1000;
    const uT = tpl.upright.thickness / 1000; // each post's own profile depth
    const uD = tpl.frameDepth / 1000;        // distance between the front and back post
    const uH = tpl.upright.height / 1000;
    const bH = tpl.beam.height / 1000;
    const bT = tpl.beam.thickness / 1000;
    const spacing = tpl.baySpacing / 1000;
    const bayCount = rack.bayCount;
    const uprightCount = bayCount + 1;

    const rackGroup = new THREE.Group();

    // Computed up front so the frame-side bracing (below) can tie its
    // horizontal ties/diagonals to real level elevations, not just a fixed
    // low/high pair. Level elevations account for the "ground level" option
    // (bottom level resting on the floor with no beam) and each level's own
    // independently-configured clear height (not a single uniform spacing
    // across every level).
    const levelElevations = window.WarehouseModel.computeLevelElevations(tpl);

    // Frame-side bracing elevations: floor, each level's base, and the top
    // of the uprights — deduplicated and clamped to the frame's actual height.
    const braceElevations = [...new Set([0, ...levelElevations.map((lv) => lv.bottomY), tpl.upright.height])]
      .sort((a, b) => a - b)
      .map((mm) => mm / 1000)
      .filter((y) => y >= 0 && y <= uH);

    // Each frame position gets two independent posts — one at the front
    // face, one at the back face — tied together by horizontal ties at
    // every brace elevation plus zig-zagging diagonal braces between them,
    // rather than a single box spanning the whole rack depth or just two
    // fixed ties.
    const tieGeo = new THREE.BoxGeometry(uW * 0.5, 0.04, Math.max(uD - uT, 0.01));
    const frontZ = uT / 2, backZ = uD - uT / 2;
    for (let i = 0; i < uprightCount; i++) {
      const localX = i * (spacing + uW) + uW / 2;
      const postGeo = new THREE.BoxGeometry(uW, uH, uT);

      const front = new THREE.Mesh(postGeo, uprightMat);
      front.position.set(localX, uH / 2, uT / 2);
      rackGroup.add(front);

      const back = new THREE.Mesh(postGeo.clone(), uprightMat);
      back.position.set(localX, uH / 2, uD - uT / 2);
      rackGroup.add(back);

      braceElevations.forEach((y) => {
        const tie = new THREE.Mesh(tieGeo.clone(), braceMat);
        tie.position.set(localX, y, uD / 2);
        rackGroup.add(tie);
      });

      for (let s = 0; s < braceElevations.length - 1; s++) {
        const y0 = braceElevations[s], y1 = braceElevations[s + 1];
        if (y1 - y0 < 0.05) continue; // segment too short to bother bracing
        const z0 = s % 2 === 0 ? frontZ : backZ;
        const z1 = s % 2 === 0 ? backZ : frontZ;
        addDiagonalBrace(rackGroup, braceMat, localX, y0, z0, y1, z1, uW * 0.15);
      }
    }

    // Per level: pallet levels get open front/back load beams (pallets rest
    // on the two edges, nothing in between); shelf levels get one
    // continuous solid deck across the full depth, since loose stock/
    // cartons need a full supporting surface rather than two edge rails.
    levelElevations.forEach((lv) => {
      if (!lv.hasBeam) return; // floor-resting bottom level — nothing to draw
      const levelY = lv.bottomY / 1000;
      if (levelY > uH) return;
      for (let b = 0; b < bayCount; b++) {
        const startX = b * (spacing + uW) + uW;
        if (lv.levelType === 'shelf') {
          const shelfGeo = new THREE.BoxGeometry(spacing, bH, uD);
          const shelf = new THREE.Mesh(shelfGeo, shelfMat);
          shelf.position.set(startX + spacing / 2, levelY + bH / 2, uD / 2);
          rackGroup.add(shelf);
        } else {
          const beamGeo = new THREE.BoxGeometry(spacing, bH, bT);
          const front = new THREE.Mesh(beamGeo, beamMat);
          front.position.set(startX + spacing / 2, levelY + bH / 2, bT / 2);
          rackGroup.add(front);
          const back = new THREE.Mesh(beamGeo.clone(), beamMat);
          back.position.set(startX + spacing / 2, levelY + bH / 2, uD - bT / 2);
          rackGroup.add(back);
        }
      }
    });

    // Per-location labels (e.g. "A"/"B") floating within each level's
    // opening, one per bay per discrete location — skipped for
    // single-location levels (an unlabeled open shelf). Mirrors the same
    // treatment in the live Bay Builder preview (baypreview3d.js).
    levelElevations.forEach((lv, li) => {
      const locLabels = window.WarehouseModel.generateLocationLabels(lv.locations);
      if (locLabels.length <= 1) return;
      const openBottom = lv.hasBeam ? lv.topY / 1000 : 0;
      const nextBottomMm = levelElevations[li + 1] ? levelElevations[li + 1].bottomY : tpl.upright.height;
      const openTop = nextBottomMm / 1000;
      const midY = (openBottom + openTop) / 2;
      for (let b = 0; b < bayCount; b++) {
        const startX = b * (spacing + uW) + uW;
        locLabels.forEach((loc, k) => {
          const segCenter = startX + (spacing * (k + 0.5)) / locLabels.length;
          const tag = makeTextSprite(loc);
          tag.scale.set(0.5, 0.3, 1);
          tag.position.set(segCenter, midY, bT + 0.05);
          rackGroup.add(tag);
        });
      }
    });

    // Occupancy boxes for any location currently in the simulated inventory
    // feed — one box per occupied location, filling most of its slice of
    // the level's opening, with its part number floating just above. Runs
    // for every location regardless of how many share the level (unlike the
    // label loop above, which skips single-location levels since there's
    // nothing to distinguish there — an occupied single-location level
    // still needs its box).
    if (invByKey.size) {
      levelElevations.forEach((lv, li) => {
        const locLabels = window.WarehouseModel.generateLocationLabels(lv.locations);
        const openBottom = lv.hasBeam ? lv.topY / 1000 : 0;
        const nextBottomMm = levelElevations[li + 1] ? levelElevations[li + 1].bottomY : tpl.upright.height;
        const openTop = nextBottomMm / 1000;
        if (openTop <= openBottom) return;
        for (let b = 0; b < bayCount; b++) {
          const startX = b * (spacing + uW) + uW;
          locLabels.forEach((loc, k) => {
            const inv = invByKey.get(`${rack.id}|${b}|${li}|${k}`);
            if (!inv) return;
            const segCenter = startX + (spacing * (k + 0.5)) / locLabels.length;
            const slotW = spacing / locLabels.length;
            // Real pallet footprint (1165x1165mm standard), shrunk only if
            // the location slot itself is narrower/shallower than that
            // (e.g. tight bay spacing) so it never pokes through an
            // upright or a neighboring position.
            const cellW = Math.min(PALLET_FOOTPRINT_M, slotW * 0.9);
            const cellD = Math.min(PALLET_FOOTPRINT_M, uD * 0.9);
            const floorY = openBottom + 0.02;
            // Fills the level's actual clear opening up to (not touching)
            // the beam above, rather than a fixed "typical load" height —
            // a tall level shows a correspondingly tall load, a short one
            // shows a short one, and nothing ever visually clips the beam.
            const availableH = Math.max(openTop - floorY - TOP_CLEARANCE_M, 0.05);

            let boxBottomY, boxH;
            if (lv.levelType === 'shelf') {
              // Loose stock / cartons on a shelf — just the goods, no pallet underneath.
              boxBottomY = floorY;
              boxH = availableH;
            } else {
              // Pallet location — a real 1165x1165x150mm pallet under the
              // load, goods box on top using the rest of the clear height.
              const baseH = Math.min(PALLET_BASE_HEIGHT_M, availableH * 0.4);
              const { topY } = addPalletBase(rackGroup, palletMat, segCenter, floorY, uD / 2, cellW, cellD, baseH);
              boxBottomY = topY;
              boxH = Math.max(availableH - baseH, 0.05);
            }

            const box = new THREE.Mesh(new THREE.BoxGeometry(cellW * 0.95, boxH, cellD * 0.95), occupiedMat);
            box.position.set(segCenter, boxBottomY + boxH / 2, uD / 2);
            box.userData.inventory = inv;
            inventoryBoxes.push(box);
            rackGroup.add(box);

            const partTag = makeTextSprite(inv.lpn);
            partTag.scale.set(0.6, 0.25, 1);
            partTag.position.set(segCenter, boxBottomY + boxH + 0.18, uD / 2);
            rackGroup.add(partTag);
          });
        }
      });
    }

    const label = makeTextSprite(`${rack.name}`);
    const totalLength = uprightCount * uW + bayCount * spacing;
    label.position.set(totalLength / 2, uH + 0.8, uD / 2);
    rackGroup.add(label);

    // Per-bay identifier tags, floating above each bay opening.
    if (Array.isArray(rack.bays)) {
      for (let b = 0; b < bayCount; b++) {
        const bayInfo = rack.bays[b];
        if (!bayInfo) continue;
        const startX = b * (spacing + uW) + uW;
        const text = bayInfo.palletCount > 1 ? `${bayInfo.label} ×${bayInfo.palletCount}` : bayInfo.label;
        const tag = makeTextSprite(text);
        tag.scale.set(1.6, 0.4, 1);
        tag.position.set(startX + spacing / 2, uH + 0.3, uD / 2);
        rackGroup.add(tag);
      }
    }

    // position & rotate the whole rack group into world space — mezzanine
    // racks are lifted to rest on top of the deck instead of the floor.
    rackGroup.rotation.y = rack.rotation === 90 ? Math.PI / 2 : 0;
    const baseY = rack.floor === 'mezzanine' ? mezzDeckTopM : 0;
    rackGroup.position.set(rack.x, baseY, -rack.y);
    group.add(rackGroup);

    const edge = window.WarehouseModel.rackPickingEdge({
      x: rack.x, y: rack.y, rotation: rack.rotation,
      lengthM: totalLength, depthM: uD, pickingSide: rack.pickingSide
    });
    buildPickingIndicator(edge);
  });
}

// Computes the warehouse's bounding-box center (as a target for the
// controls) and a diagonal/height figure used to size each camera preset
// below. Returns null if there's no warehouse shell yet to frame.
function computeFrame(store) {
  const wh = store.data.warehouse;
  if (!wh || !wh.shape || wh.shape.length < 3) return null;
  const bounds = window.WarehouseModel.polygonBounds(wh.shape);
  const target = new THREE.Vector3(bounds.minX + bounds.width / 2, 0, -(bounds.minY + bounds.length / 2));
  const diag = Math.sqrt(bounds.width * bounds.width + bounds.length * bounds.length) || 10;
  return { target, diag, height: wh.height || 5 };
}

// Default "reset" framing — a 3/4 angled view looking back at the shell from
// the +X/+Z side, sized to comfortably fit the whole footprint. Same framing
// used automatically the first time a warehouse is opened.
function resetView(store) {
  const frame = computeFrame(store);
  if (!frame || !camera || !controls) return;
  const { target, diag, height } = frame;
  controls.target.copy(target);
  camera.position.set(target.x + diag * 0.55, Math.max(height * 1.4, diag * 0.4), target.z + diag * 0.55);
  controls.update();
}

// Straight-down, top-down floor-plan-style view. A tiny Z offset keeps the
// camera off the exact vertical axis so OrbitControls doesn't hit the
// polar-angle singularity (which can otherwise make orbiting feel "stuck"
// right after snapping to this view).
function topView(store) {
  const frame = computeFrame(store);
  if (!frame || !camera || !controls) return;
  const { target, diag } = frame;
  controls.target.copy(target);
  camera.position.set(target.x, Math.max(diag * 1.2, 20), target.z + 0.01);
  controls.update();
}

// A true isometric angle (equal foreshortening on all 3 axes) rather than
// the slightly flatter default "reset" angle — useful when you want a more
// technical/schematic look at the model.
function isometricView(store) {
  const frame = computeFrame(store);
  if (!frame || !camera || !controls) return;
  const { target, diag, height } = frame;
  const dist = Math.max(diag, height) * 0.9 + 5;
  const iso = new THREE.Vector3(1, 1, 1).normalize();
  controls.target.copy(target);
  camera.position.set(target.x + iso.x * dist, iso.y * dist, target.z + iso.z * dist);
  controls.update();
}

// Moves the camera toward/away from its current orbit target — used by the
// Zoom In/Out buttons as a manual alternative to scroll-to-zoom.
// factor < 1 moves closer (zoom in), > 1 moves farther away (zoom out).
function zoomBy(factor) {
  if (!camera || !controls) return;
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  offset.multiplyScalar(factor);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}
function zoomIn() { zoomBy(1 / 1.25); }
function zoomOut() { zoomBy(1.25); }

// Orbits the camera around its current target by a fixed angle step — a
// manual alternative to drag-to-orbit, e.g. for touch/precision use. Uses
// spherical coordinates around the target so the camera's distance and
// height above the target stay unchanged, only the angle changes.
const ROTATE_STEP = Math.PI / 12; // 15°
function rotateBy(azimuthDelta) {
  if (!camera || !controls) return;
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta += azimuthDelta;
  offset.setFromSpherical(spherical);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}
function rotateLeft() { rotateBy(ROTATE_STEP); }
function rotateRight() { rotateBy(-ROTATE_STEP); }

function render(store) {
  if (!ready) init();
  if (!group) return;
  lastStore = store; // remembered so the click-info panel can look up item catalog entries later
  clearGroup();
  const wh = store.data.warehouse;
  if (!wh || !wh.shape || wh.shape.length < 3) return;
  buildWarehouseShell(wh);
  buildZones(store.data.zones);
  buildMezzanineDeck(wh.mezzanine);
  buildRacks(store.data.racks, store);
  buildDoors(store.data.doors, wh);
  resetView(store);
}

window.ThreeView = {
  render, resetView, topView, isometricView, setLabelsVisible, labelsAreVisible,
  zoomIn, zoomOut, rotateLeft, rotateRight
};
