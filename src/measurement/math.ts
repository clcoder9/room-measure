import * as THREE from 'three';

export type UnitSystem = 'metric' | 'imperial';

/**
 * Calculates the Euclidean 3D distance between two points:
 * d = sqrt((x2 - x1)^2 + (y2 - y1)^2 + (z2 - z1)^2)
 */
export function calculateEuclideanDistance(p1: THREE.Vector3, p2: THREE.Vector3): number {
  return p1.distanceTo(p2);
}

/**
 * Calculates the horizontal distance on the X-Z floor plane so minor AR
 * vertical drift does not distort wall lengths.
 */
export function calculateHorizontalDistance(p1: THREE.Vector3, p2: THREE.Vector3): number {
  return Math.hypot(p2.x - p1.x, p2.z - p1.z);
}

/**
 * Computes the 2D polygon area using the Shoelace formula on the horizontal X-Z plane.
 * A = 0.5 * |sum(x_i * z_{i+1} - x_{i+1} * z_i)|
 */
export function calculateShoelaceArea(points: THREE.Vector3[]): number {
  const n = points.length;
  if (n < 3) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    sum += points[i].x * points[next].z - points[next].x * points[i].z;
  }

  return Math.abs(sum) * 0.5;
}

/**
 * Calculates the horizontal perimeter of a floor polyline or closed polygon.
 */
export function calculatePerimeter(points: THREE.Vector3[], isClosed: boolean = true): number {
  if (points.length < 2) return 0;

  let perimeter = 0;
  for (let i = 0; i < points.length - 1; i++) {
    perimeter += calculateHorizontalDistance(points[i], points[i + 1]);
  }

  if (isClosed && points.length >= 3) {
    perimeter += calculateHorizontalDistance(points[points.length - 1], points[0]);
  }

  return perimeter;
}

/**
 * Calculates the interior corner angle in degrees on the horizontal X-Z plane
 * between segments (pCorner -> pPrev) and (pCorner -> pNext).
 */
export function calculateInteriorAngleDeg(
  pPrev: THREE.Vector3,
  pCorner: THREE.Vector3,
  pNext: THREE.Vector3
): number {
  const v1x = pPrev.x - pCorner.x;
  const v1z = pPrev.z - pCorner.z;
  const v2x = pNext.x - pCorner.x;
  const v2z = pNext.z - pCorner.z;

  const len1 = Math.hypot(v1x, v1z);
  const len2 = Math.hypot(v2x, v2z);
  if (len1 < 1e-5 || len2 < 1e-5) return 0;

  const dot = (v1x * v2x + v1z * v2z) / (len1 * len2);
  const clamped = Math.max(-1, Math.min(1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/**
 * Snaps a candidate target point to an orthogonal (90° or 180°) extension from
 * the previous wall segment (pPrev -> pCorner) on the X-Z plane if within toleranceDeg.
 */
export function snapToOrthogonal(
  pPrev: THREE.Vector3,
  pCorner: THREE.Vector3,
  target: THREE.Vector3,
  toleranceDeg: number = 6
): { point: THREE.Vector3; snapped: boolean; angleDeg: number } {
  const angleDeg = calculateInteriorAngleDeg(pPrev, pCorner, target);
  const segDx = pCorner.x - pPrev.x;
  const segDz = pCorner.z - pPrev.z;
  const segLen = Math.hypot(segDx, segDz);

  const candDx = target.x - pCorner.x;
  const candDz = target.z - pCorner.z;
  const candLen = Math.hypot(candDx, candDz);

  if (segLen < 1e-4 || candLen < 0.08) {
    return { point: target.clone(), snapped: false, angleDeg };
  }

  const ux = segDx / segLen;
  const uz = segDz / segLen;

  // Check 90° orthogonal snap
  if (Math.abs(angleDeg - 90) <= toleranceDeg) {
    // Two unit perpendiculars in XZ plane
    const perp1x = -uz;
    const perp1z = ux;
    const dot = candDx * perp1x + candDz * perp1z;
    const sign = dot >= 0 ? 1 : -1;
    const projLen = Math.abs(dot);
    const snappedPoint = new THREE.Vector3(
      pCorner.x + perp1x * sign * projLen,
      target.y,
      pCorner.z + perp1z * sign * projLen
    );
    return { point: snappedPoint, snapped: true, angleDeg: 90 };
  }

  // Check 180° straight-line extension snap
  if (Math.abs(angleDeg - 180) <= toleranceDeg) {
    const dot = candDx * ux + candDz * uz;
    if (dot > 0) {
      const snappedPoint = new THREE.Vector3(
        pCorner.x + ux * dot,
        target.y,
        pCorner.z + uz * dot
      );
      return { point: snappedPoint, snapped: true, angleDeg: 180 };
    }
  }

  return { point: target.clone(), snapped: false, angleDeg };
}

/**
 * Calculates average horizontal floor elevation (Y).
 */
export function calculateAverageFloorHeight(points: THREE.Vector3[]): number {
  if (points.length === 0) return 0;
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  return sumY / points.length;
}

/**
 * Calculates room height from floor baseline and ceiling point.
 */
export function calculateCeilingHeight(floorPoints: THREE.Vector3[], ceilingPoint: THREE.Vector3): number {
  if (floorPoints.length === 0) return 0;
  const floorY = calculateAverageFloorHeight(floorPoints);
  return Math.abs(ceilingPoint.y - floorY);
}

/**
 * Calculates volumetric capacity (m³) = Floor Area (m²) * Ceiling Height (m).
 */
export function calculateVolume(floorArea: number, height: number): number {
  return floorArea * height;
}

/**
 * Format distance in metric or imperial (feet & inches)
 */
export function formatDistance(meters: number, unitSystem: UnitSystem = 'metric'): string {
  if (unitSystem === 'imperial') {
    const totalInches = meters * 39.37007874;
    let feet = Math.floor(totalInches / 12);
    let inches = totalInches - feet * 12;
    if (inches >= 11.95) {
      feet += 1;
      inches = 0;
    }
    if (feet === 0) {
      return `${inches.toFixed(1)}"`;
    }
    return `${feet}' ${inches.toFixed(1)}"`;
  }

  if (meters < 1) {
    return `${(meters * 100).toFixed(1)} cm`;
  }
  return `${meters.toFixed(2)} m`;
}

/**
 * Format area in m² or sq ft (or both for export reports)
 */
export function formatArea(
  squareMeters: number,
  unitSystem: UnitSystem = 'metric',
  includeBoth: boolean = false
): string {
  const sqFt = squareMeters * 10.7639104;
  if (includeBoth) {
    return `${squareMeters.toFixed(2)} m² (${sqFt.toFixed(1)} sq ft)`;
  }
  if (unitSystem === 'imperial') {
    return `${sqFt.toFixed(1)} sq ft`;
  }
  return `${squareMeters.toFixed(2)} m²`;
}

/**
 * Format volume in m³ or cu ft (or both for export reports)
 */
export function formatVolume(
  cubicMeters: number,
  unitSystem: UnitSystem = 'metric',
  includeBoth: boolean = false
): string {
  const cuFt = cubicMeters * 35.3146667;
  if (includeBoth) {
    return `${cubicMeters.toFixed(2)} m³ (${cuFt.toFixed(1)} cu ft)`;
  }
  if (unitSystem === 'imperial') {
    return `${cuFt.toFixed(1)} cu ft`;
  }
  return `${cubicMeters.toFixed(2)} m³`;
}
