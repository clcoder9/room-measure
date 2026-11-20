import * as THREE from 'three';
import {
  UnitSystem,
  calculateHorizontalDistance,
  calculateShoelaceArea,
  calculateInteriorAngleDeg,
  formatDistance,
  formatArea
} from '../measurement/math';

interface MapTransform {
  centerX: number;
  centerZ: number;
  scale: number;
  w: number;
  h: number;
}

export class MiniMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;
  private headerTitleEl: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private isExpanded = false;

  private lastFloorPoints: THREE.Vector3[] = [];
  private lastTransform: MapTransform | null = null;
  private dragTransform: MapTransform | null = null;
  private draggingIndex: number | null = null;
  private onCornerDrag?: (index: number, newX: number, newZ: number) => void;

  constructor(
    parent: HTMLElement,
    onCornerDrag?: (index: number, newX: number, newZ: number) => void
  ) {
    this.onCornerDrag = onCornerDrag;

    this.container = document.createElement('div');
    this.container.className = 'minimap-container';
    this.container.title = 'Tap to expand 2D Floor Plan';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 160;
    this.canvas.height = 160;
    this.canvas.className = 'minimap-canvas';

    const header = document.createElement('div');
    header.className = 'minimap-header';

    this.headerTitleEl = document.createElement('span');
    this.headerTitleEl.textContent = '2D PLAN';

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.type = 'button';
    this.toggleBtn.className = 'minimap-toggle';
    this.toggleBtn.setAttribute('aria-label', 'Expand 2D floor plan');
    this.toggleBtn.textContent = '⛶';

    header.appendChild(this.headerTitleEl);
    header.appendChild(this.toggleBtn);
    this.container.appendChild(header);
    this.container.appendChild(this.canvas);
    parent.appendChild(this.container);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context for MiniMap');
    this.ctx = ctx;

    // Prevent WebXR select events when interacting with the minimap overlay
    this.container.addEventListener('beforexrselect', (e) => {
      e.preventDefault();
    });

    // Toggle expand/collapse: anywhere when compact, or header/toggle button when expanded
    this.container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.isExpanded || e.target === header || e.target === this.headerTitleEl || e.target === this.toggleBtn) {
        this.toggleExpand();
      }
    });

    // Interactive corner dragging on expanded 2D plan
    this.canvas.addEventListener('pointerdown', this.onCanvasPointerDown.bind(this));
    this.canvas.addEventListener('pointermove', this.onCanvasPointerMove.bind(this));
    this.canvas.addEventListener('pointerup', this.onCanvasPointerUp.bind(this));
    this.canvas.addEventListener('pointercancel', this.onCanvasPointerUp.bind(this));
  }

  public toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
    this.draggingIndex = null;
    this.dragTransform = null;

    if (this.isExpanded) {
      this.container.classList.add('expanded');
      this.canvas.width = Math.min(window.innerWidth - 40, 420);
      this.canvas.height = Math.min(window.innerHeight * 0.52, 380);
      this.headerTitleEl.textContent = 'Drag corners to fine-tune • Tap ✕ to close';
      this.toggleBtn.textContent = '✕';
      this.toggleBtn.setAttribute('aria-label', 'Close 2D floor plan');
      this.canvas.style.touchAction = 'none';
    } else {
      this.container.classList.remove('expanded');
      this.canvas.width = 160;
      this.canvas.height = 160;
      this.headerTitleEl.textContent = '2D PLAN';
      this.toggleBtn.textContent = '⛶';
      this.toggleBtn.setAttribute('aria-label', 'Expand 2D floor plan');
      this.canvas.style.touchAction = 'auto';
    }
  }

  private getCanvasPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.height
    };
  }

  private onCanvasPointerDown(e: PointerEvent): void {
    if (!this.isExpanded || !this.lastTransform || this.lastFloorPoints.length === 0) return;

    const pt = this.getCanvasPoint(e);
    const t = this.lastTransform;
    let bestIdx = -1;
    let bestDist = 20; // hit radius in canvas px

    this.lastFloorPoints.forEach((p, idx) => {
      const cx = t.w / 2 + (p.x - t.centerX) * t.scale;
      const cy = t.h / 2 + (p.z - t.centerZ) * t.scale;
      const dist = Math.hypot(pt.x - cx, pt.y - cy);
      if (dist <= bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });

    if (bestIdx !== -1) {
      e.stopPropagation();
      e.preventDefault();
      this.draggingIndex = bestIdx;
      this.dragTransform = { ...t };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }
    }
  }

  private onCanvasPointerMove(e: PointerEvent): void {
    if (this.draggingIndex === null || !this.dragTransform || !this.onCornerDrag) return;
    e.stopPropagation();
    e.preventDefault();

    const pt = this.getCanvasPoint(e);
    const t = this.dragTransform;
    const wx = t.centerX + (pt.x - t.w / 2) / t.scale;
    const wz = t.centerZ + (pt.y - t.h / 2) / t.scale;
    this.onCornerDrag(this.draggingIndex, wx, wz);
  }

  private onCanvasPointerUp(e: PointerEvent): void {
    if (this.draggingIndex === null) return;
    e.stopPropagation();
    this.draggingIndex = null;
    this.dragTransform = null;
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Render top-down 2D floor plan radar
   */
  public render(
    floorPoints: THREE.Vector3[],
    isClosed: boolean,
    reticlePos: THREE.Vector3 | null,
    camera: THREE.Camera,
    unitSystem: UnitSystem = 'metric',
    isSnapped: boolean = false
  ): void {
    this.lastFloorPoints = floorPoints;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Determine bounding box transform (freeze during active corner drag)
    let transform: MapTransform;
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    if (this.dragTransform) {
      transform = this.dragTransform;
    } else {
      const allPts: { x: number; z: number }[] = floorPoints.map((p) => ({ x: p.x, z: p.z }));
      if (reticlePos) {
        allPts.push({ x: reticlePos.x, z: reticlePos.z });
      }
      allPts.push({ x: camPos.x, z: camPos.z });

      if (allPts.length === 0) return;

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      allPts.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      });

      const spanX = Math.max(maxX - minX, 2.5);
      const spanZ = Math.max(maxZ - minZ, 2.5);
      const span = Math.max(spanX, spanZ) * 1.35;

      transform = {
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        scale: Math.min(w, h) / span,
        w,
        h
      };
      this.lastTransform = transform;
    }

    const { centerX, centerZ, scale } = transform;
    const toCanvasX = (wx: number) => w / 2 + (wx - centerX) * scale;
    const toCanvasY = (wz: number) => h / 2 + (wz - centerZ) * scale;

    // 2. Subtle background radar grid (1m)
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.lineWidth = 1;
    const gridSize = 1.0 * scale;
    if (gridSize > 12) {
      const startX = (w / 2) % gridSize;
      for (let x = startX; x < w; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      const startY = (h / 2) % gridSize;
      for (let y = startY; y < h; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // 3. Floor Polygon Fill
    if (floorPoints.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(toCanvasX(floorPoints[0].x), toCanvasY(floorPoints[0].z));
      for (let i = 1; i < floorPoints.length; i++) {
        ctx.lineTo(toCanvasX(floorPoints[i].x), toCanvasY(floorPoints[i].z));
      }
      if (isClosed) ctx.closePath();
      ctx.fillStyle = 'rgba(0, 242, 254, 0.15)';
      ctx.fill();
    }

    // 4. Solid Wall Lines & Expanded Labels
    if (floorPoints.length >= 2) {
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = this.isExpanded ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(toCanvasX(floorPoints[0].x), toCanvasY(floorPoints[0].z));
      for (let i = 1; i < floorPoints.length; i++) {
        ctx.lineTo(toCanvasX(floorPoints[i].x), toCanvasY(floorPoints[i].z));
      }
      if (isClosed && floorPoints.length >= 3) {
        ctx.lineTo(toCanvasX(floorPoints[0].x), toCanvasY(floorPoints[0].z));
      }
      ctx.stroke();

      if (this.isExpanded) {
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < floorPoints.length - 1; i++) {
          const p1 = floorPoints[i];
          const p2 = floorPoints[i + 1];
          const mx = (toCanvasX(p1.x) + toCanvasX(p2.x)) / 2;
          const my = (toCanvasY(p1.z) + toCanvasY(p2.z)) / 2;
          const d = calculateHorizontalDistance(p1, p2);
          ctx.fillText(formatDistance(d, unitSystem), mx, my - 8);
        }
        if (isClosed && floorPoints.length >= 3) {
          const pLast = floorPoints[floorPoints.length - 1];
          const pFirst = floorPoints[0];
          const mx = (toCanvasX(pLast.x) + toCanvasX(pFirst.x)) / 2;
          const my = (toCanvasY(pLast.z) + toCanvasY(pFirst.z)) / 2;
          const d = calculateHorizontalDistance(pLast, pFirst);
          ctx.fillText(formatDistance(d, unitSystem), mx, my - 8);
        }
      }
    }

    // 5. Live Line to Reticle
    if (!isClosed && floorPoints.length > 0 && reticlePos) {
      const lastP = floorPoints[floorPoints.length - 1];
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = isSnapped ? '#10b981' : '#38bdf8';
      ctx.lineWidth = isSnapped ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(toCanvasX(lastP.x), toCanvasY(lastP.z));
      ctx.lineTo(toCanvasX(reticlePos.x), toCanvasY(reticlePos.z));
      ctx.stroke();
      ctx.restore();
    }

    // 6. Corner Anchor Dots, Numbers, and Interior Angles
    floorPoints.forEach((p, idx) => {
      const cx = toCanvasX(p.x);
      const cy = toCanvasY(p.z);
      const isDraggingThis = this.draggingIndex === idx;

      if (isDraggingThis) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = idx === 0 ? '#10b981' : '#00f2fe';
      ctx.beginPath();
      ctx.arc(cx, cy, this.isExpanded ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();

      if (this.isExpanded) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(`#${idx + 1}`, cx + 10, cy - 3);

        if (floorPoints.length >= 3 && (isClosed || (idx > 0 && idx < floorPoints.length - 1))) {
          const pPrev = floorPoints[(idx - 1 + floorPoints.length) % floorPoints.length];
          const pNext = floorPoints[(idx + 1) % floorPoints.length];
          const angleDeg = calculateInteriorAngleDeg(pPrev, p, pNext);
          if (angleDeg > 0) {
            const isRight = Math.abs(angleDeg - 90) <= 1.5;
            ctx.fillStyle = isRight ? '#34d399' : '#94a3b8';
            ctx.font = 'bold 10px system-ui';
            ctx.fillText(`${Math.round(angleDeg)}°`, cx + 10, cy + 9);
          }
        }
      }
    });

    // 7. Reticle target on radar
    if (reticlePos) {
      const rx = toCanvasX(reticlePos.x);
      const ry = toCanvasY(reticlePos.z);
      ctx.strokeStyle = isSnapped ? '#10b981' : '#00f2fe';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rx, ry, this.isExpanded ? 7 : 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 8. Camera Position & User View Cone
    const camX = toCanvasX(camPos.x);
    const camY = toCanvasY(camPos.z);

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const yaw = Math.atan2(camDir.z, camDir.x);

    ctx.save();
    ctx.translate(camX, camY);
    ctx.rotate(yaw);

    const coneLength = this.isExpanded ? 32 : 18;
    const fovAngle = Math.PI / 4;

    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, coneLength, -fovAngle, fovAngle);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(0, 0, this.isExpanded ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 9. Area readout badge inside minimap
    if (floorPoints.length >= 3) {
      const area = calculateShoelaceArea(floorPoints);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(formatArea(area, unitSystem, false), 6, h - 8);
    }
  }
}
