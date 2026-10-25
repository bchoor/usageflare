# usageflare brand assets (LOGO-A, Gauge)

Files: public/favicon.svg, public/favicon.ico (16/32/48), public/apple-touch-icon.png (180, full-bleed),
public/brand/usageflare-{mark,glyph,logo-light,logo-dark}.svg.

## Glyph (use inside the existing .brand-mark tile; inherits currentColor)
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M8.21 22.5A9 9 0 1 1 23.79 22.5" stroke="currentColor" stroke-opacity=".32" stroke-width="3" stroke-linecap="round"/><path d="M8.21 22.5A9 9 0 0 1 22.69 11.98" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M16 18L20.6 13.9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="16" cy="18" r="2.2" fill="currentColor"/></svg>
```

## favicon.svg / app mark
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>usageflare</title><rect width="32" height="32" rx="8" fill="#F38020"/><path d="M8.21 22.5A9 9 0 1 1 23.79 22.5" fill="none" stroke="#1A0F05" stroke-opacity=".32" stroke-width="3" stroke-linecap="round"/><path d="M8.21 22.5A9 9 0 0 1 22.69 11.98" fill="none" stroke="#1A0F05" stroke-width="3" stroke-linecap="round"/><path d="M16 18L20.6 13.9" stroke="#1A0F05" stroke-width="2.2" stroke-linecap="round"/><circle cx="16" cy="18" r="2.2" fill="#1A0F05"/></svg>
```

## index.html head
```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

Sidebar wordmark: "usage" in foreground + "flare" in --primary, Manrope 700 (already the app font).
