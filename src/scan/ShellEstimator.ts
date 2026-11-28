import type {
  DetectedWallSegment,
  ScanStats,
  ShellEstimate,
  WallConfidenceLevel
} from './ScanTypes';
import { FREE_CELL_SIZE, type VoxelCell, VoxelGrid, popcount32 } from './VoxelGrid';

interface WallPeak {
  coord: number;
  perpMin: number;
  perpMax: number;
  spanM: number;
  weight: number;
  voxelCount: number;
  upperWallHits: number;
}

interface UVWallVoxel {
  u: number;
  v: number;
  y: number;
  nu: number;
  nv: number;
  weight: number;
  viewpointMask: number;
}

const OCC_CELL = FREE_CELL_SIZE; // 0.10 m

export function pointInPolygonXZ(
  x: number,
  z: number,
  poly: [number, number][]
): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    const intersects =
      zi > z !== zj > z &&
      x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function signedArea2D(pts: [number, number][]): number {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum * 0.5;
}

function perimeter2D(pts: [number, number][]): number {
  let p = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function mergeCollinearOrtho(pts: [number, number][]): [number, number][] {
  let cur = pts.slice();
  let changed = true;
  while (changed && cur.length >= 3) {
    changed = false;
    const next: [number, number][] = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const pPrev = cur[(i - 1 + n) % n];
      const pCurr = cur[i];
      const pNext = cur[(i + 1) % n];
      const d1u = pCurr[0] - pPrev[0];
      const d1v = pCurr[1] - pPrev[1];
      const d2u = pNext[0] - pCurr[0];
      const d2v = pNext[1] - pCurr[1];
      const len1 = Math.hypot(d1u, d1v);
      const len2 = Math.hypot(d2u, d2v);
      if (len1 < 1e-4 || len2 < 1e-4) {
        changed = true;
        continue;
      }
      const cross = Math.abs(d1u * d2v - d1v * d2u) / (len1 * len2);
      if (cross < 0.02) {
        // Collinear (180 deg) or 0-deg foldback
        changed = true;
        continue;
      }
      next.push(pCurr);
    }
    cur = next;
  }
  return cur;
}

function simplifyOrthogonalLoop(rawPts: [number, number][], minStepM = 0.28): [number, number][] {
  let pts = mergeCollinearOrtho(rawPts.map(([u, v]) => [u, v]));

  for (let iter = 0; iter < 64 && pts.length > 4; iter++) {
    const n = pts.length;
    let shortestIdx = -1;
    let shortestLen = minStepM;

    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < shortestLen) {
        shortestLen = len;
        shortestIdx = i;
      }
    }

    if (shortestIdx === -1) break;

    const iPrev = (shortestIdx - 1 + n) % n;
    const iA = shortestIdx;
    const iB = (shortestIdx + 1) % n;
    const iNext = (shortestIdx + 2) % n;

    const pPrev = pts[iPrev];
    const pA = pts[iA];
    const pB = pts[iB];
    const pNext = pts[iNext];

    const vPrevX = pA[0] - pPrev[0];
    const vPrevY = pA[1] - pPrev[1];
    const vNextX = pNext[0] - pB[0];
    const vNextY = pNext[1] - pB[1];
    const lenPrev = Math.hypot(vPrevX, vPrevY);
    const lenNext = Math.hypot(vNextX, vNextY);
    const dot = vPrevX * vNextX + vPrevY * vNextY;

    if (dot < 0) {
      // U-turn spike/notch: drop pA and pB if removing doesn't drop below 4
      if (pts.length - 2 >= 4) {
        const filtered = pts.filter((_, idx) => idx !== iA && idx !== iB);
        pts = mergeCollinearOrtho(filtered);
        continue;
      }
    }

    // Staircase step: align shorter flanking segment onto longer flanking segment's axis coord
    const isEdgeVertical = Math.abs(pB[0] - pA[0]) < Math.abs(pB[1] - pA[1]);
    if (lenPrev >= lenNext) {
      // Keep pPrev->pA line, shift pB and pNext onto pA's perpendicular coordinate
      if (isEdgeVertical) {
        // Short edge is vertical (changes Y), flanking edges are horizontal (constant Y)
        pB[1] = pA[1];
        pNext[1] = pA[1];
      } else {
        pB[0] = pA[0];
        pNext[0] = pA[0];
      }
    } else {
      if (isEdgeVertical) {
        pA[1] = pB[1];
        pPrev[1] = pB[1];
      } else {
        pA[0] = pB[0];
        pPrev[0] = pB[0];
      }
    }
    pts = mergeCollinearOrtho(pts);
  }

  return mergeCollinearOrtho(pts);
}

export class ShellEstimator {
  public static estimateShell(grid: VoxelGrid): { shell: ShellEstimate; stats: ScanStats } {
    const camPos = grid.getLatestCamPos();
    const { floorY, floorConfidence, ceilingY, ceilingConfidence, provisionalCeilingY } =
      this.estimateFloorAndCeiling(grid, camPos[1]);

    grid.setEstimatedFloorY(floorY);

    const wallVoxels = this.collectWallVoxels(grid, floorY, provisionalCeilingY);
    const frameCount = grid.getFrameCount();
    const distinctViewpoints = grid.getDistinctViewpoints();
    const voxelCount = grid.getVoxelCount();

    const emptyShell: ShellEstimate = {
      valid: false,
      floorY: round3(floorY),
      floorConfidence: round2(floorConfidence),
      ceilingY: ceilingY !== null ? round3(ceilingY) : null,
      ceilingConfidence: round2(ceilingConfidence),
      provisionalCeilingY: round3(provisionalCeilingY),
      yawRad: 0,
      cornersXZ: [],
      walls: [],
      floorAreaSqM: 0,
      perimeterM: 0
    };

    if (wallVoxels.length < 35) {
      return {
        shell: emptyShell,
        stats: {
          voxelCount,
          wallVoxelCount: wallVoxels.length,
          frameCount,
          distinctViewpoints,
          readinessPct: Math.min(20, Math.round((wallVoxels.length / 35) * 20)),
          guidanceHint: 'Pan slowly around the room walls and floor to start mapping.'
        }
      };
    }

    const yawRad = this.estimateManhattanYaw(wallVoxels, grid);
    const ux = Math.cos(yawRad);
    const uz = Math.sin(yawRad);
    const vx = -uz;
    const vz = ux;

    // Project wall voxels into Manhattan (u, v) frame
    const uvVoxels: UVWallVoxel[] = [];
    const plusUVoxels: UVWallVoxel[] = [];
    const minusUVoxels: UVWallVoxel[] = [];
    const plusVVoxels: UVWallVoxel[] = [];
    const minusVVoxels: UVWallVoxel[] = [];

    for (let i = 0; i < wallVoxels.length; i++) {
      const wv = wallVoxels[i];
      const invH = 1 / wv.hits;
      const px = wv.sumX * invH;
      const py = wv.sumY * invH;
      const pz = wv.sumZ * invH;
      const nLen = Math.hypot(wv.sumNx, wv.sumNz) || 1;
      const nx = wv.sumNx / nLen;
      const nz = wv.sumNz / nLen;

      const u = px * ux + pz * uz;
      const v = px * vx + pz * vz;
      const nu = nx * ux + nz * uz;
      const nv = nx * vx + nz * vz;

      const item: UVWallVoxel = {
        u,
        v,
        y: py,
        nu,
        nv,
        weight: wv.sumWeight,
        viewpointMask: wv.viewpointMask
      };
      uvVoxels.push(item);

      if (nu > 0.82) plusUVoxels.push(item);
      else if (nu < -0.82) minusUVoxels.push(item);
      else if (nv > 0.82) plusVVoxels.push(item);
      else if (nv < -0.82) minusVVoxels.push(item);
    }

    const plusUPeaks = this.extractWallPeaks(plusUVoxels, 'u', floorY);
    const minusUPeaks = this.extractWallPeaks(minusUVoxels, 'u', floorY);
    const plusVPeaks = this.extractWallPeaks(plusVVoxels, 'v', floorY);
    const minusVPeaks = this.extractWallPeaks(minusVVoxels, 'v', floorY);

    const cornersUV = this.extractManhattanPolygon(
      grid,
      uvVoxels,
      ux,
      uz,
      vx,
      vz,
      plusUPeaks,
      minusUPeaks,
      plusVPeaks,
      minusVPeaks
    );

    if (cornersUV.length < 3) {
      return {
        shell: { ...emptyShell, yawRad },
        stats: {
          voxelCount,
          wallVoxelCount: wallVoxels.length,
          frameCount,
          distinctViewpoints,
          readinessPct: 25,
          guidanceHint: 'Keep panning across more walls to close the room perimeter.'
        }
      };
    }

    // Ensure CCW winding in (u, v) so inward normal is (-dv, du)
    let orderedUV = signedArea2D(cornersUV) < 0 ? cornersUV.slice().reverse() : cornersUV.slice();
    // Strip degenerate edges < 5cm so walls[i] stays strictly 1-to-1 with polygon edge i
    orderedUV = orderedUV.filter((pt, idx) => {
      const next = orderedUV[(idx + 1) % orderedUV.length];
      return Math.hypot(next[0] - pt[0], next[1] - pt[1]) >= 0.05;
    });

    if (orderedUV.length < 3) {
      return {
        shell: { ...emptyShell, yawRad },
        stats: {
          voxelCount,
          wallVoxelCount: wallVoxels.length,
          frameCount,
          distinctViewpoints,
          readinessPct: 25,
          guidanceHint: 'Keep panning across more walls to close the room perimeter.'
        }
      };
    }

    // Transform back to world XZ
    const cornersXZ: [number, number][] = orderedUV.map(([u, v]) => [
      round3(u * ux + v * vx),
      round3(u * uz + v * vz)
    ]);

    const floorAreaSqM = round2(Math.abs(signedArea2D(cornersXZ)));
    const perimeterM = round2(perimeter2D(cornersXZ));

    if (floorAreaSqM < 0.8) {
      return {
        shell: { ...emptyShell, yawRad },
        stats: {
          voxelCount,
          wallVoxelCount: wallVoxels.length,
          frameCount,
          distinctViewpoints,
          readinessPct: 25,
          guidanceHint: 'Walk further into the room and sweep all 4 walls.'
        }
      };
    }

    // Score each wall segment against accumulated wall voxels
    const walls = this.scoreWallSegments(orderedUV, cornersXZ, uvVoxels, ux, uz, vx, vz);

    let readySum = 0;
    let lowestWall: DetectedWallSegment | null = null;
    let lowestScore = Infinity;
    let goodWalls = 0;

    for (const w of walls) {
      if (w.confidence === 'good') goodWalls++;
      const covFactor = Math.min(1, w.coveragePct / 60);
      const passFactor = Math.min(1, w.passCount / 3);
      const sigFactor = Math.max(0, Math.min(1, 1 - (w.sigmaCm - 1.0) / 3.5));
      const wallScore = 0.45 * covFactor + 0.35 * passFactor + 0.20 * sigFactor;
      readySum += wallScore;
      if (wallScore < lowestScore) {
        lowestScore = wallScore;
        lowestWall = w;
      }
    }

    const wallReadyAvg = walls.length > 0 ? readySum / walls.length : 0;
    const floorBonus = floorConfidence >= 0.4 ? 0.1 : 0;
    const ceilBonus = ceilingY !== null ? 0.1 : 0;
    const readinessPct = Math.min(100, Math.round((wallReadyAvg * 0.8 + floorBonus + ceilBonus) * 100));

    let guidanceHint = 'Walk past each wall from another angle for higher accuracy.';
    if (goodWalls === walls.length && walls.length >= 3) {
      guidanceHint =
        ceilingY !== null
          ? 'All walls high confidence! Tap Finish & Edit 3D Wireframe.'
          : 'All walls locked! Tilt slightly toward wall-ceiling corner or finish now.';
    } else if (lowestWall) {
      if (lowestWall.coveragePct < 45) {
        guidanceHint = `Scan Wall #${lowestWall.index + 1} (${lowestWall.lengthM.toFixed(1)}m) further — ${lowestWall.coveragePct.toFixed(0)}% covered.`;
      } else if (lowestWall.passCount < 3) {
        guidanceHint = `View Wall #${lowestWall.index + 1} from ${3 - lowestWall.passCount} more spot(s) to boost accuracy.`;
      } else {
        guidanceHint = `Move closer to Wall #${lowestWall.index + 1} to tighten ±${lowestWall.sigmaCm.toFixed(1)}cm.`;
      }
    }

    return {
      shell: {
        valid: true,
        floorY: round3(floorY),
        floorConfidence: round2(floorConfidence),
        ceilingY: ceilingY !== null ? round3(ceilingY) : null,
        ceilingConfidence: round2(ceilingConfidence),
        provisionalCeilingY: round3(provisionalCeilingY),
        yawRad,
        cornersXZ,
        walls,
        floorAreaSqM,
        perimeterM
      },
      stats: {
        voxelCount,
        wallVoxelCount: wallVoxels.length,
        frameCount,
        distinctViewpoints,
        readinessPct,
        guidanceHint
      }
    };
  }

  private static estimateFloorAndCeiling(
    grid: VoxelGrid,
    camY: number
  ): {
    floorY: number;
    floorConfidence: number;
    ceilingY: number | null;
    ceilingConfidence: number;
    provisionalCeilingY: number;
  } {
    const BIN = 0.02;
    const floorBins = new Map<number, number>();
    const ceilBins = new Map<number, number>();
    let floorPlaneBestArea = 0;
    let ceilPlaneBestArea = 0;

    for (const p of grid.getLatestPlanes()) {
      if (p.orientation !== 'horizontal') continue;
      if (p.centerY < camY - 0.45 && p.areaSqM >= 1.2) {
        const b = Math.round(p.centerY / BIN);
        const w = p.areaSqM * 120;
        floorBins.set(b, (floorBins.get(b) ?? 0) + w);
        if (p.areaSqM > floorPlaneBestArea) floorPlaneBestArea = p.areaSqM;
      }
    }

    let upVoxelCount = 0;
    for (const v of grid.getVoxels()) {
      if (v.hits < 2) continue;
      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;
      const py = v.sumY / v.hits;
      if (ny > 0.72 && py < camY - 0.45) {
        upVoxelCount++;
        const b = Math.round(py / BIN);
        floorBins.set(b, (floorBins.get(b) ?? 0) + v.sumWeight);
      }
    }

    if (upVoxelCount < 15 && floorBins.size === 0) {
      for (const v of grid.getVoxels()) {
        const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
        const ny = v.sumNy / nLen;
        const py = v.sumY / v.hits;
        if (ny > 0.72 && py < camY - 0.45) {
          const b = Math.round(py / BIN);
          floorBins.set(b, (floorBins.get(b) ?? 0) + v.sumWeight);
        }
      }
    }

    let floorY = camY - 1.30;
    let floorConfidence = 0;

    if (floorBins.size > 0) {
      const smoothed = new Map<number, number>();
      let maxW = 0;
      for (const [b] of floorBins) {
        const sw =
          0.25 * (floorBins.get(b - 1) ?? 0) +
          0.5 * (floorBins.get(b) ?? 0) +
          0.25 * (floorBins.get(b + 1) ?? 0);
        smoothed.set(b, sw);
        if (sw > maxW) maxW = sw;
      }

      const sortedBins = Array.from(smoothed.keys()).sort((a, b) => a - b);
      let chosenBin = sortedBins[0];
      for (const b of sortedBins) {
        if ((smoothed.get(b) ?? 0) >= maxW * 0.2) {
          chosenBin = b;
          break;
        }
      }

      let wSum = 0;
      let ySum = 0;
      for (let db = -2; db <= 2; db++) {
        const b = chosenBin + db;
        const w = floorBins.get(b) ?? 0;
        if (w > 0) {
          wSum += w;
          ySum += w * (b * BIN);
        }
      }
      if (wSum > 0) {
        floorY = ySum / wSum;
        floorConfidence = Math.min(1, Math.max(floorPlaneBestArea >= 2.0 ? 0.9 : 0, wSum / 45));
      }
    }

    // Ceiling: fuse downward voxels + ceiling horizontal XRPlanes + wall-ceiling seam bins
    for (const p of grid.getLatestPlanes()) {
      if (p.orientation !== 'horizontal') continue;
      if (p.centerY > floorY + 1.85 && p.centerY < floorY + 4.2 && p.areaSqM >= 0.8) {
        const b = Math.round(p.centerY / BIN);
        ceilBins.set(b, (ceilBins.get(b) ?? 0) + p.areaSqM * 100);
        if (p.areaSqM > ceilPlaneBestArea) ceilPlaneBestArea = p.areaSqM;
      }
    }

    for (const v of grid.getVoxels()) {
      if (v.hits < 2) continue;
      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;
      const py = v.sumY / v.hits;
      if (ny < -0.70 && py > floorY + 1.85 && py < floorY + 4.2) {
        const b = Math.round(py / BIN);
        ceilBins.set(b, (ceilBins.get(b) ?? 0) + v.sumWeight);
      }
    }

    // Seam bins
    const seamBins = grid.getCeilingSeamBins();
    for (const [b, hits] of seamBins) {
      const y = b * BIN;
      if (y >= floorY + 1.90 && y <= floorY + 3.80) {
        const localHits =
          (seamBins.get(b - 1) ?? 0) + hits + (seamBins.get(b + 1) ?? 0);
        if (localHits >= 16) {
          ceilBins.set(b, (ceilBins.get(b) ?? 0) + hits * 0.65);
        }
      }
    }

    let ceilingY: number | null = null;
    let ceilingConfidence = 0;

    if (ceilBins.size > 0) {
      let bestBin = 0;
      let bestW = 0;
      for (const [b] of ceilBins) {
        const sw =
          0.25 * (ceilBins.get(b - 1) ?? 0) +
          0.5 * (ceilBins.get(b) ?? 0) +
          0.25 * (ceilBins.get(b + 1) ?? 0);
        if (sw > bestW) {
          bestW = sw;
          bestBin = b;
        }
      }

      if (bestW >= 9 || ceilPlaneBestArea >= 0.8) {
        let wSum = 0;
        let ySum = 0;
        for (let db = -2; db <= 2; db++) {
          const b = bestBin + db;
          const w = ceilBins.get(b) ?? 0;
          if (w > 0) {
            wSum += w;
            ySum += w * (b * BIN);
          }
        }
        if (wSum > 0) {
          ceilingY = ySum / wSum;
          ceilingConfidence = Math.min(1, bestW / 40);
        }
      }
    }

    return {
      floorY,
      floorConfidence,
      ceilingY,
      ceilingConfidence,
      provisionalCeilingY: ceilingY ?? floorY + 2.50
    };
  }

  private static collectWallVoxels(
    grid: VoxelGrid,
    floorY: number,
    provisionalCeilingY: number
  ): VoxelCell[] {
    const minY = floorY + 0.12;
    const maxY = provisionalCeilingY - 0.05;
    const out: VoxelCell[] = [];

    for (const v of grid.getVoxels()) {
      if (v.hits < 2) continue;
      const py = v.sumY / v.hits;
      if (py < minY || py > maxY) continue;
      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;
      if (Math.abs(ny) < 0.35) {
        out.push(v);
      }
    }

    if (out.length < 35) {
      out.length = 0;
      for (const v of grid.getVoxels()) {
        const py = v.sumY / v.hits;
        if (py < minY || py > maxY) continue;
        const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
        const ny = v.sumNy / nLen;
        if (Math.abs(ny) < 0.35) {
          out.push(v);
        }
      }
    }

    return out;
  }

  private static estimateManhattanYaw(wallVoxels: VoxelCell[], grid: VoxelGrid): number {
    const hist = new Float64Array(90);

    for (let i = 0; i < wallVoxels.length; i++) {
      const v = wallVoxels[i];
      const ang = Math.atan2(v.sumNz, v.sumNx);
      const deg = (((ang * 180) / Math.PI) % 90 + 90) % 90;
      const bin = Math.floor(deg) % 90;
      hist[bin] += v.sumWeight;
    }

    for (const p of grid.getLatestPlanes()) {
      if (p.orientation === 'vertical' && p.normalXZ) {
        const ang = Math.atan2(p.normalXZ[1], p.normalXZ[0]);
        const deg = (((ang * 180) / Math.PI) % 90 + 90) % 90;
        const bin = Math.floor(deg) % 90;
        hist[bin] += p.areaSqM * 80;
      }
    }

    const smoothed = new Float64Array(90);
    let peakIdx = 0;
    let peakVal = -1;
    for (let i = 0; i < 90; i++) {
      const s =
        0.15 * hist[(i - 2 + 90) % 90] +
        0.22 * hist[(i - 1 + 90) % 90] +
        0.26 * hist[i] +
        0.22 * hist[(i + 1) % 90] +
        0.15 * hist[(i + 2) % 90];
      smoothed[i] = s;
      if (s > peakVal) {
        peakVal = s;
        peakIdx = i;
      }
    }

    const y1 = smoothed[(peakIdx - 1 + 90) % 90];
    const y2 = smoothed[peakIdx];
    const y3 = smoothed[(peakIdx + 1) % 90];
    const denom = 2 * (y1 - 2 * y2 + y3);
    const delta = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (y1 - y3) / denom)) : 0;
    const peakDeg = (((peakIdx + 0.5 + delta) % 90) + 90) % 90;
    return (peakDeg * Math.PI) / 180;
  }

  private static extractWallPeaks(
    familyVoxels: UVWallVoxel[],
    primaryAxis: 'u' | 'v',
    floorY: number
  ): WallPeak[] {
    if (familyVoxels.length < 6) return [];

    const BIN = 0.02;
    const hist = new Map<number, number>();
    let minBin = Infinity;
    let maxBin = -Infinity;

    for (let i = 0; i < familyVoxels.length; i++) {
      const c = primaryAxis === 'u' ? familyVoxels[i].u : familyVoxels[i].v;
      const b = Math.round(c / BIN);
      hist.set(b, (hist.get(b) ?? 0) + familyVoxels[i].weight);
      if (b < minBin) minBin = b;
      if (b > maxBin) maxBin = b;
    }

    const smoothed = new Map<number, number>();
    let maxSmooth = 0;
    for (let b = minBin; b <= maxBin; b++) {
      const sw =
        0.1 * (hist.get(b - 2) ?? 0) +
        0.2 * (hist.get(b - 1) ?? 0) +
        0.4 * (hist.get(b) ?? 0) +
        0.2 * (hist.get(b + 1) ?? 0) +
        0.1 * (hist.get(b + 2) ?? 0);
      if (sw > 0) {
        smoothed.set(b, sw);
        if (sw > maxSmooth) maxSmooth = sw;
      }
    }

    const candidates: { bin: number; score: number }[] = [];
    for (let b = minBin; b <= maxBin; b++) {
      const cur = smoothed.get(b) ?? 0;
      if (cur < maxSmooth * 0.12) continue;
      if (cur >= (smoothed.get(b - 1) ?? 0) && cur >= (smoothed.get(b + 1) ?? 0)) {
        candidates.push({ bin: b, score: cur });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const chosenBins: number[] = [];
    for (const cand of candidates) {
      if (chosenBins.every((cb) => Math.abs(cb - cand.bin) >= 14)) {
        chosenBins.push(cand.bin);
      }
    }

    const peaks: WallPeak[] = [];
    for (const cb of chosenBins) {
      const roughCoord = cb * BIN;
      let wSum = 0;
      let cSum = 0;
      let perpMin = Infinity;
      let perpMax = -Infinity;
      let count = 0;
      let upperHits = 0;
      const perpBins = new Set<number>();

      for (let i = 0; i < familyVoxels.length; i++) {
        const wv = familyVoxels[i];
        const coord = primaryAxis === 'u' ? wv.u : wv.v;
        if (Math.abs(coord - roughCoord) > 0.12) continue;
        const perp = primaryAxis === 'u' ? wv.v : wv.u;

        wSum += wv.weight;
        cSum += wv.weight * coord;
        if (perp < perpMin) perpMin = perp;
        if (perp > perpMax) perpMax = perp;
        perpBins.add(Math.floor(perp / 0.2));
        if (wv.y > floorY + 0.95) upperHits++;
        count++;
      }

      const spanM = perpBins.size * 0.2;
      if (count >= 6 && spanM >= 0.35 && wSum > 0) {
        peaks.push({
          coord: cSum / wSum,
          perpMin,
          perpMax,
          spanM,
          weight: wSum,
          voxelCount: count,
          upperWallHits: upperHits
        });
      }
    }

    return peaks;
  }

  private static extractManhattanPolygon(
    grid: VoxelGrid,
    uvVoxels: UVWallVoxel[],
    ux: number,
    uz: number,
    vx: number,
    vz: number,
    plusUPeaks: WallPeak[],
    minusUPeaks: WallPeak[],
    plusVPeaks: WallPeak[],
    minusVPeaks: WallPeak[]
  ): [number, number][] {
    // Compute UV bounds across freeCells + wallVoxels
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;

    const freeUVs: { u: number; v: number; traversed: boolean }[] = [];
    for (const fc of grid.getFreeCells()) {
      if (!fc.traversed && fc.freeHits < 2) continue;
      const wx = (fc.kx + 0.5) * OCC_CELL;
      const wz = (fc.kz + 0.5) * OCC_CELL;
      const u = wx * ux + wz * uz;
      const v = wx * vx + wz * vz;
      freeUVs.push({ u, v, traversed: fc.traversed });
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }

    if (freeUVs.length < 4) return [];

    for (let i = 0; i < uvVoxels.length; i++) {
      const { u, v } = uvVoxels[i];
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }

    // Pad by 0.60 m so border flood-fill always starts outside
    uMin -= 0.6;
    vMin -= 0.6;
    uMax += 0.6;
    vMax += 0.6;

    const cols = Math.min(250, Math.max(8, Math.ceil((uMax - uMin) / OCC_CELL)));
    const rows = Math.min(250, Math.max(8, Math.ceil((vMax - vMin) / OCC_CELL)));
    const total = cols * rows;
    let occ = new Uint8Array(total);
    const travCount = new Uint16Array(total);

    for (let i = 0; i < freeUVs.length; i++) {
      const cu = Math.floor((freeUVs[i].u - uMin) / OCC_CELL);
      const cv = Math.floor((freeUVs[i].v - vMin) / OCC_CELL);
      if (cu >= 1 && cu < cols - 1 && cv >= 1 && cv < rows - 1) {
        const idx = cv * cols + cu;
        occ[idx] = 1;
        if (freeUVs[i].traversed) travCount[idx]++;
      }
    }

    // Also include floor XRPlane polygons if available
    for (const p of grid.getLatestPlanes()) {
      if (p.orientation !== 'horizontal' || p.areaSqM < 1.2 || p.worldVertices.length < 9) {
        continue;
      }
      const floorY = grid.getEstimatedFloorY();
      if (floorY !== null && Math.abs(p.centerY - floorY) > 0.12) continue;
      // Rasterize bounding interior? Only vertices + centroid to avoid over-expanding L-shapes
      const verts = p.worldVertices;
      for (let i = 0; i < verts.length; i += 3) {
        const u = verts[i] * ux + verts[i + 2] * uz;
        const v = verts[i] * vx + verts[i + 2] * vz;
        const cu = Math.floor((u - uMin) / OCC_CELL);
        const cv = Math.floor((v - vMin) / OCC_CELL);
        if (cu >= 1 && cu < cols - 1 && cv >= 1 && cv < rows - 1) {
          occ[cv * cols + cu] = 1;
        }
      }
    }

    // Morphological close (3x3 dilate then 3x3 erode) to eliminate rotation moire holes
    const dilated = new Uint8Array(total);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (occ[r * cols + c] === 1) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              dilated[(r + dr) * cols + (c + dc)] = 1;
            }
          }
        }
      }
    }
    const closed = new Uint8Array(total);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        let all = 1;
        for (let dr = -1; dr <= 1 && all === 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dilated[(r + dr) * cols + (c + dc)] === 0) {
              all = 0;
              break;
            }
          }
        }
        closed[r * cols + c] = all;
      }
    }
    occ = closed;

    // Expand behind wall-adjacent cabinets/furniture toward outer wall peaks
    this.expandMaskToOuterWalls(occ, cols, rows, uMin, vMin, plusUPeaks, minusUPeaks, plusVPeaks, minusVPeaks);

    // Trim narrow untraversed doorway protrusions outside strong perimeter wall peaks
    this.closeUntraversedDoorwayNecks(occ, travCount, cols, rows, uMin, vMin, plusUPeaks, minusUPeaks, plusVPeaks, minusVPeaks);

    // Flood-fill exterior from borders and fill interior islands < 2.5 m^2 (250 cells)
    this.fillSmallInteriorHoles(occ, cols, rows, 250);

    // Keep single 4-connected component containing most camera trajectory cells (or largest)
    this.keepMainComponent(occ, travCount, cols, rows);

    // Resolve any 2x2 diagonal checkerboard touches so boundary tracing is unambiguous
    for (let r = 1; r < rows - 2; r++) {
      for (let c = 1; c < cols - 2; c++) {
        const a = occ[r * cols + c];
        const b = occ[r * cols + c + 1];
        const d = occ[(r + 1) * cols + c];
        const e = occ[(r + 1) * cols + c + 1];
        if (a === 1 && e === 1 && b === 0 && d === 0) {
          occ[r * cols + c + 1] = 1;
        } else if (b === 1 && d === 1 && a === 0 && e === 0) {
          occ[r * cols + c] = 1;
        }
      }
    }

    const rawLoopUV = this.traceBoundaryLoop(occ, cols, rows, uMin, vMin);
    if (rawLoopUV.length < 4) return [];

    let simplified = simplifyOrthogonalLoop(rawLoopUV, 0.42);
    if (simplified.length < 4) return [];

    // Ensure CCW before snapping edges to signed wall peaks
    if (signedArea2D(simplified) < 0) {
      simplified.reverse();
    }

    simplified = this.snapEdgesToWallPeaks(
      simplified,
      plusUPeaks,
      minusUPeaks,
      plusVPeaks,
      minusVPeaks
    );

    return simplifyOrthogonalLoop(simplified, 0.30);
  }

  private static expandMaskToOuterWalls(
    occ: Uint8Array,
    cols: number,
    rows: number,
    uMin: number,
    vMin: number,
    plusUPeaks: WallPeak[],
    minusUPeaks: WallPeak[],
    plusVPeaks: WallPeak[],
    minusVPeaks: WallPeak[]
  ): void {
    const MAX_GAP_CELLS = 8; // 0.80 m cabinet/furniture depth

    // plusU walls (left / -U side)
    for (const pk of plusUPeaks) {
      if (pk.upperWallHits === 0 && pk.spanM < 0.8) continue;
      const cuPeak = Math.max(1, Math.min(cols - 2, Math.floor((pk.coord - uMin) / OCC_CELL)));
      const cvStart = Math.max(1, Math.floor((pk.perpMin - vMin) / OCC_CELL));
      const cvEnd = Math.min(rows - 2, Math.ceil((pk.perpMax - vMin) / OCC_CELL));

      for (let cv = cvStart; cv <= cvEnd; cv++) {
        let foundCu = -1;
        for (let cu = cuPeak; cu <= Math.min(cols - 2, cuPeak + MAX_GAP_CELLS); cu++) {
          if (occ[cv * cols + cu] === 1) {
            foundCu = cu;
            break;
          }
        }
        if (foundCu > cuPeak) {
          const foundU = uMin + (foundCu + 0.5) * OCC_CELL;
          const blocked = minusUPeaks.some(
            (op) => op.spanM >= 0.6 && op.coord > pk.coord + 0.12 && op.coord < foundU - 0.12
          );
          if (!blocked) {
            for (let cu = cuPeak; cu < foundCu; cu++) {
              occ[cv * cols + cu] = 1;
            }
          }
        }
      }
    }

    // minusU walls (right / +U side)
    for (const pk of minusUPeaks) {
      if (pk.upperWallHits === 0 && pk.spanM < 0.8) continue;
      const cuPeak = Math.max(1, Math.min(cols - 2, Math.floor((pk.coord - uMin) / OCC_CELL)));
      const cvStart = Math.max(1, Math.floor((pk.perpMin - vMin) / OCC_CELL));
      const cvEnd = Math.min(rows - 2, Math.ceil((pk.perpMax - vMin) / OCC_CELL));

      for (let cv = cvStart; cv <= cvEnd; cv++) {
        let foundCu = -1;
        for (let cu = cuPeak; cu >= Math.max(1, cuPeak - MAX_GAP_CELLS); cu--) {
          if (occ[cv * cols + cu] === 1) {
            foundCu = cu;
            break;
          }
        }
        if (foundCu !== -1 && foundCu < cuPeak) {
          const foundU = uMin + (foundCu + 0.5) * OCC_CELL;
          const blocked = plusUPeaks.some(
            (op) => op.spanM >= 0.6 && op.coord < pk.coord - 0.12 && op.coord > foundU + 0.12
          );
          if (!blocked) {
            for (let cu = foundCu + 1; cu <= cuPeak; cu++) {
              occ[cv * cols + cu] = 1;
            }
          }
        }
      }
    }

    // plusV walls (bottom / -V side)
    for (const pk of plusVPeaks) {
      if (pk.upperWallHits === 0 && pk.spanM < 0.8) continue;
      const cvPeak = Math.max(1, Math.min(rows - 2, Math.floor((pk.coord - vMin) / OCC_CELL)));
      const cuStart = Math.max(1, Math.floor((pk.perpMin - uMin) / OCC_CELL));
      const cuEnd = Math.min(cols - 2, Math.ceil((pk.perpMax - uMin) / OCC_CELL));

      for (let cu = cuStart; cu <= cuEnd; cu++) {
        let foundCv = -1;
        for (let cv = cvPeak; cv <= Math.min(rows - 2, cvPeak + MAX_GAP_CELLS); cv++) {
          if (occ[cv * cols + cu] === 1) {
            foundCv = cv;
            break;
          }
        }
        if (foundCv > cvPeak) {
          const foundV = vMin + (foundCv + 0.5) * OCC_CELL;
          const blocked = minusVPeaks.some(
            (op) => op.spanM >= 0.6 && op.coord > pk.coord + 0.12 && op.coord < foundV - 0.12
          );
          if (!blocked) {
            for (let cv = cvPeak; cv < foundCv; cv++) {
              occ[cv * cols + cu] = 1;
            }
          }
        }
      }
    }

    // minusV walls (top / +V side)
    for (const pk of minusVPeaks) {
      if (pk.upperWallHits === 0 && pk.spanM < 0.8) continue;
      const cvPeak = Math.max(1, Math.min(rows - 2, Math.floor((pk.coord - vMin) / OCC_CELL)));
      const cuStart = Math.max(1, Math.floor((pk.perpMin - uMin) / OCC_CELL));
      const cuEnd = Math.min(cols - 2, Math.ceil((pk.perpMax - uMin) / OCC_CELL));

      for (let cu = cuStart; cu <= cuEnd; cu++) {
        let foundCv = -1;
        for (let cv = cvPeak; cv >= Math.max(1, cvPeak - MAX_GAP_CELLS); cv--) {
          if (occ[cv * cols + cu] === 1) {
            foundCv = cv;
            break;
          }
        }
        if (foundCv !== -1 && foundCv < cvPeak) {
          const foundV = vMin + (foundCv + 0.5) * OCC_CELL;
          const blocked = plusVPeaks.some(
            (op) => op.spanM >= 0.6 && op.coord < pk.coord - 0.12 && op.coord > foundV + 0.12
          );
          if (!blocked) {
            for (let cv = foundCv + 1; cv <= cvPeak; cv++) {
              occ[cv * cols + cu] = 1;
            }
          }
        }
      }
    }
  }

  private static closeUntraversedDoorwayNecks(
    occ: Uint8Array,
    travCount: Uint16Array,
    cols: number,
    rows: number,
    uMin: number,
    vMin: number,
    plusUPeaks: WallPeak[],
    minusUPeaks: WallPeak[],
    plusVPeaks: WallPeak[],
    minusVPeaks: WallPeak[]
  ): void {
    const MAX_DOOR_CELLS = 14; // 1.4 m
    const trimFamily = (peaks: WallPeak[], axis: 'u' | 'v', inwardSign: 1 | -1) => {
      const primMin = axis === 'u' ? uMin : vMin;
      const tanMin = axis === 'u' ? vMin : uMin;
      const primLimit = axis === 'u' ? cols : rows;
      const tanLimit = axis === 'u' ? rows : cols;
      const cellIdx = (p: number, t: number) => (axis === 'u' ? t * cols + p : p * cols + t);

      for (const pk of peaks) {
        if (pk.spanM < 1.2 || pk.upperWallHits < 4) continue;
        const pPeak = Math.max(1, Math.min(primLimit - 2, Math.floor((pk.coord - primMin) / OCC_CELL)));
        const tStart = Math.max(1, Math.floor((pk.perpMin - tanMin) / OCC_CELL));
        const tEnd = Math.min(tanLimit - 2, Math.ceil((pk.perpMax - tanMin) / OCC_CELL));
        const outDir = -inwardSign;

        const span = tEnd - tStart + 1;
        if (span < 6) continue;
        const hasInside = new Uint8Array(span);
        const hasOutside = new Uint8Array(span);

        for (let i = 0; i < span; i++) {
          const t = tStart + i;
          for (let k = 0; k <= 3; k++) {
            const pIn = pPeak + inwardSign * k;
            if (pIn >= 0 && pIn < primLimit && occ[cellIdx(pIn, t)] === 1) {
              hasInside[i] = 1;
              break;
            }
          }
          for (let k = 1; k <= 20; k++) {
            const pOut = pPeak + outDir * k;
            if (pOut < 0 || pOut >= primLimit) break;
            if (occ[cellIdx(pOut, t)] === 1) {
              hasOutside[i] = 1;
              break;
            }
          }
        }

        let i = 0;
        while (i < span) {
          if (hasOutside[i] === 0) {
            i++;
            continue;
          }
          const rStart = i;
          while (i < span && hasOutside[i] === 1) i++;
          const rEnd = i - 1;
          const widthCells = rEnd - rStart + 1;
          const leftBound = rStart > 0 && hasInside[rStart - 1] === 1 && hasOutside[rStart - 1] === 0;
          const rightBound = i < span && hasInside[i] === 1 && hasOutside[i] === 0;

          if (!leftBound || !rightBound || widthCells > MAX_DOOR_CELLS) continue;

          // Keep L-shape or connected room if camera ever walked out past this line
          let anyTraversed = false;
          for (let j = rStart; j <= rEnd && !anyTraversed; j++) {
            const t = tStart + j;
            for (let k = 1; k <= 24; k++) {
              const pOut = pPeak + outDir * k;
              if (pOut < 0 || pOut >= primLimit) break;
              if (travCount[cellIdx(pOut, t)] > 0) {
                anyTraversed = true;
                break;
              }
            }
          }
          if (anyTraversed) continue;

          for (let j = rStart; j <= rEnd; j++) {
            const t = tStart + j;
            for (let k = 1; k <= 24; k++) {
              const pOut = pPeak + outDir * k;
              if (pOut < 0 || pOut >= primLimit) break;
              occ[cellIdx(pOut, t)] = 0;
            }
          }
        }
      }
    };

    trimFamily(plusUPeaks, 'u', 1);
    trimFamily(minusUPeaks, 'u', -1);
    trimFamily(plusVPeaks, 'v', 1);
    trimFamily(minusVPeaks, 'v', -1);
  }

  private static fillSmallInteriorHoles(
    occ: Uint8Array,
    cols: number,
    rows: number,
    maxHoleCells: number
  ): void {
    const total = cols * rows;
    const exterior = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;

    const pushIfZero = (idx: number) => {
      if (occ[idx] === 0 && exterior[idx] === 0) {
        exterior[idx] = 1;
        queue[tail++] = idx;
      }
    };

    for (let c = 0; c < cols; c++) {
      pushIfZero(c);
      pushIfZero((rows - 1) * cols + c);
    }
    for (let r = 0; r < rows; r++) {
      pushIfZero(r * cols);
      pushIfZero(r * cols + cols - 1);
    }

    while (head < tail) {
      const idx = queue[head++];
      const r = Math.floor(idx / cols);
      const c = idx - r * cols;
      if (c > 0) pushIfZero(idx - 1);
      if (c + 1 < cols) pushIfZero(idx + 1);
      if (r > 0) pushIfZero(idx - cols);
      if (r + 1 < rows) pushIfZero(idx + cols);
    }

    const visited = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (occ[i] === 0 && exterior[i] === 0 && visited[i] === 0) {
        const comp: number[] = [];
        let qh = 0;
        let qt = 0;
        visited[i] = 1;
        queue[qt++] = i;
        while (qh < qt) {
          const cur = queue[qh++];
          comp.push(cur);
          const r = Math.floor(cur / cols);
          const c = cur - r * cols;
          const neighbors = [
            c > 0 ? cur - 1 : -1,
            c + 1 < cols ? cur + 1 : -1,
            r > 0 ? cur - cols : -1,
            r + 1 < rows ? cur + cols : -1
          ];
          for (const nb of neighbors) {
            if (nb !== -1 && occ[nb] === 0 && exterior[nb] === 0 && visited[nb] === 0) {
              visited[nb] = 1;
              queue[qt++] = nb;
            }
          }
        }
        if (comp.length <= maxHoleCells) {
          for (const idx of comp) occ[idx] = 1;
        }
      }
    }
  }

  private static keepMainComponent(
    occ: Uint8Array,
    travCount: Uint16Array,
    cols: number,
    rows: number
  ): void {
    const total = cols * rows;
    const compId = new Int32Array(total);
    const queue = new Int32Array(total);
    let bestId = 0;
    let bestTravScore = -1;
    let bestSizeScore = -1;
    let nextId = 1;

    for (let i = 0; i < total; i++) {
      if (occ[i] === 1 && compId[i] === 0) {
        const id = nextId++;
        let qh = 0;
        let qt = 0;
        let trav = 0;
        let size = 0;
        compId[i] = id;
        queue[qt++] = i;

        while (qh < qt) {
          const cur = queue[qh++];
          size++;
          trav += travCount[cur];
          const r = Math.floor(cur / cols);
          const c = cur - r * cols;
          if (c > 0 && occ[cur - 1] === 1 && compId[cur - 1] === 0) {
            compId[cur - 1] = id;
            queue[qt++] = cur - 1;
          }
          if (c + 1 < cols && occ[cur + 1] === 1 && compId[cur + 1] === 0) {
            compId[cur + 1] = id;
            queue[qt++] = cur + 1;
          }
          if (r > 0 && occ[cur - cols] === 1 && compId[cur - cols] === 0) {
            compId[cur - cols] = id;
            queue[qt++] = cur - cols;
          }
          if (r + 1 < rows && occ[cur + cols] === 1 && compId[cur + cols] === 0) {
            compId[cur + cols] = id;
            queue[qt++] = cur + cols;
          }
        }

        if (trav > bestTravScore || (trav === bestTravScore && size > bestSizeScore)) {
          bestTravScore = trav;
          bestSizeScore = size;
          bestId = id;
        }
      }
    }

    if (bestId > 0) {
      for (let i = 0; i < total; i++) {
        if (compId[i] !== bestId) occ[i] = 0;
      }
    }
  }

  private static traceBoundaryLoop(
    occ: Uint8Array,
    cols: number,
    rows: number,
    uMin: number,
    vMin: number
  ): [number, number][] {
    const stride = cols + 1;
    const outgoing = new Map<number, number[]>();

    const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
      const k0 = y0 * stride + x0;
      const k1 = y1 * stride + x1;
      const arr = outgoing.get(k0);
      if (arr) arr.push(k1);
      else outgoing.set(k0, [k1]);
    };

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (occ[r * cols + c] !== 1) continue;
        if (occ[(r - 1) * cols + c] === 0) addEdge(c, r, c + 1, r);
        if (occ[r * cols + c + 1] === 0) addEdge(c + 1, r, c + 1, r + 1);
        if (occ[(r + 1) * cols + c] === 0) addEdge(c + 1, r + 1, c, r + 1);
        if (occ[r * cols + c - 1] === 0) addEdge(c, r + 1, c, r);
      }
    }

    if (outgoing.size === 0) return [];

    // Pick lowest vertex key (top-leftmost) to guarantee outer boundary
    let startKey = Infinity;
    for (const k of outgoing.keys()) {
      if (k < startKey) startKey = k;
    }

    const pts: [number, number][] = [];
    let cur = startKey;
    const maxSteps = outgoing.size + 8;

    for (let step = 0; step < maxSteps; step++) {
      const gx = cur % stride;
      const gy = Math.floor(cur / stride);
      pts.push([uMin + gx * OCC_CELL, vMin + gy * OCC_CELL]);

      const nexts = outgoing.get(cur);
      if (!nexts || nexts.length === 0) break;
      const nxt = nexts.pop()!;
      cur = nxt;
      if (cur === startKey) break;
    }

    return pts;
  }

  private static snapEdgesToWallPeaks(
    pts: [number, number][],
    plusUPeaks: WallPeak[],
    minusUPeaks: WallPeak[],
    plusVPeaks: WallPeak[],
    minusVPeaks: WallPeak[]
  ): [number, number][] {
    const out = pts.map(([u, v]): [number, number] => [u, v]);
    const n = out.length;

    const findBestPeak = (
      peaks: WallPeak[],
      targetCoord: number,
      segPerpMin: number,
      segPerpMax: number
    ): number | null => {
      let bestCoord: number | null = null;
      let bestScore = Infinity;

      for (const pk of peaks) {
        const diff = Math.abs(pk.coord - targetCoord);
        if (diff > 0.30) continue;
        const overlap = Math.min(pk.perpMax, segPerpMax) - Math.max(pk.perpMin, segPerpMin);
        if (overlap < -0.35) continue;
        const score = diff - Math.min(0.15, pk.weight * 0.001);
        if (score < bestScore) {
          bestScore = score;
          bestCoord = pk.coord;
        }
      }
      return bestCoord;
    };

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = out[i];
      const b = out[j];
      const du = b[0] - a[0];
      const dv = b[1] - a[1];
      const len = Math.hypot(du, dv);
      if (len < 0.05) continue;

      // CCW inward normal is (-dv/len, du/len)
      const nu = -dv / len;
      const nv = du / len;

      if (Math.abs(nu) >= Math.abs(nv)) {
        // Vertical edge (constant U)
        const uCur = (a[0] + b[0]) * 0.5;
        const pMin = Math.min(a[1], b[1]);
        const pMax = Math.max(a[1], b[1]);
        const peaks = nu > 0 ? plusUPeaks : minusUPeaks;
        const snappedU = findBestPeak(peaks, uCur, pMin, pMax);
        if (snappedU !== null) {
          a[0] = snappedU;
          b[0] = snappedU;
        }
      } else {
        // Horizontal edge (constant V)
        const vCur = (a[1] + b[1]) * 0.5;
        const pMin = Math.min(a[0], b[0]);
        const pMax = Math.max(a[0], b[0]);
        const peaks = nv > 0 ? plusVPeaks : minusVPeaks;
        const snappedV = findBestPeak(peaks, vCur, pMin, pMax);
        if (snappedV !== null) {
          a[1] = snappedV;
          b[1] = snappedV;
        }
      }
    }

    return out;
  }

  private static scoreWallSegments(
    orderedUV: [number, number][],
    cornersXZ: [number, number][],
    uvVoxels: UVWallVoxel[],
    ux: number,
    uz: number,
    vx: number,
    vz: number
  ): DetectedWallSegment[] {
    const walls: DetectedWallSegment[] = [];
    const n = orderedUV.length;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const aUV = orderedUV[i];
      const bUV = orderedUV[j];
      const du = bUV[0] - aUV[0];
      const dv = bUV[1] - aUV[1];
      const len = Math.hypot(du, dv);
      if (len < 0.05) continue;

      const tU = du / len;
      const tV = dv / len;
      const nU = -tV;
      const nV = tU;

      // World inward normal
      const nx = nU * ux + nV * vx;
      const nz = nU * uz + nV * vz;

      let wSum = 0;
      let errSqSum = 0;
      let vpMask = 0;
      let matched = 0;
      const binCount = Math.max(1, Math.ceil(len / 0.2));
      const coveredBins = new Uint8Array(binCount);

      for (let k = 0; k < uvVoxels.length; k++) {
        const wv = uvVoxels[k];
        if (wv.nu * nU + wv.nv * nV < 0.72) continue;
        const relU = wv.u - aUV[0];
        const relV = wv.v - aUV[1];
        const along = relU * tU + relV * tV;
        if (along < -0.08 || along > len + 0.08) continue;
        const perpDist = relU * nU + relV * nV;
        if (Math.abs(perpDist) > 0.12) continue;

        matched++;
        wSum += wv.weight;
        errSqSum += wv.weight * perpDist * perpDist;
        vpMask = (vpMask | wv.viewpointMask) >>> 0;

        const bin = Math.min(binCount - 1, Math.max(0, Math.floor(along / 0.2)));
        coveredBins[bin] = 1;
      }

      let covered = 0;
      for (let b = 0; b < binCount; b++) {
        if (coveredBins[b] === 1) covered++;
      }

      const coveragePct = round1((covered / binCount) * 100);
      const passCount = popcount32(vpMask);
      const sigmaCm =
        matched >= 3 && wSum > 0 ? round2(Math.sqrt(errSqSum / wSum) * 100) : 9.9;

      let confidence: WallConfidenceLevel = 'low';
      if (coveragePct >= 50 && passCount >= 3 && sigmaCm <= 2.0) {
        confidence = 'good';
      } else if (coveragePct >= 30 && passCount >= 2 && sigmaCm <= 3.5) {
        confidence = 'medium';
      }

      walls.push({
        index: walls.length,
        p1: cornersXZ[i],
        p2: cornersXZ[j],
        normal: [round3(nx), round3(nz)],
        lengthM: round2(len),
        sigmaCm,
        passCount,
        coveragePct,
        confidence
      });
    }

    return walls;
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
