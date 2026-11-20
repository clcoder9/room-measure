import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  // Enable HTTPS by default for mobile WebXR, disable only with --mode http
  const isHttp = mode === 'http';

  return {
    base: './',
    plugins: isHttp ? [] : [basicSsl()],
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
