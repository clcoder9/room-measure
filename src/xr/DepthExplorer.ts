/**
 * WebXR Depth Sensing API Explorer
 * Queries XRFrame.getDepthInformation(view) during the AR session to test and log
 * depth buffer availability on Pixel Pro (and ARCore depth-enabled devices).
 */

export interface DepthDiagnostics {
  supported: boolean;
  active: boolean;
  usage?: string;
  dataFormat?: string;
  width?: number;
  height?: number;
  centerDepthMeters?: number;
  statusMessage: string;
}

export class DepthExplorer {
  private lastSampleTime = 0;
  private sampleInterval = 1000; // Log/sample once per second to avoid CPU overhead
  private diagnostics: DepthDiagnostics = {
    supported: false,
    active: false,
    statusMessage: 'Depth sensing not initiated'
  };

  private onUpdateCallback?: (diag: DepthDiagnostics) => void;

  public setUpdateListener(cb: (diag: DepthDiagnostics) => void): void {
    this.onUpdateCallback = cb;
  }

  public getDiagnostics(): DepthDiagnostics {
    return this.diagnostics;
  }

  /**
   * Called on every AR frame to probe depth availability
   */
  public probeFrame(frame: XRFrame, referenceSpace: XRReferenceSpace, timestamp: number): void {
    if (timestamp - this.lastSampleTime < this.sampleInterval) {
      return;
    }
    this.lastSampleTime = timestamp;

    const viewerPose = frame.getViewerPose(referenceSpace);
    if (!viewerPose || viewerPose.views.length === 0) {
      return;
    }

    const view = viewerPose.views[0];
    const frameWithDepth = frame as unknown as {
      getDepthInformation?: (view: XRView) => XRCPUDepthInformation | null;
    };

    if (typeof frameWithDepth.getDepthInformation !== 'function') {
      this.diagnostics = {
        supported: false,
        active: false,
        statusMessage: 'Depth API method getDepthInformation() not found on XRFrame'
      };
      this.notify();
      return;
    }

    try {
      const depthInfo = frameWithDepth.getDepthInformation(view);
      if (depthInfo) {
        // Query center point depth (0.5, 0.5)
        let centerDepth: number | undefined;
        if (typeof depthInfo.getDepthInMeters === 'function') {
          try {
            centerDepth = depthInfo.getDepthInMeters(0.5, 0.5);
          } catch {
            // center depth outside valid bounds
          }
        }

        const session = frame.session as unknown as {
          depthUsage?: string;
          depthDataFormat?: string;
        };

        this.diagnostics = {
          supported: true,
          active: true,
          usage: session.depthUsage || 'cpu-optimized',
          dataFormat: session.depthDataFormat || 'float32 / luminance-alpha',
          width: depthInfo.width,
          height: depthInfo.height,
          centerDepthMeters: centerDepth,
          statusMessage: `Active (${depthInfo.width}x${depthInfo.height}${centerDepth ? `, ~${centerDepth.toFixed(2)}m` : ''})`
        };

        console.debug('[WebXR Depth API] Available:', this.diagnostics);
      } else {
        this.diagnostics = {
          supported: true,
          active: false,
          statusMessage: 'Depth sensing negotiated but no frame depth buffer'
        };
      }
    } catch (err) {
      this.diagnostics = {
        supported: false,
        active: false,
        statusMessage: `Depth probe error: ${(err as Error).message}`
      };
    }

    this.notify();
  }

  private notify(): void {
    if (this.onUpdateCallback) {
      this.onUpdateCallback(this.diagnostics);
    }
  }

  public reset(): void {
    this.diagnostics = {
      supported: false,
      active: false,
      statusMessage: 'Waiting for AR session...'
    };
    this.notify();
  }
}
