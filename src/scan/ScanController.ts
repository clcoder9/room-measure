import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { UnitSystem } from '../measurement/math';
import {
  DepthFramePayload,
  FurnitureBox,
  ScanStats,
  SerializedPlaneInput,
  ShellEstimate,
  WallOpening,
  WorkerInMessage,
  WorkerOutMessage
} from './ScanTypes';
import { ScanVisuals } from './ScanVisuals';

const SAMPLE_INTERVAL_MS = 160; // ~6 Hz depth ingestion
const SIM_WIDTH = 80;
const SIM_HEIGHT = 60;

type ExtendedXRFrame = XRFrame & {
  getDepthInformation?: (view: XRView) => XRCPUDepthInformation | null | undefined;
};

export class ScanController {
  private worker: Worker;
  private visuals: ScanVisuals;
  private active = false;
  private paused = false;
  private isSimulator = false;
  private lastSampleTime = 0;

  private latestShell: ShellEstimate | null = null;
  private latestStats: ScanStats | null = null;
  private latestFurniture: FurnitureBox[] = [];
  private latestOpenings: WallOpening[] = [];
  private latestPathXZ: Float32Array = new Float32Array(0);
  private unitSystem: UnitSystem = 'metric';

  private onUpdateCallback?: (
    shell: ShellEstimate,
    stats: ScanStats,
    furniture: FurnitureBox[],
    openings: WallOpening[]
  ) => void;

  // Scratch objects
  private raycaster = new THREE.Raycaster();
  private ndcScratch = new THREE.Vector2();
  private camPosScratch = new THREE.Vector3();
  private camDirScratch = new THREE.Vector3();
  private keysPressed = new Set<string>();

  constructor(visuals: ScanVisuals) {
    this.visuals = visuals;
    this.worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      if (e.data.type !== 'SCAN_UPDATE' || !this.active) return;
      this.latestShell = e.data.shell;
      this.latestStats = e.data.stats;
      this.latestFurniture = e.data.furniture ?? [];
      this.latestOpenings = e.data.openings ?? [];
      this.latestPathXZ = e.data.cameraPathXZ;

      this.visuals.updatePointCloud(
        e.data.previewPositions,
        e.data.previewColors,
        e.data.previewCount
      );
      this.visuals.updateShell(
        e.data.shell,
        this.unitSystem,
        this.latestFurniture,
        this.latestOpenings
      );
      this.onUpdateCallback?.(
        e.data.shell,
        e.data.stats,
        this.latestFurniture,
        this.latestOpenings
      );
    };

    window.addEventListener('keydown', (e) => {
      this.keysPressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.code);
    });
  }

  public setOnUpdate(
    cb: (
      shell: ShellEstimate,
      stats: ScanStats,
      furniture: FurnitureBox[],
      openings: WallOpening[]
    ) => void
  ): void {
    this.onUpdateCallback = cb;
  }

  public setUnitSystem(unit: UnitSystem): void {
    this.unitSystem = unit;
    if (this.active && this.latestShell) {
      this.visuals.updateShell(
        this.latestShell,
        this.unitSystem,
        this.latestFurniture,
        this.latestOpenings
      );
    }
  }

  public isActive(): boolean {
    return this.active;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public start(isSimulator: boolean): void {
    this.active = true;
    this.paused = false;
    this.isSimulator = isSimulator;
    this.lastSampleTime = 0;
    this.visuals.setActive(true);
  }

  public stop(): void {
    this.active = false;
    this.paused = false;
    this.visuals.setActive(false);
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  public reset(): void {
    this.latestShell = null;
    this.latestStats = null;
    this.latestFurniture = [];
    this.latestOpenings = [];
    this.latestPathXZ = new Float32Array(0);
    this.lastSampleTime = 0;
    this.visuals.reset();
    const msg: WorkerInMessage = { type: 'RESET' };
    this.worker.postMessage(msg);
  }

  public getLatestShell(): ShellEstimate | null {
    return this.latestShell;
  }

  public getLatestStats(): ScanStats | null {
    return this.latestStats;
  }

  public getLatestFurniture(): FurnitureBox[] {
    return this.latestFurniture;
  }

  public getLatestOpenings(): WallOpening[] {
    return this.latestOpenings;
  }

  public getLatestCameraPathXZ(): Float32Array {
    return this.latestPathXZ;
  }

  public updateSimulatorWalk(
    dt: number,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls | null
  ): void {
    if (!this.active || !this.isSimulator || this.keysPressed.size === 0) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-5) return;
    forward.normalize();

    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();

    if (this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp')) move.add(forward);
    if (this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown')) move.sub(forward);
    if (this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight')) move.add(right);
    if (this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft')) move.sub(right);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(Math.min(0.2, dt * 1.8));
      camera.position.add(move);
      controls?.target.add(move);
    }
  }

  public onARFrame(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    camera: THREE.Camera,
    timestamp: number
  ): void {
    if (!this.active || this.paused) return;
    if (timestamp - this.lastSampleTime < SAMPLE_INTERVAL_MS) return;

    const extFrame = frame as ExtendedXRFrame;
    if (typeof extFrame.getDepthInformation !== 'function') return;

    const viewerPose = frame.getViewerPose(refSpace);
    if (!viewerPose || viewerPose.views.length === 0) return;

    const view = viewerPose.views[0];
    let depthInfo: XRCPUDepthInformation | null | undefined = null;
    try {
      depthInfo = extFrame.getDepthInformation(view);
    } catch {
      return;
    }
    if (!depthInfo || depthInfo.data.byteLength === 0) return;

    this.lastSampleTime = timestamp;

    const depthBuffer = depthInfo.data.slice(0);
    const isFloat32 = depthInfo.data.byteLength === depthInfo.width * depthInfo.height * 4;
    const normDepthFromNormView = new Float32Array(depthInfo.normDepthBufferFromNormView.matrix);
    const projMatrix = new Float32Array(view.projectionMatrix);
    const viewToWorld = new Float32Array(view.transform.matrix);

    camera.getWorldPosition(this.camPosScratch);
    camera.getWorldDirection(this.camDirScratch);

    const planes = this.serializeDetectedPlanes(frame, refSpace);
    const transferables: Transferable[] = [
      depthBuffer,
      normDepthFromNormView.buffer,
      projMatrix.buffer,
      viewToWorld.buffer
    ];
    for (const p of planes) {
      transferables.push(p.worldVertices.buffer);
    }

    const payload: DepthFramePayload = {
      depthBuffer,
      width: depthInfo.width,
      height: depthInfo.height,
      rawValueToMeters: depthInfo.rawValueToMeters,
      isFloat32,
      normDepthFromNormView,
      projMatrix,
      viewToWorld,
      cameraPos: [this.camPosScratch.x, this.camPosScratch.y, this.camPosScratch.z],
      cameraForward: [this.camDirScratch.x, this.camDirScratch.y, this.camDirScratch.z],
      planes
    };

    const msg: WorkerInMessage = { type: 'INGEST_FRAME', payload };
    this.worker.postMessage(msg, transferables);
  }

  public onSimulatorFrame(
    camera: THREE.PerspectiveCamera,
    simMeshes: THREE.Object3D[],
    timestamp: number
  ): void {
    if (!this.active || this.paused) return;
    if (timestamp - this.lastSampleTime < SAMPLE_INTERVAL_MS) return;
    this.lastSampleTime = timestamp;

    camera.updateMatrixWorld();
    camera.getWorldPosition(this.camPosScratch);
    camera.getWorldDirection(this.camDirScratch);

    const depthArr = new Float32Array(SIM_WIDTH * SIM_HEIGHT);
    const tmpPoint = new THREE.Vector3();

    for (let r = 0; r < SIM_HEIGHT; r++) {
      const v = (r + 0.5) / SIM_HEIGHT;
      const ndcY = 1 - 2 * v;
      for (let c = 0; c < SIM_WIDTH; c++) {
        const u = (c + 0.5) / SIM_WIDTH;
        this.ndcScratch.set(2 * u - 1, ndcY);
        this.raycaster.setFromCamera(this.ndcScratch, camera);
        const hits = this.raycaster.intersectObjects(simMeshes, false);
        if (hits.length === 0) continue;
        const first = hits[0];
        if (first.object.userData?.isWindowGlass) {
          depthArr[r * SIM_WIDTH + c] = 25.0; // Simulate glass shoot-through
          continue;
        }
        tmpPoint.copy(first.point).sub(this.camPosScratch);
        const zOpt = tmpPoint.dot(this.camDirScratch);
        if (zOpt > 0.25 && zOpt <= 6.0) {
          const noise = Math.sin(u * 213.7 + v * 331.3 + timestamp * 0.01) * 0.004 * zOpt;
          depthArr[r * SIM_WIDTH + c] = Math.max(0.2, zOpt + noise);
        }
      }
    }

    const normDepthFromNormView = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    const projMatrix = new Float32Array(camera.projectionMatrix.elements);
    const viewToWorld = new Float32Array(camera.matrixWorld.elements);

    const payload: DepthFramePayload = {
      depthBuffer: depthArr.buffer,
      width: SIM_WIDTH,
      height: SIM_HEIGHT,
      rawValueToMeters: 1.0,
      isFloat32: true,
      normDepthFromNormView,
      projMatrix,
      viewToWorld,
      cameraPos: [this.camPosScratch.x, this.camPosScratch.y, this.camPosScratch.z],
      cameraForward: [this.camDirScratch.x, this.camDirScratch.y, this.camDirScratch.z],
      planes: []
    };

    const msg: WorkerInMessage = { type: 'INGEST_FRAME', payload };
    this.worker.postMessage(msg, [
      depthArr.buffer,
      normDepthFromNormView.buffer,
      projMatrix.buffer,
      viewToWorld.buffer
    ]);
  }

  private serializeDetectedPlanes(frame: XRFrame, refSpace: XRReferenceSpace): SerializedPlaneInput[] {
    const planes = frame.detectedPlanes;
    if (!planes || planes.size === 0) return [];

    const out: SerializedPlaneInput[] = [];
    planes.forEach((plane) => {
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose || !plane.polygon || plane.polygon.length < 3) return;

      const mat = pose.transform.matrix;
      const worldVertices = new Float32Array(plane.polygon.length * 3);
      let sumY = 0;
      let area2 = 0;
      const n = plane.polygon.length;

      for (let i = 0; i < n; i++) {
        const lp = plane.polygon[i];
        const lpNext = plane.polygon[(i + 1) % n];
        area2 += lp.x * lpNext.z - lpNext.x * lp.z;

        const wx = mat[0] * lp.x + mat[4] * lp.y + mat[8] * lp.z + mat[12];
        const wy = mat[1] * lp.x + mat[5] * lp.y + mat[9] * lp.z + mat[13];
        const wz = mat[2] * lp.x + mat[6] * lp.y + mat[10] * lp.z + mat[14];
        worldVertices[i * 3] = wx;
        worldVertices[i * 3 + 1] = wy;
        worldVertices[i * 3 + 2] = wz;
        sumY += wy;
      }

      const orient =
        plane.orientation === 'horizontal' || plane.orientation === 'vertical'
          ? plane.orientation
          : 'unknown';

      let normalXZ: [number, number] | undefined;
      if (orient === 'vertical') {
        // Plane local +Y is plane normal in WebXR plane-detection
        const nx = mat[4];
        const nz = mat[6];
        const len = Math.hypot(nx, nz);
        if (len > 0.2) {
          normalXZ = [nx / len, nz / len];
        }
      }

      out.push({
        orientation: orient,
        worldVertices,
        areaSqM: Math.abs(area2) * 0.5,
        centerY: sumY / n,
        normalXZ
      });
    });

    return out;
  }
}
