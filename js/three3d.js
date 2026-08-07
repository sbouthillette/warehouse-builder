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

let renderer, scene, camera, controls, group;
let ready = false;

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
  return sprite;
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

function buildZones(zones) {
  zones.forEach((z) => {
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

function buildRacks(racks, store) {
  // Standard pallet-racking colors: blue upright frames, orange load beams.
  const uprightMat = new THREE.MeshStandardMaterial({ color: 0x1F4E96, metalness: 0.35, roughness: 0.45 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xE8630A, metalness: 0.25, roughness: 0.5 });
  const braceMat = new THREE.MeshStandardMaterial({ color: 0x2E5AA8, metalness: 0.3, roughness: 0.5 });

  racks.forEach((rack) => {
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

    // Each frame position gets two independent posts — one at the front
    // face, one at the back face — tied together by two horizontal braces,
    // rather than a single box spanning the whole rack depth.
    const tieGeo = new THREE.BoxGeometry(uW * 0.5, 0.04, Math.max(uD - uT, 0.01));
    for (let i = 0; i < uprightCount; i++) {
      const localX = i * (spacing + uW) + uW / 2;
      const postGeo = new THREE.BoxGeometry(uW, uH, uT);

      const front = new THREE.Mesh(postGeo, uprightMat);
      front.position.set(localX, uH / 2, uT / 2);
      rackGroup.add(front);

      const back = new THREE.Mesh(postGeo.clone(), uprightMat);
      back.position.set(localX, uH / 2, uD - uT / 2);
      rackGroup.add(back);

      const braceLow = new THREE.Mesh(tieGeo, braceMat);
      braceLow.position.set(localX, Math.min(0.15, uH * 0.1), uD / 2);
      rackGroup.add(braceLow);

      const braceHigh = new THREE.Mesh(tieGeo.clone(), braceMat);
      braceHigh.position.set(localX, uH - Math.min(0.15, uH * 0.1), uD / 2);
      rackGroup.add(braceHigh);
    }

    // beams per level, front (z=bT/2) and back (z=uD-bT/2). Level elevations
    // account for the "ground level" option (bottom level resting on the
    // floor with no beam) and treat levels.spacing as the clear opening
    // between beam faces, not a center-to-center distance.
    const levelElevations = window.WarehouseModel.computeLevelElevations(tpl);
    levelElevations.forEach((lv) => {
      if (!lv.hasBeam) return; // floor-resting bottom level — nothing to draw
      const levelY = lv.bottomY / 1000;
      if (levelY > uH) return;
      for (let b = 0; b < bayCount; b++) {
        const startX = b * (spacing + uW) + uW;
        const beamGeo = new THREE.BoxGeometry(spacing, bH, bT);
        const front = new THREE.Mesh(beamGeo, beamMat);
        front.position.set(startX + spacing / 2, levelY + bH / 2, bT / 2);
        rackGroup.add(front);
        const back = new THREE.Mesh(beamGeo.clone(), beamMat);
        back.position.set(startX + spacing / 2, levelY + bH / 2, uD - bT / 2);
        rackGroup.add(back);
      }
    });

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

    // position & rotate the whole rack group into world space
    rackGroup.rotation.y = rack.rotation === 90 ? Math.PI / 2 : 0;
    rackGroup.position.set(rack.x, 0, -rack.y);
    group.add(rackGroup);
  });
}

function render(store) {
  if (!ready) init();
  if (!group) return;
  clearGroup();
  const wh = store.data.warehouse;
  if (!wh || !wh.shape || wh.shape.length < 3) return;
  buildWarehouseShell(wh);
  buildZones(store.data.zones);
  buildRacks(store.data.racks, store);
  buildDoors(store.data.doors, wh);

  // frame camera on the polygon's bounding box
  const bounds = window.WarehouseModel.polygonBounds(wh.shape);
  const target = new THREE.Vector3(bounds.minX + bounds.width / 2, 0, -(bounds.minY + bounds.length / 2));
  controls.target.copy(target);
  const diag = Math.sqrt(bounds.width * bounds.width + bounds.length * bounds.length) || 10;
  camera.position.set(target.x + diag * 0.55, Math.max(wh.height * 1.4, diag * 0.4), target.z + diag * 0.55);
  controls.update();
}

window.ThreeView = { render };
