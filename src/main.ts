import './style.css';
import * as THREE from 'three';
import { XRManager } from './xr/XRManager';
import { UIManager, UIElements } from './ui/UIManager';
import { SnapshotManager } from './ui/SnapshotManager';
import { SpikeOverlayUI } from './spike/SpikeOverlayUI';
import { AutoScanHUD } from './ui/AutoScanHUD';

let isRefreshing = false;

function isOnLandingScreen(): boolean {
  const arOverlay = document.getElementById('ar-overlay');
  return !arOverlay || arOverlay.classList.contains('hidden');
}

function showUpdateBanner(): void {
  const arOverlay = document.getElementById('ar-overlay');
  const host = isOnLandingScreen() ? document.body : (arOverlay ?? document.body);
  let banner = document.getElementById('update-banner');

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');

    const msg = document.createElement('span');
    msg.textContent = 'New app version deployed';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'update-banner-btn';
    btn.textContent = 'Reload Now';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isRefreshing) {
        isRefreshing = true;
        window.location.reload();
      }
    });

    banner.addEventListener('beforexrselect', (e) => {
      e.preventDefault();
    });

    banner.appendChild(msg);
    banner.appendChild(btn);
  }

  if (banner.parentElement !== host) {
    host.appendChild(banner);
  }
}

function handleNewVersionAvailable(): void {
  if (isOnLandingScreen()) {
    if (!isRefreshing) {
      isRefreshing = true;
      window.location.reload();
    }
  } else {
    showUpdateBanner();
  }
}

async function checkRemoteVersion(reg?: ServiceWorkerRegistration): Promise<void> {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const remote = (await res.json()) as { version?: string };
    if (remote.version && remote.version !== __APP_VERSION__) {
      console.log(`[PWA] New version detected: ${remote.version} (current: ${__APP_VERSION__})`);
      if (reg) {
        await reg.update().catch(() => {});
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      }
      showUpdateBanner();
    }
  } catch {
    // Ignore offline or transient fetch errors
  }
}

// Register PWA Service Worker only in production; unregister stale SWs in development
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      const hadController = Boolean(navigator.serviceWorker.controller);

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) {
          handleNewVersionAvailable();
        }
      });

      navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          console.log('[PWA] ServiceWorker registered with scope:', reg.scope);

          if (reg.waiting && navigator.serviceWorker.controller) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }

          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });

          const runUpdateCheck = () => {
            reg.update().catch(() => {});
            void checkRemoteVersion(reg);
          };

          runUpdateCheck();

          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              runUpdateCheck();
            }
          });

          window.setInterval(runUpdateCheck, 60_000);
        })
        .catch((err) => {
          console.warn('[PWA] ServiceWorker registration failed:', err);
          void checkRemoteVersion();
        });
    } else {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((reg) => {
          reg.unregister().catch(() => {});
        });
      });
    }
  });
}

function initApp(): void {
  const container = document.getElementById('canvas-container')!;
  const overlayElement = document.getElementById('ar-overlay')!;

  const versionLabel = document.getElementById('app-version-label');
  if (versionLabel) {
    versionLabel.textContent = `Build: ${__APP_VERSION__}`;
  }

  const uiElements: UIElements = {
    landingScreen: document.getElementById('landing-screen')!,
    arOverlay: overlayElement,
    hudTop: overlayElement.querySelector('.hud-top')!,
    hudBottom: overlayElement.querySelector('.hud-bottom')!,
    instructionBanner: overlayElement.querySelector('.instruction-banner')!,
    hudToolbar: overlayElement.querySelector('.hud-toolbar')!,
    toolbarStatus: document.getElementById('toolbar-status')!,
    wallAreaSummary: document.getElementById('wall-area-summary')!,
    btnStartAR: document.getElementById('btn-start-ar') as HTMLButtonElement,
    btnStartSim: document.getElementById('btn-start-sim') as HTMLButtonElement,
    btnOpenHelp: document.getElementById('btn-open-help') as HTMLButtonElement | null,
    helpModal: document.getElementById('help-modal') as HTMLDialogElement | null,
    helpCloseBtn: document.getElementById('help-close-btn') as HTMLButtonElement | null,
    btnExitSession: document.getElementById('btn-exit-session') as HTMLButtonElement,
    btnRestartSession: document.getElementById('btn-restart-session') as HTMLButtonElement,
    btnHudScreenshot: document.getElementById('btn-hud-screenshot') as HTMLButtonElement,
    shutterFlash: document.getElementById('shutter-flash')!,
    screenshotModal: document.getElementById('screenshot-modal')!,
    screenshotCloseBtn: document.getElementById('screenshot-close-btn') as HTMLButtonElement,
    screenshotPreviewImg: document.getElementById('screenshot-preview-img') as HTMLImageElement,
    btnShareScreenshot: document.getElementById('btn-share-screenshot') as HTMLButtonElement,
    btnDownloadScreenshot: document.getElementById('btn-download-screenshot') as HTMLButtonElement,
    statusBadge: document.getElementById('status-badge')!,
    depthBadge: document.getElementById('depth-badge')!,
    instructionText: document.getElementById('instruction-text')!,
    readoutSegment: document.getElementById('readout-segment')!,
    readoutArea: document.getElementById('readout-area')!,
    readoutHeight: document.getElementById('readout-height')!,
    readoutVolume: document.getElementById('readout-volume')!,
    btnPinPoint: document.getElementById('btn-pin-point') as HTMLButtonElement,
    btnCloseFloor: document.getElementById('btn-close-floor') as HTMLButtonElement,
    btnUndo: document.getElementById('btn-undo') as HTMLButtonElement,
    btnReset: document.getElementById('btn-reset') as HTMLButtonElement,
    btnSnapToggle: document.getElementById('btn-snap-toggle') as HTMLButtonElement,
    btnUnitToggle: document.getElementById('btn-unit-toggle') as HTMLButtonElement,
    btnOpenings: document.getElementById('btn-openings') as HTMLButtonElement,
    btnSpikeToggle: document.getElementById('btn-spike-toggle') as HTMLButtonElement | null,
    btnAutoScanToggle: document.getElementById('btn-autoscan-toggle') as HTMLButtonElement | null,
    btnExport: document.getElementById('btn-export') as HTMLButtonElement,
    exportModal: document.getElementById('export-modal')!,
    modalCloseBtn: document.getElementById('modal-close-btn') as HTMLButtonElement,
    modalContent: document.getElementById('modal-content')!,
    summaryReportPre: document.getElementById('summary-report-pre')!,
    btnCopySummary: document.getElementById('btn-copy-summary') as HTMLButtonElement,
    btnDownloadSvg: document.getElementById('btn-download-svg') as HTMLButtonElement,
    btnDownloadJson: document.getElementById('btn-download-json') as HTMLButtonElement,
    btnModalRestart: document.getElementById('btn-modal-restart') as HTMLButtonElement
  };

  const compatIndicator = document.getElementById('compat-indicator')!;
  const compatLabel = document.getElementById('compat-label')!;
  const btnStartAutoScan = document.getElementById('btn-start-autoscan') as HTMLButtonElement | null;
  const btnStartSpike = document.getElementById('btn-start-spike') as HTMLButtonElement | null;
  const btnSpikeDepthPref = document.getElementById('btn-spike-depth-pref') as HTMLButtonElement | null;

  let uiManager: UIManager;
  let spikeOverlayUI: SpikeOverlayUI;
  let autoScanHUD: AutoScanHUD;

  const syncModeUI = () => {
    const spikeActive = xrManager.isSpikeModeActive();
    const autoActive = xrManager.isAutoScanActive();
    uiManager.setSpikeUIMode(spikeActive);
    uiManager.setAutoScanUIMode(autoActive);
    spikeOverlayUI.setVisible(spikeActive);
    autoScanHUD.setVisible(autoActive);
  };

  // Initialize XR Manager
  const xrManager = new XRManager({
    container,
    overlayElement,
    onSessionStarted: () => {
      uiManager.showAROverlay();
      syncModeUI();
    },
    onSessionEnded: () => {
      uiManager.showLandingScreen();
      spikeOverlayUI.setVisible(false);
      autoScanHUD.setVisible(false);
    },
    onStatusMessage: (msg) => {
      console.log('[XR Status]', msg);
    },
    onRenderFrame: (reticlePos, camera) => {
      if (!uiManager) return;
      if (xrManager.isAutoScanActive()) {
        const sc = xrManager.getScanController();
        uiManager.renderAutoScanMiniMap(
          sc.getLatestShell(),
          sc.getLatestCameraPathXZ(),
          camera
        );
      } else if (!xrManager.isSpikeModeActive()) {
        uiManager.renderMiniMap(
          xrManager.getRoomManager().getFloorPoints(),
          xrManager.getRoomManager().isClosed(),
          reticlePos,
          camera
        );
      }
    },
    onSpikeFrameUpdated: () => {
      if (spikeOverlayUI && xrManager.isSpikeModeActive()) {
        spikeOverlayUI.updateTelemetry();
      }
    },
    isInteractionBlocked: () => (uiManager ? uiManager.isInteractionBlocked() : false)
  });

  // Initialize UI Manager
  uiManager = new UIManager(uiElements, xrManager.getRoomManager(), {
    onPinRequested: () => {
      xrManager.pinReticlePoint();
    },
    onExitRequested: () => {
      xrManager.stopSession();
    },
    onRestartSessionRequested: async () => {
      await xrManager.restartSession();
      syncModeUI();
    },
    onSpikeToggleRequested: () => {
      const next = !xrManager.isSpikeModeActive();
      xrManager.setSpikeModeActive(next);
      syncModeUI();
      uiManager.showToast(next ? 'Phase 0 Spike mode enabled' : 'Returned to manual measurement');
    },
    onAutoScanToggleRequested: () => {
      const next = !xrManager.isAutoScanActive();
      xrManager.setAutoScanActive(next);
      syncModeUI();
      uiManager.showToast(next ? 'Auto Room Scan enabled' : 'Returned to manual measurement');
    },
    onBeforeCopy: (targetId) => {
      if (targetId === 'spike-report-pre') {
        spikeOverlayUI.syncReportText();
      } else if (targetId === 'landing-spike-report-pre') {
        spikeOverlayUI.refreshLandingSavedCard();
      }
    },
    onLandingShown: () => {
      spikeOverlayUI.refreshLandingSavedCard();
    }
  });

  autoScanHUD = new AutoScanHUD(xrManager.getScanVisuals(), {
    onFinishScan: () => {
      const shell = xrManager.getScanController().getLatestShell();
      if (!shell || !shell.valid || shell.cornersXZ.length < 3) {
        uiManager.showToast('Keep scanning until walls are detected');
        return;
      }
      xrManager.getRoomManager().loadFromAutoScan(shell.cornersXZ, shell.floorY, shell.ceilingY);
      xrManager.setAutoScanActive(false);
      syncModeUI();
      uiManager.showToast(
        shell.ceilingY !== null
          ? '3D wireframe ready! Tap 2D Plan to fine-tune corners'
          : 'Floor walls locked! Aim at wall top to pin ceiling height'
      );
    },
    onExitToManual: () => {
      xrManager.setAutoScanActive(false);
      syncModeUI();
      uiManager.showToast('Switched to manual measurement mode');
    },
    onResetScan: () => {
      xrManager.getScanController().reset();
    },
    onTogglePause: () => {
      const sc = xrManager.getScanController();
      const next = !sc.isPaused();
      sc.setPaused(next);
      return next;
    },
    onToast: (msg) => {
      uiManager.showToast(msg);
    }
  });

  xrManager.getScanController().setOnUpdate((shell, stats) => {
    if (xrManager.isAutoScanActive()) {
      const unit = xrManager.getRoomManager().getUnitSystem();
      xrManager.getScanController().setUnitSystem(unit);
      autoScanHUD.update(shell, stats, unit);
    }
  });

  spikeOverlayUI = new SpikeOverlayUI(
    xrManager.getSensorSpikeProbe(),
    xrManager.getSpikeVisuals(),
    {
      onExitSpikeMode: () => {
        xrManager.setSpikeModeActive(false);
        syncModeUI();
        uiManager.showToast('Switched to manual measurement mode');
      },
      onSwitchDepthPreference: async (nextPref) => {
        const prefLabel = nextPref === 'raw-first' ? 'Raw' : 'Smooth';
        if (btnSpikeDepthPref) {
          btnSpikeDepthPref.textContent = `Depth: ${prefLabel}`;
        }
        uiManager.showToast(`Switching depth request to ${prefLabel}-first...`);
        try {
          await xrManager.switchDepthPreferenceLive(nextPref);
          syncModeUI();
        } catch (err) {
          uiManager.showToast(`Depth switch failed: ${(err as Error).message}`);
        }
      },
      onToast: (msg) => {
        uiManager.showToast(msg);
      }
    }
  );

  // Sync initial Depth preference button label on landing screen
  if (btnSpikeDepthPref) {
    btnSpikeDepthPref.textContent =
      xrManager.getDepthPreference() === 'raw-first' ? 'Depth: Raw' : 'Depth: Smooth';
    btnSpikeDepthPref.addEventListener('click', () => {
      const next = xrManager.getDepthPreference() === 'raw-first' ? 'smooth-first' : 'raw-first';
      xrManager.setDepthPreference(next);
      btnSpikeDepthPref.textContent = next === 'raw-first' ? 'Depth: Raw' : 'Depth: Smooth';
    });
  }

  // Initialize Snapshot Manager for capturing 3D AR measurements inside active frames
  const snapshotManager = new SnapshotManager(xrManager.getRoomManager(), xrManager);
  uiManager.setSnapshotManager(snapshotManager);

  // Connect Depth Diagnostics to UI Badge
  xrManager.getDepthExplorer().setUpdateListener((diag) => {
    uiManager.updateDepthDiagnostics(diag);
  });

  (window as any).__xrManager = xrManager;
  (window as any).__roomManager = xrManager.getRoomManager();
  (window as any).THREE = THREE;

  // WebXR Compatibility Detection
  XRManager.isARSupported().then((supported) => {
    if (supported) {
      compatIndicator.className = 'indicator-dot ready';
      compatLabel.textContent = 'WebXR AR Supported (Chrome Android / Pixel Pro)';
      uiElements.btnStartAR.disabled = false;
    } else {
      compatIndicator.className = 'indicator-dot unsupported';
      compatLabel.textContent = 'WebXR AR Not Detected (Simulator Ready)';
      uiElements.btnStartAR.disabled = true;
      uiElements.btnStartAR.title = 'WebXR immersive-ar session mode is not supported on this browser/platform.';
    }
  });

  // Launch Handlers
  uiElements.btnStartAR.addEventListener('click', async () => {
    try {
      xrManager.setSpikeModeActive(false);
      xrManager.setAutoScanActive(false);
      await xrManager.startARSession();
    } catch (err) {
      alert(`Could not start WebXR AR session: ${(err as Error).message}`);
    }
  });

  btnStartAutoScan?.addEventListener('click', async () => {
    xrManager.setSpikeModeActive(false);
    xrManager.setAutoScanActive(true);
    autoScanHUD.resetDisplay();
    const arSupported = await XRManager.isARSupported();
    if (arSupported) {
      try {
        await xrManager.startARSession();
        return;
      } catch (err) {
        console.warn('[AutoScan] AR launch failed, falling back to simulator:', err);
        uiManager.showToast(`AR failed (${(err as Error).message}), opening Simulator`);
      }
    }
    xrManager.startSimulatorSession();
  });

  uiElements.btnStartSim.addEventListener('click', () => {
    xrManager.setSpikeModeActive(false);
    xrManager.setAutoScanActive(false);
    xrManager.startSimulatorSession();
  });

  btnStartSpike?.addEventListener('click', async () => {
    xrManager.setAutoScanActive(false);
    xrManager.setSpikeModeActive(true);
    const arSupported = await XRManager.isARSupported();
    if (arSupported) {
      try {
        await xrManager.startARSession();
        return;
      } catch (err) {
        console.warn('[Spike] AR launch failed, falling back to simulator:', err);
        uiManager.showToast(`AR failed (${(err as Error).message}), opening Simulator`);
      }
    }
    xrManager.startSimulatorSession();
  });
}

window.addEventListener('DOMContentLoaded', initApp);
