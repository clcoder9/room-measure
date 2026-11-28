import type { DepthFramePayload, SerializedPlaneInput } from './ScanTypes';

export const VOXEL_SIZE = 0.05;
export const FREE_CELL_SIZE = 0.10;
export const PASS_CELL_SIZE = 0.12;
export const MAX_VOXELS = 60_000;
export const MAX_PASS_CELLS = 45_000;

const GRID_COLS = 48;
const GRID_ROWS = 36;
const GRID_UV_MIN = 0.04;
const GRID_UV_MAX = 0.96;

const OUT_OF_FOV = -1;
const HOLE = 0;
const SHOOT_THROUGH = 999;

export interface VoxelCell {
  kx: number;
  ky: number;
  kz: number;
  hits: number;
  sumX: number;
  sumY: number;
  sumZ: number;
  sumNx: number;
  sumNy: number;
  sumNz: number;
  sumWeight: number;
  viewpointMask: number;
}

export interface FreeCell {
  kx: number;
  kz: number;
  freeHits: number;
  lowFreeHits: number;
  traversed: boolean;
}

function hashVoxelKey(kx: number, ky: number, kz: number): number {
  return ((kx + 2048) * 4096 + (ky + 2048)) * 4096 + (kz + 2048);
}

function hashFreeKey(kx: number, kz: number): number {
  return (kx + 4096) * 8192 + (kz + 4096);
}

export function popcount32(n: number): number {
  let v = n >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class VoxelGrid {
  private voxels = new Map<number, VoxelCell>();
  private freeCells = new Map<number, FreeCell>();
  private passCells = new Map<number, number>();
  private ceilingSeamBins = new Map<number, number>(); // 2cm Y bin -> hit count
  private latestPlanes: SerializedPlaneInput[] = [];
  private cameraPathXZ: number[] = [];

  private frameCount = 0;
  private globalViewpointMask = 0;
  private latestCamPos: [number, number, number] = [0, 1.4, 0];
  private lastEstimatedFloorY: number | null = null;

  // Scratch buffers for 48x36 grid unprojection (zero per-frame allocations)
  private gridD = new Float32Array(GRID_COLS * GRID_ROWS);
  private gridVx = new Float32Array(GRID_COLS * GRID_ROWS);
  private gridVy = new Float32Array(GRID_COLS * GRID_ROWS);
  private gridVz = new Float32Array(GRID_COLS * GRID_ROWS);
  private gridValid = new Uint8Array(GRID_COLS * GRID_ROWS);
  private gridWorldY = new Float32Array(GRID_COLS * GRID_ROWS);
  private gridWorldNy = new Float32Array(GRID_COLS * GRID_ROWS);

  public reset(): void {
    this.voxels.clear();
    this.freeCells.clear();
    this.passCells.clear();
    this.ceilingSeamBins.clear();
    this.latestPlanes = [];
    this.cameraPathXZ = [];
    this.frameCount = 0;
    this.globalViewpointMask = 0;
    this.latestCamPos = [0, 1.4, 0];
    this.lastEstimatedFloorY = null;
  }

  public getFrameCount(): number {
    return this.frameCount;
  }

  public getVoxelCount(): number {
    return this.voxels.size;
  }

  public getDistinctViewpoints(): number {
    return popcount32(this.globalViewpointMask);
  }

  public getLatestCamPos(): [number, number, number] {
    return this.latestCamPos;
  }

  public setEstimatedFloorY(y: number | null): void {
    this.lastEstimatedFloorY = y;
  }

  public getEstimatedFloorY(): number | null {
    return this.lastEstimatedFloorY;
  }

  public getVoxels(): IterableIterator<VoxelCell> {
    return this.voxels.values();
  }

  public getFreeCells(): IterableIterator<FreeCell> {
    return this.freeCells.values();
  }

  public getFreeCellAtWorld(x: number, z: number): FreeCell | undefined {
    const kx = Math.floor(x / FREE_CELL_SIZE);
    const kz = Math.floor(z / FREE_CELL_SIZE);
    return this.freeCells.get(hashFreeKey(kx, kz));
  }

  public getPassThroughHits(x: number, y: number, z: number): number {
    const kx = Math.floor(x / PASS_CELL_SIZE);
    const ky = Math.floor(y / PASS_CELL_SIZE);
    const kz = Math.floor(z / PASS_CELL_SIZE);
    if (kx < -2048 || kx > 2047 || ky < -2047 || ky > 2046 || kz < -2048 || kz > 2047) {
      return 0;
    }
    const c = this.passCells.get(hashVoxelKey(kx, ky, kz)) ?? 0;
    const up = this.passCells.get(hashVoxelKey(kx, ky + 1, kz)) ?? 0;
    const dn = this.passCells.get(hashVoxelKey(kx, ky - 1, kz)) ?? 0;
    return Math.max(c, up, dn);
  }

  public getCeilingSeamBins(): Map<number, number> {
    return this.ceilingSeamBins;
  }

  public getLatestPlanes(): SerializedPlaneInput[] {
    return this.latestPlanes;
  }

  public getCameraPathXZArray(): Float32Array {
    return new Float32Array(this.cameraPathXZ);
  }

  private computeViewpointBit(pos: [number, number, number], forward: [number, number, number]): number {
    const yaw = Math.atan2(forward[0], forward[2]); // [-pi, pi]
    const normYaw = ((yaw + Math.PI) / (2 * Math.PI)) * 8;
    const yawSector = Math.max(0, Math.min(7, Math.floor(normYaw)));

    const px = Math.floor(pos[0] / 1.2);
    const pz = Math.floor(pos[2] / 1.2);
    const posSector = (((px * 73856093) ^ (pz * 19349663)) >>> 0) & 3;
    const bitIndex = (yawSector * 4 + posSector) & 31;
    return (1 << bitIndex) >>> 0;
  }

  private recordTrajectory(camX: number, camZ: number): void {
    const n = this.cameraPathXZ.length;
    if (n >= 2) {
      const lx = this.cameraPathXZ[n - 2];
      const lz = this.cameraPathXZ[n - 1];
      if (Math.hypot(camX - lx, camZ - lz) < 0.12) {
        return;
      }
    }
    this.cameraPathXZ.push(camX, camZ);

    // Mark 25cm disk around camera XZ as traversed free space
    const ckx = Math.floor(camX / FREE_CELL_SIZE);
    const ckz = Math.floor(camZ / FREE_CELL_SIZE);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dz * dz > 5) continue;
        const kx = ckx + dx;
        const kz = ckz + dz;
        const key = hashFreeKey(kx, kz);
        const cell = this.freeCells.get(key);
        if (cell) {
          cell.traversed = true;
          cell.freeHits = Math.max(cell.freeHits, 2);
          cell.lowFreeHits = Math.max(cell.lowFreeHits, 2);
        } else {
          this.freeCells.set(key, {
            kx,
            kz,
            freeHits: 2,
            lowFreeHits: 2,
            traversed: true
          });
        }
      }
    }
  }

  public ingestFrame(payload: DepthFramePayload): void {
    this.frameCount++;
    this.latestCamPos = payload.cameraPos;
    this.latestPlanes = payload.planes;

    const vpBit = this.computeViewpointBit(payload.cameraPos, payload.cameraForward);
    this.globalViewpointMask = (this.globalViewpointMask | vpBit) >>> 0;
    this.recordTrajectory(payload.cameraPos[0], payload.cameraPos[2]);

    const { width, height, rawValueToMeters, isFloat32 } = payload;
    if (width <= 0 || height <= 0 || payload.depthBuffer.byteLength === 0) {
      return;
    }

    const typed = isFloat32
      ? new Float32Array(payload.depthBuffer)
      : new Uint16Array(payload.depthBuffer);

    const M = payload.normDepthFromNormView;
    const P = payload.projMatrix;
    const W = payload.viewToWorld;
    const p0 = Math.abs(P[0]) > 1e-6 ? P[0] : 1;
    const p5 = Math.abs(P[5]) > 1e-6 ? P[5] : 1;
    const p8 = P[8] ?? 0;
    const p9 = P[9] ?? 0;

    this.gridValid.fill(0);

    // 1. Sample 48x36 grid & unproject into view space
    for (let r = 0; r < GRID_ROWS; r++) {
      const v = GRID_UV_MIN + (r / (GRID_ROWS - 1)) * (GRID_UV_MAX - GRID_UV_MIN);
      const ndcY = 1 - 2 * v;
      for (let c = 0; c < GRID_COLS; c++) {
        const u = GRID_UV_MIN + (c / (GRID_COLS - 1)) * (GRID_UV_MAX - GRID_UV_MIN);
        const idx = r * GRID_COLS + c;

        const du = M[0] * u + M[4] * v + M[12];
        const dv = M[1] * u + M[5] * v + M[13];
        if (du < 0 || du >= 1 || dv < 0 || dv >= 1) {
          this.gridD[idx] = OUT_OF_FOV;
          continue;
        }

        const col = Math.min(width - 1, Math.max(0, Math.floor(du * width)));
        const row = Math.min(height - 1, Math.max(0, Math.floor(dv * height)));
        const raw = typed[row * width + col];
        const d = raw * rawValueToMeters;

        if (!Number.isFinite(d) || d < 0.25) {
          this.gridD[idx] = HOLE;
          continue;
        }
        if (d > 5.2) {
          this.gridD[idx] = SHOOT_THROUGH;
          continue;
        }

        this.gridD[idx] = d;
        const ndcX = 2 * u - 1;
        this.gridVx[idx] = (d * (ndcX + p8)) / p0;
        this.gridVy[idx] = (d * (ndcY + p9)) / p5;
        this.gridVz[idx] = -d;
      }
    }

    // 2. Edge-discontinuity filter + central-difference normals + voxel insertion
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const idx = r * GRID_COLS + c;
        const d = this.gridD[idx];
        if (d < 0.25 || d > 5.2) continue;

        const idxL = idx - 1;
        const idxR = idx + 1;
        const idxU = idx - GRID_COLS;
        const idxD = idx + GRID_COLS;

        const dL = this.gridD[idxL];
        const dR = this.gridD[idxR];
        const dU = this.gridD[idxU];
        const dD = this.gridD[idxD];

        if (
          dL < 0.25 || dL > 5.2 ||
          dR < 0.25 || dR > 5.2 ||
          dU < 0.25 || dU > 5.2 ||
          dD < 0.25 || dD > 5.2
        ) {
          continue;
        }

        const maxDiff = Math.max(
          Math.abs(d - dL),
          Math.abs(d - dR),
          Math.abs(d - dU),
          Math.abs(d - dD)
        );
        if (maxDiff > 0.065 * d) continue;

        const dxR = this.gridVx[idxR] - this.gridVx[idxL];
        const dyR = this.gridVy[idxR] - this.gridVy[idxL];
        const dzR = this.gridVz[idxR] - this.gridVz[idxL];

        const dxU = this.gridVx[idxU] - this.gridVx[idxD];
        const dyU = this.gridVy[idxU] - this.gridVy[idxD];
        const dzU = this.gridVz[idxU] - this.gridVz[idxD];

        let nxV = dyR * dzU - dzR * dyU;
        let nyV = dzR * dxU - dxR * dzU;
        let nzV = dxR * dyU - dyR * dxU;
        const nLen = Math.hypot(nxV, nyV, nzV);
        if (nLen < 1e-6) continue;
        nxV /= nLen;
        nyV /= nLen;
        nzV /= nLen;

        if (nzV < 0) {
          nxV = -nxV;
          nyV = -nyV;
          nzV = -nzV;
        }
        if (nzV < 0.25) continue;

        const xv = this.gridVx[idx];
        const yv = this.gridVy[idx];
        const zv = this.gridVz[idx];

        const xw = W[0] * xv + W[4] * yv + W[8] * zv + W[12];
        const yw = W[1] * xv + W[5] * yv + W[9] * zv + W[13];
        const zw = W[2] * xv + W[6] * yv + W[10] * zv + W[14];

        let nxw = W[0] * nxV + W[4] * nyV + W[8] * nzV;
        let nyw = W[1] * nxV + W[5] * nyV + W[9] * nzV;
        let nzw = W[2] * nxV + W[6] * nyV + W[10] * nzV;
        const wnLen = Math.hypot(nxw, nyw, nzw) || 1;
        nxw /= wnLen;
        nyw /= wnLen;
        nzw /= wnLen;

        this.gridValid[idx] = 1;
        this.gridWorldY[idx] = yw;
        this.gridWorldNy[idx] = nyw;

        const weight = nzV / Math.max(0.36, d * d);
        this.insertVoxel(xw, yw, zw, nxw, nyw, nzw, weight, vpBit);
      }
    }

    const refFloorY = this.lastEstimatedFloorY ?? payload.cameraPos[1] - 1.30;

    // 3. Wall-ceiling seam detector (for featureless white ceilings returning 0 depth)
    for (let c = 4; c < GRID_COLS - 4; c++) {
      let runLen = 0;
      let runTopRow = -1;
      for (let r = GRID_ROWS - 5; r >= 5; r--) {
        const idx = r * GRID_COLS + c;
        const isWallPx = this.gridValid[idx] === 1 && Math.abs(this.gridWorldNy[idx]) < 0.35;
        if (isWallPx) {
          runLen++;
          runTopRow = r;
        } else {
          if (runLen >= 4 && runTopRow >= 5) {
            const above1 = (runTopRow - 1) * GRID_COLS + c;
            const above2 = (runTopRow - 2) * GRID_COLS + c;
            const above3 = (runTopRow - 3) * GRID_COLS + c;
            const topIdx = runTopRow * GRID_COLS + c;
            const topY = this.gridWorldY[topIdx];
            const aboveIsCeilingOrHole =
              this.gridD[above2] === HOLE ||
              this.gridD[above3] === HOLE ||
              (this.gridValid[above2] === 1 && this.gridWorldNy[above2] < -0.70) ||
              (this.gridValid[above3] === 1 && this.gridWorldNy[above3] < -0.70);

            if (aboveIsCeilingOrHole) {
              const above1Y =
                W[1] * this.gridVx[above1] +
                W[5] * this.gridVy[above1] +
                W[9] * this.gridVz[above1] +
                W[13];
              const stepY = above1Y - topY;
              const seamY = stepY > 0 && stepY < 0.25 ? above1Y + 0.5 * stepY : above1Y;
              if (seamY > refFloorY + 1.85 && seamY < refFloorY + 4.0) {
                const bin = Math.round(seamY / 0.02);
                this.ceilingSeamBins.set(bin, (this.ceilingSeamBins.get(bin) ?? 0) + 1);
              }
            }
          }
          runLen = 0;
          runTopRow = -1;
        }
      }
    }

    // 4. Multi-height 2D free-space carving (solid hits only, never SHOOT_THROUGH window rays)
    const camX = payload.cameraPos[0];
    const camY = payload.cameraPos[1];
    const camZ = payload.cameraPos[2];
    const minFreeY = refFloorY + 0.18;
    const maxFreeY = refFloorY + 2.35;
    const maxLowFreeY = refFloorY + 0.85;

    for (let r = 1; r < GRID_ROWS - 1; r += 2) {
      for (let c = 1; c < GRID_COLS - 1; c += 2) {
        const idx = r * GRID_COLS + c;
        const d = this.gridD[idx];
        if (d < 0.35 || d > 5.2) continue;

        const xv = this.gridVx[idx];
        const yv = this.gridVy[idx];
        const zv = this.gridVz[idx];
        const wx = W[0] * xv + W[4] * yv + W[8] * zv + W[12];
        const wy = W[1] * xv + W[5] * yv + W[9] * zv + W[13];
        const wz = W[2] * xv + W[6] * yv + W[10] * zv + W[14];

        const dx = wx - camX;
        const dy = wy - camY;
        const dz = wz - camZ;
        const rayLen = Math.hypot(dx, dy, dz);
        if (rayLen < 0.35) continue;
        const invRay = 1 / rayLen;
        const dirX = dx * invRay;
        const dirY = dy * invRay;
        const dirZ = dz * invRay;
        if (Math.abs(dirY) >= 0.55) continue;

        const maxT = rayLen - 0.08;
        for (let t = 0.20; t <= maxT; t += 0.10) {
          const yt = camY + dirY * t;
          if (yt < minFreeY || yt > maxFreeY) continue;
          const xt = camX + dirX * t;
          const zt = camZ + dirZ * t;
          const kx = Math.floor(xt / FREE_CELL_SIZE);
          const kz = Math.floor(zt / FREE_CELL_SIZE);
          const fkey = hashFreeKey(kx, kz);
          const isLow = yt <= maxLowFreeY;
          const cell = this.freeCells.get(fkey);
          if (cell) {
            cell.freeHits++;
            if (isLow) cell.lowFreeHits++;
          } else {
            this.freeCells.set(fkey, {
              kx,
              kz,
              freeHits: 1,
              lowFreeHits: isLow ? 1 : 0,
              traversed: false
            });
          }
        }
      }
    }

    // 5. 3D ray pass-through marching (includes SHOOT_THROUGH window glass rays, stops 18cm before solids)
    const minPassY = refFloorY + 0.05;
    const maxPassY = refFloorY + 2.65;
    for (let r = 1; r < GRID_ROWS - 1; r += 3) {
      const v = GRID_UV_MIN + (r / (GRID_ROWS - 1)) * (GRID_UV_MAX - GRID_UV_MIN);
      const ndcY = 1 - 2 * v;
      for (let c = 1; c < GRID_COLS - 1; c += 3) {
        const idx = r * GRID_COLS + c;
        const d = this.gridD[idx];
        if (d < 0.45) continue;
        const isShootThrough = d === SHOOT_THROUGH;
        if (!isShootThrough && d > 5.2) continue;

        const u = GRID_UV_MIN + (c / (GRID_COLS - 1)) * (GRID_UV_MAX - GRID_UV_MIN);
        const ndcX = 2 * u - 1;
        const vx1 = (ndcX + p8) / p0;
        const vy1 = (ndcY + p9) / p5;
        const vz1 = -1;

        const dx = W[0] * vx1 + W[4] * vy1 + W[8] * vz1;
        const dy = W[1] * vx1 + W[5] * vy1 + W[9] * vz1;
        const dz = W[2] * vx1 + W[6] * vy1 + W[10] * vz1;
        const dirLen = Math.hypot(dx, dy, dz);
        if (dirLen < 1e-6) continue;
        const invLen = 1 / dirLen;
        const dirX = dx * invLen;
        const dirY = dy * invLen;
        const dirZ = dz * invLen;
        if (Math.abs(dirY) >= 0.65) continue;

        let maxT = 6.2;
        if (!isShootThrough) {
          const xv = this.gridVx[idx];
          const yv = this.gridVy[idx];
          const zv = this.gridVz[idx];
          const wx = W[0] * xv + W[4] * yv + W[8] * zv + W[12];
          const wy = W[1] * xv + W[5] * yv + W[9] * zv + W[13];
          const wz = W[2] * xv + W[6] * yv + W[10] * zv + W[14];
          maxT = Math.hypot(wx - camX, wy - camY, wz - camZ) - 0.18;
        }
        if (maxT < 0.45) continue;

        for (let t = 0.40; t <= maxT; t += PASS_CELL_SIZE) {
          const yt = camY + dirY * t;
          if (yt < minPassY || yt > maxPassY) continue;
          const xt = camX + dirX * t;
          const zt = camZ + dirZ * t;
          const pkx = Math.floor(xt / PASS_CELL_SIZE);
          const pky = Math.floor(yt / PASS_CELL_SIZE);
          const pkz = Math.floor(zt / PASS_CELL_SIZE);
          if (pkx < -2048 || pkx > 2047 || pky < -2047 || pky > 2046 || pkz < -2048 || pkz > 2047) {
            continue;
          }
          const pkey = hashVoxelKey(pkx, pky, pkz);
          const curHits = this.passCells.get(pkey);
          if (curHits !== undefined) {
            if (curHits < 65535) this.passCells.set(pkey, curHits + 1);
          } else if (this.passCells.size < MAX_PASS_CELLS) {
            this.passCells.set(pkey, 1);
          }
        }
      }
    }
  }

  private insertVoxel(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    weight: number,
    vpBit: number
  ): void {
    const kx = Math.floor(x / VOXEL_SIZE);
    const ky = Math.floor(y / VOXEL_SIZE);
    const kz = Math.floor(z / VOXEL_SIZE);
    if (kx < -2048 || kx > 2047 || ky < -2048 || ky > 2047 || kz < -2048 || kz > 2047) {
      return;
    }

    const key = hashVoxelKey(kx, ky, kz);
    const existing = this.voxels.get(key);
    if (existing) {
      existing.hits++;
      existing.sumX += x;
      existing.sumY += y;
      existing.sumZ += z;
      existing.sumNx += nx * weight;
      existing.sumNy += ny * weight;
      existing.sumNz += nz * weight;
      existing.sumWeight += weight;
      existing.viewpointMask = (existing.viewpointMask | vpBit) >>> 0;
      return;
    }

    if (this.voxels.size >= MAX_VOXELS) {
      return;
    }

    this.voxels.set(key, {
      kx,
      ky,
      kz,
      hits: 1,
      sumX: x,
      sumY: y,
      sumZ: z,
      sumNx: nx * weight,
      sumNy: ny * weight,
      sumNz: nz * weight,
      sumWeight: weight,
      viewpointMask: vpBit
    });
  }

  public exportPreviewPointCloud(
    maxPoints: number,
    floorY: number,
    ceilingY: number | null
  ): { positions: Float32Array; colors: Float32Array; count: number } {
    const positions = new Float32Array(maxPoints * 3);
    const colors = new Float32Array(maxPoints * 3);

    let eligible = 0;
    for (const v of this.voxels.values()) {
      if (v.hits >= 2) eligible++;
    }
    if (eligible === 0) {
      return { positions: new Float32Array(0), colors: new Float32Array(0), count: 0 };
    }

    const stride = Math.max(1, Math.ceil(eligible / maxPoints));
    let seen = 0;
    let outIdx = 0;

    for (const v of this.voxels.values()) {
      if (v.hits < 2) continue;
      if (seen % stride !== 0) {
        seen++;
        continue;
      }
      seen++;
      if (outIdx >= maxPoints) break;

      const invH = 1 / v.hits;
      const px = v.sumX * invH;
      const py = v.sumY * invH;
      const pz = v.sumZ * invH;

      const nLen = Math.hypot(v.sumNx, v.sumNy, v.sumNz) || 1;
      const ny = v.sumNy / nLen;

      let cr = 0.20;
      let cg = 0.85;
      let cb = 0.60;
      if (Math.abs(py - floorY) < 0.09 && ny > 0.65) {
        cr = 0.0;
        cg = 0.95;
        cb = 1.0;
      } else if (
        (ny < -0.30 && py > floorY + 1.0) ||
        (ceilingY !== null && Math.abs(py - ceilingY) < 0.12 && ny < -0.65)
      ) {
        // Violet for flat AND inclined ceilings so sloped roofs are distinguished from furniture
        cr = 0.68;
        cg = 0.42;
        cb = 1.0;
      } else if (Math.abs(ny) < 0.35 && py > floorY + 0.10) {
        cr = 0.98;
        cg = 0.65;
        cb = 0.15;
      }

      const base = outIdx * 3;
      positions[base] = px;
      positions[base + 1] = py;
      positions[base + 2] = pz;
      colors[base] = cr;
      colors[base + 1] = cg;
      colors[base + 2] = cb;
      outIdx++;
    }

    return {
      positions: positions.subarray(0, outIdx * 3),
      colors: colors.subarray(0, outIdx * 3),
      count: outIdx
    };
  }
}
