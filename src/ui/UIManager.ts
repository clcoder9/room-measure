import * as THREE from 'three';
import { RoomManager, RoomMetrics } from '../measurement/RoomManager';
import { DepthDiagnostics } from '../xr/DepthExplorer';
import { formatDistance, formatArea, formatVolume, calculateHorizontalDistance } from '../measurement/math';
import { MiniMap } from './MiniMap';
import { SnapshotManager } from './SnapshotManager';
import { FurnitureBox, ShellEstimate, SurfaceTextureMode, WallOpening } from '../scan/ScanTypes';
import { exportRoomToGLB } from '../export/RoomGLBExporter';

export interface UIElements {
  landingScreen: HTMLElement;
  arOverlay: HTMLElement;
  hudTop: HTMLElement;
  hudBottom: HTMLElement;
  instructionBanner: HTMLElement;
  hudToolbar: HTMLElement;
  toolbarStatus: HTMLElement;
  wallAreaSummary: HTMLElement;
  btnStartAR: HTMLButtonElement;
  btnStartSim: HTMLButtonElement;
  btnOpenHelp?: HTMLButtonElement | null;
  helpModal?: HTMLDialogElement | null;
  helpCloseBtn?: HTMLButtonElement | null;
  btnExitSession: HTMLButtonElement;
  btnRestartSession: HTMLButtonElement;
  btnHudScreenshot: HTMLButtonElement;
  shutterFlash: HTMLElement;
  screenshotModal: HTMLElement;
  screenshotCloseBtn: HTMLButtonElement;
  screenshotPreviewImg: HTMLImageElement;
  btnShareScreenshot: HTMLButtonElement;
  btnDownloadScreenshot: HTMLButtonElement;
  statusBadge: HTMLElement;
  depthBadge: HTMLElement;
  instructionText: HTMLElement;
  readoutSegment: HTMLElement;
  readoutArea: HTMLElement;
  readoutHeight: HTMLElement;
  readoutVolume: HTMLElement;
  btnPinPoint: HTMLButtonElement;
  btnCloseFloor: HTMLButtonElement;
  btnUndo: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnSnapToggle: HTMLButtonElement;
  btnUnitToggle: HTMLButtonElement;
  btnOpenings: HTMLButtonElement;
  btnSpikeToggle?: HTMLButtonElement | null;
  btnAutoScanToggle?: HTMLButtonElement | null;
  btnExport: HTMLButtonElement;
  exportModal: HTMLElement;
  modalCloseBtn: HTMLButtonElement;
  modalContent: HTMLElement;
  summaryReportPre: HTMLElement;
  btnCopySummary: HTMLButtonElement;
  btnDownloadSvg: HTMLButtonElement;
  btnDownloadJson: HTMLButtonElement;
  btnDownloadGlb?: HTMLButtonElement | null;
  btnImportJson?: HTMLButtonElement | null;
  inputImportJson?: HTMLInputElement | null;
  btnModalRestart: HTMLButtonElement;
}

export class UIManager {
  private els: UIElements;
  private roomManager: RoomManager;
  private miniMap: MiniMap;
  private snapshotManager?: SnapshotManager;
  private currentScreenshotBlob: Blob | null = null;
  private currentScreenshotUrl: string | null = null;
  private copyTimers = new WeakMap<HTMLElement, number>();
  private lastCopyAnnouncement: string = '';
  private currentRoomNameDraft: string = 'Living Room';

  private spikeUIMode = false;
  private autoScanUIMode = false;

  private onPinRequested: () => void;
  private onExitRequested: () => void;
  private onRestartSessionRequested: () => Promise<void> | void;
  private onSpikeToggleRequested?: () => void;
  private onAutoScanToggleRequested?: () => void;
  private onBeforeCopy?: (targetId: string) => void;
  private onLandingShown?: () => void;
  private btnOpenHelp: HTMLButtonElement | null;
  private helpModal: HTMLDialogElement | null;
  private helpCloseBtn: HTMLButtonElement | null;
  private photoFileInput: HTMLInputElement;
  private pendingTextureSurfaceKey: string | null = null;

  constructor(
    els: UIElements,
    roomManager: RoomManager,
    callbacks: {
      onPinRequested: () => void;
      onExitRequested: () => void;
      onRestartSessionRequested: () => Promise<void> | void;
      onSpikeToggleRequested?: () => void;
      onAutoScanToggleRequested?: () => void;
      onBeforeCopy?: (targetId: string) => void;
      onLandingShown?: () => void;
    }
  ) {
    this.els = els;
    this.roomManager = roomManager;
    this.onPinRequested = callbacks.onPinRequested;
    this.onExitRequested = callbacks.onExitRequested;
    this.onRestartSessionRequested = callbacks.onRestartSessionRequested;
    this.onSpikeToggleRequested = callbacks.onSpikeToggleRequested;
    this.onAutoScanToggleRequested = callbacks.onAutoScanToggleRequested;
    this.onBeforeCopy = callbacks.onBeforeCopy;
    this.onLandingShown = callbacks.onLandingShown;
    this.btnOpenHelp =
      els.btnOpenHelp ?? (document.getElementById('btn-open-help') as HTMLButtonElement | null);
    this.helpModal =
      els.helpModal ?? (document.getElementById('help-modal') as HTMLDialogElement | null);
    this.helpCloseBtn =
      els.helpCloseBtn ?? (document.getElementById('help-close-btn') as HTMLButtonElement | null);

    this.photoFileInput = document.createElement('input');
    this.photoFileInput.type = 'file';
    this.photoFileInput.accept = 'image/*';
    this.photoFileInput.className = 'hidden';
    this.els.arOverlay.appendChild(this.photoFileInput);
    this.photoFileInput.addEventListener('change', async () => {
      const file = this.photoFileInput.files?.[0];
      const key = this.pendingTextureSurfaceKey;
      this.photoFileInput.value = '';
      this.pendingTextureSurfaceKey = null;
      if (!file || !key) return;

      try {
        const dataUrl = await this.resizeImageToDataUrl(file, 1024, 0.82);
        const existing = this.roomManager.getSurfaceTexture(key);
        this.roomManager.setSurfaceTexture({
          surfaceKey: key,
          dataUrl,
          mode: existing?.mode ?? (key.startsWith('wall:') ? 'stretch' : 'tile'),
          tileSizeMeters: existing?.tileSizeMeters ?? 1.0
        });
        this.renderExportModalBody();
        this.showToast('Surface photo attached!');
      } catch (err) {
        console.error('[Texture] Failed to process image:', err);
        this.showToast('Could not read photo');
      }
    });

    this.miniMap = new MiniMap(
      this.els.arOverlay,
      (index, wx, wz) => {
        this.roomManager.updateFloorPoint(index, wx, wz);
      },
      (id, wx, wz) => {
        this.roomManager.updateFurniture(id, { centerXZ: [wx, wz], source: 'manual' });
      }
    );

    this.syncToggleButtons();
    this.initToolbarFocusFallback();
    this.initCopyInvokerHandlers();
    this.initHelpDialogHandlers();
    this.attachEventListeners();

    this.roomManager.setOnStateChange(this.renderMetrics.bind(this));
    this.roomManager.setOnValidationError((msg) => {
      this.showToast(msg);
      this.announceToolbarStatus(msg);
    });
  }

  public setSnapshotManager(manager: SnapshotManager): void {
    this.snapshotManager = manager;
  }

  public getMiniMap(): MiniMap {
    return this.miniMap;
  }

  public isInteractionBlocked(): boolean {
    return (
      !this.els.exportModal.classList.contains('hidden') ||
      !this.els.screenshotModal.classList.contains('hidden') ||
      Boolean(this.helpModal?.open) ||
      this.miniMap.isExpandedView()
    );
  }

  private initHelpDialogHandlers(): void {
    this.btnOpenHelp?.addEventListener('click', () => {
      if (this.helpModal && !this.helpModal.open) {
        this.helpModal.showModal();
      }
    });

    this.helpCloseBtn?.addEventListener('click', () => {
      this.helpModal?.close();
    });

    // Fallback light-dismiss for browsers without <dialog closedby="any">
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const outside = (e: PointerEvent, dialog: HTMLDialogElement) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[closedby="any"]')) {
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => {
          pressedOutside = outside(e, dialog);
        });
        dialog.addEventListener('pointerup', (e) => {
          if (pressedOutside && outside(e, dialog)) {
            dialog.close();
          }
          pressedOutside = false;
        });
      }
    }
  }

  private syncToggleButtons(): void {
    const isImperial = this.roomManager.getUnitSystem() === 'imperial';
    this.els.btnUnitToggle.setAttribute('aria-pressed', String(isImperial));
    const unitLabel = this.els.btnUnitToggle.querySelector('span:last-child');
    if (unitLabel) {
      unitLabel.textContent = isImperial ? 'Imperial (ft)' : 'Metric (m)';
    }
    this.els.btnSnapToggle.setAttribute(
      'aria-pressed',
      String(this.roomManager.getOrthoSnapEnabled())
    );
  }

  private announceToolbarStatus(message: string): void {
    this.els.toolbarStatus.textContent = '';
    requestAnimationFrame(() => {
      this.els.toolbarStatus.textContent = message;
    });
  }

  /**
   * Roving tabindex fallback for [role="toolbar"] when native focusgroup is unsupported.
   */
  private initToolbarFocusFallback(): void {
    if ('focusGroup' in HTMLElement.prototype) return;

    const bar = this.els.hudToolbar;
    const items = Array.from(bar.querySelectorAll<HTMLButtonElement>('button'));
    if (items.length === 0) return;

    items.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });

    bar.addEventListener('focusin', (e) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLButtonElement && items.includes(target)) {
        items.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    });

    bar.addEventListener('keydown', (e) => {
      const current = document.activeElement as HTMLButtonElement | null;
      if (!current) return;
      const idx = items.indexOf(current);
      if (idx === -1) return;

      const vertical = bar.getAttribute('aria-orientation') === 'vertical';
      const rtl = getComputedStyle(bar).direction === 'rtl';
      const steps: Record<string, number> = vertical
        ? { ArrowDown: 1, ArrowUp: -1 }
        : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };

      let nextIdx: number | null = null;
      if (e.key in steps) {
        nextIdx = (idx + steps[e.key] + items.length) % items.length;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = items.length - 1;
      }

      if (nextIdx !== null) {
        e.preventDefault();
        items.forEach((b, i) => {
          b.tabIndex = i === nextIdx ? 0 : -1;
        });
        items[nextIdx].focus();
      }
    });
  }

  /**
   * Invoker Commands (--copy) with fallback click handler when CommandEvent is absent.
   */
  private initCopyInvokerHandlers(): void {
    if ('CommandEvent' in window) {
      document.addEventListener(
        'command',
        (event) => {
          const cmdEvent = event as Event & {
            command?: string;
            source?: HTMLElement | null;
            target?: HTMLElement | null;
          };
          if (cmdEvent.command && cmdEvent.command.startsWith('--copy')) {
            if (cmdEvent.source && cmdEvent.target) {
              this.executeCopyCommand(cmdEvent.source, cmdEvent.target);
            }
          }
        },
        true
      );
    } else {
      document.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        const targetEl = event.target as HTMLElement | null;
        const button = targetEl?.closest<HTMLButtonElement>('button[command^="--copy"]');
        if (!button) return;
        const forId = button.getAttribute('commandfor');
        const target = forId ? document.getElementById(forId) : null;
        if (target) {
          this.executeCopyCommand(button, target);
        }
      });
    }
  }

  private legacyCopy(text: string): boolean {
    const previousFocus = document.activeElement as HTMLElement | null;
    const field = Object.assign(document.createElement('textarea'), { value: text });
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } finally {
      field.remove();
      previousFocus?.focus({ preventScroll: true });
    }
  }

  private async executeCopyCommand(button: HTMLElement, target: HTMLElement): Promise<void> {
    if (target.id === 'summary-report-pre') {
      target.textContent = this.roomManager.getFormattedSummaryText();
    } else if (this.onBeforeCopy) {
      this.onBeforeCopy(target.id);
    }

    const text =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target.value
        : (target.innerText || target.textContent || '').trim();

    if (!text) return;

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
      } else if (!this.legacyCopy(text)) {
        throw new Error('Copy unavailable');
      }
      this.reportCopyStatus(button, true);
    } catch {
      try {
        if (this.legacyCopy(text)) {
          this.reportCopyStatus(button, true);
          return;
        }
      } catch {
        // Fall through to error status
      }
      this.reportCopyStatus(button, false);
    }
  }

  private reportCopyStatus(button: HTMLElement, ok: boolean): void {
    const tip = button.nextElementSibling as HTMLElement | null;
    const iconEl = button.querySelector('.copy-icon');
    const prevTimer = this.copyTimers.get(button);
    if (prevTimer !== undefined) {
      clearTimeout(prevTimer);
    }

    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');

    let message = ok ? 'Copied' : 'Copy failed';
    if (message === this.lastCopyAnnouncement) {
      message += '\u00A0';
    }
    this.lastCopyAnnouncement = message;

    if (tip) tip.textContent = '';
    void button.offsetWidth;
    button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
    if (iconEl) {
      iconEl.textContent = ok ? '✅' : '❌';
    }

    if (tip) {
      requestAnimationFrame(() => {
        tip.textContent = message;
      });
    }

    const timerId = window.setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      if (iconEl) iconEl.textContent = '📋';
      if (tip) tip.textContent = '';
    }, 2000);

    this.copyTimers.set(button, timerId);
  }

  private attachEventListeners(): void {
    // Prevent WebXR select events from firing when tapping any HUD or modal surface
    const blockXRSelect = (el: HTMLElement) => {
      el.addEventListener('beforexrselect', (e) => {
        e.preventDefault();
      });
    };
    blockXRSelect(this.els.hudTop);
    blockXRSelect(this.els.hudBottom);
    blockXRSelect(this.els.instructionBanner);
    blockXRSelect(this.els.exportModal);
    blockXRSelect(this.els.screenshotModal);

    // Screenshot Controls
    this.els.btnHudScreenshot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleTakeScreenshot();
    });

    this.els.screenshotCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeScreenshotModal();
    });

    this.els.btnShareScreenshot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shareOrSaveScreenshot();
    });

    this.els.btnDownloadScreenshot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.downloadScreenshotFile();
    });

    this.els.btnRestartSession.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.onRestartSessionRequested();
      this.showToast('New session started from here!');
    });

    this.els.btnPinPoint.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.roomManager.isMarkingOpening() && this.roomManager.getState() === 'COMPLETED') {
        this.roomManager.reset();
        this.showToast('Starting new room measurement');
      } else {
        this.onPinRequested();
      }
    });

    this.els.btnCloseFloor.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.roomManager.isMarkingOpening()) {
        this.roomManager.cancelMarkingOpening();
        this.showToast('Cancelled opening mark');
      } else {
        this.roomManager.closeFloor();
      }
    });

    this.els.btnUndo.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.els.btnUndo.getAttribute('aria-disabled') === 'true') return;
      this.roomManager.undo();
      this.announceToolbarStatus('Last point undone');
    });

    this.els.btnReset.addEventListener('click', (e) => {
      e.stopPropagation();
      this.roomManager.reset();
      this.showToast('Measurement reset');
      this.announceToolbarStatus('Measurement reset');
    });

    this.els.btnSnapToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !this.roomManager.getOrthoSnapEnabled();
      this.roomManager.setOrthoSnapEnabled(next);
      this.els.btnSnapToggle.setAttribute('aria-pressed', String(next));
      const msg = next ? '90 degree snapping enabled' : '90 degree snapping disabled';
      this.showToast(msg);
      this.announceToolbarStatus(msg);
    });

    this.els.btnUnitToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextUnit = this.roomManager.getUnitSystem() === 'metric' ? 'imperial' : 'metric';
      this.roomManager.setUnitSystem(nextUnit);
      this.syncToggleButtons();
      const msg = nextUnit === 'imperial' ? 'Switched to imperial units' : 'Switched to metric units';
      this.showToast(msg);
      this.announceToolbarStatus(msg);
    });

    this.els.btnOpenings.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openExportModal('openings');
    });

    this.els.btnSpikeToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSpikeToggleRequested?.();
    });

    this.els.btnAutoScanToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onAutoScanToggleRequested?.();
    });

    this.els.btnModalRestart.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeExportModal();
      this.roomManager.reset();
      this.showToast('Starting new room measurement');
    });

    this.els.btnExitSession.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onExitRequested();
    });

    this.els.btnExport.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openExportModal();
    });

    this.els.modalCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeExportModal();
    });

    this.els.exportModal.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === this.els.exportModal) {
        this.closeExportModal();
      }
    });

    this.els.screenshotModal.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === this.els.screenshotModal) {
        this.closeScreenshotModal();
      }
    });

    this.els.btnDownloadSvg.addEventListener('click', (e) => {
      e.stopPropagation();
      const nameInput = document.getElementById('room-name-input') as HTMLInputElement | null;
      const roomName = (nameInput?.value || this.currentRoomNameDraft || 'Measured Room').trim();
      const svg = this.roomManager.generateSVGBlueprint(roomName);
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      this.triggerBlobDownload(blob, `room-blueprint-${Date.now()}.svg`);
      this.showToast('2D SVG blueprint downloaded!');
    });

    this.els.btnDownloadJson.addEventListener('click', (e) => {
      e.stopPropagation();
      const data = this.roomManager.getExportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      this.triggerBlobDownload(blob, `room-measurement-${Date.now()}.json`);
      this.showToast('JSON report downloaded!');
    });

    this.els.btnDownloadGlb?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = this.els.btnDownloadGlb!;
      if (this.roomManager.getFloorPoints().length < 3) {
        this.showToast('Measure at least 3 floor corners first');
        return;
      }
      const nameInput = document.getElementById('room-name-input') as HTMLInputElement | null;
      const roomName = (nameInput?.value || this.currentRoomNameDraft || 'Measured_Room').trim();
      const prevText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Exporting...';
      try {
        const blob = await exportRoomToGLB(this.roomManager.getExportData(), roomName);
        this.triggerBlobDownload(blob, `room-model-${Date.now()}.glb`);
        this.showToast('Walkable 3D .glb downloaded!');
      } catch (err) {
        console.error('[GLB Export]', err);
        this.showToast(`3D export failed: ${(err as Error).message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    });

    this.els.btnImportJson?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.els.inputImportJson?.click();
    });

    this.els.inputImportJson?.addEventListener('change', async () => {
      const file = this.els.inputImportJson?.files?.[0];
      if (this.els.inputImportJson) {
        this.els.inputImportJson.value = '';
      }
      if (file) {
        await this.importJsonFile(file);
      }
    });
  }

  private triggerBlobDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  public async importJsonFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = this.roomManager.importFromJSON(parsed);
      if (!res.ok) {
        this.showToast(res.error || 'Invalid room JSON');
        return;
      }
      if (res.roomName) {
        this.currentRoomNameDraft = res.roomName;
      }
      this.syncToggleButtons();
      if (!this.els.exportModal.classList.contains('hidden')) {
        this.renderExportModalBody();
      }
      this.showToast('Room imported into 3D scene!');
    } catch {
      this.showToast('Could not parse JSON file');
    }
  }

  private async resizeImageToDataUrl(file: File, maxDim: number, quality: number): Promise<string> {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');

    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file);
      try {
        const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', quality);
      } finally {
        bmp.close();
      }
    }

    const rawUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image load failed'));
      el.src = rawUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  public showAROverlay(): void {
    this.helpModal?.close();
    this.closeExportModal();
    this.closeScreenshotModal();
    this.els.landingScreen.classList.add('hidden');
    this.els.arOverlay.classList.remove('hidden');
    this.renderMetrics(this.roomManager.getMetrics());
  }

  public showLandingScreen(): void {
    this.els.arOverlay.classList.add('hidden');
    this.els.landingScreen.classList.remove('hidden');
    this.closeExportModal();
    this.closeScreenshotModal();
    this.onLandingShown?.();
  }

  public setSpikeUIMode(active: boolean): void {
    this.spikeUIMode = active;
    this.els.btnSpikeToggle?.setAttribute('aria-pressed', String(active));
    this.syncOverlayPanels();
  }

  public setAutoScanUIMode(active: boolean): void {
    this.autoScanUIMode = active;
    this.els.btnAutoScanToggle?.setAttribute('aria-pressed', String(active));
    this.syncOverlayPanels();
  }

  private syncOverlayPanels(): void {
    const hideManual = this.spikeUIMode || this.autoScanUIMode;
    this.els.hudBottom.classList.toggle('hidden', hideManual);
    this.els.instructionBanner.classList.toggle('hidden', hideManual);
    // MiniMap is hidden in Spike mode, visible in Manual and Auto Scan modes
    this.miniMap.setVisible(!this.spikeUIMode);
  }

  public updateDepthDiagnostics(diag: DepthDiagnostics): void {
    if (diag.active) {
      this.els.depthBadge.textContent = `Depth: ${diag.statusMessage}`;
      this.els.depthBadge.className = 'badge badge-success';
    } else if (diag.supported) {
      this.els.depthBadge.textContent = 'Depth: Standby';
      this.els.depthBadge.className = 'badge badge-warning';
    } else {
      this.els.depthBadge.textContent = 'Depth: Inactive';
      this.els.depthBadge.className = 'badge badge-muted';
    }
  }

  public renderMetrics(metrics: RoomMetrics): void {
    if (this.roomManager.isMarkingOpening()) {
      const mark = this.roomManager.getOpeningMarkState();
      this.els.statusBadge.textContent = mark.firstHit ? 'Mark Corner #2' : 'Mark Corner #1';
      this.els.statusBadge.className = 'status-pill state-ceiling';
      this.els.instructionText.textContent = mark.firstHit
        ? `Aim at opposite corner of ${mark.type} on Wall #${mark.firstHit.wallIndex + 1}, then tap.`
        : `Aim at first corner of ${mark.type} on any wall, then tap screen or button.`;
      this.els.btnPinPoint.textContent = mark.firstHit ? '🎯 Pin Corner #2' : '🎯 Pin Corner #1';
      this.els.btnPinPoint.className = 'btn-hud btn-hud-snap';
      this.els.btnCloseFloor.textContent = '✕ Cancel Mark';
      this.els.btnCloseFloor.disabled = false;
      this.els.btnUndo.setAttribute('aria-disabled', 'false');
    } else {
      this.els.btnCloseFloor.textContent = '📐 Close Floor';
      switch (metrics.state) {
        case 'SCAN_FLOOR':
          this.els.statusBadge.textContent = 'Scan Floor';
          this.els.statusBadge.className = 'status-pill state-scan';
          this.els.instructionText.textContent =
            'Point camera at floor and move slowly to detect plane. Tap screen or "Pin Corner" to place point #1.';
          this.els.btnPinPoint.textContent = '📍 Pin Corner #1';
          this.els.btnPinPoint.className = 'btn-hud btn-hud-primary';
          this.els.btnCloseFloor.disabled = true;
          this.els.btnUndo.setAttribute('aria-disabled', 'true');
          break;

        case 'MEASURING_FLOOR': {
          this.els.statusBadge.textContent = `Floor (${metrics.pointCount} corners)`;
          this.els.statusBadge.className = 'status-pill state-measuring';
          this.els.btnCloseFloor.disabled = metrics.pointCount < 3;
          this.els.btnUndo.setAttribute('aria-disabled', 'false');

          if (metrics.isSnappedToStart && metrics.pointCount >= 3) {
            this.els.instructionText.textContent =
              'Snap locked to Corner #1! Tap screen or "Close Polygon" to complete floor.';
            this.els.btnPinPoint.textContent = '📐 Close Polygon (#1)';
            this.els.btnPinPoint.className = 'btn-hud btn-hud-snap';
          } else if (metrics.isOrthoSnapped && metrics.liveAngleDeg !== null) {
            this.els.instructionText.textContent =
              metrics.pointCount < 3
                ? `Ortho snap (${Math.round(metrics.liveAngleDeg)}°) active. Tap to pin corner #${metrics.pointCount + 1}.`
                : `Ortho snap (${Math.round(metrics.liveAngleDeg)}°) active. Pin corner #${metrics.pointCount + 1} or close floor.`;
            this.els.btnPinPoint.textContent = `📍 Pin Corner #${metrics.pointCount + 1} (${Math.round(metrics.liveAngleDeg)}°)`;
            this.els.btnPinPoint.className = 'btn-hud btn-hud-snap';
          } else {
            this.els.instructionText.textContent =
              metrics.pointCount < 3
                ? `Pin corner #${metrics.pointCount + 1}. At least 3 corners required to form floor polygon.`
                : `Pin next corner or tap "Close Floor" once perimeter is complete.`;
            this.els.btnPinPoint.textContent = `📍 Pin Corner #${metrics.pointCount + 1}`;
            this.els.btnPinPoint.className = 'btn-hud btn-hud-primary';
          }
          break;
        }

        case 'FLOOR_CLOSED':
        case 'MEASURING_CEILING':
          this.els.statusBadge.textContent = 'Pin Ceiling';
          this.els.statusBadge.className = 'status-pill state-ceiling';
          this.els.instructionText.textContent =
            'Aim reticle at ceiling or top of any wall directly above floor, then tap "Pin Ceiling".';
          this.els.btnPinPoint.textContent = '📍 Pin Ceiling Point';
          this.els.btnPinPoint.className = 'btn-hud btn-hud-primary';
          this.els.btnCloseFloor.disabled = true;
          this.els.btnUndo.setAttribute('aria-disabled', 'false');
          break;

        case 'COMPLETED':
          this.els.statusBadge.textContent = 'Complete';
          this.els.statusBadge.className = 'status-pill state-complete';
          this.els.instructionText.textContent =
            'Room complete! Inspect 3D wireframe, drag corners/furniture in 2D Plan, or Edit Model.';
          this.els.btnPinPoint.textContent = '🔄 Start New Room';
          this.els.btnPinPoint.className = 'btn-hud btn-hud-restart';
          this.els.btnCloseFloor.disabled = true;
          this.els.btnUndo.setAttribute('aria-disabled', 'false');
          break;
      }
    }

    const unit = metrics.unitSystem;
    this.els.readoutSegment.textContent =
      metrics.currentSegmentLength > 0 ? formatDistance(metrics.currentSegmentLength, unit) : '--';

    this.els.readoutArea.textContent =
      metrics.floorArea > 0 ? formatArea(metrics.floorArea, unit, false) : '--';

    this.els.readoutHeight.textContent =
      metrics.ceilingHeight > 0 ? formatDistance(metrics.ceilingHeight, unit) : '--';

    this.els.readoutVolume.textContent =
      metrics.volume > 0 ? formatVolume(metrics.volume, unit, false) : '--';

    const openingsLabelSpan = this.els.btnOpenings.querySelector('span:last-child');
    if (openingsLabelSpan) {
      const totalItems = metrics.openingsCount + metrics.furnitureCount;
      openingsLabelSpan.textContent =
        totalItems > 0 ? `Edit (${totalItems})` : 'Edit Model';
    }

    const parts: string[] = [];
    if (metrics.furnitureCount > 0 && metrics.floorArea > 0) {
      parts.push(`Free Floor: ${formatArea(metrics.freeFloorArea, unit, false)} (${metrics.furnitureCount} furn)`);
    }
    if (metrics.grossWallArea > 0) {
      parts.push(
        metrics.openingsCount > 0
          ? `Net Wall: ${formatArea(metrics.netWallArea, unit, false)} (-${metrics.openingsCount} open)`
          : `Gross Wall: ${formatArea(metrics.grossWallArea, unit, false)}`
      );
    } else if (metrics.openingsCount > 0) {
      parts.push(`Openings (${metrics.openingsCount}): -${formatArea(metrics.openingsArea, unit, false)}`);
    }

    if (parts.length > 0) {
      this.els.wallAreaSummary.textContent = parts.join(' • ');
      this.els.wallAreaSummary.classList.remove('hidden');
    } else {
      this.els.wallAreaSummary.classList.add('hidden');
    }
  }

  public renderMiniMap(
    floorPoints: THREE.Vector3[],
    isClosed: boolean,
    reticlePos: THREE.Vector3 | null,
    camera: THREE.Camera,
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): void {
    const snap = this.roomManager.getLiveSnapState();
    const effectiveReticle = snap.effectiveReticlePos ?? reticlePos;
    this.miniMap.render(
      floorPoints,
      isClosed,
      effectiveReticle,
      camera,
      this.roomManager.getUnitSystem(),
      snap.isSnappedToStart || snap.isOrthoSnapped,
      furniture,
      openings
    );
  }

  public renderAutoScanMiniMap(
    shell: ShellEstimate | null,
    cameraPathXZ: Float32Array,
    camera: THREE.Camera,
    furniture: FurnitureBox[] = [],
    openings: WallOpening[] = []
  ): void {
    this.miniMap.renderAutoScan(
      shell,
      cameraPathXZ,
      camera,
      this.roomManager.getUnitSystem(),
      furniture,
      openings
    );
  }

  private openExportModal(focusSection?: 'openings'): void {
    this.renderExportModalBody();
    this.els.exportModal.classList.remove('hidden');

    if (focusSection === 'openings') {
      requestAnimationFrame(() => {
        const el = document.getElementById('modal-openings-section');
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  private renderExportModalBody(): void {
    const data = this.roomManager.getExportData();
    const unit = this.roomManager.getUnitSystem();
    const savedRooms = this.roomManager.getSavedRooms();
    const floorPts = this.roomManager.getFloorPoints();
    const isClosed = this.roomManager.isClosed() && floorPts.length >= 3;
    this.els.summaryReportPre.textContent = this.roomManager.getFormattedSummaryText();

    const totalSavedArea = savedRooms.reduce((acc, r) => acc + r.metrics.floorAreaSqMeters, 0);
    const totalSavedVol = savedRooms.reduce((acc, r) => acc + r.metrics.roomVolumeCuMeters, 0);
    const isImperial = unit === 'imperial';
    const unitShort = isImperial ? 'ft' : 'm';
    const mToUnit = isImperial ? 1 / 0.3048 : 1;
    const defaultW = isImperial ? '3.0' : '0.9';
    const defaultH = isImperial ? '6.9' : '2.1';
    const furnDefW = isImperial ? '4.0' : '1.2';
    const furnDefD = isImperial ? '2.0' : '0.6';
    const furnDefH = isImperial ? '3.0' : '0.9';
    const openingsSubBadge =
      data.metrics.openingsAreaSqMeters > 0
        ? ` • -${formatArea(data.metrics.openingsAreaSqMeters, unit, false)}`
        : '';
    const netWallNote =
      data.metrics.grossWallAreaSqMeters === 0
        ? '<span style="font-size:0.68rem; color:#94a3b8; margin-top:0.2rem;">Pin ceiling height to compute Net Wall Area</span>'
        : '';

    const wallOptionsHtml = isClosed
      ? floorPts
          .map((p1, idx) => {
            const p2 = floorPts[(idx + 1) % floorPts.length];
            const len = calculateHorizontalDistance(p1, p2);
            return `<option value="${idx}">Wall #${idx + 1} (${formatDistance(len, unit)})</option>`;
          })
          .join('')
      : '';

    const surfaceEntries: { key: string; label: string }[] = [];
    if (floorPts.length >= 3) {
      surfaceEntries.push({ key: 'floor', label: 'Floor' });
    }
    if (data.metrics.ceilingHeightMeters > 0.3 && floorPts.length >= 3) {
      surfaceEntries.push({ key: 'ceiling', label: 'Ceiling' });
    }
    if (isClosed) {
      for (let idx = 0; idx < floorPts.length; idx++) {
        const p1 = floorPts[idx];
        const p2 = floorPts[(idx + 1) % floorPts.length];
        const len = calculateHorizontalDistance(p1, p2);
        surfaceEntries.push({
          key: `wall:${idx}`,
          label: `Wall #${idx + 1} (${formatDistance(len, unit)})`
        });
      }
    }
    for (const f of data.furniture) {
      surfaceEntries.push({ key: `furniture:${f.id}`, label: `🪑 ${f.label}` });
    }
    const existingTextures = new Map(
      this.roomManager.getSurfaceTextures().map((t) => [t.surfaceKey, t])
    );

    this.els.modalContent.innerHTML = `
      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">Floor Area (Shell)</span>
          <span class="val highlight">${data.metrics.formatted.floorArea}</span>
        </div>
        <div class="summary-item">
          <span class="label">Free Floor Area (${data.furniture.length} furn)</span>
          <span class="val highlight">${data.metrics.formatted.freeFloorArea}</span>
        </div>
        <div class="summary-item">
          <span class="label">Ceiling Height</span>
          <span class="val">${data.metrics.formatted.ceilingHeight}</span>
        </div>
        <div class="summary-item">
          <span class="label">Room Volume</span>
          <span class="val">${data.metrics.formatted.roomVolume}</span>
        </div>
        <div class="summary-item">
          <span class="label">Gross Wall Area</span>
          <span class="val">${data.metrics.formatted.grossWallArea}</span>
        </div>
        <div class="summary-item">
          <span class="label">Net Wall Area</span>
          <span class="val highlight">${data.metrics.formatted.netWallArea}</span>
          ${netWallNote}
        </div>
      </div>

      <section id="modal-openings-section" class="modal-section">
        <div class="modal-section-title">Doors &amp; Windows (${data.openings.length}${openingsSubBadge})</div>
        <div class="preset-row">
          <button type="button" class="btn-chip btn-chip-mark" data-start-mark="door" ${isClosed ? '' : 'disabled title="Close room perimeter first"'}>🎯 Mark Door on Wall (2 Taps)</button>
          <button type="button" class="btn-chip btn-chip-mark" data-start-mark="window" ${isClosed ? '' : 'disabled title="Close room perimeter first"'}>🎯 Mark Window on Wall (2 Taps)</button>
        </div>
        <div class="preset-row">
          <button type="button" class="btn-chip" data-preset-opening="door:0.9:2.1:Standard Door">+ Standard Door (${formatDistance(0.9, unit)} × ${formatDistance(2.1, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="door:1.6:2.1:Double Door">+ Double Door (${formatDistance(1.6, unit)} × ${formatDistance(2.1, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="window:1.2:1.2:Window">+ Window (${formatDistance(1.2, unit)} × ${formatDistance(1.2, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="window:1.8:1.5:Large Window">+ Large Window (${formatDistance(1.8, unit)} × ${formatDistance(1.5, unit)})</button>
        </div>
        <form id="form-add-opening" class="custom-opening-form" novalidate aria-labelledby="modal-openings-section">
          <fieldset class="opening-type-fieldset">
            <legend>Opening Type</legend>
            <div class="radio-inline-group">
              <label class="radio-pill" for="op-type-door"><input type="radio" id="op-type-door" name="openingType" value="door" checked /><span>Door</span></label>
              <label class="radio-pill" for="op-type-window"><input type="radio" id="op-type-window" name="openingType" value="window" /><span>Window</span></label>
            </div>
          </fieldset>
          <div class="form-fields-row">
            ${
              isClosed
                ? `<div class="form-field"><label for="custom-opening-wall">Wall</label><select id="custom-opening-wall" name="wallIndex" class="modal-input"><option value="">Area Only</option>${wallOptionsHtml}</select></div>`
                : ''
            }
            <div class="form-field">
              <label for="custom-opening-w">Width (${unitShort})</label>
              <input id="custom-opening-w" name="width" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0.1" value="${defaultW}" required />
            </div>
            <div class="form-field">
              <label for="custom-opening-h">Height (${unitShort})</label>
              <input id="custom-opening-h" name="height" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0.1" value="${defaultH}" required />
            </div>
            <div class="form-field">
              <label for="custom-opening-sill">Sill (${unitShort})</label>
              <input id="custom-opening-sill" name="sill" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0" value="0" />
            </div>
          </div>
          <button type="submit" id="btn-add-custom-opening" class="btn-mini">+ Add Opening (${unitShort})</button>
          <p id="opening-form-error" class="form-error-msg" role="alert"></p>
        </form>
        <div class="list-stack">
          ${
            data.openings.length === 0
              ? '<div class="list-item-row" style="color:#94a3b8;">No doors or windows detected or added yet.</div>'
              : data.openings
                  .map((op) => {
                    const sourceBadge = op.source === 'auto' ? '<span class="auto-badge">Auto</span>' : '';
                    const wallInfo = op.wallIndex !== undefined ? ` • Wall #${op.wallIndex + 1}` : '';
                    const sillInfo =
                      op.sillHeightMeters && op.sillHeightMeters > 0.01
                        ? ` • sill ${formatDistance(op.sillHeightMeters, unit)}`
                        : '';
                    const wDisp = (op.widthMeters * mToUnit).toFixed(2);
                    const hDisp = (op.heightMeters * mToUnit).toFixed(2);
                    return `
              <div class="list-item-row">
                <div class="list-item-main">
                  <span>${op.type === 'door' ? '🚪' : '🪟'} ${this.escapeHtml(op.label)} ${sourceBadge}</span>
                  <span class="list-item-sub">${this.escapeHtml(`${wallInfo}${sillInfo}`.replace(/^ • /, ''))}</span>
                </div>
                <div class="list-item-actions">
                  <input type="number" step="0.05" min="0.1" class="inline-dim-input" value="${wDisp}" aria-label="Edit opening width in ${unitShort}" data-edit-op-w="${this.escapeHtml(op.id)}" />
                  <span class="dim-x">×</span>
                  <input type="number" step="0.05" min="0.1" class="inline-dim-input" value="${hDisp}" aria-label="Edit opening height in ${unitShort}" data-edit-op-h="${this.escapeHtml(op.id)}" />
                  <button type="button" class="btn-mini btn-mini-danger" data-remove-opening="${this.escapeHtml(op.id)}">Remove</button>
                </div>
              </div>`;
                  })
                  .join('')
          }
        </div>
      </section>

      <section id="modal-furniture-section" class="modal-section">
        <div class="modal-section-title">Furniture Silhouettes (${data.furniture.length})</div>
        <div class="preset-row">
          <button type="button" class="btn-chip" data-preset-furn="Counter:1.8:0.6:0.9">+ Counter (${formatDistance(1.8, unit)}×${formatDistance(0.6, unit)})</button>
          <button type="button" class="btn-chip" data-preset-furn="Fridge:0.7:0.7:1.85">+ Fridge (${formatDistance(0.7, unit)}×${formatDistance(0.7, unit)})</button>
          <button type="button" class="btn-chip" data-preset-furn="Table:1.4:0.8:0.75">+ Table (${formatDistance(1.4, unit)}×${formatDistance(0.8, unit)})</button>
          <button type="button" class="btn-chip" data-preset-furn="Bed:2.0:1.6:0.55">+ Bed (${formatDistance(2.0, unit)}×${formatDistance(1.6, unit)})</button>
        </div>
        <form id="form-add-furniture" class="custom-opening-form" novalidate aria-labelledby="modal-furniture-section">
          <div class="form-fields-row">
            <div class="form-field">
              <label for="furn-label">Label</label>
              <input id="furn-label" name="label" class="modal-input" type="text" value="Cabinet" required maxlength="32" />
            </div>
            <div class="form-field">
              <label for="furn-w">W (${unitShort})</label>
              <input id="furn-w" name="width" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0.15" value="${furnDefW}" required />
            </div>
            <div class="form-field">
              <label for="furn-d">D (${unitShort})</label>
              <input id="furn-d" name="depth" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0.15" value="${furnDefD}" required />
            </div>
            <div class="form-field">
              <label for="furn-h">H (${unitShort})</label>
              <input id="furn-h" name="height" class="modal-input" type="number" inputmode="decimal" step="0.05" min="0.15" value="${furnDefH}" required />
            </div>
          </div>
          <button type="submit" class="btn-mini">+ Add Furniture Box (${unitShort})</button>
          <p id="furn-form-error" class="form-error-msg" role="alert"></p>
        </form>
        <div class="list-stack">
          ${
            data.furniture.length === 0
              ? '<div class="list-item-row" style="color:#94a3b8;">No furniture silhouettes yet. Tap 2D Plan to drag boxes once added.</div>'
              : data.furniture
                  .map((f) => {
                    const sourceBadge = f.source === 'auto' ? '<span class="auto-badge">Auto</span>' : '';
                    const wDisp = (f.widthMeters * mToUnit).toFixed(2);
                    const dDisp = (f.depthMeters * mToUnit).toFixed(2);
                    const hDisp = (f.heightMeters * mToUnit).toFixed(2);
                    return `
              <div class="list-item-row">
                <div class="list-item-main">
                  <span>🪑 ${this.escapeHtml(f.label)} ${sourceBadge}</span>
                  <span class="list-item-sub">${formatDistance(f.widthMeters, unit)} × ${formatDistance(f.depthMeters, unit)} × ${formatDistance(f.heightMeters, unit)}</span>
                </div>
                <div class="list-item-actions">
                  <input type="number" step="0.05" min="0.15" class="inline-dim-input" value="${wDisp}" aria-label="Width in ${unitShort}" data-edit-furn-w="${this.escapeHtml(f.id)}" />
                  <input type="number" step="0.05" min="0.15" class="inline-dim-input" value="${dDisp}" aria-label="Depth in ${unitShort}" data-edit-furn-d="${this.escapeHtml(f.id)}" />
                  <input type="number" step="0.05" min="0.15" class="inline-dim-input" value="${hDisp}" aria-label="Height in ${unitShort}" data-edit-furn-h="${this.escapeHtml(f.id)}" />
                  <button type="button" class="btn-mini" data-rotate-furn="${this.escapeHtml(f.id)}" title="Rotate 90 degrees">↻ 90°</button>
                  <button type="button" class="btn-mini btn-mini-danger" data-remove-furn="${this.escapeHtml(f.id)}">Remove</button>
                </div>
              </div>`;
                  })
                  .join('')
          }
        </div>
      </section>

      <section class="modal-section">
        <div class="modal-section-title">Surface Photos (3D Textures)</div>
        <div class="list-stack">
          ${
            surfaceEntries.length === 0
              ? '<div class="list-item-row" style="color:#94a3b8;">Measure floor corners to attach surface photos for Blender .glb export.</div>'
              : surfaceEntries
                  .map((s) => {
                    const tex = existingTextures.get(s.key);
                    const thumbHtml = tex
                      ? `<img class="texture-thumb" src="${tex.dataUrl}" alt="${this.escapeHtml(s.label)} texture" />`
                      : '';
                    const modeSelectHtml = tex
                      ? `<select class="texture-select" data-tex-mode="${this.escapeHtml(s.key)}" aria-label="Texture mapping mode">
                          <option value="stretch" ${tex.mode === 'stretch' ? 'selected' : ''}>Fit</option>
                          <option value="tile" ${tex.mode === 'tile' ? 'selected' : ''}>Tile 1m</option>
                        </select>`
                      : '';
                    const clearBtnHtml = tex
                      ? `<button type="button" class="btn-mini btn-mini-danger" data-clear-tex="${this.escapeHtml(s.key)}" aria-label="Remove texture">✕</button>`
                      : '';
                    return `
              <div class="texture-row">
                <div class="texture-label-wrap">
                  ${thumbHtml}
                  <span>${this.escapeHtml(s.label)}</span>
                </div>
                <div class="list-item-actions">
                  ${modeSelectHtml}
                  <button type="button" class="btn-mini" data-pick-tex="${this.escapeHtml(s.key)}">📷 Photo</button>
                  ${clearBtnHtml}
                </div>
              </div>`;
                  })
                  .join('')
          }
        </div>
      </section>

      <section class="modal-section">
        <div class="modal-section-title">Save &amp; Multi-Room History (${savedRooms.length})</div>
        <div class="save-room-row">
          <input id="room-name-input" class="modal-input" type="text" value="${this.escapeHtml(this.currentRoomNameDraft)}" placeholder="Room name (e.g. Kitchen)" aria-label="Room name" />
          <button type="button" id="btn-save-room" class="btn-mini">💾 Save to History</button>
        </div>
        ${
          savedRooms.length > 0
            ? `<div style="font-size:0.74rem; color:#94a3b8;">Total Saved: <strong style="color:#00f2fe;">${formatArea(totalSavedArea, unit, false)}</strong> • <strong style="color:#00f2fe;">${formatVolume(totalSavedVol, unit, false)}</strong></div>`
            : ''
        }
        <div class="list-stack">
          ${
            savedRooms.length === 0
              ? '<div class="list-item-row" style="color:#94a3b8;">No saved rooms yet.</div>'
              : savedRooms
                  .map(
                    (r) => `
              <div class="list-item-row">
                <div>
                  <strong>${this.escapeHtml(r.name)}</strong>
                  <div style="font-size:0.7rem; color:#94a3b8;">${formatArea(r.metrics.floorAreaSqMeters, unit, false)} • ${formatVolume(r.metrics.roomVolumeCuMeters, unit, false)}</div>
                </div>
                <div class="list-item-actions">
                  <button type="button" class="btn-mini" data-load-room="${this.escapeHtml(r.id)}">Load</button>
                  <button type="button" class="btn-mini btn-mini-danger" data-delete-room="${this.escapeHtml(r.id)}">Delete</button>
                </div>
              </div>`
                  )
                  .join('')
          }
        </div>
      </section>

      <section class="modal-section">
        <div class="modal-section-title">Pinned Coordinates (Meters)</div>
        <div class="coords-list">
          ${data.floorCoordinates
            .map(
              (c) => `
            <div class="coord-row">
              <span class="coord-tag">Corner #${c.index}</span>
              <span>X: ${c.x.toFixed(3)}m, Y: ${c.y.toFixed(3)}m, Z: ${c.z.toFixed(3)}m</span>
            </div>`
            )
            .join('')}
          ${
            data.ceilingCoordinate
              ? `
            <div class="coord-row highlight">
              <span class="coord-tag">Ceiling</span>
              <span>X: ${data.ceilingCoordinate.x.toFixed(3)}m, Y: ${data.ceilingCoordinate.y.toFixed(3)}m, Z: ${data.ceilingCoordinate.z.toFixed(3)}m</span>
            </div>`
              : '<div class="coord-row" style="color:#94a3b8;">Ceiling point not yet recorded</div>'
          }
        </div>
      </section>
    `;

    this.bindModalBodyEvents();
  }

  private getRoomCenterXZAndFloor(): { cx: number; cz: number; floorY: number } {
    const pts = this.roomManager.getFloorPoints();
    if (pts.length === 0) return { cx: 0, cz: 0, floorY: 0 };
    let sx = 0, sy = 0, sz = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
      sz += p.z;
    }
    return { cx: sx / pts.length, cz: sz / pts.length, floorY: sy / pts.length };
  }

  private bindModalBodyEvents(): void {
    const content = this.els.modalContent;
    const scaleToMeters = this.roomManager.getUnitSystem() === 'imperial' ? 0.3048 : 1;

    const roomInput = content.querySelector<HTMLInputElement>('#room-name-input');
    roomInput?.addEventListener('input', () => {
      this.currentRoomNameDraft = roomInput.value;
    });

    content.querySelectorAll<HTMLButtonElement>('[data-start-mark]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-start-mark') === 'window' ? 'window' : 'door';
        if (this.roomManager.startMarkingOpening(type)) {
          this.closeExportModal();
          this.showToast(`Aim at ${type} corner #1 on any wall and tap`);
        }
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-preset-opening]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const spec = btn.getAttribute('data-preset-opening');
        if (!spec) return;
        const [type, wStr, hStr, label] = spec.split(':');
        this.roomManager.addOpening(
          type === 'window' ? 'window' : 'door',
          parseFloat(wStr),
          parseFloat(hStr),
          label
        );
        this.renderExportModalBody();
        this.showToast(`Added ${label}`);
      });
    });

    const openingForm = content.querySelector<HTMLFormElement>('#form-add-opening');
    const openingErrorEl = content.querySelector<HTMLElement>('#opening-form-error');
    if (openingForm) {
      const clearOpeningErrors = (el?: HTMLInputElement) => {
        if (el) el.removeAttribute('aria-invalid');
        if (openingErrorEl) openingErrorEl.textContent = '';
      };
      openingForm.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((inp) => {
        inp.addEventListener('input', () => clearOpeningErrors(inp));
      });
      openingForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(openingForm);
        const type = formData.get('openingType') === 'window' ? 'window' : 'door';
        const wEl = openingForm.querySelector<HTMLInputElement>('#custom-opening-w');
        const hEl = openingForm.querySelector<HTMLInputElement>('#custom-opening-h');
        const rawW = parseFloat(String(formData.get('width') ?? ''));
        const rawH = parseFloat(String(formData.get('height') ?? ''));
        const rawSill = parseFloat(String(formData.get('sill') ?? '0'));
        const rawWall = String(formData.get('wallIndex') ?? '');

        if (!Number.isFinite(rawW) || rawW <= 0) {
          wEl?.setAttribute('aria-invalid', 'true');
          wEl?.focus();
          if (openingErrorEl) openingErrorEl.textContent = 'Enter a valid width > 0.';
          return;
        }
        if (!Number.isFinite(rawH) || rawH <= 0) {
          hEl?.setAttribute('aria-invalid', 'true');
          hEl?.focus();
          if (openingErrorEl) openingErrorEl.textContent = 'Enter a valid height > 0.';
          return;
        }

        const w = rawW * scaleToMeters;
        const h = rawH * scaleToMeters;
        const sill = Number.isFinite(rawSill) && rawSill >= 0 ? rawSill * scaleToMeters : 0;
        const wallIndex = rawWall !== '' ? parseInt(rawWall, 10) : undefined;
        let offsetAlong: number | undefined;
        if (wallIndex !== undefined && Number.isFinite(wallIndex)) {
          const pts = this.roomManager.getFloorPoints();
          const p1 = pts[wallIndex];
          const p2 = pts[(wallIndex + 1) % pts.length];
          if (p1 && p2) {
            const wallLen = calculateHorizontalDistance(p1, p2);
            offsetAlong = Math.max(0, Math.round((wallLen - w) * 50) / 100);
          }
        }

        this.roomManager.addOpening(
          type,
          w,
          h,
          type === 'door' ? 'Custom Door' : 'Custom Window',
          {
            wallIndex: Number.isFinite(wallIndex) ? wallIndex : undefined,
            offsetAlongWallMeters: offsetAlong,
            sillHeightMeters: sill,
            source: 'manual'
          }
        );
        this.renderExportModalBody();
        this.showToast('Opening added');
      });
    }

    content.querySelectorAll<HTMLInputElement>('[data-edit-op-w], [data-edit-op-h]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const val = parseFloat(inp.value);
        if (!Number.isFinite(val) || val <= 0) return;
        const wId = inp.getAttribute('data-edit-op-w');
        const hId = inp.getAttribute('data-edit-op-h');
        if (wId) {
          this.roomManager.updateOpening(wId, { widthMeters: val * scaleToMeters, source: 'manual' });
        } else if (hId) {
          this.roomManager.updateOpening(hId, { heightMeters: val * scaleToMeters, source: 'manual' });
        }
        this.renderExportModalBody();
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-remove-opening]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-remove-opening');
        if (!id) return;
        this.roomManager.removeOpening(id);
        this.renderExportModalBody();
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-preset-furn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const spec = btn.getAttribute('data-preset-furn');
        if (!spec) return;
        const [label, wStr, dStr, hStr] = spec.split(':');
        const { cx, cz, floorY } = this.getRoomCenterXZAndFloor();
        this.roomManager.addFurniture({
          label,
          centerXZ: [cx, cz],
          widthMeters: parseFloat(wStr),
          depthMeters: parseFloat(dStr),
          heightMeters: parseFloat(hStr),
          floorY,
          yawRad: 0,
          source: 'manual'
        });
        this.renderExportModalBody();
        this.showToast(`Added ${label} (drag in 2D Plan to position)`);
      });
    });

    const furnForm = content.querySelector<HTMLFormElement>('#form-add-furniture');
    const furnErrorEl = content.querySelector<HTMLElement>('#furn-form-error');
    if (furnForm) {
      furnForm.querySelectorAll<HTMLInputElement>('input').forEach((inp) => {
        inp.addEventListener('input', () => {
          inp.removeAttribute('aria-invalid');
          if (furnErrorEl) furnErrorEl.textContent = '';
        });
      });
      furnForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(furnForm);
        const label = String(formData.get('label') ?? '').trim();
        const rawW = parseFloat(String(formData.get('width') ?? ''));
        const rawD = parseFloat(String(formData.get('depth') ?? ''));
        const rawH = parseFloat(String(formData.get('height') ?? ''));
        if (!label) {
          furnForm.querySelector<HTMLInputElement>('#furn-label')?.setAttribute('aria-invalid', 'true');
          if (furnErrorEl) furnErrorEl.textContent = 'Enter a furniture label.';
          return;
        }
        if (!Number.isFinite(rawW) || rawW <= 0 || !Number.isFinite(rawD) || rawD <= 0 || !Number.isFinite(rawH) || rawH <= 0) {
          if (furnErrorEl) furnErrorEl.textContent = 'Enter valid positive dimensions.';
          return;
        }
        const { cx, cz, floorY } = this.getRoomCenterXZAndFloor();
        this.roomManager.addFurniture({
          label,
          centerXZ: [cx, cz],
          widthMeters: rawW * scaleToMeters,
          depthMeters: rawD * scaleToMeters,
          heightMeters: rawH * scaleToMeters,
          floorY,
          yawRad: 0,
          source: 'manual'
        });
        this.renderExportModalBody();
        this.showToast(`Added ${label}`);
      });
    }

    content
      .querySelectorAll<HTMLInputElement>('[data-edit-furn-w], [data-edit-furn-d], [data-edit-furn-h]')
      .forEach((inp) => {
        inp.addEventListener('change', () => {
          const val = parseFloat(inp.value);
          if (!Number.isFinite(val) || val <= 0) return;
          const wId = inp.getAttribute('data-edit-furn-w');
          const dId = inp.getAttribute('data-edit-furn-d');
          const hId = inp.getAttribute('data-edit-furn-h');
          if (wId) {
            this.roomManager.updateFurniture(wId, { widthMeters: val * scaleToMeters, source: 'manual' });
          } else if (dId) {
            this.roomManager.updateFurniture(dId, { depthMeters: val * scaleToMeters, source: 'manual' });
          } else if (hId) {
            this.roomManager.updateFurniture(hId, { heightMeters: val * scaleToMeters, source: 'manual' });
          }
          this.renderExportModalBody();
        });
      });

    content.querySelectorAll<HTMLButtonElement>('[data-rotate-furn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-rotate-furn');
        if (!id) return;
        this.roomManager.rotateFurniture90(id);
        this.renderExportModalBody();
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-remove-furn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-remove-furn');
        if (!id) return;
        this.roomManager.removeFurniture(id);
        this.renderExportModalBody();
      });
    });

    const saveRoomBtn = content.querySelector<HTMLButtonElement>('#btn-save-room');
    saveRoomBtn?.addEventListener('click', () => {
      if (this.roomManager.getFloorPoints().length < 2) {
        this.showToast('Pin at least 2 corners before saving');
        return;
      }
      const name = roomInput?.value || this.currentRoomNameDraft || 'Measured Room';
      const saved = this.roomManager.saveCurrentRoom(name);
      this.renderExportModalBody();
      this.showToast(`Saved "${saved.name}" to history`);
    });

    content.querySelectorAll<HTMLButtonElement>('[data-load-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-load-room');
        if (!id) return;
        if (this.roomManager.loadSavedRoom(id)) {
          this.renderExportModalBody();
          this.showToast('Room loaded into 3D scene');
        }
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-delete-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-delete-room');
        if (!id) return;
        this.roomManager.deleteSavedRoom(id);
        this.renderExportModalBody();
        this.showToast('Room deleted from history');
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-pick-tex]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-pick-tex');
        if (!key) return;
        this.pendingTextureSurfaceKey = key;
        this.photoFileInput.click();
      });
    });

    content.querySelectorAll<HTMLSelectElement>('[data-tex-mode]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const key = sel.getAttribute('data-tex-mode');
        if (!key) return;
        const existing = this.roomManager.getSurfaceTexture(key);
        if (!existing) return;
        const mode: SurfaceTextureMode = sel.value === 'stretch' ? 'stretch' : 'tile';
        this.roomManager.setSurfaceTexture({ ...existing, mode });
      });
    });

    content.querySelectorAll<HTMLButtonElement>('[data-clear-tex]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-clear-tex');
        if (!key) return;
        this.roomManager.removeSurfaceTexture(key);
        this.renderExportModalBody();
        this.showToast('Surface texture removed');
      });
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private closeExportModal(): void {
    this.els.exportModal.classList.add('hidden');
  }

  private revokeScreenshotUrl(): void {
    if (this.currentScreenshotUrl) {
      URL.revokeObjectURL(this.currentScreenshotUrl);
      this.currentScreenshotUrl = null;
    }
  }

  private closeScreenshotModal(): void {
    this.els.screenshotModal.classList.add('hidden');
    this.els.screenshotPreviewImg.removeAttribute('src');
    this.revokeScreenshotUrl();
  }

  private async handleTakeScreenshot(): Promise<void> {
    if (!this.snapshotManager) return;
    this.triggerShutterFlash();

    try {
      this.showToast('Generating AR measurement photo...');
      const blob = await this.snapshotManager.generateCompositeSnapshot();
      this.currentScreenshotBlob = blob;
      this.revokeScreenshotUrl();
      this.currentScreenshotUrl = URL.createObjectURL(blob);
      this.els.screenshotPreviewImg.src = this.currentScreenshotUrl;
      this.els.screenshotModal.classList.remove('hidden');
    } catch (err) {
      console.error('[Snapshot] Capture error:', err);
      this.showToast('Failed to capture snapshot');
    }
  }

  private triggerShutterFlash(): void {
    this.els.shutterFlash.classList.remove('hidden');
    this.els.shutterFlash.classList.add('flash-active');
    setTimeout(() => {
      this.els.shutterFlash.classList.remove('flash-active');
      setTimeout(() => this.els.shutterFlash.classList.add('hidden'), 250);
    }, 120);
  }

  private async shareOrSaveScreenshot(): Promise<void> {
    if (!this.currentScreenshotBlob) return;
    const file = new File(
      [this.currentScreenshotBlob],
      `spatial-room-${Date.now()}.png`,
      { type: 'image/png' }
    );

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'SpatialMeasure AR Room Capture',
          text: this.roomManager.getFormattedSummaryText()
        });
        return;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          this.downloadScreenshotFile();
        }
        return;
      }
    }
    this.downloadScreenshotFile();
  }

  private downloadScreenshotFile(): void {
    if (!this.currentScreenshotBlob) return;
    this.triggerBlobDownload(this.currentScreenshotBlob, `spatial-room-${Date.now()}.png`);
    this.showToast('Photo saved to downloads!');
  }

  public showToast(msg: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    const host = this.els.arOverlay.classList.contains('hidden') ? document.body : this.els.arOverlay;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('show');
    }, 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }
}
