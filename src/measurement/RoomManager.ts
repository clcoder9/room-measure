import * as THREE from 'three';
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

export type MeasurementState =
  | 'SCAN_FLOOR'
  | 'MEASURING_FLOOR'
  | 'FLOOR_CLOSED'
  | 'MEASURING_CEILING'
  | 'COMPLETED';

export interface WallOpening {
  id: string;
  type: 'door' | 'window';
  label: string;
  widthMeters: number;
  heightMeters: number;
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
    floorPerimeterMeters: number;
    ceilingHeightMeters: number;
    roomVolumeCuMeters: number;
    grossWallAreaSqMeters: number;
    openingsAreaSqMeters: number;
    netWallAreaSqMeters: number;
    formatted: {
      floorArea: string;
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
}

export interface SavedRoomRecord {
  id: string;
  name: string;
  timestamp: string;
  floorCoordinates: { x: number; y: number; z: number }[];
  ceilingCoordinate: { x: number; y: number; z: number } | null;
  openings: WallOpening[];
  metrics: {
    floorAreaSqMeters: number;
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
    label?: string
  ): WallOpening {
    const opening: WallOpening = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      label: label || (type === 'door' ? 'Door' : 'Window'),
      widthMeters: Math.max(0.1, widthMeters),
      heightMeters: Math.max(0.1, heightMeters)
    };
    this.openings.push(opening);
    this.notifyState();
    return opening;
  }

  public removeOpening(id: string): void {
    this.openings = this.openings.filter((o) => o.id !== id);
    this.notifyState();
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
    this.syncVisuals();
    this.notifyState();
  }

  /**
   * Action: Undo last placed point
   */
  public undo(): void {
    this.lastLiveDistance = 0;
    if (this.state === 'COMPLETED') {
      this.ceilingPoint = null;
      this.state = 'MEASURING_CEILING';
    } else if (this.state === 'MEASURING_CEILING') {
      this.isFloorClosed = false;
      this.state = 'MEASURING_FLOOR';
    } else if (this.state === 'MEASURING_FLOOR') {
      this.floorPoints.pop();
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
      this.unitSystem
    );
  }

  public getMetrics(liveDistance: number = this.lastLiveDistance): RoomMetrics {
    const area = this.floorPoints.length >= 3 ? calculateShoelaceArea(this.floorPoints) : 0;
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
        floorPerimeterMeters: metrics.perimeter,
        ceilingHeightMeters: metrics.ceilingHeight,
        roomVolumeCuMeters: metrics.volume,
        grossWallAreaSqMeters: metrics.grossWallArea,
        openingsAreaSqMeters: metrics.openingsArea,
        netWallAreaSqMeters: metrics.netWallArea,
        formatted: {
          floorArea: formatArea(metrics.floorArea, this.unitSystem, true),
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
      openings: this.getOpenings()
    };
  }

  public getFormattedSummaryText(): string {
    const data = this.getExportData();
    const lines = [
      '--- SpatialMeasure Room Report ---',
      `Date: ${new Date().toLocaleString()}`,
      `Unit System: ${this.unitSystem.toUpperCase()}`,
      `Floor Corners: ${data.floorCoordinates.length}`,
      `Floor Perimeter: ${data.metrics.formatted.floorPerimeter}`,
      `Floor Area: ${data.metrics.formatted.floorArea}`,
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
        lines.push(
          `  - ${o.label} (${o.type}): ${formatDistance(o.widthMeters, this.unitSystem)} × ${formatDistance(o.heightMeters, this.unitSystem)}`
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
    const height = 920;
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

  <!-- Wall Labels & Corners -->
  ${wallLabels.join('\n  ')}
  ${cornerNodes}

  <!-- Specifications Panel -->
  <rect x="24" y="680" width="${width - 48}" height="212" rx="14" fill="#0f172a" stroke="#38bdf8" stroke-opacity="0.35"/>
  <text x="44" y="712" fill="#00f2fe" font-size="13" font-weight="700" letter-spacing="1">MEASUREMENT SPECIFICATIONS</text>

  <text x="44" y="748" fill="#94a3b8" font-size="12">FLOOR AREA</text>
  <text x="44" y="772" fill="#f8fafc" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.floorArea)}</text>

  <text x="300" y="748" fill="#94a3b8" font-size="12">ROOM VOLUME</text>
  <text x="300" y="772" fill="#f8fafc" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.roomVolume)}</text>

  <text x="560" y="748" fill="#94a3b8" font-size="12">CEILING HEIGHT</text>
  <text x="560" y="772" fill="#f8fafc" font-size="17" font-weight="700">${this.escapeXml(data.metrics.formatted.ceilingHeight)}</text>

  <text x="44" y="822" fill="#94a3b8" font-size="12">PERIMETER</text>
  <text x="44" y="846" fill="#f8fafc" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.floorPerimeter)}</text>

  <text x="300" y="822" fill="#94a3b8" font-size="12">GROSS WALL AREA</text>
  <text x="300" y="846" fill="#f8fafc" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.grossWallArea)}</text>

  <text x="560" y="822" fill="#94a3b8" font-size="12">NET WALL AREA (${data.openings.length} openings)</text>
  <text x="560" y="846" fill="#34d399" font-size="16" font-weight="700">${this.escapeXml(data.metrics.formatted.netWallArea)}</text>
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
      metrics: {
        floorAreaSqMeters: metrics.floorArea,
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
