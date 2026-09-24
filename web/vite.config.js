import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development: npm run dev proxies the API to a running platform (BACKEND=http://host:7860)
const backend = process.env.BACKEND || 'http://localhost:7860';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': backend, '/files': backend } },
});
