import * as THREE from 'three';
import type { FurnitureBox, SurfaceTextureEntry, WallOpening } from '../scan/ScanTypes';
import {
  UnitSystem,
  calculateHorizontalDistance,
  calculateAverageFloorHeight,
  calculateInteriorAngleDeg,
  formatDistance
} from './math';

export interface VisualOpeningMarkState {
  active: boolean;
  type: 'door' | 'window';
  firstHit: { wallIndex: number; alongM: number; heightM: number; worldPos: THREE.Vector3 } | null;
  liveHit: { wallIndex: number; alongM: number; heightM: number; worldPos: THREE.Vector3 } | null;
}

export class MeasurementVisuals extends THREE.Group {
  private markersGroup: THREE.Group;
  private linesGroup: THREE.Group;
  private labelsGroup: THREE.Group;
  private furnitureGroup: THREE.Group;
  private openingsGroup: THREE.Group;
  private markPreviewGroup: THREE.Group;
  private texturePreviewGroup: THREE.Group;
  private textureCache = new Map<string, THREE.Texture>();
  private polygonMesh: THREE.Mesh | null = null;
  private volumeMesh: THREE.Mesh | null = null;
  private liveLine: THREE.Line | null = null;
  private liveLineGeometry: THREE.BufferGeometry | null = null;
  private ceilingDropLine: THREE.Line | null = null;

  // Reusable live angle sprite (zero per-frame allocations)
  private liveAngleSprite: THREE.Sprite | null = null;
  private liveAngleCanvas: HTMLCanvasElement | null = null;
  private liveAngleTexture: THREE.CanvasTexture | null = null;
  private lastLiveAngleKey: string = '';

  // Shared Geometries (reused across updates to prevent WebGL leaks)
  private sphereGeo = new THREE.SphereGeometry(0.025, 24, 24);
  private pillarGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 12);

  // Materials
  private sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00f2fe });
  private firstPointMaterial = new THREE.MeshBasicMaterial({ color: 0x10b981 });
  private ceilingSphereMaterial = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  private furnitureFillMat = new THREE.MeshBasicMaterial({
    color: 0x10b981,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  private furnitureLineMat = new THREE.LineBasicMaterial({
    color: 0x34d399,
    depthTest: false
  });
  private doorLineMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false });
  private windowLineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false });
  private openingFillMat = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  private markDashedMat = new THREE.LineDashedMaterial({
    color: 0xfbbf24,
    dashSize: 0.06,
    gapSize: 0.04,
    depthTest: false
  });
  private pillarMaterial = new THREE.MeshBasicMaterial({
    color: 0x00f2fe,
    transparent: true,
    opacity: 0.35,
    depthTest: false
  });
  private firstPillarMaterial = new THREE.MeshBasicMaterial({
    color: 0x10b981,
    transparent: true,
    opacity: 0.45,
    depthTest: false
  });
  private solidLineMaterial = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    linewidth: 3,
    depthTest: false
  });
  private liveLineMaterial = new THREE.LineDashedMaterial({
    color: 0x00f2fe,
    dashSize: 0.05,
    gapSize: 0.03,
    depthTest: false
  });
  private verticalLineMaterial = new THREE.LineDashedMaterial({
    color: 0xffaa00,
    dashSize: 0.05,
    gapSize: 0.03,
    depthTest: false
  });
  private polygonMaterial = new THREE.MeshBasicMaterial({
    color: 0x00f2fe,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  private volumeMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
    wireframe: true
  });

  constructor() {
    super();
    this.name = 'MeasurementVisuals';

    this.markersGroup = new THREE.Group();
    this.linesGroup = new THREE.Group();
    this.labelsGroup = new THREE.Group();
    this.furnitureGroup = new THREE.Group();
    this.openingsGroup = new THREE.Group();
    this.markPreviewGroup = new THREE.Group();
    this.texturePreviewGroup = new THREE.Group();

    this.add(this.markersGroup);
    this.add(this.linesGroup);
    this.add(this.labelsGroup);
    this.add(this.furnitureGroup);
    this.add(this.openingsGroup);
    this.add(this.markPreviewGroup);
    this.add(this.texturePreviewGroup);

    this.initLiveLine();
    this.initLiveAngleSprite();
  }

  private initLiveLine(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.liveLineGeometry = geo;
    this.liveLine = new THREE.Line(geo, this.liveLineMaterial);
    this.liveLine.visible = false;
    this.liveLine.renderOrder = 998;
    this.add(this.liveLine);
  }

  private initLiveAngleSprite(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 56;
    this.liveAngleCanvas = canvas;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    this.liveAngleTexture = texture;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.14, 0.06, 1);
    sprite.visible = false;
    sprite.renderOrder = 1001;
    this.liveAngleSprite = sprite;
    this.add(sprite);
  }

  private signedAreaXZ(points: THREE.Vector3[]): number {
    let sum = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      sum += a.x * b.z - b.x * a.z;
    }
    return sum * 0.5;
  }

  private getOrCreatePreviewTexture(entry: SurfaceTextureEntry): THREE.Texture {
    const cacheKey = `${entry.mode}|${entry.dataUrl}`;
    const existing = this.textureCache.get(cacheKey);
    if (existing) return existing;

    const img = new Image();
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    if (entry.mode === 'tile') {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
    } else {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
    }
    img.onload = () => {
      tex.needsUpdate = true;
    };
    img.src = entry.dataUrl;
    this.textureCache.set(cacheKey, tex);
    return tex;
  }

  /**
   * Updates placed points, connecting lines, floor mesh, and volume visualization.
   */
  public updatePoints(
    floorPoints: THREE.Vector3[],
    ceilingPoint: THREE.Vector3 | null,
    isFloorClosed: boolean,
    unitSystem: UnitSystem = 'metric',
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = [],
    surfaceTextures: SurfaceTextureEntry[] = []
  ): void {
    this.clearDynamicObjects();

    const floorY = floorPoints.length > 0 ? calculateAverageFloorHeight(floorPoints) : 0;
    const pillarH = ceilingPoint ? Math.max(0.5, Math.abs(ceilingPoint.y - floorY)) : 2.4;
    const windingSign = floorPoints.length >= 3 && this.signedAreaXZ(floorPoints) < 0 ? -1 : 1;

    // 1. Draw corner anchor markers + vertical holographic beacons
    floorPoints.forEach((point, index) => {
      const isFirst = index === 0;
      const mesh = new THREE.Mesh(
        this.sphereGeo,
        isFirst ? this.firstPointMaterial : this.sphereMaterial
      );
      mesh.position.copy(point);
      mesh.renderOrder = 999;
      this.markersGroup.add(mesh);

      // Vertical holographic light pillar scaled to ceiling height
      const pillar = new THREE.Mesh(
        this.pillarGeo,
        isFirst ? this.firstPillarMaterial : this.pillarMaterial
      );
      pillar.scale.set(1, pillarH, 1);
      pillar.position.set(point.x, point.y + pillarH * 0.5, point.z);
      pillar.renderOrder = 997;
      this.markersGroup.add(pillar);

      // Floor level corner number badge
      const sprite = this.createNumberSprite(index + 1);
      sprite.position.copy(point).add(new THREE.Vector3(0, 0.08, 0));
      this.labelsGroup.add(sprite);

      // Eye-level corner number badge (1.4m high, visible when standing)
      const highSprite = this.createNumberSprite(index + 1);
      highSprite.position.copy(point).add(new THREE.Vector3(0, 1.4, 0));
      this.labelsGroup.add(highSprite);
    });

    // 2. Draw lines between floor points
    if (floorPoints.length >= 2) {
      const ptsToConnect = [...floorPoints];
      if (isFloorClosed && floorPoints.length >= 3) {
        ptsToConnect.push(floorPoints[0]);
      }

      const lineGeo = new THREE.BufferGeometry().setFromPoints(ptsToConnect);
      const lineMesh = new THREE.Line(lineGeo, this.solidLineMaterial);
      lineMesh.renderOrder = 998;
      this.linesGroup.add(lineMesh);

      // Create distance label sprites along each segment
      for (let i = 0; i < floorPoints.length - 1; i++) {
        this.addSegmentDistanceSprite(floorPoints[i], floorPoints[i + 1], unitSystem);
      }
      if (isFloorClosed && floorPoints.length >= 3) {
        this.addSegmentDistanceSprite(
          floorPoints[floorPoints.length - 1],
          floorPoints[0],
          unitSystem
        );
      }
    }

    // 2b. Interior corner angle badges when >= 3 points
    if (floorPoints.length >= 3) {
      const count = floorPoints.length;
      const startIdx = isFloorClosed ? 0 : 1;
      const endIdx = isFloorClosed ? count : count - 1;
      for (let i = startIdx; i < endIdx; i++) {
        const pPrev = floorPoints[(i - 1 + count) % count];
        const pCurr = floorPoints[i];
        const pNext = floorPoints[(i + 1) % count];
        const angle = calculateInteriorAngleDeg(pPrev, pCurr, pNext);
        if (angle > 0) {
          const isRightAngle = Math.abs(angle - 90) <= 1.5;
          const angleSprite = this.createAngleSprite(
            `${Math.round(angle)}°`,
            isRightAngle
          );
          angleSprite.position.copy(pCurr).add(new THREE.Vector3(0, 0.22, 0));
          this.labelsGroup.add(angleSprite);
        }
      }
    }

    // 3. Draw Floor Polygon Mesh
    if (floorPoints.length >= 3) {
      this.buildFloorPolygon(floorPoints);
    }

    // 4. Draw Ceiling point & height drop line
    if (ceilingPoint && floorPoints.length >= 1) {
      const ceilingMesh = new THREE.Mesh(this.sphereGeo, this.ceilingSphereMaterial);
      ceilingMesh.position.copy(ceilingPoint);
      ceilingMesh.renderOrder = 999;
      this.markersGroup.add(ceilingMesh);

      const basePoint = new THREE.Vector3(ceilingPoint.x, floorY, ceilingPoint.z);

      const dropGeo = new THREE.BufferGeometry().setFromPoints([basePoint, ceilingPoint]);
      this.ceilingDropLine = new THREE.Line(dropGeo, this.verticalLineMaterial);
      this.ceilingDropLine.computeLineDistances();
      this.ceilingDropLine.renderOrder = 998;
      this.linesGroup.add(this.ceilingDropLine);

      // Height text sprite
      const height = Math.abs(ceilingPoint.y - floorY);
      const heightSprite = this.createTextSprite(`H: ${formatDistance(height, unitSystem)}`);
      heightSprite.position.copy(basePoint).lerp(ceilingPoint, 0.5).add(new THREE.Vector3(0.08, 0, 0));
      this.labelsGroup.add(heightSprite);

      // 5. Build Extruded Room Volume (extending upward from floorY to floorY + height)
      if (isFloorClosed && floorPoints.length >= 3) {
        this.buildExtrudedVolume(floorPoints, height);
      }
    }

    // 6. Layer 2: Furniture Wireframe Silhouettes (rotation.y = -yawRad)
    for (const box of furniture) {
      const baseFloorY = floorPoints.length > 0 ? floorY : box.floorY;
      const boxGeo = new THREE.BoxGeometry(box.widthMeters, box.heightMeters, box.depthMeters);
      const mesh = new THREE.Mesh(boxGeo, this.furnitureFillMat);
      mesh.position.set(box.centerXZ[0], baseFloorY + box.heightMeters * 0.5, box.centerXZ[1]);
      mesh.rotation.y = -box.yawRad;
      mesh.renderOrder = 995;
      this.furnitureGroup.add(mesh);

      const wireGeo = new THREE.EdgesGeometry(boxGeo);
      const wire = new THREE.LineSegments(wireGeo, this.furnitureLineMat);
      wire.position.copy(mesh.position);
      wire.rotation.y = -box.yawRad;
      wire.renderOrder = 996;
      this.furnitureGroup.add(wire);

      const dims = `${formatDistance(box.widthMeters, unitSystem)}×${formatDistance(box.depthMeters, unitSystem)}×${formatDistance(box.heightMeters, unitSystem)}`;
      const fSprite = this.createTextSprite(`${box.label} ${dims}`, '#34d399');
      fSprite.scale.set(0.32, 0.08, 1);
      fSprite.position.set(box.centerXZ[0], baseFloorY + box.heightMeters + 0.12, box.centerXZ[1]);
      this.furnitureGroup.add(fSprite);
    }

    // 7. Layer 3: Positioned Doors & Windows anchored to wall segments
    if (isFloorClosed && floorPoints.length >= 3) {
      const n = floorPoints.length;
      for (const op of openings) {
        if (op.wallIndex === undefined || op.offsetAlongWallMeters === undefined) continue;
        const p1 = floorPoints[op.wallIndex];
        const p2 = floorPoints[(op.wallIndex + 1) % n];
        if (!p1 || !p2) continue;

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const wallLen = Math.hypot(dx, dz);
        if (wallLen < 0.05) continue;
        const tx = dx / wallLen;
        const tz = dz / wallLen;
        const nx = -tz * windingSign;
        const nz = tx * windingSign;

        const s0 = Math.max(0, Math.min(wallLen, op.offsetAlongWallMeters));
        const s1 = Math.max(s0 + 0.05, Math.min(wallLen, s0 + op.widthMeters));
        const sill = op.sillHeightMeters ?? 0;
        const y0 = floorY + sill;
        const y1 = y0 + op.heightMeters;
        const offX = nx * 0.025;
        const offZ = nz * 0.025;

        const ax = p1.x + tx * s0 + offX;
        const az = p1.z + tz * s0 + offZ;
        const bx = p1.x + tx * s1 + offX;
        const bz = p1.z + tz * s1 + offZ;

        const quadGeo = new THREE.BufferGeometry();
        quadGeo.setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az]),
            3
          )
        );
        const quadMesh = new THREE.Mesh(quadGeo, this.openingFillMat);
        quadMesh.renderOrder = 995;
        this.openingsGroup.add(quadMesh);

        const segPts: THREE.Vector3[] = [
          new THREE.Vector3(ax, y0, az),
          new THREE.Vector3(bx, y0, bz),
          new THREE.Vector3(bx, y0, bz),
          new THREE.Vector3(bx, y1, bz),
          new THREE.Vector3(bx, y1, bz),
          new THREE.Vector3(ax, y1, az),
          new THREE.Vector3(ax, y1, az),
          new THREE.Vector3(ax, y0, az)
        ];
        if (op.type === 'window') {
          const yMid = (y0 + y1) * 0.5;
          segPts.push(new THREE.Vector3(ax, yMid, az), new THREE.Vector3(bx, yMid, bz));
        }
        const frameGeo = new THREE.BufferGeometry().setFromPoints(segPts);
        const frameLine = new THREE.LineSegments(
          frameGeo,
          op.type === 'door' ? this.doorLineMat : this.windowLineMat
        );
        frameLine.renderOrder = 997;
        this.openingsGroup.add(frameLine);

        const badge = this.createTextSprite(
          `${op.type === 'door' ? '🚪' : '🪟'} ${formatDistance(op.widthMeters, unitSystem)}×${formatDistance(op.heightMeters, unitSystem)}`,
          '#fbbf24'
        );
        badge.scale.set(0.28, 0.075, 1);
        badge.position.set((ax + bx) * 0.5 + nx * 0.08, (y0 + y1) * 0.5, (az + bz) * 0.5 + nz * 0.08);
        this.openingsGroup.add(badge);
      }
    }

    // 8. Live Textured Surface Previews (when photos are attached to surfaces)
    if (surfaceTextures.length > 0) {
      this.buildTexturePreviews(
        floorPoints,
        ceilingPoint,
        isFloorClosed,
        floorY,
        pillarH,
        windingSign,
        furniture,
        surfaceTextures
      );
    }
  }

  private buildTexturePreviews(
    floorPoints: THREE.Vector3[],
    ceilingPoint: THREE.Vector3 | null,
    isFloorClosed: boolean,
    floorY: number,
    wallH: number,
    windingSign: number,
    furniture: FurnitureBox[],
    surfaceTextures: SurfaceTextureEntry[]
  ): void {
    const texMap = new Map<string, SurfaceTextureEntry>();
    for (const st of surfaceTextures) {
      texMap.set(st.surfaceKey, st);
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of floorPoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = Math.max(0.1, maxX - minX);
    const spanZ = Math.max(0.1, maxZ - minZ);

    const floorTex = texMap.get('floor');
    if (floorTex && floorPoints.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(floorPoints[0].x, -floorPoints[0].z);
      for (let i = 1; i < floorPoints.length; i++) {
        shape.lineTo(floorPoints[i].x, -floorPoints[i].z);
      }
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, floorY + 0.004, 0);
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      const tile = Math.max(0.1, floorTex.tileSizeMeters || 1);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (floorTex.mode === 'stretch') {
          uv.setXY(i, (x - minX) / spanX, (z - minZ) / spanZ);
        } else {
          uv.setXY(i, (x - minX) / tile, (z - minZ) / tile);
        }
      }
      uv.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({
        map: this.getOrCreatePreviewTexture(floorTex),
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 994;
      this.texturePreviewGroup.add(mesh);
    }

    const ceilTex = texMap.get('ceiling');
    if (ceilTex && floorPoints.length >= 3 && ceilingPoint) {
      const ceilH = Math.abs(ceilingPoint.y - floorY);
      const shape = new THREE.Shape();
      shape.moveTo(floorPoints[0].x, floorPoints[0].z);
      for (let i = 1; i < floorPoints.length; i++) {
        shape.lineTo(floorPoints[i].x, floorPoints[i].z);
      }
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, floorY + ceilH - 0.004, 0);
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      const tile = Math.max(0.1, ceilTex.tileSizeMeters || 1);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (ceilTex.mode === 'stretch') {
          uv.setXY(i, (x - minX) / spanX, (z - minZ) / spanZ);
        } else {
          uv.setXY(i, (x - minX) / tile, (z - minZ) / tile);
        }
      }
      uv.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({
        map: this.getOrCreatePreviewTexture(ceilTex),
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 994;
      this.texturePreviewGroup.add(mesh);
    }

    if (isFloorClosed && floorPoints.length >= 3) {
      const n = floorPoints.length;
      const h = ceilingPoint ? wallH : 2.5;
      for (let i = 0; i < n; i++) {
        const wallTex = texMap.get(`wall:${i}`);
        if (!wallTex) continue;
        const p1 = floorPoints[i];
        const p2 = floorPoints[(i + 1) % n];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const nx = (-dz / len) * windingSign;
        const nz = (dx / len) * windingSign;
        const offX = nx * 0.008;
        const offZ = nz * 0.008;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([
              p1.x + offX, floorY, p1.z + offZ,
              p2.x + offX, floorY, p2.z + offZ,
              p2.x + offX, floorY + h, p2.z + offZ,
              p1.x + offX, floorY, p1.z + offZ,
              p2.x + offX, floorY + h, p2.z + offZ,
              p1.x + offX, floorY + h, p1.z + offZ
            ]),
            3
          )
        );
        const tile = Math.max(0.1, wallTex.tileSizeMeters || 1);
        const uMax = wallTex.mode === 'stretch' ? 1 : len / tile;
        const vMax = wallTex.mode === 'stretch' ? 1 : h / tile;
        geo.setAttribute(
          'uv',
          new THREE.BufferAttribute(
            new Float32Array([0, 0, uMax, 0, uMax, vMax, 0, 0, uMax, vMax, 0, vMax]),
            2
          )
        );
        const mat = new THREE.MeshBasicMaterial({
          map: this.getOrCreatePreviewTexture(wallTex),
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 994;
        this.texturePreviewGroup.add(mesh);
      }
    }

    for (const f of furniture) {
      const furnTex = texMap.get(`furniture:${f.id}`);
      if (!furnTex) continue;
      const baseFloorY = floorPoints.length > 0 ? floorY : f.floorY;
      const geo = new THREE.BoxGeometry(f.widthMeters, f.heightMeters, f.depthMeters);
      if (furnTex.mode === 'tile') {
        const pos = geo.getAttribute('position');
        const norm = geo.getAttribute('normal');
        const uv = geo.getAttribute('uv');
        const tile = Math.max(0.1, furnTex.tileSizeMeters || 1);
        for (let i = 0; i < pos.count; i++) {
          const anx = Math.abs(norm.getX(i));
          const any = Math.abs(norm.getY(i));
          const u = uv.getX(i);
          const v = uv.getY(i);
          if (anx > 0.5) {
            uv.setXY(i, (u * f.depthMeters) / tile, (v * f.heightMeters) / tile);
          } else if (any > 0.5) {
            uv.setXY(i, (u * f.widthMeters) / tile, (v * f.depthMeters) / tile);
          } else {
            uv.setXY(i, (u * f.widthMeters) / tile, (v * f.heightMeters) / tile);
          }
        }
        uv.needsUpdate = true;
      }
      const mat = new THREE.MeshBasicMaterial({
        map: this.getOrCreatePreviewTexture(furnTex),
        transparent: true,
        opacity: 0.85,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(f.centerXZ[0], baseFloorY + f.heightMeters * 0.5, f.centerXZ[1]);
      mesh.rotation.y = -f.yawRad;
      mesh.renderOrder = 994;
      this.texturePreviewGroup.add(mesh);
    }
  }

  public updateOpeningMarkPreview(
    floorPoints: THREE.Vector3[],
    markState: VisualOpeningMarkState,
    unitSystem: UnitSystem
  ): void {
    this.disposeGroupObjects(this.markPreviewGroup);
    if (!markState.active || floorPoints.length < 3 || !markState.firstHit || !markState.liveHit) {
      return;
    }

    const first = markState.firstHit;
    const live = markState.liveHit;
    if (live.wallIndex !== first.wallIndex) return;

    const p1 = floorPoints[first.wallIndex];
    const p2 = floorPoints[(first.wallIndex + 1) % floorPoints.length];
    if (!p1 || !p2) return;

    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const wallLen = Math.hypot(dx, dz);
    if (wallLen < 0.05) return;
    const tx = dx / wallLen;
    const tz = dz / wallLen;
    const windingSign = this.signedAreaXZ(floorPoints) < 0 ? -1 : 1;
    const nx = -tz * windingSign;
    const nz = tx * windingSign;
    const floorY = calculateAverageFloorHeight(floorPoints);

    const s0 = Math.min(first.alongM, live.alongM);
    const s1 = Math.max(first.alongM, live.alongM);
    const h0 = markState.type === 'door' && Math.min(first.heightM, live.heightM) <= 0.30
      ? 0
      : Math.min(first.heightM, live.heightM);
    const h1 = Math.max(first.heightM, live.heightM);

    const y0 = floorY + h0;
    const y1 = floorY + h1;
    const offX = nx * 0.035;
    const offZ = nz * 0.035;
    const ax = p1.x + tx * s0 + offX;
    const az = p1.z + tz * s0 + offZ;
    const bx = p1.x + tx * s1 + offX;
    const bz = p1.z + tz * s1 + offZ;

    const loopGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(ax, y0, az),
      new THREE.Vector3(bx, y0, bz),
      new THREE.Vector3(bx, y1, bz),
      new THREE.Vector3(ax, y1, az),
      new THREE.Vector3(ax, y0, az)
    ]);
    const loopLine = new THREE.Line(loopGeo, this.markDashedMat);
    loopLine.computeLineDistances();
    loopLine.renderOrder = 1002;
    this.markPreviewGroup.add(loopLine);

    const wM = Math.max(0, s1 - s0);
    const hM = Math.max(0, h1 - h0);
    const label = this.createTextSprite(
      `${formatDistance(wM, unitSystem)} × ${formatDistance(hM, unitSystem)}`,
      '#fbbf24'
    );
    label.scale.set(0.28, 0.075, 1);
    label.position.set((ax + bx) * 0.5 + nx * 0.08, (y0 + y1) * 0.5, (az + bz) * 0.5 + nz * 0.08);
    this.markPreviewGroup.add(label);
  }

  /**
   * Updates real-time preview line connecting the last pinned point to current reticle position
   */
  public updateLiveLine(
    lastPoint: THREE.Vector3 | null,
    reticlePoint: THREE.Vector3 | null,
    isSnapped: boolean = false,
    liveAngleDeg: number | null = null
  ): void {
    if (!lastPoint || !reticlePoint || !this.liveLine || !this.liveLineGeometry) {
      if (this.liveLine) this.liveLine.visible = false;
      if (this.liveAngleSprite) this.liveAngleSprite.visible = false;
      return;
    }

    this.liveLineMaterial.color.setHex(isSnapped ? 0x10b981 : 0x00f2fe);

    const posAttr = this.liveLineGeometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, lastPoint.x, lastPoint.y, lastPoint.z);
    posAttr.setXYZ(1, reticlePoint.x, reticlePoint.y, reticlePoint.z);
    posAttr.needsUpdate = true;
    this.liveLine.computeLineDistances();
    this.liveLine.visible = true;

    if (this.liveAngleSprite && liveAngleDeg !== null && liveAngleDeg > 0) {
      const rounded = Math.round(liveAngleDeg);
      const key = `${rounded}:${isSnapped ? 1 : 0}`;
      if (key !== this.lastLiveAngleKey) {
        this.lastLiveAngleKey = key;
        this.redrawLiveAngleCanvas(`${rounded}°`, isSnapped);
      }
      this.liveAngleSprite.position.copy(lastPoint).add(new THREE.Vector3(0, 0.22, 0));
      this.liveAngleSprite.visible = true;
    } else if (this.liveAngleSprite) {
      this.liveAngleSprite.visible = false;
    }
  }

  private redrawLiveAngleCanvas(text: string, isSnapped: boolean): void {
    if (!this.liveAngleCanvas || !this.liveAngleTexture) return;
    const ctx = this.liveAngleCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 128, 56);
    ctx.fillStyle = isSnapped ? 'rgba(16, 185, 129, 0.92)' : 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = isSnapped ? '#34d399' : '#38bdf8';
    ctx.lineWidth = 3;
    this.drawRoundedRect(ctx, 4, 4, 120, 48, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSnapped ? '#04101e' : '#f8fafc';
    ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 28);
    this.liveAngleTexture.needsUpdate = true;
  }

  private addSegmentDistanceSprite(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    unitSystem: UnitSystem
  ): void {
    const dist = calculateHorizontalDistance(p1, p2);
    const midPoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    midPoint.y += 0.04;
    const sprite = this.createTextSprite(formatDistance(dist, unitSystem));
    sprite.position.copy(midPoint);
    this.labelsGroup.add(sprite);
  }

  private buildFloorPolygon(points: THREE.Vector3[]): void {
    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, points[i].z);
    }
    shape.closePath();

    const shapeGeo = new THREE.ShapeGeometry(shape);
    shapeGeo.rotateX(Math.PI / 2);
    const avgY = calculateAverageFloorHeight(points);
    shapeGeo.translate(0, avgY, 0);

    this.polygonMesh = new THREE.Mesh(shapeGeo, this.polygonMaterial);
    this.polygonMesh.renderOrder = 997;
    this.add(this.polygonMesh);
  }

  private buildExtrudedVolume(points: THREE.Vector3[], height: number): void {
    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, points[i].z);
    }
    shape.closePath();

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: height,
      bevelEnabled: false
    };

    const extrudeGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    // Extrude builds along +Z [0..height]; rotateX(+PI/2) maps Z to -Y [-height..0].
    // Translate by avgY + height along Y so the prism rises upward from floor [avgY..avgY + height].
    extrudeGeo.rotateX(Math.PI / 2);
    const avgY = calculateAverageFloorHeight(points);
    extrudeGeo.translate(0, avgY + height, 0);

    this.volumeMesh = new THREE.Mesh(extrudeGeo, this.volumeMaterial);
    this.volumeMesh.renderOrder = 996;
    this.add(this.volumeMesh);
  }

  private createTextSprite(text: string, borderColor: string = '#00f2fe'): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 72;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 4;
      this.drawRoundedRect(ctx, 4, 4, 248, 64, 16);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 36);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.24, 0.07, 1);
    sprite.renderOrder = 1000;
    return sprite;
  }

  private createAngleSprite(text: string, isRightAngle: boolean): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 56;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = isRightAngle ? 'rgba(16, 185, 129, 0.9)' : 'rgba(15, 23, 42, 0.82)';
      ctx.strokeStyle = isRightAngle ? '#34d399' : '#38bdf8';
      ctx.lineWidth = 3;
      this.drawRoundedRect(ctx, 4, 4, 120, 48, 12);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isRightAngle ? '#04101e' : '#e2e8f0';
      ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 28);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.13, 0.055, 1);
    sprite.renderOrder = 1000;
    return sprite;
  }

  private createNumberSprite(num: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#00f2fe';
      ctx.beginPath();
      ctx.arc(48, 48, 42, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#090d16';
      ctx.font = 'bold 50px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(num.toString(), 48, 48);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.08, 0.08, 1);
    sprite.renderOrder = 1000;
    return sprite;
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

  private disposeGroupObjects(group: THREE.Group, preserveMaps = false): void {
    while (group.children.length > 0) {
      const obj = group.children[0];
      group.remove(obj);
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        if (preserveMaps && obj instanceof THREE.Mesh && obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      } else if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    }
  }

  public clearDynamicObjects(): void {
    while (this.markersGroup.children.length > 0) {
      const obj = this.markersGroup.children[0];
      this.markersGroup.remove(obj);
    }
    this.disposeGroupObjects(this.linesGroup);
    this.disposeGroupObjects(this.labelsGroup);
    this.disposeGroupObjects(this.furnitureGroup);
    this.disposeGroupObjects(this.openingsGroup);
    this.disposeGroupObjects(this.markPreviewGroup);
    this.disposeGroupObjects(this.texturePreviewGroup, true);

    if (this.polygonMesh) {
      this.remove(this.polygonMesh);
      this.polygonMesh.geometry.dispose();
      this.polygonMesh = null;
    }
    if (this.volumeMesh) {
      this.remove(this.volumeMesh);
      this.volumeMesh.geometry.dispose();
      this.volumeMesh = null;
    }
    // ceilingDropLine is added to linesGroup and disposed above
    this.ceilingDropLine = null;
  }

  public reset(): void {
    this.clearDynamicObjects();
    for (const tex of this.textureCache.values()) {
      tex.dispose();
    }
    this.textureCache.clear();
    if (this.liveLine) {
      this.liveLine.visible = false;
    }
    if (this.liveAngleSprite) {
      this.liveAngleSprite.visible = false;
    }
    this.lastLiveAngleKey = '';
  }
}
