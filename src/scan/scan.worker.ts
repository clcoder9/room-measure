import { WorkerInMessage, WorkerOutMessage } from './ScanTypes';
import { VoxelGrid } from './VoxelGrid';
import { ShellEstimator } from './ShellEstimator';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerInMessage>) => void) | null;
  postMessage: (message: WorkerOutMessage, transfer?: Transferable[]) => void;
};

const grid = new VoxelGrid();
let lastEstimateAt = 0;

ctx.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type === 'RESET') {
    grid.reset();
    lastEstimateAt = 0;
    return;
  }

  if (msg.type === 'INGEST_FRAME') {
    grid.ingestFrame(msg.payload);

    const now = performance.now();
    if (grid.getFrameCount() > 3 && now - lastEstimateAt < 380) {
      return;
    }
    lastEstimateAt = now;

    const { shell, stats } = ShellEstimator.estimateShell(grid);
    const cloud = grid.exportPreviewPointCloud(1800, shell.floorY, shell.ceilingY);
    const previewPositions = cloud.positions.slice();
    const previewColors = cloud.colors.slice();
    const cameraPathXZ = grid.getCameraPathXZArray();

    const out: WorkerOutMessage = {
      type: 'SCAN_UPDATE',
      shell,
      stats,
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
