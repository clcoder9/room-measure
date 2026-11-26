import * as THREE from 'three';
import { RoomManager, RoomMetrics } from '../measurement/RoomManager';
import { DepthDiagnostics } from '../xr/DepthExplorer';
import { formatDistance, formatArea, formatVolume } from '../measurement/math';
import { MiniMap } from './MiniMap';
import { SnapshotManager } from './SnapshotManager';

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
  btnExport: HTMLButtonElement;
  exportModal: HTMLElement;
  modalCloseBtn: HTMLButtonElement;
  modalContent: HTMLElement;
  summaryReportPre: HTMLElement;
  btnCopySummary: HTMLButtonElement;
  btnDownloadSvg: HTMLButtonElement;
  btnDownloadJson: HTMLButtonElement;
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

  private onPinRequested: () => void;
  private onExitRequested: () => void;
  private onRestartSessionRequested: () => Promise<void> | void;
  private onSpikeToggleRequested?: () => void;
  private onBeforeCopy?: (targetId: string) => void;
  private onLandingShown?: () => void;
  private btnOpenHelp: HTMLButtonElement | null;
  private helpModal: HTMLDialogElement | null;
  private helpCloseBtn: HTMLButtonElement | null;

  constructor(
    els: UIElements,
    roomManager: RoomManager,
    callbacks: {
      onPinRequested: () => void;
      onExitRequested: () => void;
      onRestartSessionRequested: () => Promise<void> | void;
      onSpikeToggleRequested?: () => void;
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
    this.onBeforeCopy = callbacks.onBeforeCopy;
    this.onLandingShown = callbacks.onLandingShown;
    this.btnOpenHelp =
      els.btnOpenHelp ?? (document.getElementById('btn-open-help') as HTMLButtonElement | null);
    this.helpModal =
      els.helpModal ?? (document.getElementById('help-modal') as HTMLDialogElement | null);
    this.helpCloseBtn =
      els.helpCloseBtn ?? (document.getElementById('help-close-btn') as HTMLButtonElement | null);

    this.miniMap = new MiniMap(this.els.arOverlay, (index, wx, wz) => {
      this.roomManager.updateFloorPoint(index, wx, wz);
    });

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
      if (this.roomManager.getState() === 'COMPLETED') {
        this.roomManager.reset();
        this.showToast('Starting new room measurement');
      } else {
        this.onPinRequested();
      }
    });

    this.els.btnCloseFloor.addEventListener('click', (e) => {
      e.stopPropagation();
      this.roomManager.closeFloor();
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
      this.els.btnUnitToggle.setAttribute('aria-pressed', String(nextUnit === 'imperial'));
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `room-blueprint-${Date.now()}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('2D SVG blueprint downloaded!');
    });

    this.els.btnDownloadJson.addEventListener('click', (e) => {
      e.stopPropagation();
      const data = this.roomManager.getExportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `room-measurement-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('JSON report downloaded!');
    });
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
    this.els.hudBottom.classList.toggle('hidden', active);
    this.els.instructionBanner.classList.toggle('hidden', active);
    this.miniMap.setVisible(!active);
    this.els.btnSpikeToggle?.setAttribute('aria-pressed', String(active));
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
          'Room complete! Inspect 3D volume, drag corners in 2D Plan, add Openings, or Export.';
        this.els.btnPinPoint.textContent = '🔄 Start New Room';
        this.els.btnPinPoint.className = 'btn-hud btn-hud-restart';
        this.els.btnCloseFloor.disabled = true;
        this.els.btnUndo.setAttribute('aria-disabled', 'false');
        break;
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
      openingsLabelSpan.textContent =
        metrics.openingsCount > 0 ? `Openings (${metrics.openingsCount})` : 'Openings';
    }

    if (metrics.grossWallArea > 0) {
      this.els.wallAreaSummary.textContent =
        metrics.openingsCount > 0
          ? `Gross Wall: ${formatArea(metrics.grossWallArea, unit, false)} • Openings (${metrics.openingsCount}): -${formatArea(metrics.openingsArea, unit, false)} • Net: ${formatArea(metrics.netWallArea, unit, false)}`
          : `Gross Wall: ${formatArea(metrics.grossWallArea, unit, false)} • Net Wall: ${formatArea(metrics.netWallArea, unit, false)}`;
      this.els.wallAreaSummary.classList.remove('hidden');
    } else if (metrics.openingsCount > 0) {
      this.els.wallAreaSummary.textContent = `Openings (${metrics.openingsCount}): -${formatArea(metrics.openingsArea, unit, false)} queued (pin ceiling for Net Wall Area)`;
      this.els.wallAreaSummary.classList.remove('hidden');
    } else {
      this.els.wallAreaSummary.classList.add('hidden');
    }
  }

  public renderMiniMap(
    floorPoints: THREE.Vector3[],
    isClosed: boolean,
    reticlePos: THREE.Vector3 | null,
    camera: THREE.Camera
  ): void {
    const snap = this.roomManager.getLiveSnapState();
    const effectiveReticle = snap.effectiveReticlePos ?? reticlePos;
    this.miniMap.render(
      floorPoints,
      isClosed,
      effectiveReticle,
      camera,
      this.roomManager.getUnitSystem(),
      snap.isSnappedToStart || snap.isOrthoSnapped
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
    this.els.summaryReportPre.textContent = this.roomManager.getFormattedSummaryText();

    const totalSavedArea = savedRooms.reduce((acc, r) => acc + r.metrics.floorAreaSqMeters, 0);
    const totalSavedVol = savedRooms.reduce((acc, r) => acc + r.metrics.roomVolumeCuMeters, 0);
    const isImperial = unit === 'imperial';
    const unitShort = isImperial ? 'ft' : 'm';
    const defaultW = isImperial ? '3.0' : '0.9';
    const defaultH = isImperial ? '6.9' : '2.1';
    const openingsSubBadge =
      data.metrics.openingsAreaSqMeters > 0
        ? ` • -${formatArea(data.metrics.openingsAreaSqMeters, unit, false)}`
        : '';
    const netWallNote =
      data.metrics.grossWallAreaSqMeters === 0
        ? '<span style="font-size:0.68rem; color:#94a3b8; margin-top:0.2rem;">Pin ceiling height to compute Net Wall Area</span>'
        : '';

    this.els.modalContent.innerHTML = `
      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">Floor Area</span>
          <span class="val highlight">${data.metrics.formatted.floorArea}</span>
        </div>
        <div class="summary-item">
          <span class="label">Room Volume</span>
          <span class="val highlight">${data.metrics.formatted.roomVolume}</span>
        </div>
        <div class="summary-item">
          <span class="label">Ceiling Height</span>
          <span class="val">${data.metrics.formatted.ceilingHeight}</span>
        </div>
        <div class="summary-item">
          <span class="label">Floor Perimeter</span>
          <span class="val">${data.metrics.formatted.floorPerimeter}</span>
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
          <button type="button" class="btn-chip" data-preset-opening="door:0.9:2.1:Standard Door">+ Standard Door (${formatDistance(0.9, unit)} × ${formatDistance(2.1, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="door:1.6:2.1:Double Door">+ Double Door (${formatDistance(1.6, unit)} × ${formatDistance(2.1, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="window:1.2:1.2:Window">+ Window (${formatDistance(1.2, unit)} × ${formatDistance(1.2, unit)})</button>
          <button type="button" class="btn-chip" data-preset-opening="window:1.8:1.5:Large Window">+ Large Window (${formatDistance(1.8, unit)} × ${formatDistance(1.5, unit)})</button>
        </div>
        <div class="custom-opening-form">
          <select id="custom-opening-type" class="modal-input" aria-label="Opening type">
            <option value="door">Door</option>
            <option value="window">Window</option>
          </select>
          <input id="custom-opening-w" class="modal-input" type="number" step="0.05" min="0.1" value="${defaultW}" aria-label="Width in ${isImperial ? 'feet' : 'meters'}" placeholder="Width (${unitShort})" />
          <input id="custom-opening-h" class="modal-input" type="number" step="0.05" min="0.1" value="${defaultH}" aria-label="Height in ${isImperial ? 'feet' : 'meters'}" placeholder="Height (${unitShort})" />
          <button type="button" id="btn-add-custom-opening" class="btn-mini">+ Add (${unitShort})</button>
        </div>
        <div class="list-stack">
          ${
            data.openings.length === 0
              ? '<div class="list-item-row" style="color:#94a3b8;">No doors or windows subtracted yet.</div>'
              : data.openings
                  .map(
                    (op) => `
              <div class="list-item-row">
                <span>${op.type === 'door' ? '🚪' : '🪟'} ${this.escapeHtml(op.label)} (${formatDistance(op.widthMeters, unit)} × ${formatDistance(op.heightMeters, unit)})</span>
                <button type="button" class="btn-mini btn-mini-danger" data-remove-opening="${this.escapeHtml(op.id)}">Remove</button>
              </div>`
                  )
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

  private bindModalBodyEvents(): void {
    const content = this.els.modalContent;

    const roomInput = content.querySelector<HTMLInputElement>('#room-name-input');
    roomInput?.addEventListener('input', () => {
      this.currentRoomNameDraft = roomInput.value;
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

    const addCustomBtn = content.querySelector<HTMLButtonElement>('#btn-add-custom-opening');
    addCustomBtn?.addEventListener('click', () => {
      const typeEl = content.querySelector<HTMLSelectElement>('#custom-opening-type');
      const wEl = content.querySelector<HTMLInputElement>('#custom-opening-w');
      const hEl = content.querySelector<HTMLInputElement>('#custom-opening-h');
      const type = typeEl?.value === 'window' ? 'window' : 'door';
      const rawW = parseFloat(wEl?.value || '');
      const rawH = parseFloat(hEl?.value || '');
      if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
        this.showToast('Enter valid opening dimensions');
        return;
      }
      const scaleToMeters = this.roomManager.getUnitSystem() === 'imperial' ? 0.3048 : 1;
      const w = rawW * scaleToMeters;
      const h = rawH * scaleToMeters;
      this.roomManager.addOpening(type, w, h, type === 'door' ? 'Custom Door' : 'Custom Window');
      this.renderExportModalBody();
      this.showToast('Opening added');
    });

    content.querySelectorAll<HTMLButtonElement>('[data-remove-opening]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-remove-opening');
        if (!id) return;
        this.roomManager.removeOpening(id);
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
    const url = URL.createObjectURL(this.currentScreenshotBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spatial-room-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
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
