export type WallConfidenceLevel = 'low' | 'medium' | 'good';

export interface WallOpening {
  id: string;
  type: 'door' | 'window';
  label: string;
  widthMeters: number;
  heightMeters: number;
  wallIndex?: number;
  offsetAlongWallMeters?: number;
  sillHeightMeters?: number;
  source?: 'manual' | 'auto';
  confidence?: number;
}

export interface FurnitureBox {
  id: string;
  label: string;
  centerXZ: [number, number];
  widthMeters: number;
  depthMeters: number;
  heightMeters: number;
  floorY: number;
  yawRad: number;
  source: 'auto' | 'manual';
  confidence?: number;
}

export interface DetectedWallSegment {
  index: number;
  p1: [number, number];
  p2: [number, number];
  normal: [number, number];
  lengthM: number;
  sigmaCm: number;
  passCount: number;
  coveragePct: number;
  confidence: WallConfidenceLevel;
}

export interface ShellEstimate {
  valid: boolean;
  floorY: number;
  floorConfidence: number;
  ceilingY: number | null;
  ceilingConfidence: number;
  provisionalCeilingY: number;
  yawRad: number;
  cornersXZ: [number, number][];
  walls: DetectedWallSegment[];
  floorAreaSqM: number;
  perimeterM: number;
}

export interface ScanStats {
  voxelCount: number;
  wallVoxelCount: number;
  frameCount: number;
  distinctViewpoints: number;
  readinessPct: number;
  guidanceHint: string;
}

export interface SerializedPlaneInput {
  orientation: 'horizontal' | 'vertical' | 'unknown';
  worldVertices: Float32Array;
  areaSqM: number;
  centerY: number;
  normalXZ?: [number, number];
}

export interface DepthFramePayload {
  depthBuffer: ArrayBuffer;
  width: number;
  height: number;
  rawValueToMeters: number;
  isFloat32: boolean;
  normDepthFromNormView: Float32Array;
  projMatrix: Float32Array;
  viewToWorld: Float32Array;
  cameraPos: [number, number, number];
  cameraForward: [number, number, number];
  planes: SerializedPlaneInput[];
}

export type SurfaceTextureMode = 'stretch' | 'tile';

export interface SurfaceTextureEntry {
  surfaceKey: string; // 'floor' | 'ceiling' | 'wall:0' | ... | 'furniture:<id>'
  dataUrl: string;
  mode: SurfaceTextureMode;
  tileSizeMeters: number;
}

export type WorkerInMessage =
  | { type: 'INGEST_FRAME'; scanId: number; payload: DepthFramePayload }
  | { type: 'RESET'; scanId: number };

export type WorkerOutMessage = {
  type: 'SCAN_UPDATE';
  scanId: number;
  shell: ShellEstimate;
  stats: ScanStats;
  furniture: FurnitureBox[];
  openings: WallOpening[];
  previewPositions: Float32Array;
  previewColors: Float32Array;
  previewCount: number;
  cameraPathXZ: Float32Array;
};
