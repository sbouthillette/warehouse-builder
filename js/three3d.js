// three3d.js — 3D digital twin renderer using Three.js
// Coordinate mapping: warehouse X (m) -> three.js X, warehouse Y (m) -> three.js Z,
// height (m) -> three.js Y (up). Bay/beam/upright dims are mm, converted to m (/1000).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const container = document.getElementById('threeContainer');

let renderer, scene, camera, controls, group;
let ready = false;

function init() {
  if (!container) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  scene.fog = new THREE.Fog(0x05070c, 40, 220);

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
  const dir2 = new THREE.DirectionalLight(0x88aaff, 0.3);
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
  ctx.fillStyle = 'rgba(15,23,42,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = '#f7c56a';
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

function buildWarehouseShell(wh) {
  const geo = new THREE.BoxGeometry(wh.width, wh.height, wh.length);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0x4f8ef7 });
  const lines = new THREE.LineSegments(edges, mat);
  lines.position.set(wh.width / 2, wh.height / 2, wh.length / 2);
  group.add(lines);

  const floorGeo = new THREE.PlaneGeometry(wh.width, wh.length);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x121a2e, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(wh.width / 2, 0, wh.length / 2);
  group.add(floor);

  const grid = new THREE.GridHelper(Math.max(wh.width, wh.length), Math.max(wh.width, wh.length), 0x2b3a5a, 0x1a2540);
  grid.position.set(wh.width / 2, 0.01, wh.length / 2);
  group.add(grid);
}

function buildZones(zones) {
  zones.forEach((z) => {
    const geo = new THREE.PlaneGeometry(z.width, z.length);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(z.color), transparent: true, opacity: 0.22, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(z.x + z.width / 2, 0.02, z.y + z.length / 2);
    group.add(mesh);

    const label = makeTextSprite(z.name);
    label.position.set(z.x + z.width / 2, 0.4, z.y + z.length / 2);
    label.scale.set(2.5, 0.65, 1);
    group.add(label);
  });
}

function buildRacks(racks, store) {
  const uprightMat = new THREE.MeshStandardMaterial({ color: 0xf7c56a, metalness: 0.3, roughness: 0.5 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x4f8ef7, metalness: 0.2, roughness: 0.6 });

  racks.forEach((rack) => {
    const tpl = store.getRackTemplate(rack);
    if (!tpl) return;

    const uW = tpl.upright.width / 1000;
    const uD = tpl.upright.depth / 1000;
    const uH = tpl.upright.height / 1000;
    const bH = tpl.beam.height / 1000;
    const bT = tpl.beam.thickness / 1000;
    const spacing = tpl.baySpacing / 1000;
    const bayCount = rack.bayCount;
    const uprightCount = bayCount + 1;

    const rackGroup = new THREE.Group();

    // uprights (frames) along local X, depth along local Z
    for (let i = 0; i < uprightCount; i++) {
      const localX = i * (spacing + uW) + uW / 2;
      const frontGeo = new THREE.BoxGeometry(uW, uH, uD);
      const mesh = new THREE.Mesh(frontGeo, uprightMat);
      mesh.position.set(localX, uH / 2, uD / 2);
      rackGroup.add(mesh);
    }

    // beams per level, front (z=bT/2) and back (z=uD-bT/2)
    for (let lvl = 0; lvl < tpl.levels.count; lvl++) {
      const levelY = (tpl.levels.baseHeight + lvl * tpl.levels.spacing) / 1000;
      if (levelY > uH) continue;
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
    }

    const label = makeTextSprite(`${rack.name}`);
    const totalLength = uprightCount * uW + bayCount * spacing;
    label.position.set(totalLength / 2, uH + 0.8, uD / 2);
    rackGroup.add(label);

    // position & rotate the whole rack group into world space
    rackGroup.rotation.y = rack.rotation === 90 ? Math.PI / 2 : 0;
    rackGroup.position.set(rack.x, 0, rack.y);
    group.add(rackGroup);
  });
}

function render(store) {
  if (!ready) init();
  if (!group) return;
  clearGroup();
  const wh = store.data.warehouse;
  if (!wh) return;
  buildWarehouseShell(wh);
  buildZones(store.data.zones);
  buildRacks(store.data.racks, store);

  // frame camera on warehouse
  const target = new THREE.Vector3(wh.width / 2, 0, wh.length / 2);
  controls.target.copy(target);
  const diag = Math.sqrt(wh.width * wh.width + wh.length * wh.length);
  camera.position.set(target.x + diag * 0.55, Math.max(wh.height * 1.4, diag * 0.4), target.z + diag * 0.55);
  controls.update();
}

window.ThreeView = { render };
