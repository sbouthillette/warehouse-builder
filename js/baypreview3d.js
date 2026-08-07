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

function init() {
  if (!container) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a18); // ink — matches the viewport chrome
  scene.fog = new THREE.Fog(0x1a1a18, 20, 120);

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
  const dir2 = new THREE.DirectionalLight(0xF2A93C, 0.25); // warm amber fill light
  dir2.position.set(-8, 6, -8);
  scene.add(dir2);

  group = new THREE.Group();
  scene.add(group);

  window.addEventListener('resize', () => resizeRenderer());

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

  const uprightMat = new THREE.MeshStandardMaterial({ color: 0xF2A93C, metalness: 0.3, roughness: 0.5 }); // primary
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xE2572E, metalness: 0.2, roughness: 0.6 }); // secondary-2
  const braceMat = new THREE.MeshStandardMaterial({ color: 0xBC5C92, metalness: 0.2, roughness: 0.6 }); // tertiary

  const tieGeo = new THREE.BoxGeometry(uW * 0.5, 0.04, Math.max(uD - uT, 0.01));

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

    const braceLow = new THREE.Mesh(tieGeo, braceMat);
    braceLow.position.set(localX, Math.min(0.15, uH * 0.1), uD / 2);
    group.add(braceLow);

    const braceHigh = new THREE.Mesh(tieGeo.clone(), braceMat);
    braceHigh.position.set(localX, uH - Math.min(0.15, uH * 0.1), uD / 2);
    group.add(braceHigh);
  }

  // Beams per level, front (z=bT/2) and back (z=uD-bT/2), spanning the bay opening.
  const startX = uW;
  for (let lvl = 0; lvl < tpl.levels.count; lvl++) {
    const levelY = (tpl.levels.baseHeight + lvl * tpl.levels.spacing) / 1000;
    if (levelY > uH) continue;
    const beamGeo = new THREE.BoxGeometry(spacing, bH, bT);
    const front = new THREE.Mesh(beamGeo, beamMat);
    front.position.set(startX + spacing / 2, levelY + bH / 2, bT / 2);
    group.add(front);
    const back = new THREE.Mesh(beamGeo.clone(), beamMat);
    back.position.set(startX + spacing / 2, levelY + bH / 2, uD - bT / 2);
    group.add(back);
  }

  // Ground grid for scale reference.
  const totalLength = 2 * uW + spacing;
  const span = Math.max(totalLength, uD, 2);
  const grid = new THREE.GridHelper(span * 1.6, Math.max(Math.round(span * 1.6), 4), 0x4a3f34, 0x2a241e);
  grid.position.set(totalLength / 2, 0, uD / 2);
  group.add(grid);

  return { totalLength, uD, uH };
}

function render(tpl) {
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

window.BayPreview3D = { render };
