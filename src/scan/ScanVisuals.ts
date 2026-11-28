import * as THREE from 'three';
import { UnitSystem, formatDistance } from '../measurement/math';
import { FurnitureBox, ShellEstimate, WallConfidenceLevel, WallOpening } from './ScanTypes';

const MAX_PREVIEW_POINTS = 1800;

const CONFIDENCE_COLORS: Record<WallConfidenceLevel, number> = {
  low: 0xef4444,
  medium: 0xf59e0b,
  good: 0x10b981
};

const CONFIDENCE_CSS: Record<WallConfidenceLevel, string> = {
  low: '#fca5a5',
  medium: '#fbbf24',
  good: '#34d399'
};

export class ScanVisuals extends THREE.Group {
  private pointsMesh: THREE.Points;
  private pointsGeo: THREE.BufferGeometry;
  private positionAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private wallsGroup: THREE.Group;

  private showPoints = true;
  private floorOutlineMat = new THREE.LineBasicMaterial({ color: 0x00f2fe, depthTest: false });
  private ceilingLockedMat = new THREE.LineBasicMaterial({ color: 0x00f2fe, depthTest: false });
  private furnitureFillMat = new THREE.MeshBasicMaterial({
    color: 0x10b981,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  private furnitureLineMat = new THREE.LineBasicMaterial({
    color: 0x34d399,
    depthTest: false
  });
  private doorLineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false });
  private windowLineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false });
  private openingFillMat = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  private wallFillMats: Record<WallConfidenceLevel, THREE.MeshBasicMaterial>;
  private wallLineMats: Record<WallConfidenceLevel, THREE.LineBasicMaterial>;
  private wallDashedMats: Record<WallConfidenceLevel, THREE.LineDashedMaterial>;

  constructor() {
    super();
    this.name = 'ScanVisuals';
    this.visible = false;

    this.pointsGeo = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(new Float32Array(MAX_PREVIEW_POINTS * 3), 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(MAX_PREVIEW_POINTS * 3), 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.pointsGeo.setAttribute('position', this.positionAttr);
    this.pointsGeo.setAttribute('color', this.colorAttr);
    this.pointsGeo.setDrawRange(0, 0);

    const pointsMat = new THREE.PointsMaterial({
      size: 0.026,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      sizeAttenuation: true
    });
    this.pointsMesh = new THREE.Points(this.pointsGeo, pointsMat);
    this.pointsMesh.frustumCulled = false;
    this.pointsMesh.renderOrder = 930;
    this.add(this.pointsMesh);

    this.wallsGroup = new THREE.Group();
    this.wallsGroup.renderOrder = 940;
    this.add(this.wallsGroup);

    this.wallFillMats = {
      low: this.makeFillMat(CONFIDENCE_COLORS.low),
      medium: this.makeFillMat(CONFIDENCE_COLORS.medium),
      good: this.makeFillMat(CONFIDENCE_COLORS.good)
    };
    this.wallLineMats = {
      low: new THREE.LineBasicMaterial({ color: CONFIDENCE_COLORS.low, depthTest: false }),
      medium: new THREE.LineBasicMaterial({ color: CONFIDENCE_COLORS.medium, depthTest: false }),
      good: new THREE.LineBasicMaterial({ color: CONFIDENCE_COLORS.good, depthTest: false })
    };
    this.wallDashedMats = {
      low: new THREE.LineDashedMaterial({
        color: CONFIDENCE_COLORS.low,
        dashSize: 0.08,
        gapSize: 0.06,
        depthTest: false
      }),
      medium: new THREE.LineDashedMaterial({
        color: CONFIDENCE_COLORS.medium,
        dashSize: 0.08,
        gapSize: 0.06,
        depthTest: false
      }),
      good: new THREE.LineDashedMaterial({
        color: CONFIDENCE_COLORS.good,
        dashSize: 0.08,
        gapSize: 0.06,
        depthTest: false
      })
    };
  }

  private makeFillMat(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false
    });
  }

  public setActive(active: boolean): void {
    this.visible = active;
    if (!active) {
      this.reset();
    }
  }

  public setShowPoints(show: boolean): void {
    this.showPoints = show;
    this.pointsMesh.visible = show;
  }

  public isShowingPoints(): boolean {
    return this.showPoints;
  }

  public updatePointCloud(positions: Float32Array, colors: Float32Array, count: number): void {
    const safeCount = Math.min(count, MAX_PREVIEW_POINTS);
    if (safeCount > 0) {
      (this.positionAttr.array as Float32Array).set(positions.subarray(0, safeCount * 3));
      (this.colorAttr.array as Float32Array).set(colors.subarray(0, safeCount * 3));
      this.positionAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
    this.pointsGeo.setDrawRange(0, safeCount);
  }

  public updateShell(
    shell: ShellEstimate | null,
    unitSystem: UnitSystem,
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): void {
    this.clearWallsGroup();
    if (!shell || !shell.valid || shell.cornersXZ.length < 3) return;

    const floorY = shell.floorY;
    const topY = shell.ceilingY ?? shell.provisionalCeilingY;
    const wallHeight = Math.max(0.5, topY - floorY);
    const hasCeiling = shell.ceilingY !== null;

    // Floor polygon outline
    const floorVerts: THREE.Vector3[] = shell.cornersXZ.map(
      ([x, z]) => new THREE.Vector3(x, floorY + 0.005, z)
    );
    const floorLoop = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(floorVerts),
      this.floorOutlineMat
    );
    this.wallsGroup.add(floorLoop);

    for (const w of shell.walls) {
      const [x1, z1] = w.p1;
      const [x2, z2] = w.p2;

      // Translucent wall quad
      const quadGeo = new THREE.BufferGeometry();
      const quadVerts = new Float32Array([
        x1, floorY, z1,
        x2, floorY, z2,
        x2, topY, z2,
        x1, floorY, z1,
        x2, topY, z2,
        x1, topY, z1
      ]);
      quadGeo.setAttribute('position', new THREE.BufferAttribute(quadVerts, 3));
      quadGeo.computeVertexNormals();
      const quad = new THREE.Mesh(quadGeo, this.wallFillMats[w.confidence]);
      this.wallsGroup.add(quad);

      // Vertical corner edges + bottom edge
      const frameGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, floorY, z1),
        new THREE.Vector3(x2, floorY, z2),
        new THREE.Vector3(x2, floorY, z2),
        new THREE.Vector3(x2, topY, z2),
        new THREE.Vector3(x1, floorY, z1),
        new THREE.Vector3(x1, topY, z1)
      ]);
      const frameLines = new THREE.LineSegments(frameGeo, this.wallLineMats[w.confidence]);
      this.wallsGroup.add(frameLines);

      // Top edge (solid cyan if ceiling detected, dashed confidence color if provisional)
      const topGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, topY, z1),
        new THREE.Vector3(x2, topY, z2)
      ]);
      const topLine = new THREE.Line(
        topGeo,
        hasCeiling ? this.ceilingLockedMat : this.wallDashedMats[w.confidence]
      );
      if (!hasCeiling) {
        topLine.computeLineDistances();
      }
      this.wallsGroup.add(topLine);

      // Wall label sprite
      const mx = (x1 + x2) * 0.5 + w.normal[0] * 0.08;
      const mz = (z1 + z2) * 0.5 + w.normal[1] * 0.08;
      const my = floorY + Math.min(1.35, wallHeight * 0.5);
      const label = `${formatDistance(w.lengthM, unitSystem)} • ±${w.sigmaCm.toFixed(1)}cm (${w.passCount}p)`;
      const sprite = this.createLabelSprite(label, CONFIDENCE_CSS[w.confidence]);
      sprite.position.set(mx, my, mz);
      this.wallsGroup.add(sprite);
    }

    // Layer 2: Furniture silhouette boxes (rotation.y = -yawRad maps local +X/+Z to world u/v)
    for (const box of furniture) {
      const boxGeo = new THREE.BoxGeometry(box.widthMeters, box.heightMeters, box.depthMeters);
      const boxMesh = new THREE.Mesh(boxGeo, this.furnitureFillMat);
      boxMesh.position.set(box.centerXZ[0], floorY + box.heightMeters * 0.5, box.centerXZ[1]);
      boxMesh.rotation.y = -box.yawRad;
      this.wallsGroup.add(boxMesh);

      const edgesGeo = new THREE.EdgesGeometry(boxGeo);
      const wire = new THREE.LineSegments(edgesGeo, this.furnitureLineMat);
      wire.position.copy(boxMesh.position);
      wire.rotation.y = -box.yawRad;
      this.wallsGroup.add(wire);

      const dims = `${formatDistance(box.widthMeters, unitSystem)}×${formatDistance(box.depthMeters, unitSystem)}×${formatDistance(box.heightMeters, unitSystem)}`;
      const fSprite = this.createLabelSprite(`${box.label} ${dims}`, '#34d399');
      fSprite.scale.set(0.52, 0.115, 1);
      fSprite.position.set(box.centerXZ[0], floorY + box.heightMeters + 0.12, box.centerXZ[1]);
      this.wallsGroup.add(fSprite);
    }

    // Layer 3: Auto-detected doors & windows anchored onto detected walls
    for (const op of openings) {
      if (op.wallIndex === undefined || op.offsetAlongWallMeters === undefined) continue;
      const wall = shell.walls[op.wallIndex];
      if (!wall) continue;

      const dx = wall.p2[0] - wall.p1[0];
      const dz = wall.p2[1] - wall.p1[1];
      const wLen = Math.hypot(dx, dz);
      if (wLen < 0.05) continue;
      const tx = dx / wLen;
      const tz = dz / wLen;

      const s0 = Math.max(0, Math.min(wLen, op.offsetAlongWallMeters));
      const s1 = Math.max(s0 + 0.05, Math.min(wLen, s0 + op.widthMeters));
      const sill = op.sillHeightMeters ?? 0;
      const y0 = floorY + sill;
      const y1 = y0 + op.heightMeters;
      const offX = wall.normal[0] * 0.03;
      const offZ = wall.normal[1] * 0.03;

      const ax = wall.p1[0] + tx * s0 + offX;
      const az = wall.p1[1] + tz * s0 + offZ;
      const bx = wall.p1[0] + tx * s1 + offX;
      const bz = wall.p1[1] + tz * s1 + offZ;

      const quadGeo = new THREE.BufferGeometry();
      quadGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az]),
          3
        )
      );
      this.wallsGroup.add(new THREE.Mesh(quadGeo, this.openingFillMat));

      const frameGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ax, y0, az),
        new THREE.Vector3(bx, y0, bz),
        new THREE.Vector3(bx, y0, bz),
        new THREE.Vector3(bx, y1, bz),
        new THREE.Vector3(bx, y1, bz),
        new THREE.Vector3(ax, y1, az),
        new THREE.Vector3(ax, y1, az),
        new THREE.Vector3(ax, y0, az)
      ]);
      const mat = op.type === 'door' ? this.doorLineMat : this.windowLineMat;
      this.wallsGroup.add(new THREE.LineSegments(frameGeo, mat));

      const opSprite = this.createLabelSprite(
        `${op.type === 'door' ? '🚪' : '🪟'} ${formatDistance(op.widthMeters, unitSystem)}×${formatDistance(op.heightMeters, unitSystem)}`,
        op.type === 'door' ? '#fbbf24' : '#38bdf8'
      );
      opSprite.scale.set(0.46, 0.105, 1);
      opSprite.position.set((ax + bx) * 0.5 + wall.normal[0] * 0.08, (y0 + y1) * 0.5, (az + bz) * 0.5 + wall.normal[1] * 0.08);
      this.wallsGroup.add(opSprite);
    }
  }

  private createLabelSprite(text: string, borderColor: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 72;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(9, 13, 22, 0.88)';
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(4, 4, 312, 64, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 24px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 160, 36);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.58, 0.13, 1);
    sprite.renderOrder = 960;
    return sprite;
  }

  private clearWallsGroup(): void {
    while (this.wallsGroup.children.length > 0) {
      const child = this.wallsGroup.children[0];
      this.wallsGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments || child instanceof THREE.LineLoop) {
        child.geometry.dispose();
      } else if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
  }

  public reset(): void {
    this.pointsGeo.setDrawRange(0, 0);
    this.clearWallsGroup();
  }
}
