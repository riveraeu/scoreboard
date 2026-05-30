import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Override with VITE_API_TARGET in .env.local to point at a local or staging backend.
  // Default hits production — avoid bust=1 in dev to prevent unnecessary upstream fetches.
  const apiTarget = env.VITE_API_TARGET || 'https://scoreboard-ivory-xi.vercel.app';
  return {
    plugins: [react()],
    build: { outDir: 'dist' },
    server: {
      proxy: { '/api': apiTarget },
    },
  };
});
