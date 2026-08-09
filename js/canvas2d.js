// canvas2d.js — top-down 2D plan renderer for Dynamic Spatial Model Builder.
// Coordinate convention: warehouse (0,0) is bottom-left (the origin), X to the
// right, Y upward. Canvas pixel Y grows downward, so we flip Y when drawing.
//
// Exposes a reusable factory (window.PlanView.create) so multiple canvases
// can each show the full warehouse plan with their own independent pan/zoom
// state: the main "2D Plan" tab, plus small live-preview canvases embedded
// in the Doors, Zones & Obstacles, and Interior Walls tabs. Those preview
// instances can also be given a "draft" item (a door, zone/obstacle, or
// wall not yet saved, reflecting the current form values) to highlight, via
// render({door: ...}), render({zone: ...}), or render({wall: ...}).

(function () {
  // Standard door colors — kept in sync with the same constants in main.js
  // (table swatches) and three3d.js (3D view).
  const DOOR_COLORS = { garage: '#7C8892', regular: '#8B5E34' };
  // Picking-side indicator color — kept in sync with the same constant in
  // three3d.js (3D view) and main.js (legend).
  const PICKING_COLOR = '#2F8F4E';

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function createPlanView(canvas) {
    const ctx = canvas.getContext('2d');

    // fittedForId tracks which warehouse's shape the current scale/pan was
    // fitted to — not just a one-time boolean — so that switching to a
    // different (or differently-sized) warehouse re-fits automatically
    // instead of keeping a stale scale computed for a previous building.
    const view = { scale: 20, panX: 40, panY: 40, dragging: false, lastX: 0, lastY: 0, fittedForId: undefined, floor: 'ground' };
    let lastDraft = null; // { door: {...} } or { zone: {...} }, remembered across pan/zoom/resize re-renders

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

    // Mezzanine footprint — a dashed purple rectangle outline showing where
    // the raised deck sits, drawn on both floors so it's clear from Ground
    // where the mezzanine overhead is, and from Mezzanine what its own
    // boundary is (racks on that floor should stay within it).
    function drawMezzanineFootprint(mz) {
      if (!mz || !mz.enabled) return;
      const a = worldToScreen(mz.x, mz.y);
      const b = worldToScreen(mz.x + mz.width, mz.y + mz.depth);
      ctx.save();
      ctx.strokeStyle = '#7A4FBF';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(a.sx, b.sx), Math.min(a.sy, b.sy), Math.abs(b.sx - a.sx), Math.abs(b.sy - a.sy));
      ctx.setLineDash([]);
      ctx.fillStyle = '#7A4FBF';
      ctx.font = '12px sans-serif';
      ctx.fillText(`Mezzanine (${mz.heightMm}mm)`, Math.min(a.sx, b.sx), Math.min(a.sy, b.sy) - 6);
      ctx.restore();
    }

    // Interior walls render as a solid gray stroke, thick enough on-screen
    // to reflect the wall's real thickness (clamped to a legible minimum at
    // low zoom, same treatment as everything else that scales with view.scale).
    // Shown on every plan view (not just the Walls sub-tab) since — like
    // doors — they're structural context relevant everywhere.
    const WALL_COLOR = '#5f5e5a'; // ink-secondary
    function drawWalls(walls) {
      if (!walls || !walls.length) return;
      walls.forEach((w) => {
        const a = worldToScreen(w.x1, w.y1);
        const b = worldToScreen(w.x2, w.y2);
        ctx.strokeStyle = WALL_COLOR;
        ctx.lineWidth = Math.max(w.thickness * view.scale, 3);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
        ctx.lineCap = 'butt';

        const len = Math.hypot(b.sx - a.sx, b.sy - a.sy);
        if (len >= 40) {
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.save();
          ctx.translate((a.sx + b.sx) / 2, (a.sy + b.sy) / 2);
          ctx.rotate(Math.atan2(b.sy - a.sy, b.sx - a.sx));
          ctx.fillText(w.name, 0, 3);
          ctx.restore();
          ctx.textAlign = 'left';
        }
      });
    }

    // Highlights an in-progress (unsaved) wall from the Interior Walls form.
    // `draft.valid` (whether it fits fully inside the warehouse shell —
    // resolved by the caller via Model.wallFullyInsidePolygon) recolors it
    // red, same treatment as drawDraftZone/drawDraftRack.
    function drawDraftWall(draft) {
      if (!draft) return;
      const invalid = draft.valid === false;
      const a = worldToScreen(draft.x1, draft.y1);
      const b = worldToScreen(draft.x2, draft.y2);
      const color = invalid ? '#C0392B' : WALL_COLOR;

      ctx.strokeStyle = hexToRgba(color, 0.35);
      ctx.lineWidth = Math.max(draft.thickness * view.scale, 3) + 8;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();

      ctx.strokeStyle = invalid ? '#C0392B' : '#E2572E';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';

      if (invalid) {
        ctx.fillStyle = '#C0392B';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Outside warehouse shell', (a.sx + b.sx) / 2, Math.min(a.sy, b.sy) - 10);
        ctx.textAlign = 'left';
      }
    }

    // Flat zones (Storage/Staging/Picking/Dock/Office/Other) render as a
    // dashed, translucent tint — unchanged from before. Obstacles (raised
    // physical objects pickers must route around) render with a solid fill,
    // a diagonal hatch pattern, and a solid border, plus their height in the
    // label, so they read as distinctly "physical" rather than a flat area.
    // Draws a circular obstacle (e.g. a round column) — same hatch/fill/
    // stroke treatment as a rectangular obstacle, clipped to a circle
    // instead of a rect. `z.width` is the diameter; the bounding square's
    // corner is (z.x, z.y), matching how rectangular zones/obstacles store
    // their position, so a round obstacle's center is (z.x + r, z.y + r).
    function drawRoundObstacle(z) {
      const r = z.width / 2;
      const centerWorld = { x: z.x + r, y: z.y + r };
      const c = worldToScreen(centerWorld.x, centerWorld.y);
      const edge = worldToScreen(centerWorld.x + r, centerWorld.y);
      const sr = Math.abs(edge.sx - c.sx);

      ctx.fillStyle = hexToRgba(z.color, 0.35);
      ctx.beginPath(); ctx.arc(c.sx, c.sy, sr, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(c.sx, c.sy, sr, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = hexToRgba(z.color, 0.6);
      ctx.lineWidth = 1.5;
      for (let i = -2 * sr; i < 2 * sr; i += 8) {
        ctx.beginPath();
        ctx.moveTo(c.sx - sr + i, c.sy + sr);
        ctx.lineTo(c.sx - sr + i + 2 * sr, c.sy - sr);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = hexToRgba(z.color, 0.95);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.sx, c.sy, sr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#1a1a18'; // ink
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${z.name} (${z.height}m tall)`, c.sx, c.sy - sr - 6);
      ctx.textAlign = 'left';
    }

    function drawZones(zones) {
      zones.forEach((z) => {
        if (z.kind === 'obstacle' && z.shape === 'round') { drawRoundObstacle(z); return; }

        const a = worldToScreen(z.x, z.y);
        const b = worldToScreen(z.x + z.width, z.y + z.length);
        const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
        const w = Math.abs(b.sx - a.sx), h = Math.abs(b.sy - a.sy);

        if (z.kind === 'obstacle') {
          ctx.fillStyle = hexToRgba(z.color, 0.35);
          ctx.fillRect(x, y, w, h);
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.strokeStyle = hexToRgba(z.color, 0.6);
          ctx.lineWidth = 1.5;
          for (let i = -h; i < w; i += 8) {
            ctx.beginPath();
            ctx.moveTo(x + i, y + h);
            ctx.lineTo(x + i + h, y);
            ctx.stroke();
          }
          ctx.restore();
          ctx.strokeStyle = hexToRgba(z.color, 0.95);
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
          ctx.fillStyle = '#1a1a18'; // ink
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText(`${z.name} (${z.height}m tall)`, x + 4, y + 14);
        } else {
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
        }
      });
    }

    // Highlights an in-progress (unsaved) zone/obstacle from the Zones &
    // Obstacles form, so the user sees exactly where it will land before
    // clicking Add.
    // `draft.valid` (whether it fits fully inside the warehouse shell —
    // resolved by the caller via Model.zoneFullyInsidePolygon) recolors the
    // whole highlight red when false, same treatment as drawDraftRack below.
    function drawDraftZone(draft) {
      if (!draft) return;
      const invalid = draft.valid === false;
      const color = invalid ? '#C0392B' : (draft.color || (draft.kind === 'obstacle' ? '#5f5e5a' : '#BC5C92'));
      const accent = invalid ? '#C0392B' : '#E2572E'; // red when out of bounds, else the usual "editing" accent

      if (draft.kind === 'obstacle' && draft.shape === 'round') {
        const r = draft.width / 2;
        const c = worldToScreen(draft.x + r, draft.y + r);
        const edge = worldToScreen(draft.x + r + r, draft.y + r);
        const sr = Math.abs(edge.sx - c.sx);
        ctx.fillStyle = hexToRgba(color, 0.3);
        ctx.beginPath(); ctx.arc(c.sx, c.sy, sr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(c.sx, c.sy, sr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        if (invalid) {
          ctx.fillStyle = '#C0392B';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Outside warehouse shell', c.sx, c.sy - sr - 6);
          ctx.textAlign = 'left';
        }
        return;
      }

      const a = worldToScreen(draft.x, draft.y);
      const b = worldToScreen(draft.x + draft.width, draft.y + draft.length);
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
      const w = Math.abs(b.sx - a.sx), h = Math.abs(b.sy - a.sy);

      ctx.fillStyle = hexToRgba(color, 0.3);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      if (invalid) {
        ctx.fillStyle = '#C0392B';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Outside warehouse shell', x + w / 2, y - 6);
        ctx.textAlign = 'left';
      }
    }

    // Draws a colored edge + outward-pointing arrow along whichever side of
    // a rack's footprint is marked as the picking-access side. `edge` is
    // { p1, p2, nx, ny } in warehouse space, from Model.rackPickingEdge.
    // `color` overrides the default (used to flag an invalid draft red).
    function drawPickingIndicator(edge, color) {
      if (!edge) return;
      color = color || PICKING_COLOR;
      const a = worldToScreen(edge.p1.x, edge.p1.y);
      const b = worldToScreen(edge.p2.x, edge.p2.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();

      const midX = (edge.p1.x + edge.p2.x) / 2, midY = (edge.p1.y + edge.p2.y) / 2;
      const base = worldToScreen(midX, midY);
      const tip = worldToScreen(midX + edge.nx * 0.8, midY + edge.ny * 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(base.sx, base.sy); ctx.lineTo(tip.sx, tip.sy); ctx.stroke();
      const angle = Math.atan2(tip.sy - base.sy, tip.sx - base.sx);
      const ah = 6;
      ctx.beginPath();
      ctx.moveTo(tip.sx, tip.sy);
      ctx.lineTo(tip.sx - ah * Math.cos(angle - Math.PI / 6), tip.sy - ah * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(tip.sx - ah * Math.cos(angle + Math.PI / 6), tip.sy - ah * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Highlights an in-progress (unsaved) rack from the Racks & Aisles form —
    // draft is { x, y, lengthM, depthM, rotation, pickingSide, name, valid }
    // (footprint already resolved via store.rackFootprint by the caller) —
    // so the user sees exactly where it will land, how much floor space it
    // takes, and which side picking happens from before clicking Add Rack.
    // `valid` (whether it fits fully inside the warehouse shell) recolors
    // the whole highlight red when false, so an out-of-bounds placement is
    // obvious before the user even tries to submit.
    function drawDraftRack(draft) {
      if (!draft) return;
      const rot = draft.rotation === 90;
      const w = rot ? draft.depthM : draft.lengthM;
      const h = rot ? draft.lengthM : draft.depthM;
      const a = worldToScreen(draft.x, draft.y);
      const b = worldToScreen(draft.x + w, draft.y + h);
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
      const pw = Math.abs(b.sx - a.sx), ph = Math.abs(b.sy - a.sy);
      const invalid = draft.valid === false;
      const accent = invalid ? '#C0392B' : '#E2572E'; // red when out of bounds, else the usual "editing" accent

      ctx.fillStyle = invalid ? 'rgba(192,57,43,0.25)' : 'rgba(242,169,60,0.3)';
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, pw, ph);
      ctx.setLineDash([]);

      if (draft.name && pw >= 30 && ph >= 14) {
        ctx.fillStyle = '#1a1a18'; // ink
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(draft.name, x + pw / 2, y + ph / 2 + 4);
        ctx.textAlign = 'left';
      }

      if (draft.pickingSide) {
        const edge = window.WarehouseModel.rackPickingEdge(draft);
        drawPickingIndicator(edge, invalid ? '#C0392B' : PICKING_COLOR);
      }

      if (invalid) {
        ctx.fillStyle = '#C0392B';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Outside warehouse shell', x + pw / 2, y - 6);
        ctx.textAlign = 'left';
      }

      drawOriginDot(draft.x, draft.y);
    }

    // Marks a rack's origin — the (x, y) corner the form's X/Y fields refer
    // to, i.e. the low-X/low-Y corner of its footprint before rotation is
    // applied — with a large red dot, so it's unambiguous which corner moves
    // when the user edits X/Y, independent of rotation or picking side.
    function drawOriginDot(x, y) {
      const p = worldToScreen(x, y);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#C0392B';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
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
              // Screen Y is inverted relative to world Y (worldToScreen flips
              // it for the usual "up = north" plan convention), but `y`/`ph`
              // here are screen-space min/max — so a naive frac would place
              // Bay 1 at the far (high-world-Y) end instead of the origin
              // corner. Flip the fraction to keep Bay 1 anchored at the
              // origin dot, matching the un-rotated case and the 3D view.
              const ty = y + ph * (1 - frac);
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

        const edge = window.WarehouseModel.rackPickingEdge({
          x: r.x, y: r.y, rotation: r.rotation, lengthM, depthM, pickingSide: r.pickingSide
        });
        drawPickingIndicator(edge);
        drawOriginDot(r.x, r.y);
      });
    }

    // Draws each door as a thick colored overlay on its wall segment, with a
    // small perpendicular tick at each jamb (like a door-opening symbol) and a
    // label once zoomed in enough for it to be legible.
    function drawDoors(doors, wh, walls) {
      if (!doors || !doors.length) return;
      doors.forEach((d) => {
        const dp = window.WarehouseModel.doorPoints(wh.shape, walls, d);
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

    // Highlights an in-progress (unsaved) door from the Doors form, so the
    // user sees exactly where it will land on the wall before clicking Add.
    function drawDraftDoor(wh, walls, draft) {
      if (!draft || !wh) return;
      const dp = window.WarehouseModel.doorPoints(wh.shape, walls, draft);
      if (!dp) return;
      const a = worldToScreen(dp.start.x, dp.start.y);
      const b = worldToScreen(dp.end.x, dp.end.y);
      const color = DOOR_COLORS[draft.type] || DOOR_COLORS.regular;

      // Translucent halo behind the normal door stroke, plus a dashed accent
      // on top, so the draft reads as clearly "being edited."
      ctx.strokeStyle = hexToRgba(color, 0.35);
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();

      ctx.strokeStyle = '#E2572E'; // secondary-2
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
    }

    // `draft` (optional) is { door: {...} }, { zone: {...} }, { wall: {...} },
    // or { rack: {...} } — the current unsaved form state from the Doors /
    // Zones & Obstacles / Interior Walls / Racks & Aisles tabs, highlighted
    // on top of the normal plan. Passing nothing keeps whatever draft was
    // last set (so pan/zoom/resize re-renders don't lose the highlight).
    function render(draft) {
      if (draft !== undefined) lastDraft = draft;
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
      if (lastDraft && lastDraft.zone) drawDraftZone(lastDraft.zone);
      drawWalls(store.data.walls);
      if (lastDraft && lastDraft.wall) drawDraftWall(lastDraft.wall);
      const mz = wh.mezzanine;
      drawMezzanineFootprint(mz);
      // Only racks on the currently-selected floor are shown/editable here —
      // a mezzanine rack would otherwise overlap the ground floor's plan at
      // the same (x,y), which reads as a collision even though it's really
      // sitting a level above. Racks predating the mezzanine feature default
      // to floor:'ground' (see normalizeRack in model.js), so they always
      // show up on Ground with no migration needed.
      const racksOnFloor = store.data.racks.filter((r) => (r.floor || 'ground') === view.floor);
      drawRacks(racksOnFloor, store);
      if (lastDraft && lastDraft.rack) drawDraftRack(lastDraft.rack);
      drawDoors(store.data.doors, wh, store.data.walls);
      if (lastDraft && lastDraft.door) drawDraftDoor(wh, store.data.walls, lastDraft.door);
      drawScaleBar();
    }

    // Switches which floor's racks this view shows/highlights — 'ground' or
    // 'mezzanine'. No-op (still re-renders) if the warehouse has no
    // mezzanine configured, since every rack is on 'ground' by default.
    function setFloor(floor) {
      view.floor = floor === 'mezzanine' ? 'mezzanine' : 'ground';
      render();
    }

    // Rounds a raw "metres per target pixel width" value down to a tidy
    // 1/2/5 × 10^n number (the same convention printed maps/CAD tools use
    // for scale bars), so the bar reads e.g. "5 m" or "20 m" rather than an
    // arbitrary value like "13.7 m".
    function niceScaleMetres(raw) {
      if (!(raw > 0)) return 1;
      const exp = Math.floor(Math.log10(raw));
      const base = Math.pow(10, exp);
      const fraction = raw / base;
      const niceFraction = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
      return niceFraction * base;
    }

    // Bottom-left scale bar — a fixed-position (screen-space) ruler segment
    // reflecting the current zoom level, so distances in the plan can be
    // read at a glance regardless of how far in/out the user has panned/zoomed.
    function drawScaleBar() {
      const wrap = canvas.parentElement;
      const h = wrap.clientHeight;
      const targetPx = 90;
      const metres = niceScaleMetres(targetPx / view.scale);
      const px = metres * view.scale;
      const x0 = 16, y0 = h - 16;

      ctx.strokeStyle = '#1a1a18'; // ink
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + px, y0);
      ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 5);
      ctx.moveTo(x0 + px, y0 - 5); ctx.lineTo(x0 + px, y0 + 5);
      ctx.stroke();

      const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(x0 + px / 2 - tw / 2 - 3, y0 - 24, tw + 6, 14);
      ctx.fillStyle = '#1a1a18';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x0 + px / 2, y0 - 13);
      ctx.textAlign = 'left';
    }

    // Shared by the scroll-wheel handler and the Zoom In/Out toolbar
    // buttons, so both adjust the scale the same way (clamped 1–200).
    function applyZoom(factor) {
      view.scale = Math.max(1, Math.min(200, view.scale * factor));
      render();
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
      applyZoom(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    window.addEventListener('resize', () => render());

    return {
      render,
      resetView: (draft) => { view.fittedForId = null; render(draft); },
      zoomIn: () => applyZoom(1.2),
      zoomOut: () => applyZoom(1 / 1.2),
      setFloor,
      getFloor: () => view.floor
    };
  }

  window.PlanView = { create: createPlanView };

  // Main "2D Plan" tab canvas — kept as window.Canvas2D for backward compatibility.
  window.Canvas2D = createPlanView(document.getElementById('canvas2d'));

  // Live-preview canvases embedded in the Doors, Zones & Obstacles, and
  // Racks & Aisles tabs.
  const doorsCanvas = document.getElementById('doorsPlanCanvas');
  if (doorsCanvas) window.DoorsPlanView = createPlanView(doorsCanvas);
  // Walls share the Zones & Obstacles canvas above (render({wall:...}) is
  // just another draft key the same ZonesPlanView instance understands —
  // see drawWalls/drawDraftWall) rather than getting a canvas of their own.
  const racksCanvas = document.getElementById('racksPlanCanvas');
  if (racksCanvas) window.RacksPlanView = createPlanView(racksCanvas);
})();
