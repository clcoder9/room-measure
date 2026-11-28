import * as THREE from 'three';
import {
  UnitSystem,
  calculateHorizontalDistance,
  calculateShoelaceArea,
  calculateInteriorAngleDeg,
  formatDistance,
  formatArea
} from '../measurement/math';
import { FurnitureBox, ShellEstimate, WallOpening } from '../scan/ScanTypes';

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
  private lastFurniture: FurnitureBox[] = [];
  private lastTransform: MapTransform | null = null;
  private dragTransform: MapTransform | null = null;
  private draggingIndex: number | null = null;
  private draggingFurnitureId: string | null = null;
  private dragFurnOffset: [number, number] = [0, 0];
  private onCornerDrag?: (index: number, newX: number, newZ: number) => void;
  private onFurnitureDrag?: (id: string, newX: number, newZ: number) => void;

  constructor(
    parent: HTMLElement,
    onCornerDrag?: (index: number, newX: number, newZ: number) => void,
    onFurnitureDrag?: (id: string, newX: number, newZ: number) => void
  ) {
    this.onCornerDrag = onCornerDrag;
    this.onFurnitureDrag = onFurnitureDrag;

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

  public isExpandedView(): boolean {
    return this.isExpanded;
  }

  public setVisible(visible: boolean): void {
    this.container.classList.toggle('hidden', !visible);
    if (!visible && this.isExpanded) {
      this.toggleExpand();
    }
  }

  public toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
    this.draggingIndex = null;
    this.draggingFurnitureId = null;
    this.dragTransform = null;

    if (this.isExpanded) {
      this.container.classList.add('expanded');
      this.canvas.width = Math.min(window.innerWidth - 40, 420);
      this.canvas.height = Math.min(window.innerHeight * 0.52, 380);
      this.headerTitleEl.textContent = 'Drag corners or furniture • Tap ✕ to close';
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
    if (!this.isExpanded || !this.lastTransform) return;

    const pt = this.getCanvasPoint(e);
    const t = this.lastTransform;

    if (this.lastFloorPoints.length > 0) {
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
        return;
      }
    }

    if (this.lastFurniture.length > 0 && this.onFurnitureDrag) {
      const wx = t.centerX + (pt.x - t.w / 2) / t.scale;
      const wz = t.centerZ + (pt.y - t.h / 2) / t.scale;
      const padM = Math.max(0.10, 8 / t.scale);

      for (let i = this.lastFurniture.length - 1; i >= 0; i--) {
        const f = this.lastFurniture[i];
        const dx = wx - f.centerXZ[0];
        const dz = wz - f.centerXZ[1];
        const cos = Math.cos(f.yawRad);
        const sin = Math.sin(f.yawRad);
        const lu = dx * cos + dz * sin;
        const lv = -dx * sin + dz * cos;
        if (Math.abs(lu) <= f.widthMeters * 0.5 + padM && Math.abs(lv) <= f.depthMeters * 0.5 + padM) {
          e.stopPropagation();
          e.preventDefault();
          this.draggingFurnitureId = f.id;
          this.dragFurnOffset = [f.centerXZ[0] - wx, f.centerXZ[1] - wz];
          this.dragTransform = { ...t };
          try {
            this.canvas.setPointerCapture(e.pointerId);
          } catch {
            // Ignore
          }
          return;
        }
      }
    }
  }

  private onCanvasPointerMove(e: PointerEvent): void {
    if (!this.dragTransform) return;

    if (this.draggingIndex !== null && this.onCornerDrag) {
      e.stopPropagation();
      e.preventDefault();
      const pt = this.getCanvasPoint(e);
      const t = this.dragTransform;
      const wx = t.centerX + (pt.x - t.w / 2) / t.scale;
      const wz = t.centerZ + (pt.y - t.h / 2) / t.scale;
      this.onCornerDrag(this.draggingIndex, wx, wz);
      return;
    }

    if (this.draggingFurnitureId !== null && this.onFurnitureDrag) {
      e.stopPropagation();
      e.preventDefault();
      const pt = this.getCanvasPoint(e);
      const t = this.dragTransform;
      const wx = t.centerX + (pt.x - t.w / 2) / t.scale;
      const wz = t.centerZ + (pt.y - t.h / 2) / t.scale;
      this.onFurnitureDrag(
        this.draggingFurnitureId,
        wx + this.dragFurnOffset[0],
        wz + this.dragFurnOffset[1]
      );
    }
  }

  private onCanvasPointerUp(e: PointerEvent): void {
    if (this.draggingIndex === null && this.draggingFurnitureId === null) return;
    e.stopPropagation();
    this.draggingIndex = null;
    this.draggingFurnitureId = null;
    this.dragTransform = null;
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
  }

  private drawFurnitureBoxes2D(
    furniture: FurnitureBox[],
    toX: (wx: number) => number,
    toY: (wz: number) => number,
    scale: number,
    showLabels: boolean
  ): void {
    const ctx = this.ctx;
    for (const f of furniture) {
      const cx = toX(f.centerXZ[0]);
      const cy = toY(f.centerXZ[1]);
      const pw = f.widthMeters * scale;
      const pd = f.depthMeters * scale;
      const isDragging = this.draggingFurnitureId === f.id;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(f.yawRad);
      ctx.fillStyle = isDragging ? 'rgba(16, 185, 129, 0.38)' : 'rgba(16, 185, 129, 0.22)';
      ctx.strokeStyle = isDragging ? '#ffffff' : '#34d399';
      ctx.lineWidth = isDragging ? 2 : 1.4;
      ctx.fillRect(-pw * 0.5, -pd * 0.5, pw, pd);
      ctx.strokeRect(-pw * 0.5, -pd * 0.5, pw, pd);
      if (showLabels && pw > 24 && pd > 14) {
        ctx.fillStyle = '#a7f3d0';
        ctx.font = 'bold 9px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.label.split(' ')[0], 0, 0);
      }
      ctx.restore();
    }
  }

  private drawWallOpenings2D(
    openings: WallOpening[],
    getWallEndpoints: (wallIndex: number) => { p1: [number, number]; p2: [number, number] } | null,
    toX: (wx: number) => number,
    toY: (wz: number) => number
  ): void {
    const ctx = this.ctx;
    for (const op of openings) {
      if (op.wallIndex === undefined || op.offsetAlongWallMeters === undefined) continue;
      const seg = getWallEndpoints(op.wallIndex);
      if (!seg) continue;
      const dx = seg.p2[0] - seg.p1[0];
      const dz = seg.p2[1] - seg.p1[1];
      const wallLen = Math.hypot(dx, dz);
      if (wallLen < 0.05) continue;

      const s0 = Math.max(0, Math.min(wallLen, op.offsetAlongWallMeters));
      const s1 = Math.max(s0 + 0.05, Math.min(wallLen, s0 + op.widthMeters));
      const x0 = toX(seg.p1[0] + (dx / wallLen) * s0);
      const y0 = toY(seg.p1[1] + (dz / wallLen) * s0);
      const x1 = toX(seg.p1[0] + (dx / wallLen) * s1);
      const y1 = toY(seg.p1[1] + (dz / wallLen) * s1);

      ctx.save();
      ctx.strokeStyle = op.type === 'door' ? '#f59e0b' : '#38bdf8';
      ctx.lineWidth = this.isExpanded ? 4.5 : 3;
      if (op.type === 'door') {
        ctx.setLineDash([4, 2]);
      }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
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
    isSnapped: boolean = false,
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): void {
    this.lastFloorPoints = floorPoints;
    this.lastFurniture = furniture;
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

    // 3. Floor Polygon Fill & Furniture Silhouettes
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

    this.drawFurnitureBoxes2D(furniture, toCanvasX, toCanvasY, scale, this.isExpanded);

    // 4. Solid Wall Lines, Positioned Openings & Expanded Labels
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

      if (isClosed && floorPoints.length >= 3 && openings.length > 0) {
        this.drawWallOpenings2D(
          openings,
          (wi) => {
            const p1 = floorPoints[wi];
            const p2 = floorPoints[(wi + 1) % floorPoints.length];
            return p1 && p2 ? { p1: [p1.x, p1.z], p2: [p2.x, p2.z] } : null;
          },
          toCanvasX,
          toCanvasY
        );
      }

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

  /**
   * Render live Auto Scan 2D radar: walked camera trail, confidence-colored walls, furniture, openings, and camera cone.
   */
  public renderAutoScan(
    shell: ShellEstimate | null,
    cameraPathXZ: Float32Array,
    camera: THREE.Camera,
    unitSystem: UnitSystem = 'metric',
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): void {
    this.lastFloorPoints = [];
    this.lastFurniture = [];
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    let minX = camPos.x;
    let maxX = camPos.x;
    let minZ = camPos.z;
    let maxZ = camPos.z;

    if (shell && shell.valid) {
      for (const [x, z] of shell.cornersXZ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    for (let i = 0; i + 1 < cameraPathXZ.length; i += 2) {
      const x = cameraPathXZ[i];
      const z = cameraPathXZ[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const span = Math.max(maxX - minX, maxZ - minZ, 3.0) * 1.3;
    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const scale = Math.min(w, h) / span;
    const toX = (wx: number) => w * 0.5 + (wx - centerX) * scale;
    const toY = (wz: number) => h * 0.5 + (wz - centerZ) * scale;

    // Subtle 1m radar grid
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.lineWidth = 1;
    const g = scale;
    if (g > 10) {
      for (let x = (w * 0.5) % g; x < w; x += g) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = (h * 0.5) % g; y < h; y += g) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // Walked camera path
    if (cameraPathXZ.length >= 4) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(toX(cameraPathXZ[0]), toY(cameraPathXZ[1]));
      for (let i = 2; i + 1 < cameraPathXZ.length; i += 2) {
        ctx.lineTo(toX(cameraPathXZ[i]), toY(cameraPathXZ[i + 1]));
      }
      ctx.stroke();
    }

    // Detected shell fill + furniture + confidence-colored walls + openings
    if (shell && shell.valid && shell.cornersXZ.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(toX(shell.cornersXZ[0][0]), toY(shell.cornersXZ[0][1]));
      for (let i = 1; i < shell.cornersXZ.length; i++) {
        ctx.lineTo(toX(shell.cornersXZ[i][0]), toY(shell.cornersXZ[i][1]));
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 242, 254, 0.12)';
      ctx.fill();

      this.drawFurnitureBoxes2D(furniture, toX, toY, scale, this.isExpanded);

      const wallColorMap = {
        low: '#ef4444',
        medium: '#f59e0b',
        good: '#10b981'
      };
      ctx.lineWidth = this.isExpanded ? 3 : 2.5;
      for (const wall of shell.walls) {
        ctx.strokeStyle = wallColorMap[wall.confidence];
        ctx.beginPath();
        ctx.moveTo(toX(wall.p1[0]), toY(wall.p1[1]));
        ctx.lineTo(toX(wall.p2[0]), toY(wall.p2[1]));
        ctx.stroke();
      }

      if (openings.length > 0) {
        this.drawWallOpenings2D(
          openings,
          (wi) => {
            const wSeg = shell.walls[wi];
            return wSeg ? { p1: wSeg.p1, p2: wSeg.p2 } : null;
          },
          toX,
          toY
        );
      }
    }

    // Camera cone
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const yaw = Math.atan2(camDir.z, camDir.x);
    ctx.save();
    ctx.translate(toX(camPos.x), toY(camPos.z));
    ctx.rotate(yaw);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, this.isExpanded ? 28 : 16, -Math.PI / 4, Math.PI / 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(0, 0, this.isExpanded ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (shell && shell.valid) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(formatArea(shell.floorAreaSqM, unitSystem, false), 6, h - 8);
    }
  }
}
