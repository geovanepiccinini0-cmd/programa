import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: { __FINANCE_PREVIEW__: JSON.stringify(process.env.CONTEXT === 'deploy-preview' || process.env.VITE_FINANCE_PREVIEW === 'true') },
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['terminal.local'],
  },
});
