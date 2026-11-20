import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

function stampServiceWorkerPlugin(buildVersion: string): Plugin {
  return {
    name: 'stamp-service-worker',
    closeBundle() {
      const distDir = path.resolve('dist');
      if (!fs.existsSync(distDir)) return;

      const swPath = path.join(distDir, 'sw.js');
      if (fs.existsSync(swPath)) {
        const swContent = fs.readFileSync(swPath, 'utf-8');
        fs.writeFileSync(swPath, swContent.replaceAll('__BUILD_VERSION__', buildVersion), 'utf-8');
      }

      const versionPath = path.join(distDir, 'version.json');
      fs.writeFileSync(
        versionPath,
        JSON.stringify({ version: buildVersion, builtAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  // Enable HTTPS by default for mobile WebXR, disable only with --mode http
  const isHttp = mode === 'http';
  const buildVersion = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(buildVersion),
    },
    plugins: isHttp
      ? [stampServiceWorkerPlugin(buildVersion)]
      : [basicSsl(), stampServiceWorkerPlugin(buildVersion)],
    server: {
      host: true,
      port: 5173,
    },
    build: {
      target: 'es2022',
      sourcemap: false,
    },
  };
});
