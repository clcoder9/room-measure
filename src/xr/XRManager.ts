import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Reticle } from './Reticle';
import { DepthExplorer } from './DepthExplorer';
import { RoomManager } from '../measurement/RoomManager';
import { MeasurementVisuals } from '../measurement/MeasurementVisuals';
import { calculateAverageFloorHeight } from '../measurement/math';

export interface XRManagerOptions {
  container: HTMLElement;
  overlayElement: HTMLElement;
  onSessionStarted?: () => void;
  onSessionEnded?: () => void;
  onStatusMessage?: (msg: string) => void;
  onRenderFrame?: (reticlePos: THREE.Vector3 | null, camera: THREE.Camera) => void;
}

export interface FramePixelData {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export class XRManager {
  private container: HTMLElement;
  private overlayElement: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private reticle: Reticle;
  private visuals: MeasurementVisuals;
  private roomManager: RoomManager;
  private depthExplorer: DepthExplorer;

  private xrSession: XRSession | null = null;
  private xrRefSpace: XRReferenceSpace | null = null;
  private xrHitTestSource: XRHitTestSource | null = null;

  private isSimulatedMode = false;
  private orbitControls: OrbitControls | null = null;
  private simPointerDownPos = { x: 0, y: 0, button: -1 };
  private simLastNDC = new THREE.Vector2(0, 0);
  private simHasPointer = false;

  private lastFrameTime = performance.now();
  private raycaster = new THREE.Raycaster();
  private simFloorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private pendingFrameCaptureResolve: ((data: FramePixelData | null) => void) | null = null;

  private onSessionStarted?: () => void;
  private onSessionEnded?: () => void;
  private onStatusMessage?: (msg: string) => void;
  private onRenderFrame?: (reticlePos: THREE.Vector3 | null, camera: THREE.Camera) => void;

  constructor(options: XRManagerOptions) {
    this.container = options.container;
    this.overlayElement = options.overlayElement;
    this.onSessionStarted = options.onSessionStarted;
    this.onSessionEnded = options.onSessionEnded;
    this.onStatusMessage = options.onStatusMessage;
    this.onRenderFrame = options.onRenderFrame;

    // Three.js Scene Setup
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      50
    );

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    // Ambient & Directional lighting for visual clarity
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(0, 5, 2);
    this.scene.add(dirLight);

    // Reticle
    this.reticle = new Reticle();
    this.scene.add(this.reticle);

    // Visuals & Room Manager
    this.visuals = new MeasurementVisuals();
    this.scene.add(this.visuals);

    this.roomManager = new RoomManager(this.visuals);
    this.depthExplorer = new DepthExplorer();

    // Resize handling
    window.addEventListener('resize', this.onWindowResize.bind(this));

    // Handle Desktop Simulator pointer interactions
    this.container.addEventListener('pointermove', this.onPointerMoveSim.bind(this));
    this.container.addEventListener('pointerdown', this.onPointerDownSim.bind(this));
    this.container.addEventListener('pointerup', this.onPointerUpSim.bind(this));
  }

  public getRoomManager(): RoomManager {
    return this.roomManager;
  }

  public getDepthExplorer(): DepthExplorer {
    return this.depthExplorer;
  }

  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public static async isARSupported(): Promise<boolean> {
    if (!navigator.xr) {
      return false;
    }
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }

  /**
   * Captures WebGL framebuffer pixels right after the next rendered frame so
   * WebXR baseLayer framebuffers are guaranteed to be bound and populated.
   */
  public requestFramePixels(): Promise<FramePixelData | null> {
    return new Promise((resolve) => {
      if (this.pendingFrameCaptureResolve) {
        this.pendingFrameCaptureResolve(null);
      }
      const timeout = setTimeout(() => {
        if (this.pendingFrameCaptureResolve === finish) {
          this.pendingFrameCaptureResolve = null;
          resolve(null);
        }
      }, 1000);

      const finish = (data: FramePixelData | null) => {
        clearTimeout(timeout);
        resolve(data);
      };
      this.pendingFrameCaptureResolve = finish;
    });
  }

  private fulfillPendingFrameCapture(): void {
    if (!this.pendingFrameCaptureResolve) return;
    const resolve = this.pendingFrameCaptureResolve;
    this.pendingFrameCaptureResolve = null;

    try {
      const gl = this.renderer.getContext();
      let width = gl.drawingBufferWidth || this.renderer.domElement.width || window.innerWidth;
      let height = gl.drawingBufferHeight || this.renderer.domElement.height || window.innerHeight;

      if (this.renderer.xr.isPresenting) {
        const baseLayer = this.renderer.xr.getBaseLayer() as unknown as {
          framebuffer?: WebGLFramebuffer;
          framebufferWidth?: number;
          framebufferHeight?: number;
        } | null;
        if (baseLayer?.framebuffer) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
          if (baseLayer.framebufferWidth && baseLayer.framebufferHeight) {
            width = baseLayer.framebufferWidth;
            height = baseLayer.framebufferHeight;
          }
        }
      }

      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      resolve({ width, height, pixels });
    } catch (err) {
      console.warn('[Snapshot] Framebuffer read failed:', err);
      resolve(null);
    }
  }

  private cleanupSimulatorArtifacts(): void {
    const grid = this.scene.getObjectByName('SimFloorGrid');
    if (grid) {
      this.scene.remove(grid);
    }
    if (this.orbitControls) {
      this.orbitControls.dispose();
      this.orbitControls = null;
    }
  }

  private cancelHitTestSource(): void {
    if (this.xrHitTestSource) {
      try {
        this.xrHitTestSource.cancel();
      } catch {
        // Ignore if session already ended
      }
      this.xrHitTestSource = null;
    }
  }

  /**
   * Starts native WebXR immersive-ar session
   */
  public async startARSession(): Promise<void> {
    if (!navigator.xr) {
      throw new Error('WebXR is not supported on this browser or platform.');
    }

    // Restore WebXR rendering if coming back from simulator mode
    this.isSimulatedMode = false;
    this.cleanupSimulatorArtifacts();
    this.renderer.xr.enabled = true;

    const sessionInit: XRSessionInit = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'bounded-floor', 'dom-overlay', 'plane-detection', 'depth-sensing'],
      domOverlay: { root: this.overlayElement },
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32']
      }
    };

    try {
      this.notifyStatus('Requesting AR session...');

      let session: XRSession;
      try {
        session = await navigator.xr.requestSession('immersive-ar', sessionInit);
      } catch (err) {
        console.warn('[WebXR] Failed with depth-sensing options, retrying with core AR features:', err);
        const fallbackInit: XRSessionInit = {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection'],
          domOverlay: { root: this.overlayElement }
        };
        session = await navigator.xr.requestSession('immersive-ar', fallbackInit);
      }

      this.xrSession = session;

      // Safely probe reference space support: ARCore on phones typically supports 'local', not 'local-floor'
      let activeRefSpace: XRReferenceSpace | null = null;
      let chosenRefSpaceType: XRReferenceSpaceType = 'local';

      try {
        activeRefSpace = await session.requestReferenceSpace('local-floor');
        chosenRefSpaceType = 'local-floor';
      } catch {
        console.info('[WebXR] local-floor not available on this device; falling back to local tracking space');
        activeRefSpace = await session.requestReferenceSpace('local');
        chosenRefSpaceType = 'local';
      }

      this.renderer.xr.setReferenceSpaceType(chosenRefSpaceType);
      await this.renderer.xr.setSession(session);

      this.xrRefSpace = activeRefSpace || this.renderer.xr.getReferenceSpace();

      // Request hit test source from viewer ray (center of screen)
      const viewerSpace = await session.requestReferenceSpace('viewer');
      if ('requestHitTestSource' in session && typeof session.requestHitTestSource === 'function') {
        this.xrHitTestSource = (await session.requestHitTestSource({ space: viewerSpace })) ?? null;
      }

      session.addEventListener('select', this.onXRSelect.bind(this));
      session.addEventListener('end', this.onXRSessionEnded.bind(this));

      this.depthExplorer.reset();
      this.notifyStatus('AR active. Point camera at floor.');

      if (this.onSessionStarted) {
        this.onSessionStarted();
      }

      this.renderer.setAnimationLoop(this.onARFrame.bind(this));
    } catch (err) {
      console.error('[WebXR] Failed to start AR session:', err);
      throw err;
    }
  }

  /**
   * Starts Desktop Simulator mode for testing without mobile AR device
   */
  public startSimulatorSession(): void {
    this.cleanupSimulatorArtifacts();
    this.isSimulatedMode = true;
    this.renderer.xr.enabled = false;
    this.camera.position.set(0, 2.2, 3.8);
    this.camera.lookAt(0, 0, 0);

    const grid = new THREE.GridHelper(12, 24, 0x00f2fe, 0x1e293b);
    grid.name = 'SimFloorGrid';
    this.scene.add(grid);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.orbitControls.minDistance = 0.8;
    this.orbitControls.maxDistance = 18;
    this.orbitControls.target.set(0, 0, 0);

    this.notifyStatus('Simulator active. Left-click to pin, drag to orbit.');

    if (this.onSessionStarted) {
      this.onSessionStarted();
    }

    this.renderer.setAnimationLoop(this.onSimulatorFrame.bind(this));
  }

  /**
   * Projects a ray onto the best vertical wall plane rising from the floor perimeter
   * so ceiling height can be measured even when ARCore cannot detect a featureless ceiling.
   */
  private projectRayToVerticalWallPlane(
    ray: THREE.Ray,
    floorPoints: THREE.Vector3[],
    camPos: THREE.Vector3,
    camForward: THREE.Vector3
  ): THREE.Vector3 | null {
    if (floorPoints.length === 0) return null;

    let bestHit: THREE.Vector3 | null = null;
    let bestDistSq = Infinity;

    // 1. Check vertical planes of each floor wall segment
    const segCount = this.roomManager.isClosed() ? floorPoints.length : floorPoints.length - 1;
    for (let i = 0; i < segCount; i++) {
      const pA = floorPoints[i];
      const pB = floorPoints[(i + 1) % floorPoints.length];
      const dx = pB.x - pA.x;
      const dz = pB.z - pA.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.05) continue;

      const normal = new THREE.Vector3(-dz / segLen, 0, dx / segLen);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pA);
      const hit = new THREE.Vector3();
      if (ray.intersectPlane(plane, hit)) {
        const toHit = hit.clone().sub(ray.origin);
        if (toHit.dot(ray.direction) <= 0.15) continue;

        // Check horizontal projection along segment [pA, pB]
        const u = ((hit.x - pA.x) * dx + (hit.z - pA.z) * dz) / (segLen * segLen);
        if (u >= -0.35 && u <= 1.35) {
          const dSq = toHit.lengthSq();
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestHit = hit;
          }
        }
      }
    }

    if (bestHit) {
      return bestHit;
    }

    // 2. Fallback: vertical plane facing camera passing through floor centroid (or corner #1)
    const centroid = new THREE.Vector3();
    floorPoints.forEach((p) => centroid.add(p));
    centroid.divideScalar(floorPoints.length);

    const horizForward = new THREE.Vector3(camForward.x, 0, camForward.z);
    if (horizForward.lengthSq() < 1e-4) {
      horizForward.set(0, 0, -1);
    }
    horizForward.normalize();

    const toCentroid = centroid.clone().sub(camPos);
    const forwardDist = toCentroid.x * horizForward.x + toCentroid.z * horizForward.z;
    const planeAnchor =
      forwardDist > 0.5
        ? centroid
        : camPos.clone().addScaledVector(horizForward, 2.5);

    const fallbackPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      horizForward.clone().negate(),
      planeAnchor
    );
    const fallbackHit = new THREE.Vector3();
    if (ray.intersectPlane(fallbackPlane, fallbackHit)) {
      return fallbackHit;
    }
    return null;
  }

  /**
   * Primary XR animation loop called on every frame by WebXR runtime
   */
  private onARFrame(timestamp: number, frame?: XRFrame): void {
    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    this.reticle.updateAnimation(dt);

    if (frame && this.xrHitTestSource && this.xrRefSpace) {
      const hitTestResults = frame.getHitTestResults(this.xrHitTestSource);
      const isCeilingMode = this.roomManager.getState() === 'MEASURING_CEILING';
      const floorPoints = this.roomManager.getFloorPoints();
      const avgFloorY = calculateAverageFloorHeight(floorPoints);

      let resolvedReticle = false;

      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(this.xrRefSpace);

        if (pose) {
          const hitY = pose.transform.position.y;
          // In ceiling mode, only accept real AR hits that are clearly above the floor plane
          if (!isCeilingMode || Math.abs(hitY - avgFloorY) > 0.35) {
            this.reticle.updateFromMatrix(pose.transform.matrix);
            const rawWorldPos = this.reticle.getWorldPositionTarget();
            this.roomManager.updateLiveReticle(rawWorldPos);

            const snap = this.roomManager.getLiveSnapState();
            const isSnapped = snap.isSnappedToStart || snap.isOrthoSnapped;
            this.reticle.setSnapped(isSnapped);
            if (isSnapped && snap.effectiveReticlePos) {
              this.reticle.setWorldPose(snap.effectiveReticlePos, this.reticle.getSurfaceNormal());
            }
            resolvedReticle = true;
          }
        }
      }

      // Vertical Wall-Ray Projection fallback for featureless ceilings
      if (!resolvedReticle && isCeilingMode && floorPoints.length > 0) {
        const camWorldPos = new THREE.Vector3();
        const camForward = new THREE.Vector3();
        const xrCam = this.renderer.xr.getCamera();
        xrCam.getWorldPosition(camWorldPos);
        xrCam.getWorldDirection(camForward);

        const viewerRay = new THREE.Ray(camWorldPos, camForward);
        const wallHit = this.projectRayToVerticalWallPlane(
          viewerRay,
          floorPoints,
          camWorldPos,
          camForward
        );
        if (wallHit) {
          wallHit.y = Math.min(wallHit.y, avgFloorY + 8.0);
          this.reticle.setWorldPose(wallHit);
          this.roomManager.updateLiveReticle(wallHit);
          this.reticle.setSnapped(Math.abs(wallHit.y - avgFloorY) >= 0.4);
          resolvedReticle = true;
        }
      }

      if (!resolvedReticle) {
        this.reticle.visible = false;
        this.reticle.setSnapped(false);
        this.roomManager.updateLiveReticle(null);
      }

      // Secondary: Probe WebXR Depth API on Pixel Pro hardware
      this.depthExplorer.probeFrame(frame, this.xrRefSpace, timestamp);
    }

    if (this.onRenderFrame) {
      const retPos = this.reticle.visible ? this.reticle.getWorldPositionTarget() : null;
      this.onRenderFrame(retPos, this.camera);
    }

    this.renderer.render(this.scene, this.camera);
    this.fulfillPendingFrameCapture();
  }

  /**
   * Simulation frame loop for desktop testing
   */
  private onSimulatorFrame(): void {
    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    if (this.orbitControls) {
      this.orbitControls.update();
    }

    if (this.simHasPointer) {
      this.updateSimulatorReticleFromNDC(this.simLastNDC);
    }

    this.reticle.updateAnimation(dt);
    if (this.reticle.visible) {
      this.roomManager.updateLiveReticle(this.reticle.position);
      const snap = this.roomManager.getLiveSnapState();
      const isSnapped = snap.isSnappedToStart || snap.isOrthoSnapped;
      this.reticle.setSnapped(isSnapped);
      if (isSnapped && snap.effectiveReticlePos) {
        this.reticle.setWorldPose(snap.effectiveReticlePos);
      }
    }

    if (this.onRenderFrame) {
      const retPos = this.reticle.visible ? this.reticle.position.clone() : null;
      this.onRenderFrame(retPos, this.camera);
    }

    this.renderer.render(this.scene, this.camera);
    this.fulfillPendingFrameCapture();
  }

  /**
   * Triggered when user taps the screen in WebXR
   */
  private onXRSelect(): void {
    if (this.reticle.visible) {
      const pos = this.reticle.getWorldPositionTarget();
      this.roomManager.pinCurrentPosition(pos);
    }
  }

  /**
   * Explicit pin action triggered from UI HUD button
   */
  public pinReticlePoint(): boolean {
    if (this.reticle.visible) {
      const pos = this.isSimulatedMode
        ? this.reticle.position.clone()
        : this.reticle.getWorldPositionTarget();
      return this.roomManager.pinCurrentPosition(pos);
    }
    return false;
  }

  private onXRSessionEnded(): void {
    this.cancelHitTestSource();
    this.xrSession = null;
    this.xrRefSpace = null;
    this.reticle.visible = false;
    this.reticle.setSnapped(false);
    this.renderer.setAnimationLoop(null);
    this.notifyStatus('AR session ended.');

    if (this.onSessionEnded) {
      this.onSessionEnded();
    }
  }

  public async stopSession(): Promise<void> {
    if (this.xrSession) {
      await this.xrSession.end();
    } else if (this.isSimulatedMode) {
      this.isSimulatedMode = false;
      this.renderer.setAnimationLoop(null);
      this.cleanupSimulatorArtifacts();
      this.reticle.visible = false;
      this.reticle.setSnapped(false);
      if (this.onSessionEnded) {
        this.onSessionEnded();
      }
    }
  }

  /**
   * Re-anchors tracking from the current device position and clears all points.
   */
  public async restartSession(): Promise<void> {
    this.roomManager.reset();
    this.depthExplorer.reset();
    this.reticle.visible = false;
    this.reticle.setSnapped(false);

    if (this.xrSession) {
      try {
        this.cancelHitTestSource();
        const refSpace = await this.xrSession.requestReferenceSpace('local');
        this.xrRefSpace = refSpace;
        this.renderer.xr.setReferenceSpace(refSpace);

        const viewerSpace = await this.xrSession.requestReferenceSpace('viewer');
        if ('requestHitTestSource' in this.xrSession && typeof this.xrSession.requestHitTestSource === 'function') {
          this.xrHitTestSource = (await this.xrSession.requestHitTestSource({ space: viewerSpace })) ?? null;
        }

        this.notifyStatus('New session started: tracking re-anchored from current position.');
      } catch (err) {
        console.warn('[WebXR] Re-anchoring error:', err);
      }
    } else if (this.isSimulatedMode) {
      this.camera.position.set(0, 2.2, 3.8);
      if (this.orbitControls) {
        this.orbitControls.target.set(0, 0, 0);
        this.orbitControls.update();
      } else {
        this.camera.lookAt(0, 0, 0);
      }
      this.notifyStatus('Simulator session reset.');
    }
  }

  private updateSimulatorReticleFromNDC(ndc: THREE.Vector2): void {
    this.raycaster.setFromCamera(ndc, this.camera);
    const target = new THREE.Vector3();

    if (this.roomManager.getState() === 'MEASURING_CEILING') {
      const floorPoints = this.roomManager.getFloorPoints();
      const avgFloorY = calculateAverageFloorHeight(floorPoints);
      const camForward = new THREE.Vector3();
      this.camera.getWorldDirection(camForward);

      const wallHit = this.projectRayToVerticalWallPlane(
        this.raycaster.ray,
        floorPoints,
        this.camera.position,
        camForward
      );
      if (wallHit) {
        wallHit.y = Math.max(avgFloorY + 0.4, Math.min(avgFloorY + 8.0, wallHit.y));
        this.reticle.setWorldPose(wallHit);
        return;
      }

      if (this.raycaster.ray.intersectPlane(this.simFloorPlane, target)) {
        target.y = avgFloorY + 2.6;
        this.reticle.setWorldPose(target);
      }
    } else {
      if (this.raycaster.ray.intersectPlane(this.simFloorPlane, target)) {
        this.reticle.setWorldPose(target);
      }
    }
  }

  private onPointerMoveSim(e: PointerEvent): void {
    if (!this.isSimulatedMode) return;
    const rect = this.container.getBoundingClientRect();
    this.simLastNDC.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.simHasPointer = true;
    this.updateSimulatorReticleFromNDC(this.simLastNDC);
  }

  private onPointerDownSim(e: PointerEvent): void {
    if (!this.isSimulatedMode) return;
    this.simPointerDownPos = { x: e.clientX, y: e.clientY, button: e.button };
  }

  private onPointerUpSim(e: PointerEvent): void {
    if (!this.isSimulatedMode) return;
    if (e.button !== 0 || this.simPointerDownPos.button !== 0) return;

    const dragDist = Math.hypot(
      e.clientX - this.simPointerDownPos.x,
      e.clientY - this.simPointerDownPos.y
    );
    // Distinguish quick click (< 6px) from OrbitControls drag
    if (dragDist < 6 && this.reticle.visible) {
      this.updateSimulatorReticleFromNDC(this.simLastNDC);
      this.roomManager.pinCurrentPosition(this.reticle.position.clone());
    }
  }

  private onWindowResize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private notifyStatus(msg: string): void {
    if (this.onStatusMessage) {
      this.onStatusMessage(msg);
    }
  }
}
