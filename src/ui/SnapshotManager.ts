import * as THREE from 'three';
import { RoomManager } from '../measurement/RoomManager';
import { XRManager } from '../xr/XRManager';
import { formatArea, formatDistance, formatVolume } from '../measurement/math';

export class SnapshotManager {
  private roomManager: RoomManager;
  private xrManager: XRManager;

  constructor(roomManager: RoomManager, xrManager: XRManager) {
    this.roomManager = roomManager;
    this.xrManager = xrManager;
  }

  /**
   * Generates a composite architectural snapshot image containing:
   * 1. 3D WebGL measurements & camera perspective (captured inside active render frame)
   * 2. 2D Architectural Floor Plan Radar
   * 3. Measurement HUD data cards (Area, Height, Volume, Perimeter)
   * 4. Date & app branding
   */
  public async generateCompositeSnapshot(): Promise<Blob> {
    const renderer = this.xrManager.getRenderer();
    const width = renderer.domElement.width || window.innerWidth;
    const height = renderer.domElement.height || window.innerHeight;

    // Create 2D destination canvas for final composite
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');

    // 1. Draw stylish dark blueprint background
    const bgGrad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      50,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.75
    );
    bgGrad.addColorStop(0, '#0f172a');
    bgGrad.addColorStop(1, '#050811');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Capture WebGL 3D scene pixels inside active render loop
    try {
      const frameData = await this.xrManager.requestFramePixels();
      if (frameData && frameData.pixels.length > 0) {
        const fw = frameData.width;
        const fh = frameData.height;
        const imgData = ctx.createImageData(fw, fh);
        const rowSize = fw * 4;

        // WebGL reads pixels with Y inverted (bottom-to-top)
        for (let y = 0; y < fh; y++) {
          const srcOffset = (fh - 1 - y) * rowSize;
          const dstOffset = y * rowSize;
          imgData.data.set(frameData.pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = fw;
        tempCanvas.height = fh;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          tempCtx.putImageData(imgData, 0, 0);
          ctx.drawImage(tempCanvas, 0, 0, width, height);
        }
      } else {
        ctx.drawImage(renderer.domElement, 0, 0, width, height);
      }
    } catch (err) {
      console.warn('[Snapshot] WebGL frame buffer read fallback:', err);
      try {
        ctx.drawImage(renderer.domElement, 0, 0, width, height);
      } catch {
        // ignore
      }
    }

    // 3. Draw Architectural Top Banner & App Branding
    const topBarHeight = Math.max(70, height * 0.08);
    ctx.fillStyle = 'rgba(9, 13, 22, 0.85)';
    ctx.fillRect(0, 0, width, topBarHeight);
    ctx.fillStyle = '#00f2fe';
    ctx.fillRect(0, topBarHeight - 3, width, 3);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(topBarHeight * 0.32)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('SPATIALMEASURE AR', 24, topBarHeight * 0.4);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `${Math.round(topBarHeight * 0.22)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(
      `Room Measurement Report • ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      24,
      topBarHeight * 0.72
    );

    // 4. Draw 2D Floor Plan Blueprint (Picture-in-Picture in top-right)
    const floorPts = this.roomManager.getFloorPoints();
    const isClosed = this.roomManager.isClosed();

    if (floorPts.length >= 2) {
      const planSize = Math.min(width * 0.38, height * 0.25, 240);
      const planX = width - planSize - 20;
      const planY = topBarHeight + 20;

      ctx.save();
      ctx.fillStyle = 'rgba(9, 13, 22, 0.9)';
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = 2;
      this.drawRoundedRect(ctx, planX, planY, planSize, planSize, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#00f2fe';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText('2D FLOOR PLAN', planX + 12, planY + 20);

      this.drawTopDownPolygon(
        ctx,
        floorPts,
        isClosed,
        planX + 12,
        planY + 30,
        planSize - 24,
        planSize - 42
      );
      ctx.restore();
    }

    // 5. Draw Bottom Metrics HUD Card
    const metrics = this.roomManager.getMetrics();
    const unitSystem = this.roomManager.getUnitSystem();
    const bottomCardHeight = Math.max(120, height * 0.16);
    const bottomY = height - bottomCardHeight - 24;
    const cardMargin = 20;
    const cardWidth = width - cardMargin * 2;

    ctx.save();
    ctx.fillStyle = 'rgba(9, 13, 22, 0.92)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
    ctx.lineWidth = 1.5;
    this.drawRoundedRect(ctx, cardMargin, bottomY, cardWidth, bottomCardHeight, 18);
    ctx.fill();
    ctx.stroke();

    const cols = [
      {
        label: 'FLOOR AREA',
        val: metrics.floorArea > 0 ? formatArea(metrics.floorArea, unitSystem, false) : '--',
        highlight: true
      },
      {
        label: 'ROOM VOLUME',
        val: metrics.volume > 0 ? formatVolume(metrics.volume, unitSystem, false) : '--',
        highlight: true
      },
      {
        label: 'CEILING HEIGHT',
        val: metrics.ceilingHeight > 0 ? formatDistance(metrics.ceilingHeight, unitSystem) : '--',
        highlight: false
      },
      {
        label: 'PERIMETER',
        val: metrics.perimeter > 0 ? formatDistance(metrics.perimeter, unitSystem) : '--',
        highlight: false
      }
    ];

    const colWidth = cardWidth / 4;
    cols.forEach((col, idx) => {
      const cx = cardMargin + idx * colWidth + 14;
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(col.label, cx, bottomY + bottomCardHeight * 0.32);

      ctx.fillStyle = col.highlight ? '#00f2fe' : '#ffffff';
      ctx.font = `bold ${Math.round(Math.min(colWidth * 0.16, 20))}px system-ui`;
      ctx.fillText(col.val || '--', cx, bottomY + bottomCardHeight * 0.68);
    });
    ctx.restore();

    return new Promise((resolve, reject) => {
      outCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob conversion failed'));
      }, 'image/png');
    });
  }

  private drawTopDownPolygon(
    ctx: CanvasRenderingContext2D,
    points: THREE.Vector3[],
    isClosed: boolean,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    if (points.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    points.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    });

    const span = Math.max(maxX - minX, maxZ - minZ, 1.5) * 1.3;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const scale = Math.min(w, h) / span;

    const toX = (wx: number) => x + w / 2 + (wx - centerX) * scale;
    const toY = (wz: number) => y + h / 2 + (wz - centerZ) * scale;

    if (points.length >= 3) {
      ctx.fillStyle = 'rgba(0, 242, 254, 0.2)';
      ctx.beginPath();
      ctx.moveTo(toX(points[0].x), toY(points[0].z));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(toX(points[i].x), toY(points[i].z));
      }
      if (isClosed) ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(toX(points[0].x), toY(points[0].z));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(toX(points[i].x), toY(points[i].z));
    }
    if (isClosed && points.length >= 3) {
      ctx.lineTo(toX(points[0].x), toY(points[0].z));
    }
    ctx.stroke();

    points.forEach((p, idx) => {
      ctx.fillStyle = idx === 0 ? '#10b981' : '#00f2fe';
      ctx.beginPath();
      ctx.arc(toX(p.x), toY(p.z), 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
