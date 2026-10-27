import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// This repo's own instance builds with USAGEFLARE_ENV=production (a Workers Builds variable), which
// selects `env.production` in wrangler.jsonc. A plain build uses the defaults anyone can deploy.
if (process.env.USAGEFLARE_ENV && !process.env.CLOUDFLARE_ENV) {
  process.env.CLOUDFLARE_ENV = process.env.USAGEFLARE_ENV;
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Two pages: the public landing page at `/` and the app under /app.
  environments: {
    client: { build: { rollupOptions: { input: { landing: 'index.html', app: 'app/index.html' } } } },
    // The Worker minified: a smaller script parses faster when a new isolate starts.
    usageflare: { build: { minify: true } },
  },
});
