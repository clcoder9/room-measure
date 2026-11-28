import {
  DepthPreference,
  HEATMAP_COLS,
  HEATMAP_ROWS,
  SPIKE_SAMPLE_PRESETS,
  SensorSpikeProbe,
  SpikeReportExport,
  SpikeSampleTag
} from './SensorSpikeProbe';
import { SpikeVisuals } from './SpikeVisuals';

export interface SpikeOverlayCallbacks {
  onExitSpikeMode: () => void;
  onSwitchDepthPreference: (nextPref: DepthPreference) => void;
  onToast: (msg: string) => void;
}

export class SpikeOverlayUI {
  private probe: SensorSpikeProbe;
  private visuals: SpikeVisuals;
  private callbacks: SpikeOverlayCallbacks;

  private roiGuideEl: HTMLElement;
  private panelEl: HTMLElement;
  private modePillEl: HTMLElement;
  private streamBadgeEl: HTMLElement;
  private btnPtsEl: HTMLButtonElement;
  private btnDepthModeEl: HTMLButtonElement;
  private btnMinimizeEl: HTMLButtonElement;
  private btnExitEl: HTMLButtonElement;

  private heatmapCanvas: HTMLCanvasElement;
  private heatmapCtx: CanvasRenderingContext2D;
  private heatmapImgData: ImageData;

  private valCenterEl: HTMLElement;
  private valRmsEl: HTMLElement;
  private valValidEl: HTMLElement;
  private valSurfaceEl: HTMLElement;
  private valPlanesEl: HTMLElement;
  private valFeaturesEl: HTMLElement;

  private chipsRowEl: HTMLElement;
  private copyLabelEl: HTMLElement;
  private reportPreEl: HTMLElement;
  private btnDownloadEl: HTMLButtonElement;
  private btnClearEl: HTMLButtonElement;

  // Landing screen saved report card
  private landingCardEl: HTMLElement | null;
  private landingSummaryEl: HTMLElement | null;
  private landingReportPreEl: HTMLElement | null;
  private landingCopyLabelEl: HTMLElement | null;
  private btnLandingDownloadEl: HTMLButtonElement | null;
  private btnLandingClearEl: HTMLButtonElement | null;

  private isMinimized = false;

  constructor(
    probe: SensorSpikeProbe,
    visuals: SpikeVisuals,
    callbacks: SpikeOverlayCallbacks
  ) {
    this.probe = probe;
    this.visuals = visuals;
    this.callbacks = callbacks;

    this.roiGuideEl = document.getElementById('spike-roi-guide')!;
    this.panelEl = document.getElementById('spike-panel')!;
    this.modePillEl = document.getElementById('spike-mode-pill')!;
    this.streamBadgeEl = document.getElementById('spike-stream-badge')!;
    this.btnPtsEl = document.getElementById('btn-spike-pts') as HTMLButtonElement;
    this.btnDepthModeEl = document.getElementById('btn-spike-depth-mode') as HTMLButtonElement;
    this.btnMinimizeEl = document.getElementById('btn-spike-minimize') as HTMLButtonElement;
    this.btnExitEl = document.getElementById('btn-spike-exit') as HTMLButtonElement;

    this.heatmapCanvas = document.getElementById('spike-heatmap-canvas') as HTMLCanvasElement;
    const ctx = this.heatmapCanvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D context for spike heatmap');
    this.heatmapCtx = ctx;
    this.heatmapImgData = ctx.createImageData(HEATMAP_COLS, HEATMAP_ROWS);

    this.valCenterEl = document.getElementById('spike-val-center')!;
    this.valRmsEl = document.getElementById('spike-val-rms')!;
    this.valValidEl = document.getElementById('spike-val-valid')!;
    this.valSurfaceEl = document.getElementById('spike-val-surface')!;
    this.valPlanesEl = document.getElementById('spike-val-planes')!;
    this.valFeaturesEl = document.getElementById('spike-val-features')!;

    this.chipsRowEl = document.getElementById('spike-chips-row')!;
    this.copyLabelEl = document.getElementById('spike-copy-label')!;
    this.reportPreEl = document.getElementById('spike-report-pre')!;
    this.btnDownloadEl = document.getElementById('btn-spike-download') as HTMLButtonElement;
    this.btnClearEl = document.getElementById('btn-spike-clear') as HTMLButtonElement;

    this.landingCardEl = document.getElementById('landing-spike-saved-card');
    this.landingSummaryEl = document.getElementById('landing-spike-summary');
    this.landingReportPreEl = document.getElementById('landing-spike-report-pre');
    this.landingCopyLabelEl = document.getElementById('landing-spike-copy-label');
    this.btnLandingDownloadEl = document.getElementById(
      'btn-landing-spike-download'
    ) as HTMLButtonElement | null;
    this.btnLandingClearEl = document.getElementById(
      'btn-landing-spike-clear'
    ) as HTMLButtonElement | null;

    this.renderSampleChips();
    this.bindEvents();
    this.refreshLandingSavedCard();
  }

  private renderSampleChips(): void {
    this.chipsRowEl.innerHTML = SPIKE_SAMPLE_PRESETS.map(
      (p) =>
        `<button type="button" class="btn-chip spike-chip" data-spike-tag="${p.tag}">${p.shortLabel}</button>`
    ).join('');
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
      this.callbacks.onToast(next ? '3D depth points shown' : '3D depth points hidden');
    });

    this.btnDepthModeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = this.probe.getSessionInfo().depthPreference;
      const next: DepthPreference = current === 'raw-first' ? 'smooth-first' : 'raw-first';
      this.callbacks.onSwitchDepthPreference(next);
    });

    this.btnMinimizeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isMinimized = !this.isMinimized;
      this.panelEl.classList.toggle('minimized', this.isMinimized);
      this.btnMinimizeEl.textContent = this.isMinimized ? '▴' : '▾';
      this.btnMinimizeEl.setAttribute(
        'aria-label',
        this.isMinimized ? 'Expand spike diagnostics' : 'Minimize spike diagnostics'
      );
    });

    this.btnExitEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onExitSpikeMode();
    });

    this.chipsRowEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-spike-tag]');
      if (!btn) return;
      const tag = btn.getAttribute('data-spike-tag') as SpikeSampleTag | null;
      if (!tag) return;
      const preset = SPIKE_SAMPLE_PRESETS.find((p) => p.tag === tag);
      if (!preset) return;

      const sample = this.probe.captureSample(tag, preset.label);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(20);
        } catch {
          // Ignore
        }
      }

      this.syncReportText();
      this.updateChipCounts();
      this.refreshLandingSavedCard();

      const dStr =
        sample.metrics.centerDepthM !== null ? `${sample.metrics.centerDepthM.toFixed(2)}m` : 'n/a';
      const rmsStr = sample.metrics.planeFit
        ? `RMS ${sample.metrics.planeFit.residualRmsCm.toFixed(1)}cm`
        : 'no fit';
      this.callbacks.onToast(`Captured ${preset.shortLabel}: ${dStr} (${rmsStr})`);
    });

    this.btnDownloadEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.downloadReport(this.probe.buildReportExport());
    });

    this.btnClearEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.probe.clearSamples();
      this.syncReportText();
      this.updateChipCounts();
      this.refreshLandingSavedCard();
      this.callbacks.onToast('Cleared spike samples');
    });

    this.btnLandingDownloadEl?.addEventListener('click', () => {
      const saved = SensorSpikeProbe.loadSavedReport();
      if (saved) {
        this.downloadReport(saved);
      }
    });

    this.btnLandingClearEl?.addEventListener('click', () => {
      this.probe.clearSamples();
      this.refreshLandingSavedCard();
      this.callbacks.onToast('Cleared saved spike report');
    });
  }

  public setVisible(visible: boolean): void {
    this.panelEl.classList.toggle('hidden', !visible);
    this.roiGuideEl.classList.toggle('hidden', !visible);
    if (visible) {
      this.syncReportText();
      this.updateChipCounts();
      this.updateTelemetry();
    }
  }

  public syncReportText(): void {
    const json = JSON.stringify(this.probe.buildReportExport(), null, 2);
    this.reportPreEl.textContent = json;
    const count = this.probe.getSamples().length;
    this.copyLabelEl.textContent = `Copy JSON (${count})`;
  }

  public refreshLandingSavedCard(): void {
    if (!this.landingCardEl || !this.landingReportPreEl || !this.landingSummaryEl) return;
    const saved = SensorSpikeProbe.loadSavedReport();
    if (!saved) {
      this.landingCardEl.classList.add('hidden');
      this.landingReportPreEl.textContent = '';
      return;
    }

    this.landingCardEl.classList.remove('hidden');
    this.landingReportPreEl.textContent = JSON.stringify(saved, null, 2);
    const s = saved.session;
    const resText =
      s.depthWidth > 0 ? `${s.depthWidth}×${s.depthHeight} ${s.depthDataFormat}` : s.mode;
    this.landingSummaryEl.textContent = `${saved.sampleCount} sample${saved.sampleCount === 1 ? '' : 's'} • ${resText} • Planes: ${saved.latestMetrics.detectedPlanesSupported ? 'yes' : 'no'}`;
    if (this.landingCopyLabelEl) {
      this.landingCopyLabelEl.textContent = `Copy Spike JSON (${saved.sampleCount})`;
    }
  }

  private updateChipCounts(): void {
    const buttons = this.chipsRowEl.querySelectorAll<HTMLButtonElement>('[data-spike-tag]');
    buttons.forEach((btn) => {
      const tag = btn.getAttribute('data-spike-tag') as SpikeSampleTag;
      const preset = SPIKE_SAMPLE_PRESETS.find((p) => p.tag === tag);
      if (!preset) return;
      const count = this.probe.getSampleCountByTag(tag);
      btn.textContent = count > 0 ? `${preset.shortLabel} (${count})` : preset.shortLabel;
      btn.classList.toggle('has-samples', count > 0);
    });
  }

  public updateTelemetry(): void {
    const s = this.probe.getSessionInfo();
    const m = this.probe.getLatestMetrics();

    this.modePillEl.textContent = s.mode === 'immersive-ar' ? 'AR LIVE' : 'VIEWER';
    this.modePillEl.className = `spike-mode-pill ${s.mode === 'immersive-ar' ? 'live' : 'sim'}`;

    if (s.depthActive && s.depthWidth > 0) {
      this.streamBadgeEl.textContent = `${s.depthWidth}×${s.depthHeight} ${s.depthDataFormat} • ${m.depthHz}Hz / ${m.xrFps}fps`;
      this.streamBadgeEl.className = 'badge badge-success';
    } else if (s.depthSupported) {
      this.streamBadgeEl.textContent = `Depth waiting • ${m.xrFps}fps`;
      this.streamBadgeEl.className = 'badge badge-warning';
    } else {
      this.streamBadgeEl.textContent = `No Depth API • ${m.xrFps}fps`;
      this.streamBadgeEl.className = 'badge badge-muted';
    }

    this.btnDepthModeEl.textContent =
      s.depthPreference === 'raw-first' ? `Raw (${s.depthType})` : `Smooth (${s.depthType})`;
    this.btnPtsEl.setAttribute('aria-pressed', String(this.visuals.isShowingPoints()));

    // 1. Center / Hit Δ
    const centerStr = m.centerDepthM !== null ? `${m.centerDepthM.toFixed(2)}m` : '--';
    const deltaStr =
      m.deltaDepthMinusHitCm !== null
        ? `Δ ${m.deltaDepthMinusHitCm >= 0 ? '+' : ''}${m.deltaDepthMinusHitCm.toFixed(1)}cm`
        : 'hit: --';
    this.valCenterEl.textContent = `${centerStr} (${deltaStr})`;

    // 2. Plane RMS / Jitter
    const rmsStr = m.planeFit ? `${m.planeFit.residualRmsCm.toFixed(1)}cm` : '--';
    const jitStr = m.temporalCenterStdCm !== null ? `±${m.temporalCenterStdCm.toFixed(1)}cm` : '--';
    this.valRmsEl.textContent = `${rmsStr} / ${jitStr}`;
    this.valRmsEl.className = 'spike-metric-val';
    if (m.planeFit) {
      if (m.planeFit.residualRmsCm < 1.5) this.valRmsEl.classList.add('good');
      else if (m.planeFit.residualRmsCm <= 3.5) this.valRmsEl.classList.add('warn');
      else this.valRmsEl.classList.add('bad');
    }

    // 3. ROI / Frame Valid
    this.valValidEl.textContent = `${m.roiValidPct.toFixed(0)}% / ${m.frameValidPct.toFixed(0)}% (0:${m.frameZeroOrInvalidPct.toFixed(0)}%)`;

    // 4. Surface Fit
    if (m.planeFit) {
      this.valSurfaceEl.textContent = `${m.planeFit.surfaceClass} (graze ${m.planeFit.grazingAngleDeg.toFixed(0)}°)`;
    } else {
      this.valSurfaceEl.textContent = 'Need ≥12 ROI pts';
    }

    // 5. Planes / Meshes
    const planeFlag = m.detectedPlanesSupported ? 'on' : 'off';
    const meshFlag = m.detectedMeshesSupported ? 'on' : 'off';
    this.valPlanesEl.textContent = `P:${m.detectedPlanesTotal}(H${m.detectedPlanesHorizontal}/V${m.detectedPlanesVertical},${planeFlag}) M:${m.detectedMeshesTotal}(${meshFlag})`;

    // 6. Features / Type
    const rawFlag = s.rawBufferAccessVerified ? 'buf✓' : 'api';
    this.valFeaturesEl.textContent = `${s.depthType} • att#${s.negotiationAttempt} • ${rawFlag}`;

    this.drawHeatmap();
    this.syncReportText();
  }

  private drawHeatmap(): void {
    const depths = this.probe.getHeatmapDepths();
    const data = this.heatmapImgData.data;

    for (let i = 0; i < depths.length; i++) {
      const d = depths[i];
      const px = i * 4;

      if (d < 0) {
        // Out of depth FOV crop
        data[px] = 15;
        data[px + 1] = 23;
        data[px + 2] = 42;
        data[px + 3] = 255;
      } else if (d < 0.05) {
        // Invalid / hole / glass
        data[px] = 236;
        data[px + 1] = 72;
        data[px + 2] = 153;
        data[px + 3] = 255;
      } else {
        const t = Math.max(0, Math.min(1, (d - 0.3) / 4.2));
        let r = 0;
        let g = 0;
        let b = 0;
        if (t < 0.33) {
          const k = t / 0.33;
          r = 255 * (1 - 0.85 * k);
          g = 255 * (0.45 + 0.5 * k);
          b = 255 * (0.1 + 0.3 * k);
        } else if (t < 0.66) {
          const k = (t - 0.33) / 0.33;
          r = 255 * (0.15 - 0.15 * k);
          g = 255 * (0.95 - 0.15 * k);
          b = 255 * (0.4 + 0.6 * k);
        } else {
          const k = (t - 0.66) / 0.34;
          r = 255 * (0.22 * k);
          g = 255 * (0.8 - 0.45 * k);
          b = 255;
        }
        data[px] = r | 0;
        data[px + 1] = g | 0;
        data[px + 2] = b | 0;
        data[px + 3] = 255;
      }
    }

    this.heatmapCtx.putImageData(this.heatmapImgData, 0, 0);

    // Draw crisp ROI rectangle [0.42, 0.58]^2 and center crosshair
    const x0 = Math.round(0.42 * HEATMAP_COLS);
    const y0 = Math.round(0.42 * HEATMAP_ROWS);
    const w = Math.max(4, Math.round(0.16 * HEATMAP_COLS));
    const h = Math.max(4, Math.round(0.16 * HEATMAP_ROWS));
    this.heatmapCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    this.heatmapCtx.lineWidth = 1;
    this.heatmapCtx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
  }

  private downloadReport(report: SpikeReportExport): void {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pixel11pro-phase0-spike-${Date.now()}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    this.callbacks.onToast('Spike JSON report downloaded!');
  }
}
