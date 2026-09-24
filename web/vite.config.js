import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Для разработки: npm run dev проксирует API на работающую платформу (BACKEND=http://host:7860)
const backend = process.env.BACKEND || 'http://localhost:7860';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': backend, '/files': backend } },
});
