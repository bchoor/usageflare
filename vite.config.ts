import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Two pages: the public landing page at `/` and the app under /app.
  environments: {
    client: { build: { rollupOptions: { input: { landing: 'index.html', app: 'app/index.html' } } } },
  },
});
