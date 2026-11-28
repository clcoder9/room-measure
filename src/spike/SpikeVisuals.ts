import * as THREE from 'three';
import { DetectedPlaneVisualData, MAX_WORLD_POINTS } from './SensorSpikeProbe';

const MAX_PLANE_WIREFRAMES = 16;
const MAX_PLANE_VERTS = 64;

export class SpikeVisuals extends THREE.Group {
  private pointsMesh: THREE.Points;
  private pointsGeo: THREE.BufferGeometry;
  private positionAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;

  private planesGroup: THREE.Group;
  private planePool: THREE.LineLoop[] = [];
  private horizMat = new THREE.LineBasicMaterial({ color: 0x00f2fe, depthTest: false });
  private vertMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false });

  private simKitchenGroup: THREE.Group;
  private simRayMeshes: THREE.Object3D[] = [];
  private showPoints = true;

  constructor() {
    super();
    this.name = 'SpikeVisuals';
    this.visible = false;

    // 1. Pre-allocated 3D world-space depth point cloud
    this.pointsGeo = new THREE.BufferGeometry();
    const posBuf = new Float32Array(MAX_WORLD_POINTS * 3);
    const colBuf = new Float32Array(MAX_WORLD_POINTS * 3);
    this.positionAttr = new THREE.BufferAttribute(posBuf, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(colBuf, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.pointsGeo.setAttribute('position', this.positionAttr);
    this.pointsGeo.setAttribute('color', this.colorAttr);
    this.pointsGeo.setDrawRange(0, 0);

    const pointsMat = new THREE.PointsMaterial({
      size: 0.024,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      sizeAttenuation: true
    });

    this.pointsMesh = new THREE.Points(this.pointsGeo, pointsMat);
    this.pointsMesh.frustumCulled = false;
    this.pointsMesh.renderOrder = 950;
    this.add(this.pointsMesh);

    // 2. Pooled detected-plane wireframes
    this.planesGroup = new THREE.Group();
    this.add(this.planesGroup);
    for (let i = 0; i < MAX_PLANE_WIREFRAMES; i++) {
      const geo = new THREE.BufferGeometry();
      const verts = new Float32Array(MAX_PLANE_VERTS * 3);
      const attr = new THREE.BufferAttribute(verts, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      geo.setDrawRange(0, 0);

      const loop = new THREE.LineLoop(geo, this.horizMat);
      loop.visible = false;
      loop.frustumCulled = false;
      loop.renderOrder = 955;
      this.planePool.push(loop);
      this.planesGroup.add(loop);
    }

    // 3. Synthetic Virtual Kitchen for Desktop Simulator testing
    this.simKitchenGroup = new THREE.Group();
    this.simKitchenGroup.visible = false;
    this.buildSimulatorKitchen();
    this.add(this.simKitchenGroup);
  }

  private buildSimulatorKitchen(): void {
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45
    });
    const furnitureMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const furnitureEdgeMat = new THREE.LineBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.75
    });
    const glassMat = new THREE.MeshBasicMaterial({
      color: 0xec4899,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const addSurface = (
      geo: THREE.BufferGeometry,
      pos: [number, number, number],
      rot: [number, number, number],
      mat: THREE.Material,
      outlineMat?: THREE.LineBasicMaterial,
      isGlass = false
    ) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      if (isGlass) {
        mesh.userData.isWindowGlass = true;
      }
      this.simKitchenGroup.add(mesh);
      this.simRayMeshes.push(mesh);

      if (outlineMat) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), outlineMat);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.simKitchenGroup.add(edges);
      }
    };

    // Room 4.4m (x in [-2.2, 2.2]) x 3.6m (z in [-1.8, 1.8]) x 2.6m (y in [0, 2.6])
    // Floor & Ceiling
    addSurface(new THREE.PlaneGeometry(4.4, 3.6), [0, 0, 0], [-Math.PI / 2, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(4.4, 3.6), [0, 2.6, 0], [Math.PI / 2, 0, 0], wallMat, edgeMat);

    // West wall (-X = -2.2) and South wall (+Z = 1.8)
    addSurface(new THREE.PlaneGeometry(3.6, 2.6), [-2.2, 1.3, 0], [0, Math.PI / 2, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(4.4, 2.6), [0, 1.3, 1.8], [0, Math.PI, 0], wallMat, edgeMat);

    // North wall (-Z = -1.8) with Window cutout (x in [-0.6, 0.6], y in [0.95, 2.05])
    addSurface(new THREE.PlaneGeometry(1.6, 2.6), [-1.4, 1.3, -1.8], [0, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.6, 2.6), [1.4, 1.3, -1.8], [0, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.2, 0.95), [0, 0.475, -1.8], [0, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.2, 0.55), [0, 2.325, -1.8], [0, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.2, 1.1), [0, 1.5, -1.8], [0, 0, 0], glassMat, undefined, true);

    // East wall (+X = 2.2) with Open Doorway cutout (z in [-0.45, 0.45], y in [0, 2.1])
    addSurface(new THREE.PlaneGeometry(1.35, 2.6), [2.2, 1.3, -1.125], [0, -Math.PI / 2, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.35, 2.6), [2.2, 1.3, 1.125], [0, -Math.PI / 2, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(0.9, 0.5), [2.2, 2.35, 0], [0, -Math.PI / 2, 0], wallMat, edgeMat);
    // Hallway beyond doorway so depth rays shoot through the doorway (> wall + 1.1m)
    addSurface(new THREE.PlaneGeometry(1.4, 1.2), [2.9, 0, 0], [-Math.PI / 2, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.4, 1.2), [2.9, 2.6, 0], [Math.PI / 2, 0, 0], wallMat, edgeMat);
    addSurface(new THREE.PlaneGeometry(1.2, 2.6), [3.5, 1.3, 0], [0, -Math.PI / 2, 0], wallMat, edgeMat);

    // Kitchen Counter (1.8m x 0.9m x 0.6m) along -X wall
    addSurface(new THREE.BoxGeometry(0.6, 0.9, 1.8), [-1.9, 0.45, -0.5], [0, 0, 0], furnitureMat, furnitureEdgeMat);
    // Fridge (0.7m x 1.85m x 0.7m) in SW corner
    addSurface(new THREE.BoxGeometry(0.7, 1.85, 0.7), [-1.85, 0.925, 1.1], [0, 0, 0], furnitureMat, furnitureEdgeMat);
  }

  public setActive(active: boolean, isSimulator: boolean): void {
    this.visible = active;
    this.simKitchenGroup.visible = active && isSimulator;
    this.pointsMesh.visible = active && this.showPoints;
    this.planesGroup.visible = active;
    if (!active) {
      this.pointsGeo.setDrawRange(0, 0);
      for (const loop of this.planePool) {
        loop.visible = false;
      }
    }
  }

  public setSimKitchenVisible(visible: boolean): void {
    if (visible) {
      this.visible = true;
      this.simKitchenGroup.visible = true;
      this.pointsMesh.visible = false;
      this.planesGroup.visible = false;
    } else {
      this.simKitchenGroup.visible = false;
    }
  }

  public setShowPoints(show: boolean): void {
    this.showPoints = show;
    this.pointsMesh.visible = show;
  }

  public isShowingPoints(): boolean {
    return this.showPoints;
  }

  public getSimulatorRoomMeshes(): THREE.Object3D[] {
    return this.simRayMeshes;
  }

  public updatePointCloud(positions: Float32Array, colors: Float32Array, count: number): void {
    const safeCount = Math.min(count, MAX_WORLD_POINTS);
    (this.positionAttr.array as Float32Array).set(positions.subarray(0, safeCount * 3));
    (this.colorAttr.array as Float32Array).set(colors.subarray(0, safeCount * 3));
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.pointsGeo.setDrawRange(0, safeCount);
  }

  public updateDetectedPlanes(planes: DetectedPlaneVisualData[]): void {
    for (let i = 0; i < this.planePool.length; i++) {
      const loop = this.planePool[i];
      if (i >= planes.length) {
        loop.visible = false;
        continue;
      }
      const p = planes[i];
      const vertCount = Math.min(Math.floor(p.worldVertices.length / 3), MAX_PLANE_VERTS);
      if (vertCount < 3) {
        loop.visible = false;
        continue;
      }
      const attr = loop.geometry.getAttribute('position') as THREE.BufferAttribute;
      (attr.array as Float32Array).set(p.worldVertices.subarray(0, vertCount * 3));
      attr.needsUpdate = true;
      loop.geometry.setDrawRange(0, vertCount);
      loop.material = p.orientation === 'vertical' ? this.vertMat : this.horizMat;
      loop.visible = true;
    }
  }
}
