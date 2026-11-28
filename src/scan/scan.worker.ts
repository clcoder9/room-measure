import { WorkerInMessage, WorkerOutMessage } from './ScanTypes';
import { VoxelGrid } from './VoxelGrid';
import { ShellEstimator } from './ShellEstimator';
import { FurnitureDetector } from './FurnitureDetector';
import { OpeningDetector } from './OpeningDetector';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerInMessage>) => void) | null;
  postMessage: (message: WorkerOutMessage, transfer?: Transferable[]) => void;
};

const grid = new VoxelGrid();
let lastEstimateAt = 0;
let currentScanId = 0;

ctx.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type === 'RESET') {
    currentScanId = msg.scanId;
    grid.reset();
    lastEstimateAt = 0;
    return;
  }

  if (msg.type === 'INGEST_FRAME') {
    if (msg.scanId !== currentScanId) {
      return;
    }
    grid.ingestFrame(msg.payload);

    const now = performance.now();
    if (grid.getFrameCount() > 3 && now - lastEstimateAt < 380) {
      return;
    }
    lastEstimateAt = now;

    const { shell, stats } = ShellEstimator.estimateShell(grid);
    const furniture = FurnitureDetector.detectFurniture(grid, shell);
    const openings = OpeningDetector.detectOpenings(grid, shell);
    const cloud = grid.exportPreviewPointCloud(1800, shell.floorY, shell.ceilingY);
    const previewPositions = cloud.positions.slice();
    const previewColors = cloud.colors.slice();
    const cameraPathXZ = grid.getCameraPathXZArray();

    const out: WorkerOutMessage = {
      type: 'SCAN_UPDATE',
      scanId: msg.scanId,
      shell,
      stats,
      furniture,
      openings,
      previewPositions,
      previewColors,
      previewCount: cloud.count,
      cameraPathXZ
    };

    ctx.postMessage(out, [
      previewPositions.buffer,
      previewColors.buffer,
      cameraPathXZ.buffer
    ]);
  }
};
