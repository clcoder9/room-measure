import * as THREE from 'three';
import type { FurnitureBox, SurfaceTextureEntry, WallOpening } from '../scan/ScanTypes';
import {
  UnitSystem,
  calculateHorizontalDistance,
  calculateShoelaceArea,
  calculatePerimeter,
  calculateCeilingHeight,
  calculateVolume,
  calculateAverageFloorHeight,
  calculateInteriorAngleDeg,
  snapToOrthogonal,
  formatDistance,
  formatArea,
  formatVolume
} from './math';
import { MeasurementVisuals } from './MeasurementVisuals';

export type { FurnitureBox, SurfaceTextureEntry, SurfaceTextureMode, WallOpening } from '../scan/ScanTypes';

export type MeasurementState =
  | 'SCAN_FLOOR'
  | 'MEASURING_FLOOR'
  | 'FLOOR_CLOSED'
  | 'MEASURING_CEILING'
  | 'COMPLETED';

export interface OpeningWallHit {
  wallIndex: number;
  alongM: number;
  heightM: number;
  worldPos: THREE.Vector3;
}

export interface OpeningMarkState {
  active: boolean;
  type: 'door' | 'window';
  firstHit: OpeningWallHit | null;
  liveHit: OpeningWallHit | null;
}

export interface LiveSnapState {
  isSnappedToStart: boolean;
  isOrthoSnapped: boolean;
  liveAngleDeg: number | null;
  effectiveReticlePos: THREE.Vector3 | null;
}

export interface RoomMetrics {
  state: MeasurementState;
  unitSystem: UnitSystem;
  pointCount: number;
  currentSegmentLength: number;
  floorArea: number; // m²
  furnitureFootprintArea: number; // m²
  freeFloorArea: number; // m²
  furnitureCount: number;
  perimeter: number; // m
  ceilingHeight: number; // m
  volume: number; // m³
  grossWallArea: number; // m²
  openingsArea: number; // m²
  openingsCount: number;
  netWallArea: number; // m²
  isSnappedToStart: boolean;
  isOrthoSnapped: boolean;
  liveAngleDeg: number | null;
}

export interface RoomExportData {
  appName: string;
  timestamp: string;
  unitSystem: UnitSystem;
  metrics: {
    floorAreaSqMeters: number;
    furnitureFootprintSqMeters: number;
    freeFloorAreaSqMeters: number;
    floorPerimeterMeters: number;
    ceilingHeightMeters: number;
    roomVolumeCuMeters: number;
    grossWallAreaSqMeters: number;
    openingsAreaSqMeters: number;
    netWallAreaSqMeters: number;
    formatted: {
      floorArea: string;
      furnitureFootprintArea: string;
      freeFloorArea: string;
      floorPerimeter: string;
      ceilingHeight: string;
      roomVolume: string;
      grossWallArea: string;
      netWallArea: string;
    };
  };
  floorCoordinates: { index: number; x: number; y: number; z: number }[];
  ceilingCoordinate: { x: number; y: number; z: number } | null;
  openings: WallOpening[];
  furniture: FurnitureBox[];
  surfaceTextures?: SurfaceTextureEntry[];
}

export interface SavedRoomRecord {
  id: string;
  name: string;
  timestamp: string;
  floorCoordinates: { x: number; y: number; z: number }[];
  ceilingCoordinate: { x: number; y: number; z: number } | null;
  openings: WallOpening[];
  furniture?: FurnitureBox[];
  metrics: {
    floorAreaSqMeters: number;
    freeFloorAreaSqMeters?: number;
    floorPerimeterMeters: number;
    ceilingHeightMeters: number;
    roomVolumeCuMeters: number;
    netWallAreaSqMeters: number;
  };
}

const STORAGE_KEY_UNIT = 'spatialmeasure_unit';
const STORAGE_KEY_ROOMS = 'spatialmeasure_saved_rooms';
const MIN_CEILING_HEIGHT_METERS = 0.4;
const START_SNAP_RADIUS_METERS = 0.22;

export class RoomManager {
  private state: MeasurementState = 'SCAN_FLOOR';
  private floorPoints: THREE.Vector3[] = [];
  private ceilingPoint: THREE.Vector3 | null = null;
  private isFloorClosed: boolean = false;
  private openings: WallOpening[] = [];
  private furniture: FurnitureBox[] = [];
  private surfaceTextures = new Map<string, SurfaceTextureEntry>();
  private cachedFurnitureFootprintArea = 0;
  private furnitureFootprintDirty = true;
  private openingMarkState: OpeningMarkState = {
    active: false,
    type: 'door',
    firstHit: null,
    liveHit: null
  };
  private unitSystem: UnitSystem = 'metric';
  private orthoSnapEnabled: boolean = true;
  private liveSnapState: LiveSnapState = {
    isSnappedToStart: false,
    isOrthoSnapped: false,
    liveAngleDeg: null,
    effectiveReticlePos: null
  };
  private lastLiveDistance: number = 0;

  private visuals: MeasurementVisuals;
  private onStateChangeCallback?: (metrics: RoomMetrics) => void;
  private onValidationErrorCallback?: (msg: string) => void;

  constructor(visuals: MeasurementVisuals) {
    this.visuals = visuals;
    try {
      const savedUnit = localStorage.getItem(STORAGE_KEY_UNIT);
      if (savedUnit === 'imperial' || savedUnit === 'metric') {
        this.unitSystem = savedUnit;
      }
    } catch {
      // Ignore storage failures
    }
  }

  public setOnStateChange(cb: (metrics: RoomMetrics) => void): void {
    this.onStateChangeCallback = cb;
  }

  public setOnValidationError(cb: (msg: string) => void): void {
    this.onValidationErrorCallback = cb;
  }

  public getState(): MeasurementState {
    return this.state;
  }

  public getUnitSystem(): UnitSystem {
    return this.unitSystem;
  }

  public setUnitSystem(unit: UnitSystem): void {
    if (this.unitSystem === unit) return;
    this.unitSystem = unit;
    try {
      localStorage.setItem(STORAGE_KEY_UNIT, unit);
    } catch {
      // Ignore storage failures
    }
    this.syncVisuals();
    this.notifyState();
  }

  public getOrthoSnapEnabled(): boolean {
    return this.orthoSnapEnabled;
  }

  public setOrthoSnapEnabled(enabled: boolean): void {
    this.orthoSnapEnabled = enabled;
    if (!enabled) {
      this.liveSnapState.isOrthoSnapped = false;
    }
    this.notifyState();
  }

  public getLiveSnapState(): LiveSnapState {
    return {
      isSnappedToStart: this.liveSnapState.isSnappedToStart,
      isOrthoSnapped: this.liveSnapState.isOrthoSnapped,
      liveAngleDeg: this.liveSnapState.liveAngleDeg,
      effectiveReticlePos: this.liveSnapState.effectiveReticlePos
        ? this.liveSnapState.effectiveReticlePos.clone()
        : null
    };
  }

  public getEffectiveReticlePosition(rawPos: THREE.Vector3 | null): THREE.Vector3 | null {
    if (!rawPos) return null;
    if (this.liveSnapState.effectiveReticlePos) {
      return this.liveSnapState.effectiveReticlePos.clone();
    }
    return rawPos.clone();
  }

  public getFloorPoints(): THREE.Vector3[] {
    return this.floorPoints.map((p) => p.clone());
  }

  public isClosed(): boolean {
    return this.isFloorClosed;
  }

  public getCeilingPoint(): THREE.Vector3 | null {
    return this.ceilingPoint ? this.ceilingPoint.clone() : null;
  }

  public getOpenings(): WallOpening[] {
    return this.openings.map((o) => ({ ...o }));
  }

  public addOpening(
    type: 'door' | 'window',
    widthMeters: number,
    heightMeters: number,
    label?: string,
    extras?: {
      wallIndex?: number;
      offsetAlongWallMeters?: number;
      sillHeightMeters?: number;
      source?: 'manual' | 'auto';
      confidence?: number;
    }
  ): WallOpening {
    const opening: WallOpening = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      label: label || (type === 'door' ? 'Door' : 'Window'),
      widthMeters: Math.max(0.1, widthMeters),
      heightMeters: Math.max(0.1, heightMeters),
      wallIndex: extras?.wallIndex,
      offsetAlongWallMeters: extras?.offsetAlongWallMeters,
      sillHeightMeters: extras?.sillHeightMeters,
      source: extras?.source ?? 'manual',
      confidence: extras?.confidence
    };
    this.openings.push(opening);
    this.syncVisuals();
    this.notifyState();
    return opening;
  }

  public updateOpening(id: string, patch: Partial<Omit<WallOpening, 'id'>>): void {
    const idx = this.openings.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const prev = this.openings[idx];
    this.openings[idx] = {
      ...prev,
      ...patch,
      widthMeters: Math.max(0.1, patch.widthMeters ?? prev.widthMeters),
      heightMeters: Math.max(0.1, patch.heightMeters ?? prev.heightMeters)
    };
    this.syncVisuals();
    this.notifyState();
  }

  public removeOpening(id: string): void {
    this.openings = this.openings.filter((o) => o.id !== id);
    this.syncVisuals();
    this.notifyState();
  }

  public getFurniture(): FurnitureBox[] {
    return this.furniture.map((f) => ({
      ...f,
      centerXZ: [f.centerXZ[0], f.centerXZ[1]]
    }));
  }

  public addFurniture(box: Omit<FurnitureBox, 'id'>): FurnitureBox {
    const item: FurnitureBox = {
      ...box,
      id: `furn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      centerXZ: [box.centerXZ[0], box.centerXZ[1]],
      widthMeters: Math.max(0.15, box.widthMeters),
      depthMeters: Math.max(0.15, box.depthMeters),
      heightMeters: Math.max(0.15, box.heightMeters)
    };
    this.furniture.push(item);
    this.furnitureFootprintDirty = true;
    this.syncVisuals();
    this.notifyState();
    return item;
  }

  public updateFurniture(id: string, patch: Partial<Omit<FurnitureBox, 'id'>>): void {
    const idx = this.furniture.findIndex((f) => f.id === id);
    if (idx === -1) return;
    const prev = this.furniture[idx];
    this.furniture[idx] = {
      ...prev,
      ...patch,
      centerXZ: patch.centerXZ ? [patch.centerXZ[0], patch.centerXZ[1]] : prev.centerXZ,
      widthMeters: Math.max(0.15, patch.widthMeters ?? prev.widthMeters),
      depthMeters: Math.max(0.15, patch.depthMeters ?? prev.depthMeters),
      heightMeters: Math.max(0.15, patch.heightMeters ?? prev.heightMeters)
    };
    this.furnitureFootprintDirty = true;
    this.syncVisuals();
    this.notifyState();
  }

  public rotateFurniture90(id: string): void {
    const item = this.furniture.find((f) => f.id === id);
    if (!item) return;
    item.yawRad = item.yawRad + Math.PI * 0.5;
    item.source = 'manual';
    this.furnitureFootprintDirty = true;
    this.syncVisuals();
    this.notifyState();
  }

  public removeFurniture(id: string): void {
    this.furniture = this.furniture.filter((f) => f.id !== id);
    this.surfaceTextures.delete(`furniture:${id}`);
    this.furnitureFootprintDirty = true;
    this.syncVisuals();
    this.notifyState();
  }

  public getSurfaceTextures(): SurfaceTextureEntry[] {
    return Array.from(this.surfaceTextures.values()).map((t) => ({ ...t }));
  }

  public getSurfaceTexture(surfaceKey: string): SurfaceTextureEntry | undefined {
    const found = this.surfaceTextures.get(surfaceKey);
    return found ? { ...found } : undefined;
  }

  public setSurfaceTexture(entry: SurfaceTextureEntry): void {
    this.surfaceTextures.set(entry.surfaceKey, {
      surfaceKey: entry.surfaceKey,
      dataUrl: entry.dataUrl,
      mode: entry.mode,
      tileSizeMeters: Math.max(0.1, entry.tileSizeMeters || 1.0)
    });
    this.syncVisuals();
    this.notifyState();
  }

  public removeSurfaceTexture(surfaceKey: string): void {
    if (!this.surfaceTextures.delete(surfaceKey)) return;
    this.syncVisuals();
    this.notifyState();
  }

  public isMarkingOpening(): boolean {
    return this.openingMarkState.active;
  }

  public getOpeningMarkState(): OpeningMarkState {
    return {
      active: this.openingMarkState.active,
      type: this.openingMarkState.type,
      firstHit: this.openingMarkState.firstHit
        ? {
            ...this.openingMarkState.firstHit,
            worldPos: this.openingMarkState.firstHit.worldPos.clone()
          }
        : null,
      liveHit: this.openingMarkState.liveHit
        ? {
            ...this.openingMarkState.liveHit,
            worldPos: this.openingMarkState.liveHit.worldPos.clone()
          }
        : null
    };
  }

  public startMarkingOpening(type: 'door' | 'window'): boolean {
    if (!this.isFloorClosed || this.floorPoints.length < 3) {
      this.onValidationErrorCallback?.('Close a floor polygon first before marking wall openings');
      return false;
    }
    this.openingMarkState = {
      active: true,
      type,
      firstHit: null,
      liveHit: null
    };
    this.visuals.updateOpeningMarkPreview(this.floorPoints, this.openingMarkState, this.unitSystem);
    this.notifyState();
    return true;
  }

  public cancelMarkingOpening(): void {
    if (!this.openingMarkState.active) return;
    this.openingMarkState = {
      active: false,
      type: 'door',
      firstHit: null,
      liveHit: null
    };
    this.visuals.updateOpeningMarkPreview(this.floorPoints, this.openingMarkState, this.unitSystem);
    this.notifyState();
  }

  public projectRayToWalls(ray: THREE.Ray): OpeningWallHit | null {
    if (!this.isFloorClosed || this.floorPoints.length < 3) return null;
    const floorY = calculateAverageFloorHeight(this.floorPoints);
    const maxWallH = this.ceilingPoint
      ? Math.max(2.0, Math.abs(this.ceilingPoint.y - floorY) + 0.15)
      : 3.4;

    const n = this.floorPoints.length;
    let bestHit: OpeningWallHit | null = null;
    let bestDistSq = Infinity;

    for (let i = 0; i < n; i++) {
      const p1 = this.floorPoints[i];
      const p2 = this.floorPoints[(i + 1) % n];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.05) continue;

      const normal = new THREE.Vector3(-dz / segLen, 0, dx / segLen);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p1);
      const hit = new THREE.Vector3();
      if (!ray.intersectPlane(plane, hit)) continue;

      const toHit = hit.clone().sub(ray.origin);
      if (toHit.dot(ray.direction) <= 0.15) continue;

      const alongM = ((hit.x - p1.x) * dx + (hit.z - p1.z) * dz) / segLen;
      if (alongM < -0.08 || alongM > segLen + 0.08) continue;

      const heightM = hit.y - floorY;
      if (heightM < -0.15 || heightM > maxWallH) continue;

      const clampedAlong = Math.max(0, Math.min(segLen, alongM));
      const clampedH = Math.max(0, Math.min(maxWallH, heightM));
      const clampedPos = new THREE.Vector3(
        p1.x + (dx / segLen) * clampedAlong,
        floorY + clampedH,
        p1.z + (dz / segLen) * clampedAlong
      );

      const dSq = toHit.lengthSq();
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestHit = {
          wallIndex: i,
          alongM: clampedAlong,
          heightM: clampedH,
          worldPos: clampedPos
        };
      }
    }

    return bestHit;
  }

  public updateOpeningMarkLive(hit: OpeningWallHit | null): void {
    if (!this.openingMarkState.active) return;
    this.openingMarkState.liveHit = hit
      ? { ...hit, worldPos: hit.worldPos.clone() }
      : null;
    this.visuals.updateOpeningMarkPreview(this.floorPoints, this.openingMarkState, this.unitSystem);
  }

  public pinOpeningWallHit(hit: OpeningWallHit): { completed: boolean; opening?: WallOpening } {
    if (!this.openingMarkState.active) {
      return { completed: false };
    }

    if (!this.openingMarkState.firstHit) {
      this.openingMarkState.firstHit = { ...hit, worldPos: hit.worldPos.clone() };
      this.openingMarkState.liveHit = { ...hit, worldPos: hit.worldPos.clone() };
      this.triggerHaptic(25);
      this.visuals.updateOpeningMarkPreview(this.floorPoints, this.openingMarkState, this.unitSystem);
      this.notifyState();
      return { completed: false };
    }

    const first = this.openingMarkState.firstHit;
    if (hit.wallIndex !== first.wallIndex) {
      this.onValidationErrorCallback?.(
        `Aim at Wall #${first.wallIndex + 1} for opposite corner`
      );
      return { completed: false };
    }

    const widthM = Math.abs(hit.alongM - first.alongM);
    const minH = Math.min(first.heightM, hit.heightM);
    const maxH = Math.max(first.heightM, hit.heightM);
    const rawHeightM = maxH - minH;
    if (widthM < 0.25 || rawHeightM < 0.25) {
      this.onValidationErrorCallback?.('Move reticle diagonally across the opening (>= 25cm)');
      return { completed: false };
    }

    const opType = this.openingMarkState.type;
    const snapToFloor = opType === 'door' && minH <= 0.30;
    const sillM = snapToFloor ? 0 : Math.round(minH * 100) / 100;
    const heightM = Math.round((snapToFloor ? maxH : rawHeightM) * 100) / 100;
    const offsetM = Math.round(Math.min(first.alongM, hit.alongM) * 100) / 100;
    const wRounded = Math.round(widthM * 100) / 100;

    this.openingMarkState = {
      active: false,
      type: 'door',
      firstHit: null,
      liveHit: null
    };
    this.triggerHaptic([30, 40, 30]);

    const opening = this.addOpening(
      opType,
      wRounded,
      heightM,
      `${opType === 'door' ? 'Door' : 'Window'} (Wall #${first.wallIndex + 1})`,
      {
        wallIndex: first.wallIndex,
        offsetAlongWallMeters: offsetM,
        sillHeightMeters: sillM,
        source: 'manual'
      }
    );
    return { completed: true, opening };
  }

  public getLastPoint(): THREE.Vector3 | null {
    if (this.state === 'MEASURING_CEILING' && this.floorPoints.length > 0) {
      const avgY = calculateAverageFloorHeight(this.floorPoints);
      return new THREE.Vector3(this.floorPoints[0].x, avgY, this.floorPoints[0].z);
    }
    if (this.floorPoints.length > 0 && !this.isFloorClosed) {
      return this.floorPoints[this.floorPoints.length - 1];
    }
    return null;
  }

  private resolveSnappedFloorPoint(rawPoint: THREE.Vector3): {
    point: THREE.Vector3;
    isSnappedToStart: boolean;
    isOrthoSnapped: boolean;
    liveAngleDeg: number | null;
  } {
    const point = rawPoint.clone();

    if (this.floorPoints.length >= 3) {
      const distToStart = calculateHorizontalDistance(point, this.floorPoints[0]);
      if (distToStart < START_SNAP_RADIUS_METERS) {
        let angleDeg: number | null = null;
        const n = this.floorPoints.length;
        if (n >= 2) {
          angleDeg = calculateInteriorAngleDeg(
            this.floorPoints[n - 2],
            this.floorPoints[n - 1],
            this.floorPoints[0]
          );
        }
        return {
          point: this.floorPoints[0].clone(),
          isSnappedToStart: true,
          isOrthoSnapped: false,
          liveAngleDeg: angleDeg
        };
      }
    }

    if (this.floorPoints.length >= 2) {
      const n = this.floorPoints.length;
      const pPrev = this.floorPoints[n - 2];
      const pCorner = this.floorPoints[n - 1];

      if (this.orthoSnapEnabled) {
        const snap = snapToOrthogonal(pPrev, pCorner, point, 6);
        return {
          point: snap.point,
          isSnappedToStart: false,
          isOrthoSnapped: snap.snapped,
          liveAngleDeg: snap.angleDeg
        };
      }

      const angleDeg = calculateInteriorAngleDeg(pPrev, pCorner, point);
      return {
        point,
        isSnappedToStart: false,
        isOrthoSnapped: false,
        liveAngleDeg: angleDeg
      };
    }

    return {
      point,
      isSnappedToStart: false,
      isOrthoSnapped: false,
      liveAngleDeg: null
    };
  }

  /**
   * Action: Pin corner point or ceiling point depending on current workflow state
   */
  public pinCurrentPosition(position: THREE.Vector3): boolean {
    if (this.state === 'SCAN_FLOOR' || this.state === 'MEASURING_FLOOR') {
      const resolved = this.resolveSnappedFloorPoint(position);

      if (resolved.isSnappedToStart && this.floorPoints.length >= 3) {
        this.closeFloor();
        return true;
      }

      if (this.floorPoints.length > 0) {
        const lastPt = this.floorPoints[this.floorPoints.length - 1];
        if (calculateHorizontalDistance(lastPt, resolved.point) < 0.05) {
          this.onValidationErrorCallback?.('Move reticle at least 5 cm from the previous corner');
          return false;
        }
      }

      this.floorPoints.push(resolved.point);
      this.state = 'MEASURING_FLOOR';
      this.furnitureFootprintDirty = true;
      this.lastLiveDistance = 0;
      this.triggerHaptic(25);
      this.syncVisuals();
      this.notifyState();
      return true;
    }

    if (this.state === 'MEASURING_CEILING' || this.state === 'FLOOR_CLOSED') {
      const height = calculateCeilingHeight(this.floorPoints, position);
      if (height < MIN_CEILING_HEIGHT_METERS) {
        if (this.onValidationErrorCallback) {
          this.onValidationErrorCallback('Aim higher (>= 0.4m above floor) to pin ceiling');
        }
        return false;
      }

      this.ceilingPoint = position.clone();
      this.state = 'COMPLETED';
      this.lastLiveDistance = 0;
      this.triggerHaptic([30, 40, 30]);
      this.syncVisuals();
      this.notifyState();
      return true;
    }

    return false;
  }

  /**
   * Action: Close floor polygon (requires >= 3 points)
   */
  public closeFloor(): boolean {
    if (this.floorPoints.length < 3) return false;
    this.isFloorClosed = true;
    this.state = 'MEASURING_CEILING';
    this.furnitureFootprintDirty = true;
    this.lastLiveDistance = 0;
    this.liveSnapState = {
      isSnappedToStart: false,
      isOrthoSnapped: false,
      liveAngleDeg: null,
      effectiveReticlePos: null
    };
    this.triggerHaptic([30, 40, 30]);
    this.syncVisuals();
    this.notifyState();
    return true;
  }

  /**
   * Fine-tunes an existing floor corner's horizontal position (used by interactive 2D plan editor).
   */
  public updateFloorPoint(index: number, newX: number, newZ: number): void {
    if (index < 0 || index >= this.floorPoints.length) return;
    this.floorPoints[index].x = newX;
    this.floorPoints[index].z = newZ;
    this.furnitureFootprintDirty = true;

    // Clamp positioned openings on affected wall segments
    if (this.isFloorClosed && this.floorPoints.length >= 3) {
      const n = this.floorPoints.length;
      for (const op of this.openings) {
        if (op.wallIndex === undefined) continue;
        if (op.wallIndex === index || (op.wallIndex + 1) % n === index) {
          const p1 = this.floorPoints[op.wallIndex];
          const p2 = this.floorPoints[(op.wallIndex + 1) % n];
          const wallLen = calculateHorizontalDistance(p1, p2);
          if (op.widthMeters > wallLen) {
            op.widthMeters = Math.max(0.2, Math.round(wallLen * 100) / 100);
          }
          if (op.offsetAlongWallMeters !== undefined) {
            op.offsetAlongWallMeters = Math.max(
              0,
              Math.min(Math.max(0, wallLen - op.widthMeters), op.offsetAlongWallMeters)
            );
          }
        }
      }
    }

    this.syncVisuals();
    this.notifyState();
  }

  /**
   * Loads a room shell polygon, floor/ceiling elevations, furniture silhouettes, and wall openings from Auto Scan.
   */
  public loadFromAutoScan(
    cornersXZ: [number, number][],
    floorY: number,
    ceilingY: number | null,
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): boolean {
    if (cornersXZ.length < 3) return false;

    this.floorPoints = cornersXZ.map(([x, z]) => new THREE.Vector3(x, floorY, z));
    this.isFloorClosed = true;
    this.furniture = furniture.map((f) => ({
      ...f,
      centerXZ: [f.centerXZ[0], f.centerXZ[1]]
    }));
    this.openings = openings.map((o) => ({ ...o }));
    this.surfaceTextures.clear();
    this.furnitureFootprintDirty = true;
    this.openingMarkState = {
      active: false,
      type: 'door',
      firstHit: null,
      liveHit: null
    };
    this.lastLiveDistance = 0;
    this.liveSnapState = {
      isSnappedToStart: false,
      isOrthoSnapped: false,
      liveAngleDeg: null,
      effectiveReticlePos: null
    };

    if (ceilingY !== null && Math.abs(ceilingY - floorY) >= MIN_CEILING_HEIGHT_METERS) {
      let cx = 0;
      let cz = 0;
      for (const p of this.floorPoints) {
        cx += p.x;
        cz += p.z;
      }
      cx /= this.floorPoints.length;
      cz /= this.floorPoints.length;
      this.ceilingPoint = new THREE.Vector3(cx, ceilingY, cz);
      this.state = 'COMPLETED';
    } else {
      this.ceilingPoint = null;
      this.state = 'MEASURING_CEILING';
    }

    this.triggerHaptic([30, 40, 30]);
    this.syncVisuals();
    this.notifyState();
    return true;
  }

  /**
   * Action: Undo last placed point
   */
  public undo(): void {
    if (this.openingMarkState.active) {
      if (this.openingMarkState.firstHit) {
        this.openingMarkState.firstHit = null;
        this.visuals.updateOpeningMarkPreview(this.floorPoints, this.openingMarkState, this.unitSystem);
        this.notifyState();
      } else {
        this.cancelMarkingOpening();
      }
      return;
    }

    this.lastLiveDistance = 0;
    if (this.state === 'COMPLETED') {
      this.ceilingPoint = null;
      this.state = 'MEASURING_CEILING';
    } else if (this.state === 'MEASURING_CEILING') {
      this.isFloorClosed = false;
      this.state = 'MEASURING_FLOOR';
    } else if (this.state === 'MEASURING_FLOOR') {
      this.floorPoints.pop();
      this.furnitureFootprintDirty = true;
      if (this.floorPoints.length === 0) {
        this.state = 'SCAN_FLOOR';
      }
    }

    this.syncVisuals();
    this.notifyState();
  }

  /**
   * Action: Reset all measurements
   */
  public reset(): void {
    this.floorPoints = [];
    this.ceilingPoint = null;
    this.isFloorClosed = false;
    this.openings = [];
    this.furniture = [];
    this.surfaceTextures.clear();
    this.cachedFurnitureFootprintArea = 0;
    this.furnitureFootprintDirty = true;
    this.openingMarkState = {
      active: false,
      type: 'door',
      firstHit: null,
      liveHit: null
    };
    this.state = 'SCAN_FLOOR';
    this.lastLiveDistance = 0;
    this.liveSnapState = {
      isSnappedToStart: false,
      isOrthoSnapped: false,
      liveAngleDeg: null,
      effectiveReticlePos: null
    };
    this.visuals.reset();
    this.notifyState();
  }

  /**
   * Updates real-time preview connecting line from last point to reticle
   */
  public updateLiveReticle(reticlePos: THREE.Vector3 | null): void {
    if (this.openingMarkState.active) {
      this.visuals.updateLiveLine(null, null);
      return;
    }

    if (this.state === 'MEASURING_FLOOR' && this.floorPoints.length > 0 && reticlePos) {
      const resolved = this.resolveSnappedFloorPoint(reticlePos);
      this.liveSnapState = {
        isSnappedToStart: resolved.isSnappedToStart,
        isOrthoSnapped: resolved.isOrthoSnapped,
        liveAngleDeg: resolved.liveAngleDeg,
        effectiveReticlePos: resolved.point
      };

      const last = this.floorPoints[this.floorPoints.length - 1];
      this.visuals.updateLiveLine(
        last,
        resolved.point,
        resolved.isSnappedToStart || resolved.isOrthoSnapped,
        resolved.liveAngleDeg
      );

      const currentSegment = calculateHorizontalDistance(last, resolved.point);
      this.lastLiveDistance = currentSegment;
      this.notifyState(currentSegment);
    } else if (this.state === 'MEASURING_CEILING' && this.floorPoints.length > 0 && reticlePos) {
      this.liveSnapState = {
        isSnappedToStart: false,
        isOrthoSnapped: false,
        liveAngleDeg: null,
        effectiveReticlePos: reticlePos.clone()
      };

      const avgY = calculateAverageFloorHeight(this.floorPoints);
      const floorAnchor = new THREE.Vector3(reticlePos.x, avgY, reticlePos.z);
      const liveHeight = Math.abs(reticlePos.y - avgY);
      this.visuals.updateLiveLine(
        floorAnchor,
        reticlePos,
        liveHeight >= MIN_CEILING_HEIGHT_METERS,
        null
      );

      this.lastLiveDistance = liveHeight;
      this.notifyState(liveHeight);
    } else {
      this.lastLiveDistance = 0;
      this.liveSnapState = {
        isSnappedToStart: false,
        isOrthoSnapped: false,
        liveAngleDeg: null,
        effectiveReticlePos: reticlePos ? reticlePos.clone() : null
      };
      this.visuals.updateLiveLine(null, null);
    }
  }

  private syncVisuals(): void {
    this.visuals.updatePoints(
      this.floorPoints,
      this.ceilingPoint,
      this.isFloorClosed,
      this.unitSystem,
      this.furniture,
      this.openings,
      this.getSurfaceTextures()
    );
    this.visuals.updateOpeningMarkPreview(
      this.floorPoints,
      this.openingMarkState,
      this.unitSystem
    );
  }

  private calculateFurnitureFootprintArea(floorArea: number): number {
    if (this.furniture.length === 0 || this.floorPoints.length < 3 || floorArea <= 0) {
      return 0;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.floorPoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    const cellSize = Math.max(0.05, Math.max(maxX - minX, maxZ - minZ) / 220);
    const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    const pts = this.floorPoints;
    const n = pts.length;

    let coveredCells = 0;
    for (let r = 0; r < rows; r++) {
      const z = minZ + (r + 0.5) * cellSize;
      for (let c = 0; c < cols; c++) {
        const x = minX + (c + 0.5) * cellSize;

        let inPoly = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = pts[i].x, zi = pts[i].z;
          const xj = pts[j].x, zj = pts[j].z;
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi) {
            inPoly = !inPoly;
          }
        }
        if (!inPoly) continue;

        let inFurn = false;
        for (let k = 0; k < this.furniture.length; k++) {
          const f = this.furniture[k];
          const dx = x - f.centerXZ[0];
          const dz = z - f.centerXZ[1];
          const cos = Math.cos(f.yawRad);
          const sin = Math.sin(f.yawRad);
          const lu = dx * cos + dz * sin;
          const lv = -dx * sin + dz * cos;
          if (Math.abs(lu) <= f.widthMeters * 0.5 && Math.abs(lv) <= f.depthMeters * 0.5) {
            inFurn = true;
            break;
          }
        }
        if (inFurn) coveredCells++;
      }
    }

    return Math.min(floorArea, Math.round(coveredCells * cellSize * cellSize * 100) / 100);
  }

  public getMetrics(liveDistance: number = this.lastLiveDistance): RoomMetrics {
    const area = this.floorPoints.length >= 3 ? calculateShoelaceArea(this.floorPoints) : 0;
    if (this.furnitureFootprintDirty) {
      this.cachedFurnitureFootprintArea = this.calculateFurnitureFootprintArea(area);
      this.furnitureFootprintDirty = false;
    }
    const furnitureFootprintArea = Math.min(area, this.cachedFurnitureFootprintArea);
    const freeFloorArea = Math.max(0, Math.round((area - furnitureFootprintArea) * 100) / 100);
    const perimeter = calculatePerimeter(this.floorPoints, this.isFloorClosed);
    let height = 0;
    if (this.ceilingPoint && this.floorPoints.length > 0) {
      height = calculateCeilingHeight(this.floorPoints, this.ceilingPoint);
    } else if (this.state === 'MEASURING_CEILING' && liveDistance > 0) {
      height = liveDistance;
    }
    const volume = area > 0 && height > 0 ? calculateVolume(area, height) : 0;
    const grossWallArea = perimeter > 0 && height > 0 ? perimeter * height : 0;
    const openingsArea = this.openings.reduce(
      (sum, o) => sum + o.widthMeters * o.heightMeters,
      0
    );
    const netWallArea = grossWallArea > 0 ? Math.max(0, grossWallArea - openingsArea) : 0;

    return {
      state: this.state,
      unitSystem: this.unitSystem,
      pointCount: this.floorPoints.length,
      currentSegmentLength: liveDistance,
      floorArea: area,
      furnitureFootprintArea,
      freeFloorArea,
      furnitureCount: this.furniture.length,
      perimeter,
      ceilingHeight: height,
      volume,
      grossWallArea,
      openingsArea,
      openingsCount: this.openings.length,
      netWallArea,
      isSnappedToStart: this.liveSnapState.isSnappedToStart,
      isOrthoSnapped: this.liveSnapState.isOrthoSnapped,
      liveAngleDeg: this.liveSnapState.liveAngleDeg
    };
  }

  private notifyState(liveDistance: number = this.lastLiveDistance): void {
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(this.getMetrics(liveDistance));
    }
  }

  private triggerHaptic(pattern: number | number[]): void {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignore haptic errors on unsupported browsers
      }
    }
  }

  /**
   * Generate structured export data
   */
  public getExportData(): RoomExportData {
    const metrics = this.getMetrics();
    return {
      appName: 'SpatialMeasure AR PWA',
      timestamp: new Date().toISOString(),
      unitSystem: this.unitSystem,
      metrics: {
        floorAreaSqMeters: metrics.floorArea,
        furnitureFootprintSqMeters: metrics.furnitureFootprintArea,
        freeFloorAreaSqMeters: metrics.freeFloorArea,
        floorPerimeterMeters: metrics.perimeter,
        ceilingHeightMeters: metrics.ceilingHeight,
        roomVolumeCuMeters: metrics.volume,
        grossWallAreaSqMeters: metrics.grossWallArea,
        openingsAreaSqMeters: metrics.openingsArea,
        netWallAreaSqMeters: metrics.netWallArea,
        formatted: {
          floorArea: formatArea(metrics.floorArea, this.unitSystem, true),
          furnitureFootprintArea: formatArea(metrics.furnitureFootprintArea, this.unitSystem, true),
          freeFloorArea: formatArea(metrics.freeFloorArea, this.unitSystem, true),
          floorPerimeter: formatDistance(metrics.perimeter, this.unitSystem),
          ceilingHeight: formatDistance(metrics.ceilingHeight, this.unitSystem),
          roomVolume: formatVolume(metrics.volume, this.unitSystem, true),
          grossWallArea: formatArea(metrics.grossWallArea, this.unitSystem, true),
          netWallArea: formatArea(metrics.netWallArea, this.unitSystem, true)
        }
      },
      floorCoordinates: this.floorPoints.map((p, idx) => ({
        index: idx + 1,
        x: parseFloat(p.x.toFixed(4)),
        y: parseFloat(p.y.toFixed(4)),
        z: parseFloat(p.z.toFixed(4))
      })),
      ceilingCoordinate: this.ceilingPoint
        ? {
            x: parseFloat(this.ceilingPoint.x.toFixed(4)),
            y: parseFloat(this.ceilingPoint.y.toFixed(4)),
            z: parseFloat(this.ceilingPoint.z.toFixed(4))
          }
        : null,
      openings: this.getOpenings(),
      furniture: this.getFurniture(),
      surfaceTextures: this.getSurfaceTextures()
    };
  }

  public importFromJSON(raw: unknown): { ok: boolean; error?: string; roomName?: string } {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Invalid JSON structure' };
    }
    const obj = raw as Record<string, unknown>;
    const rawCoords = obj.floorCoordinates;
    if (!Array.isArray(rawCoords) || rawCoords.length < 1) {
      return { ok: false, error: 'JSON has no floorCoordinates' };
    }

    const parsedFloor: THREE.Vector3[] = [];
    for (const pt of rawCoords) {
      if (!pt || typeof pt !== 'object') {
        return { ok: false, error: 'Invalid floor coordinate entry' };
      }
      const p = pt as Record<string, unknown>;
      if (
        typeof p.x !== 'number' || !Number.isFinite(p.x) ||
        typeof p.y !== 'number' || !Number.isFinite(p.y) ||
        typeof p.z !== 'number' || !Number.isFinite(p.z)
      ) {
        return { ok: false, error: 'Non-numeric floor coordinates in JSON' };
      }
      parsedFloor.push(new THREE.Vector3(p.x, p.y, p.z));
    }

    let parsedCeiling: THREE.Vector3 | null = null;
    if (obj.ceilingCoordinate && typeof obj.ceilingCoordinate === 'object') {
      const c = obj.ceilingCoordinate as Record<string, unknown>;
      if (
        typeof c.x === 'number' && Number.isFinite(c.x) &&
        typeof c.y === 'number' && Number.isFinite(c.y) &&
        typeof c.z === 'number' && Number.isFinite(c.z)
      ) {
        parsedCeiling = new THREE.Vector3(c.x, c.y, c.z);
      }
    }

    const parsedOpenings: WallOpening[] = [];
    if (Array.isArray(obj.openings)) {
      for (let i = 0; i < obj.openings.length; i++) {
        const o = obj.openings[i] as Record<string, unknown> | null;
        if (!o || typeof o !== 'object') continue;
        const type = o.type === 'window' ? 'window' : o.type === 'door' ? 'door' : null;
        const w = typeof o.widthMeters === 'number' && Number.isFinite(o.widthMeters) ? o.widthMeters : 0;
        const h = typeof o.heightMeters === 'number' && Number.isFinite(o.heightMeters) ? o.heightMeters : 0;
        if (!type || w <= 0 || h <= 0) continue;
        parsedOpenings.push({
          id: typeof o.id === 'string' && o.id ? o.id : `imp-op-${i + 1}`,
          type,
          label: typeof o.label === 'string' && o.label ? o.label : (type === 'door' ? 'Door' : 'Window'),
          widthMeters: Math.max(0.1, w),
          heightMeters: Math.max(0.1, h),
          wallIndex: typeof o.wallIndex === 'number' && Number.isInteger(o.wallIndex) ? o.wallIndex : undefined,
          offsetAlongWallMeters:
            typeof o.offsetAlongWallMeters === 'number' && Number.isFinite(o.offsetAlongWallMeters)
              ? o.offsetAlongWallMeters
              : undefined,
          sillHeightMeters:
            typeof o.sillHeightMeters === 'number' && Number.isFinite(o.sillHeightMeters)
              ? o.sillHeightMeters
              : undefined,
          source: o.source === 'auto' ? 'auto' : 'manual',
          confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : undefined
        });
      }
    }

    const parsedFurniture: FurnitureBox[] = [];
    if (Array.isArray(obj.furniture)) {
      for (let i = 0; i < obj.furniture.length; i++) {
        const f = obj.furniture[i] as Record<string, unknown> | null;
        if (!f || typeof f !== 'object') continue;
        const center = Array.isArray(f.centerXZ) ? f.centerXZ : null;
        const w = typeof f.widthMeters === 'number' && Number.isFinite(f.widthMeters) ? f.widthMeters : 0;
        const d = typeof f.depthMeters === 'number' && Number.isFinite(f.depthMeters) ? f.depthMeters : 0;
        const h = typeof f.heightMeters === 'number' && Number.isFinite(f.heightMeters) ? f.heightMeters : 0;
        if (
          !center || center.length < 2 ||
          typeof center[0] !== 'number' || !Number.isFinite(center[0]) ||
          typeof center[1] !== 'number' || !Number.isFinite(center[1]) ||
          w <= 0 || d <= 0 || h <= 0
        ) {
          continue;
        }
        parsedFurniture.push({
          id: typeof f.id === 'string' && f.id ? f.id : `imp-furn-${i + 1}`,
          label: typeof f.label === 'string' && f.label ? f.label : 'Furniture',
          centerXZ: [center[0], center[1]],
          widthMeters: Math.max(0.15, w),
          depthMeters: Math.max(0.15, d),
          heightMeters: Math.max(0.15, h),
          floorY: typeof f.floorY === 'number' && Number.isFinite(f.floorY) ? f.floorY : parsedFloor[0].y,
          yawRad: typeof f.yawRad === 'number' && Number.isFinite(f.yawRad) ? f.yawRad : 0,
          source: f.source === 'auto' ? 'auto' : 'manual',
          confidence: typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : undefined
        });
      }
    }

    this.surfaceTextures.clear();
    if (Array.isArray(obj.surfaceTextures)) {
      for (const t of obj.surfaceTextures) {
        if (!t || typeof t !== 'object') continue;
        const entry = t as Record<string, unknown>;
        if (
          typeof entry.surfaceKey === 'string' &&
          typeof entry.dataUrl === 'string' &&
          entry.dataUrl.startsWith('data:image/')
        ) {
          this.surfaceTextures.set(entry.surfaceKey, {
            surfaceKey: entry.surfaceKey,
            dataUrl: entry.dataUrl,
            mode: entry.mode === 'stretch' ? 'stretch' : 'tile',
            tileSizeMeters:
              typeof entry.tileSizeMeters === 'number' && Number.isFinite(entry.tileSizeMeters)
                ? Math.max(0.1, entry.tileSizeMeters)
                : 1.0
          });
        }
      }
    }

    if (obj.unitSystem === 'imperial' || obj.unitSystem === 'metric') {
      this.unitSystem = obj.unitSystem;
    }

    this.floorPoints = parsedFloor;
    this.ceilingPoint = parsedCeiling;
    this.openings = parsedOpenings;
    this.furniture = parsedFurniture;
    this.openingMarkState = { active: false, type: 'door', firstHit: null, liveHit: null };
    this.lastLiveDistance = 0;
    this.furnitureFootprintDirty = true;

    if (this.ceilingPoint && this.floorPoints.length >= 3) {
      this.isFloorClosed = true;
      this.state = 'COMPLETED';
    } else if (this.floorPoints.length >= 3) {
      this.isFloorClosed = true;
      this.state = 'MEASURING_CEILING';
    } else if (this.floorPoints.length >= 1) {
      this.isFloorClosed = false;
      this.state = 'MEASURING_FLOOR';
    } else {
      this.isFloorClosed = false;
      this.state = 'SCAN_FLOOR';
    }

    this.syncVisuals();
    this.notifyState();

    const roomName = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
    return { ok: true, roomName };
  }

  public getFormattedSummaryText(): string {
    const data = this.getExportData();
    const lines = [
      '--- SpatialMeasure Room Report ---',
      `Date: ${new Date().toLocaleString()}`,
      `Unit System: ${this.unitSystem.toUpperCase()}`,
      `Floor Corners: ${data.floorCoordinates.length}`,
      `Floor Perimeter: ${data.metrics.formatted.floorPerimeter}`,
      `Floor Area (Shell): ${data.metrics.formatted.floorArea}`,
      `Free Floor Area: ${data.metrics.formatted.freeFloorArea}`,
      `Ceiling Height: ${data.metrics.formatted.ceilingHeight}`,
      `Room Volume: ${data.metrics.formatted.roomVolume}`
    ];

    if (data.metrics.grossWallAreaSqMeters > 0) {
      lines.push(`Gross Wall Area: ${data.metrics.formatted.grossWallArea}`);
      lines.push(`Openings (${data.openings.length}): ${formatArea(data.metrics.openingsAreaSqMeters, this.unitSystem, true)}`);
      lines.push(`Net Wall Area: ${data.metrics.formatted.netWallArea}`);
    }

    lines.push('Points (XYZ meters):');
    data.floorCoordinates.forEach((c) => {
      lines.push(`  #${c.index}: [${c.x}, ${c.y}, ${c.z}]`);
    });
    if (data.ceilingCoordinate) {
      lines.push(
        `Ceiling: [${data.ceilingCoordinate.x}, ${data.ceilingCoordinate.y}, ${data.ceilingCoordinate.z}]`
      );
    }
    if (data.openings.length > 0) {
      lines.push('Openings:');
      data.openings.forEach((o) => {
        const wallInfo = o.wallIndex !== undefined ? ` on Wall #${o.wallIndex + 1}` : '';
        const sillInfo = o.sillHeightMeters ? ` (sill ${formatDistance(o.sillHeightMeters, this.unitSystem)})` : '';
        lines.push(
          `  - ${o.label} (${o.type}${wallInfo}): ${formatDistance(o.widthMeters, this.unitSystem)} × ${formatDistance(o.heightMeters, this.unitSystem)}${sillInfo}`
        );
      });
    }
    if (data.furniture.length > 0) {
      lines.push(`Furniture Silhouettes (${data.furniture.length}):`);
      data.furniture.forEach((f) => {
        lines.push(
          `  - ${f.label}: ${formatDistance(f.widthMeters, this.unitSystem)} × ${formatDistance(f.depthMeters, this.unitSystem)} × ${formatDistance(f.heightMeters, this.unitSystem)} @ [${f.centerXZ[0].toFixed(2)}, ${f.centerXZ[1].toFixed(2)}]`
        );
      });
    }
    lines.push('----------------------------------');
    return lines.join('\n');
  }

  /**
   * Generates a standalone 2D SVG architectural floor plan blueprint.
   */
  public generateSVGBlueprint(roomName: string = 'Measured Room'): string {
    const data = this.getExportData();
    const pts = this.floorPoints;
    const width = 800;
    const height = 960;
    const planPad = 80;
    const planAreaW = width - planPad * 2;
    const planAreaH = 540;
    const planTop = 100;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    });

    if (pts.length === 0) {
      minX = -1; maxX = 1; minZ = -1; maxZ = 1;
    }

    const spanX = Math.max(maxX - minX, 1.5);
    const spanZ = Math.max(maxZ - minZ, 1.5);
    const scale = Math.min(planAreaW / spanX, planAreaH / spanZ) * 0.85;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    const toSvgX = (wx: number) => width / 2 + (wx - centerX) * scale;
    const toSvgY = (wz: number) => planTop + planAreaH / 2 + (wz - centerZ) * scale;

    const polyPoints = pts.map((p) => `${toSvgX(p.x).toFixed(1)},${toSvgY(p.z).toFixed(1)}`).join(' ');

    const furnitureSvg = data.furniture
      .map((f) => {
        const cx = toSvgX(f.centerXZ[0]);
        const cy = toSvgY(f.centerXZ[1]);
        const pw = f.widthMeters * scale;
        const pd = f.depthMeters * scale;
        const deg = (f.yawRad * 180) / Math.PI;
        const label = `${f.label} (${formatDistance(f.widthMeters, this.unitSystem)}×${formatDistance(f.depthMeters, this.unitSystem)})`;
        return `<g transform="translate(${cx.toFixed(1)}, ${cy.toFixed(1)}) rotate(${deg.toFixed(1)})">
      <rect x="${(-pw * 0.5).toFixed(1)}" y="${(-pd * 0.5).toFixed(1)}" width="${pw.toFixed(1)}" height="${pd.toFixed(1)}" rx="3" fill="rgba(16, 185, 129, 0.20)" stroke="#34d399" stroke-width="1.5"/>
      <text x="0" y="3" fill="#a7f3d0" font-size="10" font-weight="600" text-anchor="middle">${this.escapeXml(label)}</text>
    </g>`;
      })
      .join('\n  ');

    const openingsSvg =
      this.isFloorClosed && pts.length >= 3
        ? data.openings
            .filter((o) => o.wallIndex !== undefined && o.offsetAlongWallMeters !== undefined)
            .map((o) => {
              const p1 = pts[o.wallIndex!];
              const p2 = pts[(o.wallIndex! + 1) % pts.length];
              if (!p1 || !p2) return '';
              const dx = p2.x - p1.x;
              const dz = p2.z - p1.z;
              const wallLen = Math.hypot(dx, dz);
              if (wallLen < 0.05) return '';
              const s0 = Math.max(0, Math.min(wallLen, o.offsetAlongWallMeters!));
              const s1 = Math.max(s0 + 0.05, Math.min(wallLen, s0 + o.widthMeters));
              const x0 = toSvgX(p1.x + (dx / wallLen) * s0);
              const y0 = toSvgY(p1.z + (dz / wallLen) * s0);
              const x1 = toSvgX(p1.x + (dx / wallLen) * s1);
              const y1 = toSvgY(p1.z + (dz / wallLen) * s1);
              const color = o.type === 'door' ? '#f59e0b' : '#38bdf8';
              return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#090d16" stroke-width="7" stroke-linecap="butt"/><line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${color}" stroke-width="4" stroke-dasharray="${o.type === 'door' ? '6 3' : 'none'}"/>`;
            })
            .join('\n  ')
        : '';

    const wallLabels: string[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const mx = (toSvgX(p1.x) + toSvgX(p2.x)) / 2;
      const my = (toSvgY(p1.z) + toSvgY(p2.z)) / 2;
      const d = calculateHorizontalDistance(p1, p2);
      wallLabels.push(
        `<g><rect x="${(mx - 36).toFixed(1)}" y="${(my - 13).toFixed(1)}" width="72" height="22" rx="6" fill="#090d16" stroke="#38bdf8" stroke-width="1"/><text x="${mx.toFixed(1)}" y="${(my + 2).toFixed(1)}" fill="#f8fafc" font-size="12" font-weight="700" text-anchor="middle">${this.escapeXml(formatDistance(d, this.unitSystem))}</text></g>`
      );
    }
    if (this.isFloorClosed && pts.length >= 3) {
      const p1 = pts[pts.length - 1];
      const p2 = pts[0];
      const mx = (toSvgX(p1.x) + toSvgX(p2.x)) / 2;
      const my = (toSvgY(p1.z) + toSvgY(p2.z)) / 2;
      const d = calculateHorizontalDistance(p1, p2);
      wallLabels.push(
        `<g><rect x="${(mx - 36).toFixed(1)}" y="${(my - 13).toFixed(1)}" width="72" height="22" rx="6" fill="#090d16" stroke="#38bdf8" stroke-width="1"/><text x="${mx.toFixed(1)}" y="${(my + 2).toFixed(1)}" fill="#f8fafc" font-size="12" font-weight="700" text-anchor="middle">${this.escapeXml(formatDistance(d, this.unitSystem))}</text></g>`
      );
    }

    const cornerNodes = pts
      .map((p, idx) => {
        const cx = toSvgX(p.x);
        const cy = toSvgY(p.z);
        let angleText = '';
        if (pts.length >= 3 && (this.isFloorClosed || (idx > 0 && idx < pts.length - 1))) {
          const pPrev = pts[(idx - 1 + pts.length) % pts.length];
          const pNext = pts[(idx + 1) % pts.length];
          const deg = Math.round(calculateInteriorAngleDeg(pPrev, p, pNext));
          if (deg > 0) {
            angleText = `<text x="${(cx + 12).toFixed(1)}" y="${(cy + 16).toFixed(1)}" fill="#34d399" font-size="11" font-weight="700">${deg}°</text>`;
          }
        }
        return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${idx === 0 ? '#10b981' : '#00f2fe'}" stroke="#090d16" stroke-width="2"/><text x="${(cx + 12).toFixed(1)}" y="${(cy - 8).toFixed(1)}" fill="#94a3b8" font-size="11" font-weight="700">#${idx + 1}</text>${angleText}`;
      })
      .join('\n    ');

    const scaleLenMeters = this.unitSystem === 'imperial' ? 1.524 : 1.0; // 5 ft or 1 m
    const scaleBarPx = Math.max(40, Math.min(200, scaleLenMeters * scale));
    const scaleLabel = this.unitSystem === 'imperial' ? '5 ft' : '1.0 m';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family: system-ui, -apple-system, sans-serif;">
  <defs>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="#090d16"/>
  <rect width="${width}" height="${height}" fill="url(#grid)"/>

  <!-- Header -->
  <rect x="24" y="20" width="${width - 48}" height="64" rx="12" fill="#0f172a" stroke="#38bdf8" stroke-opacity="0.35"/>
  <text x="44" y="48" fill="#00f2fe" font-size="20" font-weight="700">${this.escapeXml(roomName)}</text>
  <text x="44" y="70" fill="#94a3b8" font-size="12">SpatialMeasure AR Blueprint • ${this.escapeXml(new Date().toLocaleDateString())}</text>

  <!-- Scale Bar -->
  <g transform="translate(${width - 44 - scaleBarPx}, 52)">
    <line x1="0" y1="8" x2="${scaleBarPx.toFixed(1)}" y2="8" stroke="#00f2fe" stroke-width="2.5"/>
    <line x1="0" y1="2" x2="0" y2="14" stroke="#00f2fe" stroke-width="2"/>
    <line x1="${scaleBarPx.toFixed(1)}" y1="2" x2="${scaleBarPx.toFixed(1)}" y2="14" stroke="#00f2fe" stroke-width="2"/>
    <text x="${(scaleBarPx / 2).toFixed(1)}" y="0" fill="#94a3b8" font-size="11" text-anchor="middle">${scaleLabel}</text>
  </g>

  <!-- Floor Polygon -->
  ${
    pts.length >= 3
      ? `<polygon points="${polyPoints}" fill="rgba(0, 242, 254, 0.16)" stroke="#00f2fe" stroke-width="3" stroke-linejoin="round"/>`
      : pts.length === 2
      ? `<polyline points="${polyPoints}" fill="none" stroke="#00f2fe" stroke-width="3"/>`
      : ''
  }

  <!-- Furniture Silhouettes -->
  ${furnitureSvg}

  <!-- Wall Openings -->
  ${openingsSvg}

  <!-- Wall Labels & Corners -->
  ${wallLabels.join('\n  ')}
  ${cornerNodes}

  <!-- Specifications Panel -->
  <rect x="24" y="680" width="${width - 48}" height="252" rx="14" fill="#0f172a" stroke="#38bdf8" stroke-opacity="0.35"/>
  <text x="44" y="712" fill="#00f2fe" font-size="13" font-weight="700" letter-spacing="1">MEASUREMENT SPECIFICATIONS</text>

  <text x="44" y="748" fill="#94a3b8" font-size="12">FLOOR AREA (SHELL)</text>
  <text x="44" y="772" fill="#f8fafc" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.floorArea)}</text>

  <text x="300" y="748" fill="#94a3b8" font-size="12">FREE FLOOR AREA (${data.furniture.length} items)</text>
  <text x="300" y="772" fill="#34d399" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.freeFloorArea)}</text>

  <text x="560" y="748" fill="#94a3b8" font-size="12">CEILING HEIGHT</text>
  <text x="560" y="772" fill="#f8fafc" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.ceilingHeight)}</text>

  <text x="44" y="822" fill="#94a3b8" font-size="12">ROOM VOLUME</text>
  <text x="44" y="846" fill="#f8fafc" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.roomVolume)}</text>

  <text x="300" y="822" fill="#94a3b8" font-size="12">GROSS WALL AREA</text>
  <text x="300" y="846" fill="#f8fafc" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.grossWallArea)}</text>

  <text x="560" y="822" fill="#94a3b8" font-size="12">NET WALL AREA (${data.openings.length} openings)</text>
  <text x="560" y="846" fill="#34d399" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.netWallArea)}</text>

  <text x="44" y="896" fill="#94a3b8" font-size="12">PERIMETER</text>
  <text x="44" y="920" fill="#f8fafc" font-size="15" font-weight="700">${this.escapeXml(data.metrics.formatted.floorPerimeter)}</text>
</svg>`;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * LocalStorage Multi-Room History
   */
  public getSavedRooms(): SavedRoomRecord[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ROOMS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public saveCurrentRoom(name: string): SavedRoomRecord {
    const metrics = this.getMetrics();
    const record: SavedRoomRecord = {
      id: `room-${Date.now()}`,
      name: name.trim() || `Room ${this.getSavedRooms().length + 1}`,
      timestamp: new Date().toISOString(),
      floorCoordinates: this.floorPoints.map((p) => ({
        x: parseFloat(p.x.toFixed(4)),
        y: parseFloat(p.y.toFixed(4)),
        z: parseFloat(p.z.toFixed(4))
      })),
      ceilingCoordinate: this.ceilingPoint
        ? {
            x: parseFloat(this.ceilingPoint.x.toFixed(4)),
            y: parseFloat(this.ceilingPoint.y.toFixed(4)),
            z: parseFloat(this.ceilingPoint.z.toFixed(4))
          }
        : null,
      openings: this.getOpenings(),
      furniture: this.getFurniture(),
      metrics: {
        floorAreaSqMeters: metrics.floorArea,
        freeFloorAreaSqMeters: metrics.freeFloorArea,
        floorPerimeterMeters: metrics.perimeter,
        ceilingHeightMeters: metrics.ceilingHeight,
        roomVolumeCuMeters: metrics.volume,
        netWallAreaSqMeters: metrics.netWallArea
      }
    };

    const existing = this.getSavedRooms();
    existing.unshift(record);
    try {
      localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(existing.slice(0, 50)));
    } catch {
      // Ignore storage quota issues
    }
    return record;
  }

  public loadSavedRoom(id: string): boolean {
    const found = this.getSavedRooms().find((r) => r.id === id);
    if (!found) return false;

    this.floorPoints = found.floorCoordinates.map((c) => new THREE.Vector3(c.x, c.y, c.z));
    this.ceilingPoint = found.ceilingCoordinate
      ? new THREE.Vector3(found.ceilingCoordinate.x, found.ceilingCoordinate.y, found.ceilingCoordinate.z)
      : null;
    this.openings = Array.isArray(found.openings) ? found.openings.map((o) => ({ ...o })) : [];
    this.furniture = Array.isArray(found.furniture)
      ? found.furniture.map((f) => ({ ...f, centerXZ: [f.centerXZ[0], f.centerXZ[1]] }))
      : [];
    this.surfaceTextures.clear();
    this.furnitureFootprintDirty = true;
    this.openingMarkState = {
      active: false,
      type: 'door',
      firstHit: null,
      liveHit: null
    };

    if (this.ceilingPoint && this.floorPoints.length >= 3) {
      this.isFloorClosed = true;
      this.state = 'COMPLETED';
    } else if (this.floorPoints.length >= 3) {
      this.isFloorClosed = true;
      this.state = 'MEASURING_CEILING';
    } else if (this.floorPoints.length >= 1) {
      this.isFloorClosed = false;
      this.state = 'MEASURING_FLOOR';
    } else {
      this.isFloorClosed = false;
      this.state = 'SCAN_FLOOR';
    }

    this.syncVisuals();
    this.notifyState();
    return true;
  }

  public deleteSavedRoom(id: string): void {
    const remaining = this.getSavedRooms().filter((r) => r.id !== id);
    try {
      localStorage.setItem(STORAGE_KEY_ROOMS, JSON.stringify(remaining));
    } catch {
      // Ignore storage failures
    }
  }
}
