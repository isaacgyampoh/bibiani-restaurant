import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Only VITE_* variables reach the browser bundle: the public Supabase URL/anon key and the API URL.
// Server secrets (DATABASE_URL, SUPABASE_SECRET_KEY) are never VITE_-prefixed and cannot leak here.
export default defineConfig({
  plugins: [react()],
  // Builds for deployed environments pass a sealed directory holding only that environment's public values.
  envDir: process.env.VITE_ENV_DIR ?? '../..',
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: { sourcemap: true },
});
