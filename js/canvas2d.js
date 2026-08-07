// canvas2d.js — top-down 2D plan renderer for Warehouse Builder
// Coordinate convention: warehouse (0,0) is bottom-left (the origin), X to the
// right, Y upward. Canvas pixel Y grows downward, so we flip Y when drawing.

(function () {
  const canvas = document.getElementById('canvas2d');
  const ctx = canvas.getContext('2d');

  // fittedForId tracks which warehouse's shape the current scale/pan was
  // fitted to — not just a one-time boolean — so that switching to a
  // different (or differently-sized) warehouse re-fits automatically instead
  // of keeping a stale scale computed for a previous building.
  const view = { scale: 20, panX: 40, panY: 40, dragging: false, lastX: 0, lastY: 0, fittedForId: undefined };

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fitToWarehouse() {
    const wh = window.WarehouseStore.data.warehouse;
    if (!wh || !wh.shape || wh.shape.length < 3) return;
    const bounds = window.WarehouseModel.polygonBounds(wh.shape);
    const wrap = canvas.parentElement;
    const w = wrap.clientWidth - 80;
    const h = wrap.clientHeight - 80;
    const scaleX = w / (bounds.width || 1);
    const scaleY = h / (bounds.length || 1);
    view.scale = Math.max(0.5, Math.min(scaleX, scaleY));
    // Pad so the polygon's bounding box (which may not start at 0,0) sits
    // fully inside the padded viewport rather than assuming an origin-anchored rect.
    view.panX = 40 - bounds.minX * view.scale;
    view.panY = 40 - bounds.minY * view.scale;
  }

  function worldToScreen(x, y) {
    const wrap = canvas.parentElement;
    const h = wrap.clientHeight;
    return {
      sx: view.panX + x * view.scale,
      sy: h - view.panY - y * view.scale
    };
  }

  function drawGrid(wh) {
    const wrap = canvas.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    let step = 1;
    if (view.scale < 6) step = 5;
    if (view.scale < 2) step = 10;
    ctx.strokeStyle = 'rgba(26,26,24,0.08)';
    ctx.lineWidth = 1;
    const bounds = wh && wh.shape ? window.WarehouseModel.polygonBounds(wh.shape) : { minX: 0, minY: 0, maxX: 60, maxY: 60 };
    const minX = Math.min(0, bounds.minX) - step, maxX = Math.max(40, bounds.maxX) + step;
    const minY = Math.min(0, bounds.minY) - step, maxY = Math.max(40, bounds.maxY) + step;
    for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
      const a = worldToScreen(x, 0);
      ctx.beginPath(); ctx.moveTo(a.sx, 0); ctx.lineTo(a.sx, h); ctx.stroke();
    }
    for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
      const a = worldToScreen(0, y);
      ctx.beginPath(); ctx.moveTo(0, a.sy); ctx.lineTo(w, a.sy); ctx.stroke();
    }
  }

  // Draws the warehouse outline as an arbitrary closed polygon (rectangle,
  // L-shape, or any irregular/non-90° shape) rather than assuming a rectangle.
  function drawWarehouse(wh) {
    if (!wh || !wh.shape || wh.shape.length < 3) return;
    const pts = wh.shape.map((p) => worldToScreen(p.x, p.y));
    ctx.beginPath();
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(201,126,13,0.06)'; // primary-2 tint
    ctx.fill();
    ctx.strokeStyle = '#C97E0D'; // primary-2
    ctx.lineWidth = 2;
    ctx.stroke();

    const bounds = window.WarehouseModel.polygonBounds(wh.shape);
    const topLeft = worldToScreen(bounds.minX, bounds.maxY);
    ctx.fillStyle = '#5f5e5a'; // ink-secondary
    ctx.font = '12px sans-serif';
    ctx.fillText(`${wh.name} — ${bounds.width.toFixed(1)}m × ${bounds.length.toFixed(1)}m bounding box`, topLeft.sx, topLeft.sy - 8);

    // vertex markers
    pts.forEach((p) => {
      ctx.fillStyle = '#C97E0D'; // primary-2
      ctx.beginPath(); ctx.arc(p.sx, p.sy, 3, 0, Math.PI * 2); ctx.fill();
    });

    // origin marker, if (0,0) is in view
    if (bounds.minX <= 0 && 0 <= bounds.maxX + 5 && bounds.minY <= 0 && 0 <= bounds.maxY + 5) {
      const o = worldToScreen(0, 0);
      ctx.fillStyle = '#E2572E'; // secondary-2
      ctx.beginPath(); ctx.arc(o.sx, o.sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillText('(0,0)', o.sx + 6, o.sy + 14);
    }
  }

  function drawZones(zones) {
    zones.forEach((z) => {
      const a = worldToScreen(z.x, z.y);
      const b = worldToScreen(z.x + z.width, z.y + z.length);
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
      const w = Math.abs(b.sx - a.sx), h = Math.abs(b.sy - a.sy);
      ctx.fillStyle = hexToRgba(z.color, 0.18);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hexToRgba(z.color, 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#1a1a18'; // ink
      ctx.font = '11px sans-serif';
      ctx.fillText(`${z.name} (${z.type})`, x + 4, y + 14);
    });
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawRacks(racks, store) {
    racks.forEach((r) => {
      const tpl = store.getRackTemplate(r);
      if (!tpl) return;
      const fp = store.rackFootprint(r);
      const rot = r.rotation === 90;
      const lengthM = fp.lengthM, depthM = fp.depthM;
      const w = rot ? depthM : lengthM;
      const h = rot ? lengthM : depthM;
      const a = worldToScreen(r.x, r.y);
      const b = worldToScreen(r.x + w, r.y + h);
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
      const pw = Math.abs(b.sx - a.sx), ph = Math.abs(b.sy - a.sy);

      ctx.fillStyle = 'rgba(242,169,60,0.25)'; // primary tint
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = '#F2A93C'; // primary
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, pw, ph);

      // bay divider ticks
      ctx.strokeStyle = 'rgba(242,169,60,0.6)';
      ctx.lineWidth = 1;
      for (let i = 1; i < r.bayCount; i++) {
        const frac = i / r.bayCount;
        if (!rot) {
          const tx = x + pw * frac;
          ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx, y + ph); ctx.stroke();
        } else {
          const ty = y + ph * frac;
          ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x + pw, ty); ctx.stroke();
        }
      }

      ctx.fillStyle = '#1a1a18'; // ink — dark text reads well on the amber rack fill
      ctx.font = 'bold 11px sans-serif';
      ctx.save();
      if (rot) {
        ctx.translate(x + pw / 2, y + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText(`${r.name} (${r.bayCount} bays)`, 0, 0);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(`${r.name} (${r.bayCount} bays)`, x + pw / 2, y + ph / 2 + 4);
      }
      ctx.restore();

      // Per-bay identifiers, only when zoomed in enough for the text to be legible.
      const cellSpan = (rot ? ph : pw) / r.bayCount;
      if (Array.isArray(r.bays) && cellSpan >= 42) {
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#1a1a18';
        for (let i = 0; i < r.bayCount; i++) {
          const slot = r.bays[i];
          if (!slot) continue;
          const text = slot.palletCount > 1 ? `${slot.label} ×${slot.palletCount}` : slot.label;
          const frac = (i + 0.5) / r.bayCount;
          ctx.save();
          if (rot) {
            const ty = y + ph * frac;
            ctx.translate(x + pw / 2, ty);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(text, 0, -10); // small offset toward one edge, avoids the centered rack-name label
          } else {
            const tx = x + pw * frac;
            ctx.fillText(text, tx, y + 10);
          }
          ctx.restore();
        }
      }
    });
  }

  // Standard door colors — kept in sync with the same constants in main.js
  // (table swatches) and three3d.js (3D view).
  const DOOR_COLORS = { garage: '#7C8892', regular: '#8B5E34' };

  // Draws each door as a thick colored overlay on its wall segment, with a
  // small perpendicular tick at each jamb (like a door-opening symbol) and a
  // label once zoomed in enough for it to be legible.
  function drawDoors(doors, wh) {
    if (!doors || !doors.length) return;
    doors.forEach((d) => {
      const dp = window.WarehouseModel.doorPoints(wh.shape, d);
      if (!dp) return;
      const a = worldToScreen(dp.start.x, dp.start.y);
      const b = worldToScreen(dp.end.x, dp.end.y);
      const color = DOOR_COLORS[d.type] || DOOR_COLORS.regular;

      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      ctx.lineCap = 'round';

      // Perpendicular jamb ticks at each end, like a door-opening symbol.
      const dx = b.sx - a.sx, dy = b.sy - a.sy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len, ny = dx / len; // unit normal
      const tick = 6;
      ctx.lineWidth = 2;
      [a, b].forEach((p) => {
        ctx.beginPath();
        ctx.moveTo(p.sx - nx * tick, p.sy - ny * tick);
        ctx.lineTo(p.sx + nx * tick, p.sy + ny * tick);
        ctx.stroke();
      });

      if (len >= 40) {
        ctx.fillStyle = '#1a1a18'; // ink
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.save();
        ctx.translate((a.sx + b.sx) / 2, (a.sy + b.sy) / 2);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.fillText(d.label, 0, -8);
        ctx.restore();
        ctx.textAlign = 'left';
      }
    });
  }

  function render() {
    resizeCanvas();
    const store = window.WarehouseStore;
    if (!store) return;
    const wh = store.data.warehouse;
    const whId = wh ? wh.id : null;
    if (view.fittedForId !== whId && wh && wh.shape && wh.shape.length >= 3) {
      fitToWarehouse();
      view.fittedForId = whId;
    }
    const wrap = canvas.parentElement;
    ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
    if (!wh) {
      ctx.fillStyle = '#5f5e5a'; // ink-secondary
      ctx.font = '14px sans-serif';
      ctx.fillText('Define a warehouse shell first (Tab 1) to see the plan.', 20, 30);
      return;
    }
    drawGrid(wh);
    drawWarehouse(wh);
    drawZones(store.data.zones);
    drawRacks(store.data.racks, store);
    drawDoors(store.data.doors, wh);
  }

  // pan & zoom
  canvas.addEventListener('mousedown', (e) => {
    view.dragging = true; view.lastX = e.clientX; view.lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { view.dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!view.dragging) return;
    const dx = e.clientX - view.lastX;
    const dy = e.clientY - view.lastY;
    view.panX += dx;
    view.panY -= dy;
    view.lastX = e.clientX; view.lastY = e.clientY;
    render();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    view.scale = Math.max(1, Math.min(200, view.scale * factor));
    render();
  }, { passive: false });

  window.addEventListener('resize', () => render());

  window.Canvas2D = { render, resetView: () => { view.fittedForId = null; render(); } };
})();
