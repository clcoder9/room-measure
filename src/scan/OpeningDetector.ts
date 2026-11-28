import type { ShellEstimate, WallOpening } from './ScanTypes';
import { VoxelGrid } from './VoxelGrid';
import { pointInPolygonXZ } from './ShellEstimator';

interface WallVoxelSample {
  x: number;
  y: number;
  z: number;
}

const STEP_M = 0.10;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export class OpeningDetector {
  /**
   * Detects open doorways and windows on perimeter walls using accumulated wall-surface voxels
   * and ray pass-through evidence (depth rays travelling > 18cm beyond the wall plane).
   */
  public static detectOpenings(grid: VoxelGrid, shell: ShellEstimate): WallOpening[] {
    if (!shell.valid || shell.cornersXZ.length < 3 || shell.walls.length === 0) {
      return [];
    }

    const wallH = Math.max(
      1.8,
      Math.min(3.8, (shell.ceilingY ?? shell.provisionalCeilingY) - shell.floorY)
    );

    const voxels: WallVoxelSample[] = [];
    for (const v of grid.getVoxels()) {
      if (v.hits < 1) continue;
      const invH = 1 / v.hits;
      const y = v.sumY * invH;
      if (y < shell.floorY - 0.05 || y > shell.floorY + wallH + 0.15) continue;
      voxels.push({
        x: v.sumX * invH,
        y,
        z: v.sumZ * invH
      });
    }

    const out: WallOpening[] = [];
    let doorCount = 0;
    let windowCount = 0;

    for (const wall of shell.walls) {
      if (wall.lengthM < 0.65) continue;

      const [x1, z1] = wall.p1;
      const [x2, z2] = wall.p2;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.65) continue;

      const tx = dx / len;
      const tz = dz / len;
      const [nx, nz] = wall.normal; // inward normal; (-nx, -nz) points outside wall

      const cols = Math.max(6, Math.round(len / STEP_M));
      const rows = Math.max(16, Math.round(wallH / STEP_M));
      const cellW = len / cols;
      const cellH = wallH / rows;
      const total = cols * rows;

      const solidGrid = new Uint8Array(total);
      const passHitsGrid = new Uint16Array(total);

      // 1. Mark SOLID wall surface cells (within +/-14cm of wall plane)
      for (let i = 0; i < voxels.length; i++) {
        const vx = voxels[i];
        const rx = vx.x - x1;
        const rz = vx.z - z1;
        const perp = rx * nx + rz * nz;
        if (Math.abs(perp) > 0.14) continue;
        const along = rx * tx + rz * tz;
        if (along < 0 || along > len) continue;
        const h = vx.y - shell.floorY;
        if (h < 0 || h >= wallH) continue;

        const c = Math.min(cols - 1, Math.max(0, Math.floor(along / cellW)));
        const r = Math.min(rows - 1, Math.max(0, Math.floor(h / cellH)));
        solidGrid[r * cols + c] = 1;
      }

      // 2. Mark THROUGH cells from ray pass-through cells 16-28cm behind wall plane
      const rawThrough = new Uint8Array(total);
      for (let c = 0; c < cols; c++) {
        const along = (c + 0.5) * cellW;
        const wx = x1 + tx * along;
        const wz = z1 + tz * along;

        // Guard against concavities in L/U shaped rooms: target behind wall must be outside shell
        const outCheckX = wx - nx * 0.22;
        const outCheckZ = wz - nz * 0.22;
        if (pointInPolygonXZ(outCheckX, outCheckZ, shell.cornersXZ)) {
          continue;
        }

        const p1x = wx - nx * 0.16;
        const p1z = wz - nz * 0.16;
        const p2x = wx - nx * 0.28;
        const p2z = wz - nz * 0.28;

        for (let r = 0; r < rows; r++) {
          const idx = r * cols + c;
          if (solidGrid[idx] === 1) continue;
          const wy = shell.floorY + (r + 0.5) * cellH;
          const hits = Math.max(
            grid.getPassThroughHits(p1x, wy, p1z),
            grid.getPassThroughHits(p2x, wy, p2z)
          );
          if (hits >= 2) {
            rawThrough[idx] = 1;
            passHitsGrid[idx] = Math.min(65535, hits);
          }
        }
      }

      // 3. 3x3 morphological close on rawThrough (constrained by solidGrid === 0)
      const dilated = new Uint8Array(total);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (rawThrough[r * cols + c] !== 1) continue;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= cols) continue;
              const nIdx = rr * cols + cc;
              if (solidGrid[nIdx] === 0) dilated[nIdx] = 1;
            }
          }
        }
      }

      const throughMask = new Uint8Array(total);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (dilated[idx] === 0) continue;
          if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
            throughMask[idx] = rawThrough[idx];
            continue;
          }
          let all = 1;
          for (let dr = -1; dr <= 1 && all === 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dilated[(r + dr) * cols + (c + dc)] === 0) {
                all = 0;
                break;
              }
            }
          }
          throughMask[idx] = all === 1 || rawThrough[idx] === 1 ? 1 : 0;
        }
      }

      // 4. Connected components of throughMask
      const visited = new Uint8Array(total);
      const queue = new Int32Array(total);

      for (let start = 0; start < total; start++) {
        if (throughMask[start] === 0 || visited[start] === 1) continue;

        const comp: number[] = [];
        let qh = 0;
        let qt = 0;
        visited[start] = 1;
        queue[qt++] = start;

        let cMin = cols;
        let cMax = -1;
        let rMin = rows;
        let rMax = -1;
        let hitsSum = 0;

        while (qh < qt) {
          const cur = queue[qh++];
          comp.push(cur);
          hitsSum += passHitsGrid[cur];
          const r = Math.floor(cur / cols);
          const c = cur - r * cols;
          if (c < cMin) cMin = c;
          if (c > cMax) cMax = c;
          if (r < rMin) rMin = r;
          if (r > rMax) rMax = r;

          const nbs = [
            c > 0 ? cur - 1 : -1,
            c + 1 < cols ? cur + 1 : -1,
            r > 0 ? cur - cols : -1,
            r + 1 < rows ? cur + cols : -1
          ];
          for (const nb of nbs) {
            if (nb !== -1 && throughMask[nb] === 1 && visited[nb] === 0) {
              visited[nb] = 1;
              queue[qt++] = nb;
            }
          }
        }

        if (comp.length < 16) continue;

        // Trim sparse fringe cols/rows (< 25% occupancy) so stray rays don't bloat bounds
        const compSet = new Set(comp);
        const trimCols = () => {
          while (cMax - cMin + 1 > 3) {
            const hSpan = rMax - rMin + 1;
            let leftCount = 0;
            let rightCount = 0;
            for (let r = rMin; r <= rMax; r++) {
              if (compSet.has(r * cols + cMin)) leftCount++;
              if (compSet.has(r * cols + cMax)) rightCount++;
            }
            if (leftCount < hSpan * 0.25) cMin++;
            else if (rightCount < hSpan * 0.25) cMax--;
            else break;
          }
        };
        const trimRows = () => {
          while (rMax - rMin + 1 > 3) {
            const wSpan = cMax - cMin + 1;
            let botCount = 0;
            let topCount = 0;
            for (let c = cMin; c <= cMax; c++) {
              if (compSet.has(rMin * cols + c)) botCount++;
              if (compSet.has(rMax * cols + c)) topCount++;
            }
            if (botCount < wSpan * 0.25) rMin++;
            else if (topCount < wSpan * 0.25) rMax--;
            else break;
          }
        };
        trimCols();
        trimRows();

        const boxCols = cMax - cMin + 1;
        const boxRows = rMax - rMin + 1;
        let insideCount = 0;
        for (let r = rMin; r <= rMax; r++) {
          for (let c = cMin; c <= cMax; c++) {
            if (throughMask[r * cols + c] === 1) insideCount++;
          }
        }
        const fillRatio = insideCount / Math.max(1, boxCols * boxRows);
        if (fillRatio < 0.40) continue;

        // Verify solid wall structure frames this opening
        const hasSolidBand = (r0: number, r1: number, c0: number, c1: number) => {
          let hits = 0;
          for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
            for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) {
              if (solidGrid[r * cols + c] === 1) hits++;
            }
          }
          return hits >= 2;
        };

        const leftSolid = hasSolidBand(rMin, rMax, cMin - 2, cMin - 1);
        const rightSolid = hasSolidBand(rMin, rMax, cMax + 1, cMax + 2);
        const topSolid = hasSolidBand(rMax + 1, rMax + 2, cMin, cMax);
        const bottomSolid = hasSolidBand(rMin - 2, rMin - 1, cMin, cMax);

        if (!((leftSolid && rightSolid) || ((leftSolid || rightSolid) && (topSolid || bottomSolid)))) {
          continue;
        }

        const offsetM = cMin * cellW;
        const widthM = boxCols * cellW;
        const bottomM = rMin * cellH;
        const topM = (rMax + 1) * cellH;
        const heightM = topM - bottomM;
        const confidence = round2(Math.min(1, 0.5 * fillRatio + 0.5 * Math.min(1, hitsSum / 60)));

        if (
          bottomM <= 0.30 &&
          widthM >= 0.55 &&
          widthM <= 1.85 &&
          topM >= 1.65 &&
          topM <= Math.min(2.50, wallH + 0.05)
        ) {
          doorCount++;
          out.push({
            id: `auto-door-${wall.index}-${doorCount}`,
            type: 'door',
            label: `Door (Wall #${wall.index + 1})`,
            widthMeters: round2(widthM),
            heightMeters: round2(topM),
            wallIndex: wall.index,
            offsetAlongWallMeters: round2(offsetM),
            sillHeightMeters: 0,
            source: 'auto',
            confidence
          });
        } else if (
          bottomM >= 0.32 &&
          widthM >= 0.40 &&
          widthM <= 2.80 &&
          heightM >= 0.40 &&
          heightM <= 1.90 &&
          topM <= wallH - 0.05
        ) {
          windowCount++;
          out.push({
            id: `auto-win-${wall.index}-${windowCount}`,
            type: 'window',
            label: `Window (Wall #${wall.index + 1})`,
            widthMeters: round2(widthM),
            heightMeters: round2(heightM),
            wallIndex: wall.index,
            offsetAlongWallMeters: round2(offsetM),
            sillHeightMeters: round2(bottomM),
            source: 'auto',
            confidence
          });
        }
      }
    }

    return out;
  }
}
