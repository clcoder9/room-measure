export type WallConfidenceLevel = 'low' | 'medium' | 'good';

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

export type WorkerInMessage =
  | { type: 'INGEST_FRAME'; payload: DepthFramePayload }
  | { type: 'RESET' };

export type WorkerOutMessage = {
  type: 'SCAN_UPDATE';
  shell: ShellEstimate;
  stats: ScanStats;
  previewPositions: Float32Array;
  previewColors: Float32Array;
  previewCount: number;
  cameraPathXZ: Float32Array;
};
