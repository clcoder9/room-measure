# SpatialMeasure AR - WebXR Room Dimension & Volumetric Measurement PWA

A mobile-first Progressive Web App (PWA) built with **WebXR Device API**, **Three.js**, and **Vite + TypeScript**, optimized for Google Chrome on Android (tested for Google Pixel Pro / ARCore devices).

The application allows users to measure physical room dimensions (length, width, ceiling height) and dynamically calculate 2D floor area and 3D room volume using spatial AR hit-testing and plane anchors.

---

## 🌐 Live Online Demo

Test the app directly online via GitHub Pages:

**[https://clcoder9.github.io/room-measure/](https://clcoder9.github.io/room-measure/)**

GitHub Pages serves the app over HTTPS, providing the **Secure Context** required for WebXR `immersive-ar` sessions in Chrome on Android, as well as the built-in **3D Desktop Simulator** on any desktop browser. Automatic deployments run via GitHub Actions on every push to `main`.

---

## 🚀 Key Features

1. **PWA Shell & Lifecycle:**
   - Offline-capable service worker caching (`sw.js`) and Web App Manifest (`manifest.json`).
   - Hardware & session capability checks via `navigator.xr.isSessionSupported('immersive-ar')`.
   - Clean entry/exit flows with custom HTML overlay root via WebXR `dom-overlay`.

2. **Spatial AR Hit-Testing & Reticle:**
   - Real-time continuous raycasting against real-world horizontal and vertical planes using `XRHitTestSource` (`viewer` space).
   - Animated 3D reticle (neon cyan outer ring, inner pulse ring, center dot, surface normal indicator).
   - Real-time dynamic preview guide line connecting the active reticle to the last placed corner.

3. **Room Measurement Workflow & Geometry Math:**
   - **Corner Pinning:** Tap anywhere on the camera view or use the HUD button to anchor 3D pins at the reticle position.
   - **Segment Distance:** Dynamic Euclidean distance calculation:
     $$d = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2 + (z_2 - z_1)^2}$$
   - **Floor Area (Shoelace Formula):** Once 3 or more points are placed and closed:
     $$A = \frac{1}{2} \left| \sum_{i=0}^{n-1} (x_i z_{i+1} - x_{i+1} z_i) \right|$$
   - **Translucent Floor Mesh:** Live rendered 2D polygon over the scanned floor surface.
   - **Ceiling Height & Room Volume:** Pin ceiling point directly above floor elevation:
     $$h = |y_{\text{ceiling}} - y_{\text{floor}}|$$
     $$\text{Volume} = \text{Floor Area} \times h$$
   - **Extruded 3D Volume Mesh:** Translucent wireframe 3D prism displaying the measured room enclosure.

4. **WebXR Depth Sensing API Exploration:**
   - Queries `XRFrame.getDepthInformation(view)` during active AR sessions on Pixel Pro hardware (`cpu-optimized`, `luminance-alpha` / `float32`).
   - Displays real-time depth buffer availability and status directly in the HUD diagnostic badge.

5. **Desktop 3D Simulator Fallback:**
   - When running in desktop browsers or environments without WebXR AR hardware, users can launch the built-in 3D Desktop Simulator to test the complete measurement flow, geometry math, and export capabilities.

6. **Summary & Export:**
   - Minimalist, high-contrast HUD overlay with live metric readouts.
   - Detailed modal summary with metric and imperial units ($m^2$ / sq ft, $m^3$ / cu ft).
   - Copy formatted summary to clipboard or download complete structured JSON file with 3D coordinates.

---

## 🛠️ Project Structure

```
room-measure/
├── .github/
│   └── workflows/
│       └── deploy.yml           # GitHub Actions pipeline for GitHub Pages
├── index.html                   # Mobile PWA shell, WebXR DOM Overlay, HUD controls
├── package.json                 # Dependencies (Three.js, Vite, TypeScript)
├── tsconfig.json                # TypeScript configuration
├── vite.config.ts               # Vite configuration (relative base & HTTPS dev)
├── public/
│   ├── icon-192.svg             # PWA app icons
│   ├── icon-512.svg
│   ├── manifest.json            # PWA manifest
│   └── sw.js                    # Offline service worker
└── src/
    ├── main.ts                  # App entry point, PWA registration, UI wiring
    ├── style.css                # Mobile-first high-contrast HUD styles
    ├── vite-env.d.ts            # Vite client TypeScript definitions
    ├── xr/
    │   ├── XRManager.ts         # WebXR session management, hit-test, simulator
    │   ├── Reticle.ts           # 3D normal-aligned animated reticle
    │   └── DepthExplorer.ts     # WebXR CPU depth sensing probe
    ├── measurement/
    │   ├── RoomManager.ts       # Measurement state machine, Shoelace area & volume
    │   ├── MeasurementVisuals.ts# 3D anchors, lines, dimension labels, polygon & volume
    │   └── math.ts              # Euclidean distance, Shoelace area, formatting
    └── ui/
        ├── MiniMap.ts           # Interactive 2D floor plan radar & corner fine-tuning
        ├── SnapshotManager.ts   # Composite AR measurement photo generator
        └── UIManager.ts         # High-contrast HUD overlay, metrics & export modal
```

---

## 📱 Testing on Android Chrome (Pixel Pro)

WebXR requires a **Secure Context** (`https://` or `http://localhost`).

### Option A: USB Remote Debugging with Port Forwarding (Recommended)
1. Connect your Android device to your computer via USB cable.
2. Enable **USB Debugging** on your phone (Developer Options).
3. On your computer in Chrome, navigate to `chrome://inspect/#devices`.
4. Click **Port forwarding...**:
   - Port: `5173`
   - IP address and port: `localhost:5173`
   - Check **Enable port forwarding**.
5. Start the plain HTTP dev server on your computer (ideal for `localhost` port forwarding):
   ```bash
   npm run dev:http
   ```
6. Open Chrome on your Android device and navigate to:
   ```
   http://localhost:5173
   ```
7. Tap **"Launch WebXR AR Session"**. Chrome will prompt for camera access and start the AR measurement session.

### Option B: Local Network over HTTPS
To access over local Wi-Fi from your phone, Vite enables HTTPS by default via `@vitejs/plugin-basic-ssl`:
```bash
npm run dev
```
Navigate to the displayed `https://<YOUR_LOCAL_IP>:5173` on your Android phone and accept the self-signed certificate.

---

## 💻 Running the App Locally

### Development Server:
```bash
npm run dev
```

### Production Build:
```bash
npm run build
npm run preview
```
