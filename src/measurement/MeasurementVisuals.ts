import * as THREE from 'three';
import {
  UnitSystem,
  calculateHorizontalDistance,
  calculateAverageFloorHeight,
  calculateInteriorAngleDeg,
  formatDistance
} from './math';

export class MeasurementVisuals extends THREE.Group {
  private markersGroup: THREE.Group;
  private linesGroup: THREE.Group;
  private labelsGroup: THREE.Group;
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
  private pillarGeo = new THREE.CylinderGeometry(0.006, 0.006, 2.4, 12);

  // Materials
  private sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00f2fe });
  private firstPointMaterial = new THREE.MeshBasicMaterial({ color: 0x10b981 });
  private ceilingSphereMaterial = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
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

    this.add(this.markersGroup);
    this.add(this.linesGroup);
    this.add(this.labelsGroup);

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

  /**
   * Updates placed points, connecting lines, floor mesh, and volume visualization.
   */
  public updatePoints(
    floorPoints: THREE.Vector3[],
    ceilingPoint: THREE.Vector3 | null,
    isFloorClosed: boolean,
    unitSystem: UnitSystem = 'metric'
  ): void {
    this.clearDynamicObjects();

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

      // Vertical holographic light pillar (2.4m tall, visible from across the room)
      const pillar = new THREE.Mesh(
        this.pillarGeo,
        isFirst ? this.firstPillarMaterial : this.pillarMaterial
      );
      pillar.position.set(point.x, point.y + 1.2, point.z);
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

      const floorY = calculateAverageFloorHeight(floorPoints);
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

  private createTextSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 72;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = 4;
      this.drawRoundedRect(ctx, 4, 4, 248, 64, 16);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
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

  public clearDynamicObjects(): void {
    while (this.markersGroup.children.length > 0) {
      const obj = this.markersGroup.children[0];
      this.markersGroup.remove(obj);
    }
    while (this.linesGroup.children.length > 0) {
      const obj = this.linesGroup.children[0];
      this.linesGroup.remove(obj);
      if (obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    }
    while (this.labelsGroup.children.length > 0) {
      const obj = this.labelsGroup.children[0];
      this.labelsGroup.remove(obj);
      if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    }

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
    // ceilingDropLine is added to linesGroup and disposed in the linesGroup loop above
    this.ceilingDropLine = null;
  }

  public reset(): void {
    this.clearDynamicObjects();
    if (this.liveLine) {
      this.liveLine.visible = false;
    }
    if (this.liveAngleSprite) {
      this.liveAngleSprite.visible = false;
    }
    this.lastLiveAngleKey = '';
  }
}
