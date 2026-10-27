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
  // The commit this build is from (Workers Builds sets it), answered by /api/health so a deploy can
  // tell when it is live (scripts/deploy.ts).
  define: { __BUILD_SHA__: JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA ?? 'dev') },
  plugins: [react(), tailwindcss(), cloudflare()],
  // Two pages: the public landing page at `/` and the app under /app.
  environments: {
    client: { build: { rollupOptions: { input: { landing: 'index.html', app: 'app/index.html' } } } },
    // The Worker minified: a smaller script parses faster when a new isolate starts.
    usageflare: { build: { minify: true } },
  },
});
