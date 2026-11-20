import './style.css';
import * as THREE from 'three';
import { XRManager } from './xr/XRManager';
import { UIManager, UIElements } from './ui/UIManager';
import { SnapshotManager } from './ui/SnapshotManager';

// Register PWA Service Worker only in production; unregister stale SWs in development
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => {
          console.log('[PWA] ServiceWorker registered with scope:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] ServiceWorker registration failed:', err);
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

  let uiManager: UIManager;

  // Initialize XR Manager
  const xrManager = new XRManager({
    container,
    overlayElement,
    onSessionStarted: () => {
      uiManager.showAROverlay();
    },
    onSessionEnded: () => {
      uiManager.showLandingScreen();
    },
    onStatusMessage: (msg) => {
      console.log('[XR Status]', msg);
    },
    onRenderFrame: (reticlePos, camera) => {
      if (uiManager) {
        uiManager.renderMiniMap(
          xrManager.getRoomManager().getFloorPoints(),
          xrManager.getRoomManager().isClosed(),
          reticlePos,
          camera
        );
      }
    }
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
    }
  });

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
      await xrManager.startARSession();
    } catch (err) {
      alert(`Could not start WebXR AR session: ${(err as Error).message}`);
    }
  });

  uiElements.btnStartSim.addEventListener('click', () => {
    xrManager.startSimulatorSession();
  });
}

window.addEventListener('DOMContentLoaded', initApp);
