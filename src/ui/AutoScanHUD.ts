import { UnitSystem, formatArea, formatDistance } from '../measurement/math';
import { ScanStats, ShellEstimate } from '../scan/ScanTypes';
import { ScanVisuals } from '../scan/ScanVisuals';

export interface AutoScanHUDCallbacks {
  onFinishScan: () => void;
  onExitToManual: () => void;
  onResetScan: () => void;
  onTogglePause: () => boolean;
  onToast: (msg: string) => void;
}

export class AutoScanHUD {
  private visuals: ScanVisuals;
  private callbacks: AutoScanHUDCallbacks;

  private panelEl: HTMLElement;
  private wallPillEl: HTMLElement;
  private progressEl: HTMLProgressElement;
  private hintEl: HTMLElement;
  private liveAnnounceEl: HTMLElement;

  private valAreaEl: HTMLElement;
  private valHeightEl: HTMLElement;
  private valWallsEl: HTMLElement;
  private valPassesEl: HTMLElement;

  private btnPtsEl: HTMLButtonElement;
  private btnPauseEl: HTMLButtonElement;
  private btnResetEl: HTMLButtonElement;
  private btnExitEl: HTMLButtonElement;
  private btnFinishEl: HTMLButtonElement;

  private announcedReady = false;

  constructor(visuals: ScanVisuals, callbacks: AutoScanHUDCallbacks) {
    this.visuals = visuals;
    this.callbacks = callbacks;

    this.panelEl = document.getElementById('autoscan-panel')!;
    this.wallPillEl = document.getElementById('autoscan-wall-pill')!;
    this.progressEl = document.getElementById('autoscan-progress') as HTMLProgressElement;
    this.hintEl = document.getElementById('autoscan-hint')!;
    this.liveAnnounceEl = document.getElementById('autoscan-live-announce')!;

    this.valAreaEl = document.getElementById('autoscan-val-area')!;
    this.valHeightEl = document.getElementById('autoscan-val-height')!;
    this.valWallsEl = document.getElementById('autoscan-val-walls')!;
    this.valPassesEl = document.getElementById('autoscan-val-passes')!;

    this.btnPtsEl = document.getElementById('btn-autoscan-pts') as HTMLButtonElement;
    this.btnPauseEl = document.getElementById('btn-autoscan-pause') as HTMLButtonElement;
    this.btnResetEl = document.getElementById('btn-autoscan-reset') as HTMLButtonElement;
    this.btnExitEl = document.getElementById('btn-autoscan-exit') as HTMLButtonElement;
    this.btnFinishEl = document.getElementById('btn-autoscan-finish') as HTMLButtonElement;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.panelEl.addEventListener('beforexrselect', (e) => {
      e.preventDefault();
    });

    this.btnPtsEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !this.visuals.isShowingPoints();
      this.visuals.setShowPoints(next);
      this.btnPtsEl.setAttribute('aria-pressed', String(next));
      this.callbacks.onToast(next ? 'Voxel points visible' : 'Voxel points hidden');
    });

    this.btnPauseEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const paused = this.callbacks.onTogglePause();
      this.btnPauseEl.setAttribute('aria-pressed', String(paused));
      this.btnPauseEl.textContent = paused ? 'Resume' : 'Pause';
    });

    this.btnResetEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.announcedReady = false;
      this.callbacks.onResetScan();
      this.resetDisplay();
      this.callbacks.onToast('Auto scan cleared');
    });

    this.btnExitEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onExitToManual();
    });

    this.btnFinishEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onFinishScan();
    });
  }

  public setVisible(visible: boolean): void {
    this.panelEl.classList.toggle('hidden', !visible);
    if (visible) {
      this.btnPtsEl.setAttribute('aria-pressed', String(this.visuals.isShowingPoints()));
    }
  }

  public resetDisplay(): void {
    this.announcedReady = false;
    this.progressEl.removeAttribute('value');
    this.wallPillEl.textContent = 'Scanning...';
    this.wallPillEl.className = 'badge badge-warning';
    this.hintEl.textContent = 'Walk slowly and pan across room walls and floor.';
    this.valAreaEl.textContent = '--';
    this.valHeightEl.textContent = '--';
    this.valWallsEl.textContent = '0';
    this.valPassesEl.textContent = '0 pts';
    this.btnFinishEl.disabled = true;
    this.btnPauseEl.setAttribute('aria-pressed', 'false');
    this.btnPauseEl.textContent = 'Pause';
    this.liveAnnounceEl.textContent = '';
  }

  public update(
    shell: ShellEstimate,
    stats: ScanStats,
    unitSystem: UnitSystem,
    furnitureCount = 0,
    openingsCount = 0
  ): void {
    if (!shell.valid) {
      this.progressEl.removeAttribute('value');
      this.wallPillEl.textContent = `${stats.wallVoxelCount} wall pts`;
      this.wallPillEl.className = 'badge badge-warning';
      this.hintEl.textContent = stats.guidanceHint;
      this.valPassesEl.textContent = `${stats.distinctViewpoints}p / ${stats.voxelCount}vox`;
      this.btnFinishEl.disabled = true;
      return;
    }

    this.progressEl.value = stats.readinessPct;
    this.hintEl.textContent = stats.guidanceHint;

    let goodCount = 0;
    let medCount = 0;
    let lowCount = 0;
    for (const w of shell.walls) {
      if (w.confidence === 'good') goodCount++;
      else if (w.confidence === 'medium') medCount++;
      else lowCount++;
    }

    const totalWalls = shell.walls.length;
    this.wallPillEl.textContent = `${goodCount}/${totalWalls} walls 🟢`;
    this.wallPillEl.className =
      goodCount === totalWalls ? 'badge badge-success' : 'badge badge-warning';

    this.valAreaEl.textContent = formatArea(shell.floorAreaSqM, unitSystem, false);
    if (shell.ceilingY !== null) {
      this.valHeightEl.textContent = formatDistance(shell.ceilingY - shell.floorY, unitSystem);
    } else {
      this.valHeightEl.textContent = `~${formatDistance(shell.provisionalCeilingY - shell.floorY, unitSystem)}?`;
    }
    this.valWallsEl.textContent = `🟢${goodCount} 🟡${medCount} 🔴${lowCount} • 🪑${furnitureCount} 🚪${openingsCount}`;
    this.valPassesEl.textContent = `${stats.distinctViewpoints}p / ${stats.voxelCount}vox`;

    this.btnFinishEl.disabled = shell.cornersXZ.length < 3;

    if (goodCount === totalWalls && totalWalls >= 3 && !this.announcedReady) {
      this.announcedReady = true;
      this.liveAnnounceEl.textContent = 'All room walls locked with high confidence. Ready to finish.';
    }
  }
}
