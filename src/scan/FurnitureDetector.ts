import type { FurnitureBox, ShellEstimate } from './ScanTypes';
import { FREE_CELL_SIZE, VoxelGrid } from './VoxelGrid';
import { pointInPolygonXZ } from './ShellEstimator';

interface FurnitureCell {
  cu: number;
  cv: number;
  hits: number;
  minY: number;
  maxY: number;
  upwardHits: number;
  maxUpY: number;
  lowerHits: number;
}

const CELL_SIZE = FREE_CELL_SIZE; // 0.10 m

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function distToSegmentSq2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)];
}

function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function classifyFurnitureLabel(
  w: number,
  d: number,
  h: number,
  wallAdjacent: boolean
): string {
  const area = w * d;
  if (h >= 1.55) {
    return wallAdjacent && w <= 1.15 && d <= 0.95 ? 'Tall Unit / Fridge' : 'Wardrobe / Cabinet';
  }
  if (h >= 1.05) {
    return 'Shelf / Dresser';
  }
  if (h >= 0.65) {
    if (wallAdjacent && d <= 0.85) return 'Counter / Desk';
    return 'Table / Desk';
  }
  if (area >= 1.35) {
    return 'Bed / Sofa';
  }
  return 'Low Unit / Bench';
}

export class FurnitureDetector {
  /**
   * Detects simplified Manhattan-aligned 3D furniture boxes inside a scanned room shell.
   * Immune to small floor/counter clutter and inclined/sloped attic ceilings.
   */
  public static detectFurniture(grid: VoxelGrid, shell: ShellEstimate): FurnitureBox[] {
    if (!shell.valid || shell.cornersXZ.length < 3 || shell.walls.length === 0) {
      return [];
    }

    const ux = Math.cos(shell.yawRad);
    const uz = Math.sin(shell.yawRad);
    const vx = -uz;
    const vz = ux;

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;

    for (const [cx, cz] of shell.cornersXZ) {
      const u = cx * ux + cz * uz;
      const v = cx * vx + cz * vz;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }

    uMin -= 0.1;
    vMin -= 0.1;
    uMax += 0.1;
    vMax += 0.1;

    const cols = Math.min(260, Math.max(4, Math.ceil((uMax - uMin) / CELL_SIZE)));
    const rows = Math.min(260, Math.max(4, Math.ceil((vMax - vMin) / CELL_SIZE)));
    const total = cols * rows;

    const defaultCeilY = shell.ceilingY ?? shell.provisionalCeilingY;
    const ceilingH = Math.max(1.2, defaultCeilY - shell.floorY);

    // 1. Sloped/inclined ceiling shield: track lowest downward-facing voxel (ny < -0.25)
    const minDownY = new Float32Array(total);
    minDownY.fill(defaultCeilY);

    for (const v of grid.getVoxels()) {
      if (v.hits < 2) continue;
      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;
      if (ny >= -0.25) continue;

      const py = v.sumY / v.hits;
      if (py <= shell.floorY + 0.85) continue;

      const px = v.sumX / v.hits;
      const pz = v.sumZ / v.hits;
      const u = px * ux + pz * uz;
      const vv = px * vx + pz * vz;
      const cu = Math.floor((u - uMin) / CELL_SIZE);
      const cv = Math.floor((vv - vMin) / CELL_SIZE);
      if (cu < 0 || cu >= cols || cv < 0 || cv >= rows) continue;

      const idx = cv * cols + cu;
      if (py < minDownY[idx]) {
        minDownY[idx] = py;
      }
    }

    // Dilate ceiling cap Y across 3x3 cells so sloped-roof edge noise stays capped
    const ceilingCapY = new Float32Array(total);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let cap = defaultCeilY;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const val = minDownY[rr * cols + cc];
            if (val < cap) cap = val;
          }
        }
        ceilingCapY[r * cols + c] = cap;
      }
    }

    // 2. Accumulate interior voxels into 10cm (u, v) height cells
    const cells = new Map<number, FurnitureCell>();

    for (const v of grid.getVoxels()) {
      if (v.hits < 2) continue;
      const invH = 1 / v.hits;
      const px = v.sumX * invH;
      const py = v.sumY * invH;
      const pz = v.sumZ * invH;

      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;

      // Reject downward-facing inclined ceiling / overhang surfaces
      if (ny < -0.20) continue;
      if (py < shell.floorY + 0.14) continue;

      const u = px * ux + pz * uz;
      const vv = px * vx + pz * vz;
      const cu = Math.floor((u - uMin) / CELL_SIZE);
      const cv = Math.floor((vv - vMin) / CELL_SIZE);
      if (cu < 0 || cu >= cols || cv < 0 || cv >= rows) continue;

      const cellIdx = cv * cols + cu;
      if (py > ceilingCapY[cellIdx] - 0.12) continue;

      if (!pointInPolygonXZ(px, pz, shell.cornersXZ)) continue;

      // Check proximity to perimeter walls
      let minWallDistSq = Infinity;
      for (const wall of shell.walls) {
        const dSq = distToSegmentSq2D(px, pz, wall.p1[0], wall.p1[1], wall.p2[0], wall.p2[1]);
        if (dSq < minWallDistSq) minWallDistSq = dSq;
      }
      if (minWallDistSq < 0.04 * 0.04) continue;
      // Ignore vertical wall-relief/baseboard/window frame voxels within 15cm of wall,
      // while preserving upward-facing furniture tops (counters/desks) touching the wall.
      if (minWallDistSq < 0.15 * 0.15 && ny < 0.50) continue;

      let cell = cells.get(cellIdx);
      if (!cell) {
        cell = {
          cu,
          cv,
          hits: 0,
          minY: py,
          maxY: py,
          upwardHits: 0,
          maxUpY: -Infinity,
          lowerHits: 0
        };
        cells.set(cellIdx, cell);
      }

      cell.hits += v.hits;
      if (py < cell.minY) cell.minY = py;
      if (py > cell.maxY) cell.maxY = py;
      if (ny >= 0.55) {
        cell.upwardHits += v.hits;
        if (py > cell.maxUpY) cell.maxUpY = py;
      }
      if (py <= shell.floorY + 1.00) {
        cell.lowerHits += v.hits;
      }
    }

    if (cells.size < 10) return [];

    // 3. Build raw occupancy & height grid + support filtering
    const rawOcc = new Uint8Array(total);
    const rawH = new Float32Array(total);

    for (const [idx, cell] of cells) {
      if (cell.hits < 2) continue;

      // Reject floating upper noise (no lower support AND no upward tabletop)
      const hasLowerSupport = cell.lowerHits >= 2 || cell.minY <= shell.floorY + 0.95;
      const hasUpwardTop = cell.upwardHits >= 2 && cell.maxUpY <= shell.floorY + 1.15;
      if (!hasLowerSupport && !hasUpwardTop) continue;

      const topY =
        cell.upwardHits >= 2 && Number.isFinite(cell.maxUpY)
          ? Math.max(cell.maxUpY, cell.maxY - 0.14)
          : cell.maxY;
      const h = topY - shell.floorY;
      if (h < 0.28) continue;

      rawOcc[idx] = 1;
      rawH[idx] = h;
    }

    // 4. Despeckle isolated 1-cell clutter & 3x3 median-smooth height
    const occ = new Uint8Array(total);
    const smoothH = new Float32Array(total);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (rawOcc[idx] === 0) continue;

        let neighborCount = 0;
        const hVals: number[] = [];
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const nIdx = rr * cols + cc;
            if (rawOcc[nIdx] === 1) {
              hVals.push(rawH[nIdx]);
              if (dr !== 0 || dc !== 0) neighborCount++;
            }
          }
        }

        // Drop isolated 1-cell speckle clutter
        if (neighborCount < 1) continue;
        occ[idx] = 1;
        smoothH[idx] = medianOf(hVals);
      }
    }

    // 5. Height-continuous 4-connected components (separates adjacent tall/low units)
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    const boxes: FurnitureBox[] = [];

    for (let startIdx = 0; startIdx < total; startIdx++) {
      if (occ[startIdx] === 0 || visited[startIdx] === 1) continue;

      const compIndices: number[] = [];
      let qh = 0;
      let qt = 0;
      visited[startIdx] = 1;
      queue[qt++] = startIdx;

      while (qh < qt) {
        const cur = queue[qh++];
        compIndices.push(cur);
        const r = Math.floor(cur / cols);
        const c = cur - r * cols;
        const hCur = smoothH[cur];

        const neighbors = [
          c > 0 ? cur - 1 : -1,
          c + 1 < cols ? cur + 1 : -1,
          r > 0 ? cur - cols : -1,
          r + 1 < rows ? cur + cols : -1
        ];
        for (const nIdx of neighbors) {
          if (nIdx === -1 || occ[nIdx] === 0 || visited[nIdx] === 1) continue;
          if (Math.abs(smoothH[nIdx] - hCur) <= 0.36) {
            visited[nIdx] = 1;
            queue[qt++] = nIdx;
          }
        }
      }

      let totalHits = 0;
      let cUMin = Infinity;
      let cUMax = -Infinity;
      let cVMin = Infinity;
      let cVMax = -Infinity;
      const topUpwardHs: number[] = [];
      const allSmoothHs: number[] = [];

      for (const idx of compIndices) {
        const r = Math.floor(idx / cols);
        const c = idx - r * cols;
        const cellU0 = uMin + c * CELL_SIZE;
        const cellU1 = cellU0 + CELL_SIZE;
        const cellV0 = vMin + r * CELL_SIZE;
        const cellV1 = cellV0 + CELL_SIZE;

        if (cellU0 < cUMin) cUMin = cellU0;
        if (cellU1 > cUMax) cUMax = cellU1;
        if (cellV0 < cVMin) cVMin = cellV0;
        if (cellV1 > cVMax) cVMax = cellV1;

        const cellData = cells.get(idx);
        if (cellData) {
          totalHits += cellData.hits;
          if (cellData.upwardHits >= 2 && Number.isFinite(cellData.maxUpY)) {
            topUpwardHs.push(cellData.maxUpY - shell.floorY);
          }
        }
        allSmoothHs.push(smoothH[idx]);
      }

      if (compIndices.length < 6 || totalHits < 8) continue;

      const rawUSpan = cUMax - cUMin;
      const rawVSpan = cVMax - cVMin;
      const tentativeH =
        topUpwardHs.length >= Math.max(4, Math.floor(compIndices.length * 0.25))
          ? medianOf(topUpwardHs)
          : percentileOf(allSmoothHs, 0.75);

      // Snap wall-adjacent back faces flush to shell walls.
      // For tall vertical front-only scans (fridge/wardrobe where camera is below top), allow deeper back-snap.
      let wallAdjacent = false;
      for (const wall of shell.walls) {
        const p1u = wall.p1[0] * ux + wall.p1[1] * uz;
        const p1v = wall.p1[0] * vx + wall.p1[1] * vz;
        const p2u = wall.p2[0] * ux + wall.p2[1] * uz;
        const p2v = wall.p2[0] * vx + wall.p2[1] * vz;
        const nu = wall.normal[0] * ux + wall.normal[1] * uz;
        const nv = wall.normal[0] * vx + wall.normal[1] * vz;

        if (Math.abs(nu) >= Math.abs(nv)) {
          const wallU = (p1u + p2u) * 0.5;
          const overlapV = Math.min(Math.max(p1v, p2v), cVMax) - Math.max(Math.min(p1v, p2v), cVMin);
          if (overlapV < 0.25) continue;
          const maxGap = tentativeH >= 1.15 && rawUSpan <= 0.35 ? 0.85 : 0.38;
          if (nu > 0.7) {
            const gap = cUMin - wallU;
            if (gap >= -0.08 && gap <= maxGap && cUMax - wallU >= 0.30 && cUMax - wallU <= 1.25) {
              cUMin = wallU;
              wallAdjacent = true;
            }
          } else if (nu < -0.7) {
            const gap = wallU - cUMax;
            if (gap >= -0.08 && gap <= maxGap && wallU - cUMin >= 0.30 && wallU - cUMin <= 1.25) {
              cUMax = wallU;
              wallAdjacent = true;
            }
          }
        } else {
          const wallV = (p1v + p2v) * 0.5;
          const overlapU = Math.min(Math.max(p1u, p2u), cUMax) - Math.max(Math.min(p1u, p2u), cUMin);
          if (overlapU < 0.25) continue;
          const maxGap = tentativeH >= 1.15 && rawVSpan <= 0.35 ? 0.85 : 0.38;
          if (nv > 0.7) {
            const gap = cVMin - wallV;
            if (gap >= -0.08 && gap <= maxGap && cVMax - wallV >= 0.30 && cVMax - wallV <= 1.25) {
              cVMin = wallV;
              wallAdjacent = true;
            }
          } else if (nv < -0.7) {
            const gap = wallV - cVMax;
            if (gap >= -0.08 && gap <= maxGap && wallV - cVMin >= 0.30 && wallV - cVMin <= 1.25) {
              cVMax = wallV;
              wallAdjacent = true;
            }
          }
        }
      }

      const uSpan = cUMax - cUMin;
      const vSpan = cVMax - cVMin;
      if (!wallAdjacent && compIndices.length < 15) continue;
      if (uSpan < 0.30 || vSpan < 0.30 || uSpan * vSpan < 0.20) continue;

      const heightMeters = round2(Math.min(ceilingH - 0.05, Math.max(0.30, tentativeH)));
      if (heightMeters < 0.30) continue;

      const uCenter = (cUMin + cUMax) * 0.5;
      const vCenter = (cVMin + cVMax) * 0.5;
      const centerX = round3(uCenter * ux + vCenter * vx);
      const centerZ = round3(uCenter * uz + vCenter * vz);

      // Canonicalize widthMeters >= depthMeters by rotating yawRad by +90deg if vSpan > uSpan
      const rot90 = vSpan > uSpan;
      const widthMeters = round2(rot90 ? vSpan : uSpan);
      const depthMeters = round2(rot90 ? uSpan : vSpan);
      const yawRad = round3(rot90 ? shell.yawRad + Math.PI * 0.5 : shell.yawRad);

      const confidence = round2(Math.min(1, totalHits / 80));
      boxes.push({
        id: '',
        label: classifyFurnitureLabel(widthMeters, depthMeters, heightMeters, wallAdjacent),
        centerXZ: [centerX, centerZ],
        widthMeters,
        depthMeters,
        heightMeters,
        floorY: shell.floorY,
        yawRad,
        source: 'auto',
        confidence
      });
    }

    boxes.sort((a, b) => b.widthMeters * b.depthMeters - a.widthMeters * a.depthMeters);
    return boxes.map((box, idx) => ({
      ...box,
      id: `auto-furn-${idx + 1}`
    }));
  }
}
