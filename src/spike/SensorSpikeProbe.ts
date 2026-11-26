import * as THREE from 'three';

export type DepthPreference = 'raw-first' | 'smooth-first';

export type SpikeSampleTag =
  | 'wall_1m'
  | 'wall_2m'
  | 'wall_3m'
  | 'plain_white'
  | 'textured_tile'
  | 'window_glass'
  | 'floor'
  | 'ceiling'
  | 'furniture';

export const SPIKE_SAMPLE_PRESETS: readonly {
  tag: SpikeSampleTag;
  label: string;
  shortLabel: string;
}[] = [
  { tag: 'wall_1m', label: 'Wall 1m', shortLabel: 'Wall 1m' },
  { tag: 'wall_2m', label: 'Wall 2m', shortLabel: 'Wall 2m' },
  { tag: 'wall_3m', label: 'Wall 3m', shortLabel: 'Wall 3m' },
  { tag: 'plain_white', label: 'Plain White Wall', shortLabel: 'Plain White' },
  { tag: 'textured_tile', label: 'Textured / Tile Wall', shortLabel: 'Textured/Tile' },
  { tag: 'window_glass', label: 'Window Glass', shortLabel: 'Window Glass' },
  { tag: 'floor', label: 'Floor', shortLabel: 'Floor' },
  { tag: 'ceiling', label: 'Ceiling', shortLabel: 'Ceiling' },
  { tag: 'furniture', label: 'Furniture / Counter', shortLabel: 'Furniture' }
];

export interface SpikeSessionInfo {
  mode: 'immersive-ar' | 'desktop-simulator' | 'inactive';
  userAgent: string;
  startedAt: string;
  depthPreference: DepthPreference;
  negotiationAttempt: number;
  enabledFeatures: string[];
  referenceSpaceType: string;
  environmentBlendMode: string;
  depthSupported: boolean;
  depthActive: boolean;
  depthUsage: string;
  depthDataFormat: string;
  depthType: string;
  rawValueToMeters: number | null;
  depthWidth: number;
  depthHeight: number;
  normDepthBufferFromNormViewMatrix: number[] | null;
  rawBufferAccessVerified: boolean;
}

export interface DetectedPlaneSummary {
  orientation: 'horizontal' | 'vertical' | 'unknown';
  vertices: number;
  spanWidthM: number;
  spanDepthM: number;
  centerY: number;
  semanticLabel?: string;
}

export interface DetectedPlaneVisualData {
  orientation: 'horizontal' | 'vertical' | 'unknown';
  worldVertices: Float32Array;
}

export interface PlaneFitResult {
  residualRmsCm: number;
  maxResidualCm: number;
  grazingAngleDeg: number;
  worldTiltFromVerticalDeg: number;
  worldNormal: [number, number, number];
  surfaceClass: 'WALL (vertical)' | 'FLOOR (horiz ↑)' | 'CEILING (horiz ↓)' | 'SLOPED / OBJECT';
}

export interface SpikeLiveMetrics {
  xrFps: number;
  depthHz: number;
  centerDepthM: number | null;
  hitTestRayDistM: number | null;
  hitTestOpticalZM: number | null;
  deltaDepthMinusHitCm: number | null;
  worldHitDeltaCm: number | null;
  temporalCenterStdCm: number | null;
  roiValidCount: number;
  roiValidPct: number;
  roiMeanDepthM: number | null;
  roiSpreadMinMaxCm: number | null;
  planeFit: PlaneFitResult | null;
  frameValidPct: number;
  frameZeroOrInvalidPct: number;
  p10DepthM: number | null;
  p50DepthM: number | null;
  p90DepthM: number | null;
  detectedPlanesSupported: boolean;
  detectedPlanesTotal: number;
  detectedPlanesHorizontal: number;
  detectedPlanesVertical: number;
  detectedPlaneSummaries: DetectedPlaneSummary[];
  detectedMeshesSupported: boolean;
  detectedMeshesTotal: number;
}

export interface CapturedSpikeSample {
  id: string;
  tag: SpikeSampleTag;
  label: string;
  capturedAt: string;
  cameraWorldPos: [number, number, number];
  cameraYawDeg: number;
  cameraPitchDeg: number;
  metrics: {
    centerDepthM: number | null;
    hitTestRayDistM: number | null;
    hitTestOpticalZM: number | null;
    deltaDepthMinusHitCm: number | null;
    worldHitDeltaCm: number | null;
    temporalCenterStdCm: number | null;
    roiValidCount: number;
    roiValidPct: number;
    roiMeanDepthM: number | null;
    roiSpreadMinMaxCm: number | null;
    planeFit: PlaneFitResult | null;
    frameValidPct: number;
    frameZeroOrInvalidPct: number;
    p10DepthM: number | null;
    p50DepthM: number | null;
    p90DepthM: number | null;
    depthHz: number;
    xrFps: number;
    detectedPlanesTotal: number;
  };
  depthGrid16x12Mm: number[];
}

export interface SpikeReportExport {
  appVersion: string;
  exportedAt: string;
  session: SpikeSessionInfo;
  latestMetrics: SpikeLiveMetrics;
  sampleCount: number;
  samples: CapturedSpikeSample[];
}

export interface ARFrameSampleInput {
  frame: XRFrame;
  refSpace: XRReferenceSpace;
  timestamp: number;
  hitWorldPos: THREE.Vector3 | null;
  cameraWorldPos: THREE.Vector3;
  cameraForward: THREE.Vector3;
}

export interface SimulatorFrameSampleInput {
  camera: THREE.PerspectiveCamera;
  meshes: THREE.Object3D[];
  timestamp: number;
  hitWorldPos: THREE.Vector3 | null;
}

export const HEATMAP_COLS = 64;
export const HEATMAP_ROWS = 48;
export const WORLD_CLOUD_COLS = 24;
export const WORLD_CLOUD_ROWS = 18;
export const MAX_WORLD_POINTS = WORLD_CLOUD_COLS * WORLD_CLOUD_ROWS;

const STORAGE_KEY_SPIKE_REPORT = 'spatialmeasure_phase0_spike_report';
const SAMPLE_INTERVAL_MS = 100; // 10 Hz heavy probe
const OUT_OF_FOV = -1;

const ROI_MIN = 0.42;
const ROI_MAX = 0.58;
const ROI_GRID = 9; // 9x9 = 81 samples

type ExtendedXRSession = XRSession & {
  enabledFeatures?: string[];
  depthUsage?: string;
  depthDataFormat?: string;
  depthType?: string;
};

type ExtendedXRFrame = XRFrame & {
  getDepthInformation?: (view: XRView) => XRCPUDepthInformation | null | undefined;
  detectedMeshes?: Set<unknown>;
};

export function unprojectViewPoint(
  u: number,
  v: number,
  depthM: number,
  projMatrix: ArrayLike<number>
): [number, number, number] {
  const ndcX = 2 * u - 1;
  const ndcY = 1 - 2 * v;
  const p0 = Math.abs(projMatrix[0]) > 1e-6 ? projMatrix[0] : 1;
  const p5 = Math.abs(projMatrix[5]) > 1e-6 ? projMatrix[5] : 1;
  const p8 = projMatrix[8] ?? 0;
  const p9 = projMatrix[9] ?? 0;

  const xv = (depthM * (ndcX + p8)) / p0;
  const yv = (depthM * (ndcY + p9)) / p5;
  const zv = -depthM;
  return [xv, yv, zv];
}

export function fitPlaneViewSpace(
  viewPoints: readonly [number, number, number][],
  viewToWorldMatrix: ArrayLike<number>
): PlaneFitResult | null {
  const n = viewPoints.length;
  if (n < 12) return null;

  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += viewPoints[i][0];
    my += viewPoints[i][1];
    mz += viewPoints[i][2];
  }
  mx /= n;
  my /= n;
  mz /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < n; i++) {
    const dx = viewPoints[i][0] - mx;
    const dy = viewPoints[i][1] - my;
    const dz = viewPoints[i][2] - mz;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }

  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) return null;

  const alpha = (sxz * syy - syz * sxy) / det;
  const beta = (sxx * syz - sxy * sxz) / det;

  const inv = 1 / Math.hypot(alpha, beta, 1);
  const nxV = -alpha * inv;
  const nyV = -beta * inv;
  const nzV = inv; // > 0, pointing toward viewer

  let sumSq = 0;
  let maxRes = 0;
  for (let i = 0; i < n; i++) {
    const dx = viewPoints[i][0] - mx;
    const dy = viewPoints[i][1] - my;
    const dz = viewPoints[i][2] - mz;
    const res = Math.abs(nxV * dx + nyV * dy + nzV * dz);
    sumSq += res * res;
    if (res > maxRes) maxRes = res;
  }

  const residualRmsCm = Math.sqrt(sumSq / n) * 100;
  const maxResidualCm = maxRes * 100;

  // Rotate normal to world space using upper-left 3x3 of column-major viewToWorldMatrix
  const w0 = viewToWorldMatrix[0] * nxV + viewToWorldMatrix[4] * nyV + viewToWorldMatrix[8] * nzV;
  const w1 = viewToWorldMatrix[1] * nxV + viewToWorldMatrix[5] * nyV + viewToWorldMatrix[9] * nzV;
  const w2 = viewToWorldMatrix[2] * nxV + viewToWorldMatrix[6] * nyV + viewToWorldMatrix[10] * nzV;
  const wLen = Math.hypot(w0, w1, w2) || 1;
  const nxW = w0 / wLen;
  const nyW = w1 / wLen;
  const nzW = w2 / wLen;

  const grazingAngleDeg = Math.acos(Math.max(-1, Math.min(1, nzV))) * (180 / Math.PI);
  const worldTiltFromVerticalDeg = Math.asin(Math.max(0, Math.min(1, Math.abs(nyW)))) * (180 / Math.PI);

  let surfaceClass: PlaneFitResult['surfaceClass'] = 'SLOPED / OBJECT';
  if (nyW > 0.78) {
    surfaceClass = 'FLOOR (horiz ↑)';
  } else if (nyW < -0.78) {
    surfaceClass = 'CEILING (horiz ↓)';
  } else if (Math.abs(nyW) < 0.35) {
    surfaceClass = 'WALL (vertical)';
  }

  return {
    residualRmsCm: round2(residualRmsCm),
    maxResidualCm: round2(maxResidualCm),
    grazingAngleDeg: round1(grazingAngleDeg),
    worldTiltFromVerticalDeg: round1(worldTiltFromVerticalDeg),
    worldNormal: [round3(nxW), round3(nyW), round3(nzW)],
    surfaceClass
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function depthToColorRGB(depthM: number): [number, number, number] {
  // Smooth thermal/spectral ramp: 0.3m (warm orange) -> 1.8m (emerald/cyan) -> 4.5m (blue)
  const t = Math.max(0, Math.min(1, (depthM - 0.3) / 4.2));
  if (t < 0.33) {
    const k = t / 0.33;
    return [1.0 - 0.85 * k, 0.45 + 0.5 * k, 0.1 + 0.3 * k];
  }
  if (t < 0.66) {
    const k = (t - 0.33) / 0.33;
    return [0.15 - 0.15 * k, 0.95 - 0.15 * k, 0.4 + 0.6 * k];
  }
  const k = (t - 0.66) / 0.34;
  return [0.0 + 0.22 * k, 0.8 - 0.45 * k, 1.0];
}

export class SensorSpikeProbe {
  private sessionInfo: SpikeSessionInfo;
  private latestMetrics: SpikeLiveMetrics;
  private samples: CapturedSpikeSample[] = [];

  private heatmapDepths = new Float32Array(HEATMAP_COLS * HEATMAP_ROWS);
  private worldPositions = new Float32Array(MAX_WORLD_POINTS * 3);
  private worldColors = new Float32Array(MAX_WORLD_POINTS * 3);
  private worldPointCount = 0;
  private planeVisuals: DetectedPlaneVisualData[] = [];

  // Timing & rates
  private lastSampleTime = 0;
  private fpsTimestamps: number[] = [];
  private depthChangeTimestamps: number[] = [];
  private lastDepthChecksum: number | null = null;
  private centerHistory: number[] = [];
  private hasPersistedCurrentSession = false;

  // Reusable scratch objects (avoid per-frame allocations)
  private raycaster = new THREE.Raycaster();
  private ndcScratch = new THREE.Vector2();
  private camPosScratch = new THREE.Vector3();
  private camDirScratch = new THREE.Vector3();
  private viewToWorldInvScratch = new THREE.Matrix4();
  private hitViewScratch = new THREE.Vector3();
  private lastCamWorldPos: [number, number, number] = [0, 0, 0];
  private lastCamYawDeg = 0;
  private lastCamPitchDeg = 0;
  private lastDepthGrid16x12Mm: number[] = [];

  constructor() {
    this.sessionInfo = this.createEmptySessionInfo();
    this.latestMetrics = this.createEmptyMetrics();
    this.heatmapDepths.fill(OUT_OF_FOV);
  }

  private createEmptySessionInfo(): SpikeSessionInfo {
    return {
      mode: 'inactive',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      startedAt: '',
      depthPreference: 'raw-first',
      negotiationAttempt: 0,
      enabledFeatures: [],
      referenceSpaceType: 'none',
      environmentBlendMode: 'unknown',
      depthSupported: false,
      depthActive: false,
      depthUsage: 'none',
      depthDataFormat: 'none',
      depthType: 'none',
      rawValueToMeters: null,
      depthWidth: 0,
      depthHeight: 0,
      normDepthBufferFromNormViewMatrix: null,
      rawBufferAccessVerified: false
    };
  }

  private createEmptyMetrics(): SpikeLiveMetrics {
    return {
      xrFps: 0,
      depthHz: 0,
      centerDepthM: null,
      hitTestRayDistM: null,
      hitTestOpticalZM: null,
      deltaDepthMinusHitCm: null,
      worldHitDeltaCm: null,
      temporalCenterStdCm: null,
      roiValidCount: 0,
      roiValidPct: 0,
      roiMeanDepthM: null,
      roiSpreadMinMaxCm: null,
      planeFit: null,
      frameValidPct: 0,
      frameZeroOrInvalidPct: 0,
      p10DepthM: null,
      p50DepthM: null,
      p90DepthM: null,
      detectedPlanesSupported: false,
      detectedPlanesTotal: 0,
      detectedPlanesHorizontal: 0,
      detectedPlanesVertical: 0,
      detectedPlaneSummaries: [],
      detectedMeshesSupported: false,
      detectedMeshesTotal: 0
    };
  }

  public startSession(opts: {
    mode: 'immersive-ar' | 'desktop-simulator';
    session?: XRSession;
    referenceSpaceType: string;
    depthPreference: DepthPreference;
    negotiationAttempt: number;
  }): void {
    const ext = opts.session as ExtendedXRSession | undefined;
    this.sessionInfo = {
      mode: opts.mode,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      startedAt: new Date().toISOString(),
      depthPreference: opts.depthPreference,
      negotiationAttempt: opts.negotiationAttempt,
      enabledFeatures: ext?.enabledFeatures ? Array.from(ext.enabledFeatures) : [],
      referenceSpaceType: opts.referenceSpaceType,
      environmentBlendMode: opts.session?.environmentBlendMode ?? 'opaque',
      depthSupported:
        opts.mode === 'desktop-simulator' ||
        Boolean(ext?.enabledFeatures?.includes('depth-sensing')),
      depthActive: false,
      depthUsage: ext?.depthUsage ?? (opts.mode === 'desktop-simulator' ? 'simulator-raycast' : 'unavailable'),
      depthDataFormat: ext?.depthDataFormat ?? (opts.mode === 'desktop-simulator' ? 'float32' : 'unavailable'),
      depthType: ext?.depthType ?? (opts.mode === 'desktop-simulator' ? 'synthetic' : 'unavailable'),
      rawValueToMeters: opts.mode === 'desktop-simulator' ? 1 : null,
      depthWidth: 0,
      depthHeight: 0,
      normDepthBufferFromNormViewMatrix: null,
      rawBufferAccessVerified: opts.mode === 'desktop-simulator'
    };

    this.latestMetrics = this.createEmptyMetrics();
    this.heatmapDepths.fill(OUT_OF_FOV);
    this.worldPointCount = 0;
    this.planeVisuals = [];
    this.lastSampleTime = 0;
    this.fpsTimestamps = [];
    this.depthChangeTimestamps = [];
    this.lastDepthChecksum = null;
    this.centerHistory = [];
    this.lastDepthGrid16x12Mm = [];
    this.hasPersistedCurrentSession = false;

    // Load previously saved samples if user hasn't cleared them
    const existing = SensorSpikeProbe.loadSavedReport();
    if (existing && Array.isArray(existing.samples) && existing.samples.length > 0) {
      this.samples = existing.samples;
    } else {
      this.samples = [];
    }
  }

  public getSessionInfo(): SpikeSessionInfo {
    return this.sessionInfo;
  }

  public getLatestMetrics(): SpikeLiveMetrics {
    return this.latestMetrics;
  }

  public getHeatmapDepths(): Float32Array {
    return this.heatmapDepths;
  }

  public getWorldPointCloud(): {
    positions: Float32Array;
    colors: Float32Array;
    count: number;
  } {
    return {
      positions: this.worldPositions,
      colors: this.worldColors,
      count: this.worldPointCount
    };
  }

  public getPlaneVisuals(): DetectedPlaneVisualData[] {
    return this.planeVisuals;
  }

  public getSamples(): CapturedSpikeSample[] {
    return this.samples;
  }

  public getSampleCountByTag(tag: SpikeSampleTag): number {
    let count = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].tag === tag) count++;
    }
    return count;
  }

  public captureSample(tag: SpikeSampleTag, label: string): CapturedSpikeSample {
    const m = this.latestMetrics;
    const sample: CapturedSpikeSample = {
      id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tag,
      label,
      capturedAt: new Date().toISOString(),
      cameraWorldPos: [
        round3(this.lastCamWorldPos[0]),
        round3(this.lastCamWorldPos[1]),
        round3(this.lastCamWorldPos[2])
      ],
      cameraYawDeg: round1(this.lastCamYawDeg),
      cameraPitchDeg: round1(this.lastCamPitchDeg),
      metrics: {
        centerDepthM: m.centerDepthM,
        hitTestRayDistM: m.hitTestRayDistM,
        hitTestOpticalZM: m.hitTestOpticalZM,
        deltaDepthMinusHitCm: m.deltaDepthMinusHitCm,
        worldHitDeltaCm: m.worldHitDeltaCm,
        temporalCenterStdCm: m.temporalCenterStdCm,
        roiValidCount: m.roiValidCount,
        roiValidPct: m.roiValidPct,
        roiMeanDepthM: m.roiMeanDepthM,
        roiSpreadMinMaxCm: m.roiSpreadMinMaxCm,
        planeFit: m.planeFit,
        frameValidPct: m.frameValidPct,
        frameZeroOrInvalidPct: m.frameZeroOrInvalidPct,
        p10DepthM: m.p10DepthM,
        p50DepthM: m.p50DepthM,
        p90DepthM: m.p90DepthM,
        depthHz: m.depthHz,
        xrFps: m.xrFps,
        detectedPlanesTotal: m.detectedPlanesTotal
      },
      depthGrid16x12Mm: this.lastDepthGrid16x12Mm.slice()
    };

    this.samples.push(sample);
    this.persistReport();
    return sample;
  }

  public clearSamples(): void {
    this.samples = [];
    SensorSpikeProbe.clearSavedReport();
  }

  public buildReportExport(): SpikeReportExport {
    return {
      appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
      exportedAt: new Date().toISOString(),
      session: { ...this.sessionInfo },
      latestMetrics: { ...this.latestMetrics },
      sampleCount: this.samples.length,
      samples: this.samples
    };
  }

  public persistReport(): void {
    try {
      const report = this.buildReportExport();
      localStorage.setItem(STORAGE_KEY_SPIKE_REPORT, JSON.stringify(report));
      this.hasPersistedCurrentSession = true;
    } catch {
      // Ignore storage quota issues
    }
  }

  public static loadSavedReport(): SpikeReportExport | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SPIKE_REPORT);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SpikeReportExport;
      if (!parsed || typeof parsed !== 'object' || !parsed.session) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public static clearSavedReport(): void {
    try {
      localStorage.removeItem(STORAGE_KEY_SPIKE_REPORT);
    } catch {
      // Ignore
    }
  }

  private recordFpsFrame(now: number): number {
    this.fpsTimestamps.push(now);
    while (this.fpsTimestamps.length > 0 && now - this.fpsTimestamps[0] > 1500) {
      this.fpsTimestamps.shift();
    }
    if (this.fpsTimestamps.length < 2) return 0;
    const spanSec = (this.fpsTimestamps[this.fpsTimestamps.length - 1] - this.fpsTimestamps[0]) / 1000;
    if (spanSec <= 0.05) return 0;
    return round1((this.fpsTimestamps.length - 1) / spanSec);
  }

  private recordDepthChecksum(now: number, checksum: number): number {
    if (this.lastDepthChecksum === null || Math.abs(checksum - this.lastDepthChecksum) > 1e-4) {
      this.lastDepthChecksum = checksum;
      this.depthChangeTimestamps.push(now);
    }
    while (this.depthChangeTimestamps.length > 0 && now - this.depthChangeTimestamps[0] > 2000) {
      this.depthChangeTimestamps.shift();
    }
    if (this.depthChangeTimestamps.length < 2) return this.depthChangeTimestamps.length;
    const spanSec =
      (this.depthChangeTimestamps[this.depthChangeTimestamps.length - 1] -
        this.depthChangeTimestamps[0]) /
      1000;
    if (spanSec <= 0.05) return 0;
    return round1((this.depthChangeTimestamps.length - 1) / spanSec);
  }

  private updateCenterHistory(centerDepthM: number | null): number | null {
    if (centerDepthM === null || centerDepthM <= 0.05) {
      return null;
    }
    if (this.centerHistory.length > 0) {
      const prev = this.centerHistory[this.centerHistory.length - 1];
      if (Math.abs(centerDepthM - prev) > 0.25) {
        // User moved aim onto a different surface
        this.centerHistory = [];
      }
    }
    this.centerHistory.push(centerDepthM);
    if (this.centerHistory.length > 20) {
      this.centerHistory.shift();
    }
    if (this.centerHistory.length < 4) return null;

    let mean = 0;
    for (let i = 0; i < this.centerHistory.length; i++) {
      mean += this.centerHistory[i];
    }
    mean /= this.centerHistory.length;
    let varSum = 0;
    for (let i = 0; i < this.centerHistory.length; i++) {
      const diff = this.centerHistory[i] - mean;
      varSum += diff * diff;
    }
    return round2(Math.sqrt(varSum / this.centerHistory.length) * 100);
  }

  private updateCameraPoseStats(pos: THREE.Vector3, forward: THREE.Vector3): void {
    this.lastCamWorldPos = [pos.x, pos.y, pos.z];
    this.lastCamYawDeg = Math.atan2(forward.x, -forward.z) * (180 / Math.PI);
    const horizLen = Math.hypot(forward.x, forward.z) || 1e-6;
    this.lastCamPitchDeg = Math.atan2(forward.y, horizLen) * (180 / Math.PI);
  }

  /**
   * Samples a live WebXR AR frame (throttled to ~10 Hz for depth/planes, every frame for FPS).
   * Returns true if telemetry was refreshed on this frame.
   */
  public sampleARFrame(input: ARFrameSampleInput): boolean {
    const now = performance.now();
    const xrFps = this.recordFpsFrame(now);
    this.latestMetrics.xrFps = xrFps;

    if (now - this.lastSampleTime < SAMPLE_INTERVAL_MS) {
      return false;
    }
    this.lastSampleTime = now;

    this.updateCameraPoseStats(input.cameraWorldPos, input.cameraForward);

    const extFrame = input.frame as ExtendedXRFrame;
    const extSession = input.frame.session as ExtendedXRSession;
    const viewerPose = input.frame.getViewerPose(input.refSpace);

    // 1. Detected Planes & Meshes audit
    this.inspectPlanesAndMeshes(extFrame, input.refSpace);

    if (!viewerPose || viewerPose.views.length === 0) {
      return true;
    }

    const view = viewerPose.views[0];
    const projMatrix = view.projectionMatrix;
    const viewToWorld = view.transform.matrix;

    // 2. Hit-test comparison
    let hitTestRayDistM: number | null = null;
    let hitTestOpticalZM: number | null = null;
    if (input.hitWorldPos) {
      hitTestRayDistM = round3(input.hitWorldPos.distanceTo(input.cameraWorldPos));
      this.viewToWorldInvScratch.fromArray(viewToWorld).invert();
      this.hitViewScratch.copy(input.hitWorldPos).applyMatrix4(this.viewToWorldInvScratch);
      hitTestOpticalZM = round3(-this.hitViewScratch.z);
    }
    this.latestMetrics.hitTestRayDistM = hitTestRayDistM;
    this.latestMetrics.hitTestOpticalZM = hitTestOpticalZM;

    // 3. Depth sensing probe
    if (typeof extFrame.getDepthInformation !== 'function') {
      this.sessionInfo.depthSupported = false;
      this.sessionInfo.depthActive = false;
      this.latestMetrics.centerDepthM = null;
      return true;
    }

    let depthInfo: XRCPUDepthInformation | null | undefined = null;
    try {
      depthInfo = extFrame.getDepthInformation(view);
    } catch {
      depthInfo = null;
    }

    if (!depthInfo) {
      this.sessionInfo.depthActive = false;
      this.latestMetrics.centerDepthM = null;
      return true;
    }

    this.sessionInfo.depthSupported = true;
    this.sessionInfo.depthActive = true;
    this.sessionInfo.depthUsage = extSession.depthUsage ?? this.sessionInfo.depthUsage;
    this.sessionInfo.depthDataFormat = extSession.depthDataFormat ?? this.sessionInfo.depthDataFormat;
    this.sessionInfo.depthType = extSession.depthType ?? this.sessionInfo.depthType;
    this.sessionInfo.rawValueToMeters = depthInfo.rawValueToMeters;
    this.sessionInfo.depthWidth = depthInfo.width;
    this.sessionInfo.depthHeight = depthInfo.height;
    this.sessionInfo.normDepthBufferFromNormViewMatrix = Array.from(
      depthInfo.normDepthBufferFromNormView.matrix
    ).map((v) => round3(v));

    const reader = this.createDepthReader(depthInfo);

    // Checksum across 12 evenly spaced points to measure real depth refresh Hz
    let checksum = 0;
    for (let i = 1; i <= 12; i++) {
      const d = reader(0.15 + (i % 4) * 0.22, 0.2 + Math.floor(i / 4) * 0.25);
      if (d > 0) checksum += d * (i + 1);
    }
    this.latestMetrics.depthHz = this.recordDepthChecksum(now, checksum);

    const centerRaw = reader(0.5, 0.5);
    const centerDepthM = centerRaw > 0.05 ? round3(centerRaw) : null;
    this.latestMetrics.centerDepthM = centerDepthM;
    this.latestMetrics.temporalCenterStdCm = this.updateCenterHistory(centerDepthM);

    if (centerDepthM !== null && hitTestOpticalZM !== null && hitTestOpticalZM > 0.05) {
      this.latestMetrics.deltaDepthMinusHitCm = round2((centerDepthM - hitTestOpticalZM) * 100);
    } else {
      this.latestMetrics.deltaDepthMinusHitCm = null;
    }

    if (centerDepthM !== null && input.hitWorldPos) {
      const [xv, yv, zv] = unprojectViewPoint(0.5, 0.5, centerDepthM, projMatrix);
      const xw = viewToWorld[0] * xv + viewToWorld[4] * yv + viewToWorld[8] * zv + viewToWorld[12];
      const yw = viewToWorld[1] * xv + viewToWorld[5] * yv + viewToWorld[9] * zv + viewToWorld[13];
      const zw = viewToWorld[2] * xv + viewToWorld[6] * yv + viewToWorld[10] * zv + viewToWorld[14];
      const d3d = Math.hypot(
        xw - input.hitWorldPos.x,
        yw - input.hitWorldPos.y,
        zw - input.hitWorldPos.z
      );
      this.latestMetrics.worldHitDeltaCm = round2(d3d * 100);
    } else {
      this.latestMetrics.worldHitDeltaCm = null;
    }

    this.computeRoiAndFrameStats(reader, projMatrix, viewToWorld);

    if (!this.hasPersistedCurrentSession) {
      this.persistReport();
    }
    return true;
  }

  /**
   * Samples synthetic depth in Desktop Simulator against the virtual kitchen meshes.
   */
  public sampleSimulatorFrame(input: SimulatorFrameSampleInput): boolean {
    const now = performance.now();
    this.latestMetrics.xrFps = this.recordFpsFrame(now);

    if (now - this.lastSampleTime < SAMPLE_INTERVAL_MS) {
      return false;
    }
    this.lastSampleTime = now;

    input.camera.updateMatrixWorld();
    input.camera.getWorldPosition(this.camPosScratch);
    input.camera.getWorldDirection(this.camDirScratch);
    this.updateCameraPoseStats(this.camPosScratch, this.camDirScratch);

    const projMatrix = input.camera.projectionMatrix.elements;
    const viewToWorld = input.camera.matrixWorld.elements;

    let hitTestRayDistM: number | null = null;
    let hitTestOpticalZM: number | null = null;
    if (input.hitWorldPos) {
      hitTestRayDistM = round3(input.hitWorldPos.distanceTo(this.camPosScratch));
      this.viewToWorldInvScratch.copy(input.camera.matrixWorld).invert();
      this.hitViewScratch.copy(input.hitWorldPos).applyMatrix4(this.viewToWorldInvScratch);
      hitTestOpticalZM = round3(-this.hitViewScratch.z);
    }
    this.latestMetrics.hitTestRayDistM = hitTestRayDistM;
    this.latestMetrics.hitTestOpticalZM = hitTestOpticalZM;

    this.sessionInfo.depthSupported = true;
    this.sessionInfo.depthActive = true;
    this.sessionInfo.depthWidth = 160;
    this.sessionInfo.depthHeight = 120;
    this.sessionInfo.rawBufferAccessVerified = true;

    const raycastNormalized = (u: number, v: number): number => {
      this.ndcScratch.set(2 * u - 1, 1 - 2 * v);
      this.raycaster.setFromCamera(this.ndcScratch, input.camera);
      const hits = this.raycaster.intersectObjects(input.meshes, false);
      if (hits.length === 0) return 0;
      const first = hits[0];
      if (first.object.userData?.isWindowGlass) {
        return 0; // Simulate glass depth hole
      }
      // Convert ray distance to optical Z depth along camera forward (-Z view)
      const camForwardDot = first.point
        .clone()
        .sub(this.camPosScratch)
        .dot(this.camDirScratch);
      if (camForwardDot <= 0.1 || camForwardDot > 8.0) return 0;
      // Add subtle realistic sensor noise (~0.4cm * dist) so plane-fit metrics look realistic
      const noise = (Math.sin(u * 197.3 + v * 311.7 + now * 0.01) * 0.004) * camForwardDot;
      return Math.max(0.1, camForwardDot + noise);
    };

    this.latestMetrics.depthHz = this.recordDepthChecksum(now, now);

    const centerRaw = raycastNormalized(0.5, 0.5);
    const centerDepthM = centerRaw > 0.05 ? round3(centerRaw) : null;
    this.latestMetrics.centerDepthM = centerDepthM;
    this.latestMetrics.temporalCenterStdCm = this.updateCenterHistory(centerDepthM);

    if (centerDepthM !== null && hitTestOpticalZM !== null && hitTestOpticalZM > 0.05) {
      this.latestMetrics.deltaDepthMinusHitCm = round2((centerDepthM - hitTestOpticalZM) * 100);
    } else {
      this.latestMetrics.deltaDepthMinusHitCm = null;
    }

    if (centerDepthM !== null && input.hitWorldPos) {
      const [xv, yv, zv] = unprojectViewPoint(0.5, 0.5, centerDepthM, projMatrix);
      const xw = viewToWorld[0] * xv + viewToWorld[4] * yv + viewToWorld[8] * zv + viewToWorld[12];
      const yw = viewToWorld[1] * xv + viewToWorld[5] * yv + viewToWorld[9] * zv + viewToWorld[13];
      const zw = viewToWorld[2] * xv + viewToWorld[6] * yv + viewToWorld[10] * zv + viewToWorld[14];
      this.latestMetrics.worldHitDeltaCm = round2(
        Math.hypot(xw - input.hitWorldPos.x, yw - input.hitWorldPos.y, zw - input.hitWorldPos.z) * 100
      );
    } else {
      this.latestMetrics.worldHitDeltaCm = null;
    }

    // Simulator: sample 32x24 and fill 2x2 blocks in 64x48 heatmap to keep raycast < 1ms
    this.computeRoiAndFrameStats(raycastNormalized, projMatrix, viewToWorld, true);
    if (!this.hasPersistedCurrentSession) {
      this.persistReport();
    }
    return true;
  }

  private createDepthReader(depthInfo: XRCPUDepthInformation): (u: number, v: number) => number {
    const w = depthInfo.width;
    const h = depthInfo.height;
    const scale = depthInfo.rawValueToMeters;
    const mat = depthInfo.normDepthBufferFromNormView.matrix;
    const byteLen = depthInfo.data.byteLength;

    let typedView: Float32Array | Uint16Array | null = null;
    if (byteLen === w * h * 4) {
      typedView = new Float32Array(depthInfo.data);
    } else if (byteLen === w * h * 2) {
      typedView = new Uint16Array(depthInfo.data);
    }

    let useRawBuffer = false;
    if (typedView) {
      const du0 = mat[0] * 0.5 + mat[4] * 0.5 + mat[12];
      const dv0 = mat[1] * 0.5 + mat[5] * 0.5 + mat[13];
      if (du0 >= 0 && du0 < 1 && dv0 >= 0 && dv0 < 1) {
        const col0 = Math.min(w - 1, Math.max(0, Math.floor(du0 * w)));
        const row0 = Math.min(h - 1, Math.max(0, Math.floor(dv0 * h)));
        const rawCenter = typedView[row0 * w + col0] * scale;
        try {
          const apiCenter = depthInfo.getDepthInMeters(0.5, 0.5);
          if (
            (rawCenter === 0 && apiCenter === 0) ||
            (Number.isFinite(rawCenter) &&
              Number.isFinite(apiCenter) &&
              Math.abs(rawCenter - apiCenter) <= 0.02)
          ) {
            useRawBuffer = true;
          }
        } catch {
          useRawBuffer = false;
        }
      }
    }
    this.sessionInfo.rawBufferAccessVerified = useRawBuffer;

    return (u: number, v: number): number => {
      const du = mat[0] * u + mat[4] * v + mat[12];
      const dv = mat[1] * u + mat[5] * v + mat[13];
      if (du < 0 || du >= 1 || dv < 0 || dv >= 1) {
        return OUT_OF_FOV;
      }
      if (useRawBuffer && typedView) {
        const col = Math.min(w - 1, Math.max(0, Math.floor(du * w)));
        const row = Math.min(h - 1, Math.max(0, Math.floor(dv * h)));
        const val = typedView[row * w + col] * scale;
        return Number.isFinite(val) ? val : 0;
      }
      try {
        const val = depthInfo.getDepthInMeters(u, v);
        return Number.isFinite(val) ? val : 0;
      } catch {
        return 0;
      }
    };
  }

  private computeRoiAndFrameStats(
    reader: (u: number, v: number) => number,
    projMatrix: ArrayLike<number>,
    viewToWorld: ArrayLike<number>,
    coarseSimHeatmap = false
  ): void {
    // 1. Center ROI 9x9
    const roiViewPts: [number, number, number][] = [];
    let roiSum = 0;
    let roiMin = Infinity;
    let roiMax = -Infinity;

    for (let ry = 0; ry < ROI_GRID; ry++) {
      const v = ROI_MIN + (ry / (ROI_GRID - 1)) * (ROI_MAX - ROI_MIN);
      for (let rx = 0; rx < ROI_GRID; rx++) {
        const u = ROI_MIN + (rx / (ROI_GRID - 1)) * (ROI_MAX - ROI_MIN);
        const d = reader(u, v);
        if (d > 0.08 && d <= 8.0) {
          roiViewPts.push(unprojectViewPoint(u, v, d, projMatrix));
          roiSum += d;
          if (d < roiMin) roiMin = d;
          if (d > roiMax) roiMax = d;
        }
      }
    }

    const roiCount = roiViewPts.length;
    this.latestMetrics.roiValidCount = roiCount;
    this.latestMetrics.roiValidPct = round1((roiCount / (ROI_GRID * ROI_GRID)) * 100);
    this.latestMetrics.roiMeanDepthM = roiCount > 0 ? round3(roiSum / roiCount) : null;
    this.latestMetrics.roiSpreadMinMaxCm =
      roiCount >= 2 ? round2((roiMax - roiMin) * 100) : null;
    this.latestMetrics.planeFit = fitPlaneViewSpace(roiViewPts, viewToWorld);

    // 2. Heatmap (64x48) + frame percentiles
    const validDepths: number[] = [];
    let inFovTotal = 0;
    let zeroOrInvalid = 0;

    if (coarseSimHeatmap) {
      for (let r = 0; r < HEATMAP_ROWS; r += 2) {
        const v = (r + 1) / HEATMAP_ROWS;
        for (let c = 0; c < HEATMAP_COLS; c += 2) {
          const u = (c + 1) / HEATMAP_COLS;
          const d = reader(u, v);
          this.heatmapDepths[r * HEATMAP_COLS + c] = d;
          this.heatmapDepths[r * HEATMAP_COLS + c + 1] = d;
          this.heatmapDepths[(r + 1) * HEATMAP_COLS + c] = d;
          this.heatmapDepths[(r + 1) * HEATMAP_COLS + c + 1] = d;
          if (d !== OUT_OF_FOV) {
            inFovTotal++;
            if (d >= 0.1 && d <= 8.0) {
              validDepths.push(d);
            } else {
              zeroOrInvalid++;
            }
          }
        }
      }
    } else {
      for (let r = 0; r < HEATMAP_ROWS; r++) {
        const v = (r + 0.5) / HEATMAP_ROWS;
        for (let c = 0; c < HEATMAP_COLS; c++) {
          const u = (c + 0.5) / HEATMAP_COLS;
          const d = reader(u, v);
          this.heatmapDepths[r * HEATMAP_COLS + c] = d;
          if (d !== OUT_OF_FOV) {
            inFovTotal++;
            if (d >= 0.1 && d <= 8.0) {
              validDepths.push(d);
            } else {
              zeroOrInvalid++;
            }
          }
        }
      }
    }

    if (inFovTotal > 0) {
      this.latestMetrics.frameValidPct = round1((validDepths.length / inFovTotal) * 100);
      this.latestMetrics.frameZeroOrInvalidPct = round1((zeroOrInvalid / inFovTotal) * 100);
    } else {
      this.latestMetrics.frameValidPct = 0;
      this.latestMetrics.frameZeroOrInvalidPct = 0;
    }

    if (validDepths.length > 0) {
      validDepths.sort((a, b) => a - b);
      const len = validDepths.length;
      this.latestMetrics.p10DepthM = round2(validDepths[Math.floor(len * 0.1)]);
      this.latestMetrics.p50DepthM = round2(validDepths[Math.floor(len * 0.5)]);
      this.latestMetrics.p90DepthM = round2(validDepths[Math.min(len - 1, Math.floor(len * 0.9))]);
    } else {
      this.latestMetrics.p10DepthM = null;
      this.latestMetrics.p50DepthM = null;
      this.latestMetrics.p90DepthM = null;
    }

    // 3. Compact 16x12 grid in mm for JSON export snapshot
    const grid16x12: number[] = [];
    for (let r = 0; r < 12; r++) {
      const hr = Math.min(HEATMAP_ROWS - 1, Math.floor(((r + 0.5) / 12) * HEATMAP_ROWS));
      for (let c = 0; c < 16; c++) {
        const hc = Math.min(HEATMAP_COLS - 1, Math.floor(((c + 0.5) / 16) * HEATMAP_COLS));
        const d = this.heatmapDepths[hr * HEATMAP_COLS + hc];
        grid16x12.push(d > 0.05 && d <= 8.0 ? Math.round(d * 1000) : 0);
      }
    }
    this.lastDepthGrid16x12Mm = grid16x12;

    // 4. 24x18 world-space point cloud for live 3D inspection
    let ptCount = 0;
    for (let r = 0; r < WORLD_CLOUD_ROWS; r++) {
      const hr = Math.min(
        HEATMAP_ROWS - 1,
        Math.floor(((r + 0.5) / WORLD_CLOUD_ROWS) * HEATMAP_ROWS)
      );
      const v = (hr + 0.5) / HEATMAP_ROWS;
      for (let c = 0; c < WORLD_CLOUD_COLS; c++) {
        const hc = Math.min(
          HEATMAP_COLS - 1,
          Math.floor(((c + 0.5) / WORLD_CLOUD_COLS) * HEATMAP_COLS)
        );
        const d = this.heatmapDepths[hr * HEATMAP_COLS + hc];
        if (d < 0.15 || d > 5.5) continue;

        const u = (hc + 0.5) / HEATMAP_COLS;
        const [xv, yv, zv] = unprojectViewPoint(u, v, d, projMatrix);
        const xw = viewToWorld[0] * xv + viewToWorld[4] * yv + viewToWorld[8] * zv + viewToWorld[12];
        const yw = viewToWorld[1] * xv + viewToWorld[5] * yv + viewToWorld[9] * zv + viewToWorld[13];
        const zw = viewToWorld[2] * xv + viewToWorld[6] * yv + viewToWorld[10] * zv + viewToWorld[14];

        const base = ptCount * 3;
        this.worldPositions[base] = xw;
        this.worldPositions[base + 1] = yw;
        this.worldPositions[base + 2] = zw;

        const [cr, cg, cb] = depthToColorRGB(d);
        this.worldColors[base] = cr;
        this.worldColors[base + 1] = cg;
        this.worldColors[base + 2] = cb;
        ptCount++;
      }
    }
    this.worldPointCount = ptCount;
  }

  private inspectPlanesAndMeshes(frame: ExtendedXRFrame, refSpace: XRReferenceSpace): void {
    const planes = frame.detectedPlanes;
    if (planes && typeof planes.size === 'number') {
      this.latestMetrics.detectedPlanesSupported = true;
      this.latestMetrics.detectedPlanesTotal = planes.size;
      let horiz = 0;
      let vert = 0;
      const summaries: DetectedPlaneSummary[] = [];
      const visuals: DetectedPlaneVisualData[] = [];

      planes.forEach((plane) => {
        const orient =
          plane.orientation === 'horizontal' || plane.orientation === 'vertical'
            ? plane.orientation
            : 'unknown';
        if (orient === 'horizontal') horiz++;
        else if (orient === 'vertical') vert++;

        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (!pose || !plane.polygon || plane.polygon.length === 0) return;

        const mat = pose.transform.matrix;
        const worldVerts = new Float32Array(plane.polygon.length * 3);
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let sumY = 0;

        for (let i = 0; i < plane.polygon.length; i++) {
          const lp = plane.polygon[i];
          if (lp.x < minX) minX = lp.x;
          if (lp.x > maxX) maxX = lp.x;
          if (lp.z < minZ) minZ = lp.z;
          if (lp.z > maxZ) maxZ = lp.z;

          const wx = mat[0] * lp.x + mat[4] * lp.y + mat[8] * lp.z + mat[12];
          const wy = mat[1] * lp.x + mat[5] * lp.y + mat[9] * lp.z + mat[13];
          const wz = mat[2] * lp.x + mat[6] * lp.y + mat[10] * lp.z + mat[14];
          worldVerts[i * 3] = wx;
          worldVerts[i * 3 + 1] = wy;
          worldVerts[i * 3 + 2] = wz;
          sumY += wy;
        }

        summaries.push({
          orientation: orient,
          vertices: plane.polygon.length,
          spanWidthM: round2(maxX - minX),
          spanDepthM: round2(maxZ - minZ),
          centerY: round2(sumY / plane.polygon.length),
          semanticLabel: plane.semanticLabel
        });

        visuals.push({
          orientation: orient,
          worldVertices: worldVerts
        });
      });

      this.latestMetrics.detectedPlanesHorizontal = horiz;
      this.latestMetrics.detectedPlanesVertical = vert;
      this.latestMetrics.detectedPlaneSummaries = summaries;
      this.planeVisuals = visuals;
    } else {
      this.latestMetrics.detectedPlanesSupported = Boolean(
        this.sessionInfo.enabledFeatures.includes('plane-detection')
      );
      this.latestMetrics.detectedPlanesTotal = 0;
      this.latestMetrics.detectedPlanesHorizontal = 0;
      this.latestMetrics.detectedPlanesVertical = 0;
      this.latestMetrics.detectedPlaneSummaries = [];
      this.planeVisuals = [];
    }

    const meshes = frame.detectedMeshes;
    if (meshes && typeof meshes.size === 'number') {
      this.latestMetrics.detectedMeshesSupported = true;
      this.latestMetrics.detectedMeshesTotal = meshes.size;
    } else {
      this.latestMetrics.detectedMeshesSupported = Boolean(
        this.sessionInfo.enabledFeatures.includes('mesh-detection')
      );
      this.latestMetrics.detectedMeshesTotal = 0;
    }
  }
}
