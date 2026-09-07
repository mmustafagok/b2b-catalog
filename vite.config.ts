import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'html-transform',
      transformIndexHtml(html) {
        const apiKey = process.env.VITE_SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY || '';
        return html.replace(/%VITE_SHOPIFY_API_KEY%/g, apiKey);
      },
    },
  ],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8080',
      '/c': 'http://localhost:8080',
      '/app': 'http://localhost:8080',
    },
  },
});
