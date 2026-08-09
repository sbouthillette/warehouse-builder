// baypreview3d.js — live single-bay 3D preview for the Bay Builder tab.
// Self-contained Three.js scene (own camera/renderer/controls) rendering just
// one bay opening — two upright frames (front + back posts each) with a beam
// at every level — so the user sees the shape update as they edit fields.
// Local space only: no ties to warehouse world coordinates.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const container = document.getElementById('bayPreviewContainer');

let renderer, scene, camera, controls, group;
let ready = false;
// Set true if a browser/environment can't create a WebGL context at all
// (hardware acceleration disabled, a sandboxed/virtualized session, a GPU
// driver crash, etc.) — see init()'s try/catch below. Once true, init() and
// render() become permanent no-ops instead of repeatedly throwing.
let webglFailed = false;

function init() {
  if (!container || webglFailed) return;
  try {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f3f0); // surface — light viewport, matches the app chrome
    scene.fog = new THREE.Fog(0xf4f3f0, 30, 150);

    camera = new THREE.PerspectiveCamera(50, containerAspect(), 0.05, 500);
    camera.position.set(6, 5, 6);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    resizeRenderer();
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(10, 16, 6);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xd9e6f7, 0.25); // cool fill light
    dir2.position.set(-8, 6, -8);
    scene.add(dir2);

    group = new THREE.Group();
    scene.add(group);

    window.addEventListener('resize', () => resizeRenderer());

    ready = true;
    animate();
  } catch (err) {
    // Most commonly: WebGL is unavailable in this browser/environment — see
    // the identical catch block in three3d.js's init() for the full
    // explanation. Same treatment here: log once, remember it, show a
    // plain-language message in the preview panel instead of a silent
    // blank box, and never attempt WebGL again for the rest of the session.
    console.warn('Bay preview unavailable — could not create a WebGL context:', err);
    webglFailed = true;
    if (container) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;' +
        'text-align:center;color:#5f5e5a;font:14px sans-serif;">3D preview unavailable — this browser (or ' +
        'its current settings) blocked WebGL. Try a different browser, or check that hardware ' +
        'acceleration isn’t disabled in your browser’s settings.</div>';
    }
  }
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

// Small floating text label (e.g. "A", "B") marking one discrete location
// within a level's opening. Transparent background — just the glyph — so it
// doesn't clutter the preview the way an opaque chip would at this scale.
function makeLabelSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 96; canvas.height = 96;
  ctx.font = 'bold 56px sans-serif';
  ctx.fillStyle = '#1a1a18'; // ink
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.35, 0.35, 1);
  return sprite;
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

// Builds a single bay: 2 upright frames (front+back post each) tied by
// bracing, plus a front/back beam pair at every level. Mirrors the geometry
// logic in three3d.js's buildRacks(), scoped to one bay opening.
function buildBay(tpl) {
  const uW = tpl.upright.width / 1000;
  const uT = tpl.upright.thickness / 1000; // each post's own profile depth
  const uD = tpl.frameDepth / 1000;        // distance between front and back post
  const uH = tpl.upright.height / 1000;
  const bH = tpl.beam.height / 1000;
  const bT = tpl.beam.thickness / 1000;
  const spacing = tpl.baySpacing / 1000;

  // Standard pallet-racking colors: blue upright frames, orange load beams,
  // steel-gray solid shelf decks (loose-stock levels).
  const uprightMat = new THREE.MeshStandardMaterial({ color: 0x1F4E96, metalness: 0.35, roughness: 0.45 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xE8630A, metalness: 0.25, roughness: 0.5 });
  const braceMat = new THREE.MeshStandardMaterial({ color: 0x2E5AA8, metalness: 0.3, roughness: 0.5 });
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x9BA3AE, metalness: 0.2, roughness: 0.65 });

  const tieGeo = new THREE.BoxGeometry(uW * 0.5, 0.04, Math.max(uD - uT, 0.01));

  // Computed up front so the frame-side bracing (below) can tie its
  // horizontal ties/diagonals to real level elevations, not just a fixed
  // low/high pair. Level elevations account for the "ground level" option
  // (bottom level resting on the floor with no beam) and treat each level's
  // clearHeight as the clear opening above the previous level's beam, not a
  // center-to-center spacing.
  const levelElevations = window.WarehouseModel.computeLevelElevations(tpl);

  // Frame-side bracing elevations: floor, each level's base, and the top of
  // the uprights — deduplicated and clamped to the frame's actual height.
  const braceElevations = [...new Set([0, ...levelElevations.map((lv) => lv.bottomY), tpl.upright.height])]
    .sort((a, b) => a - b)
    .map((mm) => mm / 1000)
    .filter((y) => y >= 0 && y <= uH);

  // Two frame positions (left, right) bounding the single bay opening.
  for (let i = 0; i < 2; i++) {
    const localX = i * (spacing + uW) + uW / 2;
    const postGeo = new THREE.BoxGeometry(uW, uH, uT);

    const front = new THREE.Mesh(postGeo, uprightMat);
    front.position.set(localX, uH / 2, uT / 2);
    group.add(front);

    const back = new THREE.Mesh(postGeo.clone(), uprightMat);
    back.position.set(localX, uH / 2, uD - uT / 2);
    group.add(back);

    // Horizontal ties at every brace elevation — a real ladder-frame, not
    // just two ties near the floor and top.
    braceElevations.forEach((y) => {
      const tie = new THREE.Mesh(tieGeo.clone(), braceMat);
      tie.position.set(localX, y, uD / 2);
      group.add(tie);
    });

    // Diagonal braces zig-zagging between consecutive tie elevations,
    // alternating front-to-back each segment for an X/ladder bracing
    // pattern like a real rack frame.
    const frontZ = uT / 2, backZ = uD - uT / 2;
    for (let s = 0; s < braceElevations.length - 1; s++) {
      const y0 = braceElevations[s], y1 = braceElevations[s + 1];
      if (y1 - y0 < 0.05) continue; // segment too short to bother bracing
      const z0 = s % 2 === 0 ? frontZ : backZ;
      const z1 = s % 2 === 0 ? backZ : frontZ;
      addDiagonalBrace(group, braceMat, localX, y0, z0, y1, z1, uW * 0.15);
    }
  }

  // Per level: pallet levels get open front/back load beams (pallets rest
  // on the two edges, nothing in between); shelf levels get one continuous
  // solid deck across the full depth, since loose stock/cartons need a full
  // supporting surface rather than two edge rails.
  const startX = uW;
  levelElevations.forEach((lv) => {
    if (!lv.hasBeam) return; // floor-resting bottom level — nothing to draw
    const levelY = lv.bottomY / 1000;
    if (levelY > uH) return;
    if (lv.levelType === 'shelf') {
      const shelfGeo = new THREE.BoxGeometry(spacing, bH, uD);
      const shelf = new THREE.Mesh(shelfGeo, shelfMat);
      shelf.position.set(startX + spacing / 2, levelY + bH / 2, uD / 2);
      group.add(shelf);
    } else {
      const beamGeo = new THREE.BoxGeometry(spacing, bH, bT);
      const front = new THREE.Mesh(beamGeo, beamMat);
      front.position.set(startX + spacing / 2, levelY + bH / 2, bT / 2);
      group.add(front);
      const back = new THREE.Mesh(beamGeo.clone(), beamMat);
      back.position.set(startX + spacing / 2, levelY + bH / 2, uD - bT / 2);
      group.add(back);
    }
  });

  // Location labels (e.g. "A"/"B") floating within each level's opening,
  // one per discrete location — skipped for single-location levels (an
  // unlabeled open shelf, nothing to distinguish). The opening's vertical
  // span runs from this level's beam top (or the floor, if ground-level) up
  // to the bottom of the next level's beam (or the top of the uprights, for
  // the topmost level).
  levelElevations.forEach((lv, i) => {
    const labels = window.WarehouseModel.generateLocationLabels(lv.locations);
    if (labels.length <= 1) return; // single location — nothing to label
    const openBottom = lv.hasBeam ? lv.topY / 1000 : 0;
    const nextBottomMm = levelElevations[i + 1] ? levelElevations[i + 1].bottomY : tpl.upright.height;
    const openTop = nextBottomMm / 1000;
    const midY = (openBottom + openTop) / 2;
    labels.forEach((label, k) => {
      const segCenter = startX + (spacing * (k + 0.5)) / labels.length;
      const sprite = makeLabelSprite(label);
      sprite.position.set(segCenter, midY, bT + 0.08);
      group.add(sprite);
    });
  });

  // Ground grid for scale reference.
  const totalLength = 2 * uW + spacing;
  const span = Math.max(totalLength, uD, 2);
  const grid = new THREE.GridHelper(span * 1.6, Math.max(Math.round(span * 1.6), 4), 0xc7c2b5, 0xdcd8cd);
  grid.position.set(totalLength / 2, 0, uD / 2);
  group.add(grid);

  return { totalLength, uD, uH };
}

function render(tpl) {
  if (webglFailed) return;
  if (!ready) init();
  if (!group || !container) return;
  clearGroup();
  if (!tpl || !tpl.upright || !tpl.beam || !tpl.levels) return;

  const dims = buildBay(tpl);

  // Auto-frame the camera on the bay's bounding box.
  const target = new THREE.Vector3(dims.totalLength / 2, dims.uH / 2, dims.uD / 2);
  controls.target.copy(target);
  const diag = Math.sqrt(dims.totalLength * dims.totalLength + dims.uH * dims.uH + dims.uD * dims.uD) || 2;
  camera.position.set(target.x + diag * 0.75, target.y + diag * 0.55, target.z + diag * 0.95);
  camera.near = Math.max(diag * 0.01, 0.01);
  camera.far = diag * 20;
  camera.updateProjectionMatrix();
  controls.update();
  resizeRenderer();
}

// Manual zoom (toolbar buttons, alternative to scroll-to-zoom) — moves the
// camera toward/away from its current orbit target. factor < 1 zooms in.
function zoomBy(factor) {
  if (!camera || !controls) return;
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  offset.multiplyScalar(factor);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}
function zoomIn() { zoomBy(1 / 1.25); }
function zoomOut() { zoomBy(1.25); }

// Manual orbit (toolbar buttons, alternative to drag-to-orbit) — rotates
// the camera around its target by a fixed angle step, keeping its distance
// and height above the target unchanged.
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

window.BayPreview3D = { render, zoomIn, zoomOut, rotateLeft, rotateRight };
