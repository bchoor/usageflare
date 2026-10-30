/**
 * Interaction smoke: drives every page and Settings section the way a person would and reports what
 * breaks. Not a screenshot pass: it scrolls every scroll box (wheel on desktop, a finger swipe on a
 * phone), looks for content cut off with no way to reach it, opens and closes every drawer, menu and
 * picker, sorts, filters, pages, selects, hovers, and watches for console errors and failed calls.
 *
 *   bun e2e/smoke.ts                                   # local, `FIXTURES=1` dev server on :5173
 *   bun e2e/smoke.ts --base https://usageflare.icaruslab.dev   # live, read-only (tester token)
 *   bun e2e/smoke.ts --only limits --vp phone --theme dark      # narrow it down
 *
 * Live runs send the Access service token (`USAGEFLARE_ACCESS_CLIENT_ID` / `_SECRET`) to the app's
 * own host only and block every non-GET call, so nothing is written. Exits 1 on any finding; the
 * report lands in `e2e/out/` (`report.md`, `report.json`, and a screenshot per finding).
 * Run it before saying a UI change is done.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright';
import { PNG } from 'pngjs';

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = (arg('base', 'http://localhost:5173') as string).replace(/\/$/, '');
const LIVE = !/localhost|127\.0\.0\.1/.test(BASE);
const ONLY = arg('only');
const VPS = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;
type Vp = keyof typeof VPS;
const vpList = (arg('vp') ? [arg('vp')] : ['desktop', 'phone']) as Vp[];
const themes = (arg('theme') ? [arg('theme')] : ['light', 'dark']) as ('light' | 'dark')[];
const OUT = `${arg('out', new URL('./out', import.meta.url).pathname)}/`;
// Visual baselines: `--baseline <dir>` compares each page's screenshot with the one there (another
// build's run, e.g. main's); `--save <dir>` writes this run's for the next to compare with.
const BASELINE = arg('baseline');
const SAVE = arg('save');
// `--shots`: only the screenshots (a baseline run), no checks.
const SHOTS = process.argv.includes('--shots');
mkdirSync(OUT, { recursive: true });
if (SAVE) mkdirSync(SAVE, { recursive: true });

type Finding = { check: string; where: string; vp: Vp; theme: string; what: string; shot?: string };
const findings: Finding[] = [];
let shots = 0;

async function report(p: Page, f: Omit<Finding, 'shot'>) {
  const key = `${f.check}|${f.where}|${f.vp}|${f.what}`;
  if (findings.some((x) => `${x.check}|${x.where}|${x.vp}|${x.what}` === key)) return;
  const shot = `f${++shots}.png`;
  await p.screenshot({ path: OUT + shot }).catch(() => {});
  findings.push({ ...f, shot });
  console.log(`  ✗ [${f.check}] ${f.where} (${f.vp}/${f.theme}): ${f.what}`);
}

/** A short, stable name for an element: tag, slot, label or text. */
const DESCRIBE = `(el) => {
  const bits = [];
  for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
    const slot = e.getAttribute('data-slot');
    const label = e.getAttribute('aria-label') || e.getAttribute('title');
    const role = e.getAttribute('role');
    bits.unshift(e.tagName.toLowerCase() + (slot ? '[' + slot + ']' : '') + (role ? '[role=' + role + ']' : '') + (label ? '«' + label.slice(0, 30) + '»' : ''));
  }
  const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  return bits.join(' > ') + (text ? ' "' + text + '"' : '');
}`;

/**
 * Boxes inside `scope` that hide overflowing content with no way to reach it: overflow hidden or
 * clip, content taller than the box by more than a line, and no scrolling box inside to reach the rest.
 */
async function clipped(p: Page, scope: string) {
  return p.evaluate(
    ({ scope, describe }) => {
      const d = new Function(`return ${describe}`)();
      const out: string[] = [];
      for (const root of document.querySelectorAll(scope)) {
        for (const el of [root, ...root.querySelectorAll('*')] as HTMLElement[]) {
          const cs = getComputedStyle(el);
          if (!/hidden|clip/.test(cs.overflowY)) continue;
          if (el.clientHeight < 48 || el.scrollHeight <= el.clientHeight + 24) continue;
          if (el.closest('.sr-only,[aria-hidden=true],[data-allow-clip]')) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          // Something inside scrolls and holds the overflow: fine.
          const scroller = [...el.querySelectorAll('*')].some((c) => {
            const o = getComputedStyle(c).overflowY;
            return (
              /auto|scroll/.test(o) && (c as HTMLElement).scrollHeight > (c as HTMLElement).clientHeight + 8
            );
          });
          if (scroller) continue;
          // A collapsing panel mid-animation, or a line clamp, is meant to hide.
          if (cs.webkitLineClamp !== 'none' || el.getAnimations().length) continue;
          out.push(`${d(el)} shows ${el.clientHeight}px of ${el.scrollHeight}px, the rest is cut off`);
        }
      }
      return out;
    },
    { scope, describe: DESCRIBE },
  );
}

/** Every visible scroll box in `scope`, with a point inside it that a pointer actually lands on. */
async function scrollers(p: Page, scope: string) {
  return p.evaluate(
    ({ scope, describe }) => {
      const d = new Function(`return ${describe}`)();
      const out: { id: string; name: string; x: number; y: number }[] = [];
      // Ids from an earlier pass would name two boxes at once.
      for (const e of document.querySelectorAll('[data-smoke-scroll]'))
        e.removeAttribute('data-smoke-scroll');
      let n = 0;
      for (const root of document.querySelectorAll(scope)) {
        for (const el of [root, ...root.querySelectorAll('*')] as HTMLElement[]) {
          const cs = getComputedStyle(el);
          if (!/auto|scroll/.test(cs.overflowY)) continue;
          if (el.scrollHeight <= el.clientHeight + 8 || el.clientHeight < 40) continue;
          const r = el.getBoundingClientRect();
          const top = Math.max(r.top, 0);
          const bottom = Math.min(r.bottom, innerHeight);
          const left = Math.max(r.left, 0);
          const right = Math.min(r.right, innerWidth);
          if (bottom - top < 20 || right - left < 20) continue;
          let hit: { x: number; y: number } | null = null;
          for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85])
            for (const fx of [0.5, 0.25, 0.75]) {
              const x = left + (right - left) * fx;
              const y = top + (bottom - top) * fy;
              const at = document.elementFromPoint(x, y);
              if (!hit && at && el.contains(at)) hit = { x, y };
            }
          if (!hit) continue;
          const id = `s${n++}`;
          el.setAttribute('data-smoke-scroll', id);
          out.push({ id, name: d(el), ...hit });
        }
      }
      return out;
    },
    { scope, describe: DESCRIBE },
  );
}

/** Scroll each box the way a person does; report the ones that don't move. */
async function checkScroll(p: Page, ctx: Ctx, scope: string, where: string) {
  for (const s of await scrollers(p, scope)) {
    const sel = `[data-smoke-scroll="${s.id}"]`;
    const before = await p.$eval(sel, (e) => e.scrollTop).catch(() => null);
    if (before === null) continue;
    if (ctx.vp === 'phone') {
      // A finger swipe up (touch events, so touch-action and scroll locks apply as on a phone).
      const cdp = await p.context().newCDPSession(p);
      const dy = Math.min(200, Math.round(s.y - 10));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: s.x, y: s.y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: s.x, y: s.y - (dy * i) / 10 }],
        });
        await p.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await p.mouse.move(s.x, s.y);
      await p.mouse.wheel(0, 250);
    }
    await p.waitForTimeout(350);
    const after = await p.$eval(sel, (e) => e.scrollTop).catch(() => null);
    if (after !== null && after <= before && before === 0)
      await report(p, {
        check: 'scroll',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: `${s.name} won't scroll`,
      });
    await p
      .$eval(sel, (e) => {
        e.scrollTop = 0;
      })
      .catch(() => {});
  }
}

async function checkClip(p: Page, ctx: Ctx, scope: string, where: string) {
  for (const what of await clipped(p, scope))
    await report(p, { check: 'clipped', where, vp: ctx.vp, theme: ctx.theme, what });
}

/** No sideways page scroll, and short values (numbers, times, badges) stay on one line. */
async function checkLayout(p: Page, ctx: Ctx, where: string) {
  const issues = await p.evaluate((describe) => {
    const d = new Function(`return ${describe}`)();
    const out: string[] = [];
    const se = document.scrollingElement as HTMLElement;
    if (se.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${se.scrollWidth}px wide)`);
    // Table rows are one line at every width, a phone's card rows included: the row's text and
    // icons, banded by height, must sit in one band. A second band is a wrap.
    let wrapped = 0;
    for (const el of document.querySelectorAll<HTMLElement>('tbody tr')) {
      const r = el.getBoundingClientRect();
      if (!r.height || r.bottom < 0 || r.top > innerHeight || el.closest('[aria-hidden=true]')) continue;
      const boxes: DOMRect[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim() || !n.parentElement?.getClientRects().length) continue;
        if (n.parentElement.closest('.sr-only')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const b of range.getClientRects()) if (b.width > 1 && b.height > 4) boxes.push(b);
      }
      for (const g of el.querySelectorAll('svg, img, [role=progressbar], [role=checkbox]')) {
        const b = g.getBoundingClientRect();
        if (b.width > 1 && b.height > 4) boxes.push(b);
      }
      boxes.sort((a, b) => a.top - b.top);
      let bands = 0;
      let bottom = -Infinity;
      for (const b of boxes) {
        if (b.top >= bottom - 2) bands++;
        bottom = Math.max(bottom, b.bottom);
      }
      if (bands > 1 && wrapped++ < 3)
        out.push(`row wraps onto ${bands} lines (${Math.round(r.height)}px): ${d(el).slice(0, 140)}`);
    }
    // Text lines a short value's own text takes: more than one is a wrap.
    for (const el of document.querySelectorAll<HTMLElement>('.num, time, kbd, [data-slot=badge]')) {
      if (!el.getBoundingClientRect().width) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      // Line boxes: rects whose tops sit more than half a line apart (a raised unit is the same line).
      const lh = parseFloat(getComputedStyle(el).fontSize) * 0.6;
      const tops: number[] = [];
      for (const r of [...range.getClientRects()].filter((r) => r.width > 1).sort((a, b) => a.top - b.top))
        if (!tops.length || r.top - tops[tops.length - 1] > lh) tops.push(r.top);
      if (tops.length > 1) out.push(`${d(el)} wraps onto ${tops.length} lines`);
    }
    return out.slice(0, 12);
  }, DESCRIBE);
  for (const what of issues) await report(p, { check: 'layout', where, vp: ctx.vp, theme: ctx.theme, what });
}

/** An open popup: in the viewport, has a way out (× / Cancel / Esc), and its title clears the ×. */
async function checkPopup(
  p: Page,
  ctx: Ctx,
  where: string,
  sel = '[role=dialog]:visible, [role=menu]:visible, [role=listbox]:visible',
) {
  const pop = p.locator(sel).last();
  if (!(await pop.count())) return false;
  const box = await pop.boundingBox();
  const vp = VPS[ctx.vp];
  if (
    box &&
    (box.x < -1 || box.y < -1 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1)
  )
    await report(p, {
      check: 'popup',
      where,
      vp: ctx.vp,
      theme: ctx.theme,
      what: `popup runs off screen (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)})`,
    });
  const role = await pop.getAttribute('role');
  const slot = await pop.getAttribute('data-slot');
  // One Esc closes this popup and only this one.
  const before = await p.locator(sel).count();
  if (role === 'dialog') {
    const id = await pop.evaluate((e) => {
      e.setAttribute('data-smoke-pop', '1');
      return 1;
    });
    if (id) {
      await checkClip(p, ctx, '[data-smoke-pop]', where);
      await checkScroll(p, ctx, '[data-smoke-pop]', where);
      await checkInvariants(p, ctx, where, '[data-smoke-pop]');
    }
    // A popover anchored to its trigger closes on a tap outside; sheets and dialogs need their ×.
    if (ctx.vp === 'phone' && slot !== 'popover-content') {
      const close = pop.getByRole('button', { name: /close|cancel|done/i });
      if (!(await close.count()))
        await report(p, {
          check: 'popup',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'dialog has no close × or Cancel on a phone',
        });
      else {
        const overlap = await p.evaluate(() => {
          const dlg = document.querySelector('[data-smoke-pop]');
          const x = [...(dlg?.querySelectorAll('button') ?? [])].find((b) =>
            /close/i.test(b.getAttribute('aria-label') || b.textContent || ''),
          );
          const t = dlg?.querySelector('h2,[data-slot$=title]');
          if (!x || !t) return false;
          const a = x.getBoundingClientRect();
          const r = t.getBoundingClientRect();
          return r.width > 0 && a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top;
        });
        if (overlap)
          await report(p, {
            check: 'popup',
            where,
            vp: ctx.vp,
            theme: ctx.theme,
            what: 'dialog title runs under its ×',
          });
      }
    }
    await p.evaluate(() => document.querySelector('[data-smoke-pop]')?.removeAttribute('data-smoke-pop'));
  }
  await p.keyboard.press('Escape');
  // A popup's exit animation can outlast a short wait on a busy page: give it up to 1.5s.
  let after = before;
  for (let t = 0; t < 5 && after >= before; t++) {
    await p.waitForTimeout(300);
    after = await p.locator(sel).count();
  }
  if (after >= before && role) {
    await report(p, {
      check: 'popup',
      where,
      vp: ctx.vp,
      theme: ctx.theme,
      what: `${slot ?? role} doesn't close on Esc`,
    });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  }
  return true;
}

type Ctx = { vp: Vp; theme: 'light' | 'dark'; errors: string[] };

/** Loaded: the page's first table rows or cards are in, and nothing is still loading. */
async function settle(p: Page) {
  await p.waitForLoadState('load').catch(() => {});
  await p
    .locator('main tbody tr, main [data-slot=tile], [role=dialog]')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  await p
    .waitForFunction(() => !document.querySelector('main [data-slot=skeleton]'), null, { timeout: 5000 })
    .catch(() => {});
  await p.waitForTimeout(300);
}

async function flushErrors(p: Page, ctx: Ctx, where: string) {
  for (const e of ctx.errors.splice(0))
    await report(p, { check: 'error', where, vp: ctx.vp, theme: ctx.theme, what: e });
}

const visible = async (l: Locator) =>
  (await l.count()) > 0 &&
  (await l
    .first()
    .isVisible()
    .catch(() => false));

/** Drive the controls of one page: tabs, pace, sort, filter, group, menus, collapse, paging, select, drawers, hovers. */
async function exercise(p: Page, ctx: Ctx, url: string, where: string) {
  const main = p.locator('main');
  const fresh = async () => {
    await p.goto(BASE + url);
    await settle(p);
  };

  // Tabs and segmented pickers.
  for (const role of ['tab', 'radio'] as const) {
    const n = Math.min(await main.getByRole(role).count(), 8);
    for (let i = 0; i < n; i++) {
      const t = main.getByRole(role).nth(i);
      if (await t.isVisible().catch(() => false)) await t.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(150);
    }
    if (n) await flushErrors(p, ctx, `${where} ${role}s`);
  }
  await fresh();

  // Sort: every header button, twice; the row order must change for at least one of them.
  const heads = main.locator('thead th button');
  const hn = Math.min(await heads.count(), 12);
  let sorted = hn === 0;
  const firstRow = () =>
    main
      .locator('tbody tr:not([data-rollup])')
      .first()
      .innerText()
      .catch(() => '');
  // The order of every row, roll-ups included: a table that is all groups (Limits by tag)
  // still shows a sort as its groups and sub-groups trade places.
  const order = () =>
    main
      .locator('tbody tr')
      .allInnerTexts()
      .then((t) => t.slice(0, 40).join('\n'))
      .catch(() => '');
  const row0 = await order();
  for (let i = 0; i < hn; i++) {
    const h = heads.nth(i);
    if (!(await h.isVisible().catch(() => false))) continue;
    await h.click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(150);
    if ((await order()) !== row0) sorted = true;
    await h.click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(150);
  }
  // A phone's cards hide the headers: the Sort by picker and its direction stand in.
  const cardSort = main.locator('[data-slot=card-sort]').first();
  if (!sorted && (await visible(cardSort))) {
    const picker = cardSort
      .getByRole('button', { name: 'Sort by' })
      .or(cardSort.getByRole('combobox', { name: 'Sort by' }))
      .first();
    for (let k = 1; k <= 3 && !sorted; k++) {
      await picker.click();
      await p.waitForTimeout(300);
      await p
        .getByRole('option')
        .nth(k)
        .click({ timeout: 3000 })
        .catch(() => {});
      await p.waitForTimeout(250);
      if ((await order()) !== row0) sorted = true;
      const dir = cardSort.getByRole('button', { name: /high to low|low to high/i });
      if (!sorted && (await visible(dir))) {
        await dir.click();
        await p.waitForTimeout(250);
        if ((await order()) !== row0) sorted = true;
      }
    }
  }
  if (!sorted && (await main.locator('tbody tr').count()) > 2)
    await report(p, {
      check: 'sort',
      where,
      vp: ctx.vp,
      theme: ctx.theme,
      what: 'no sort (header or phone Sort by) changes the row order',
    });
  await flushErrors(p, ctx, `${where} sort`);
  await fresh();

  // Filter: type, a token or fewer rows, clear.
  const filter = main.getByRole('combobox', { name: /^Filter/ }).first();
  if (await visible(filter)) {
    const rows = await main.locator('tbody tr').count();
    await filter.click();
    await p.waitForTimeout(200);
    await checkPopup(p, ctx, `${where} filter suggestions`, '[role=listbox]:visible, [role=dialog]:visible');
    await filter.click().catch(() => {});
    await filter.fill('zzzz-no-match').catch(() => {});
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    const after = await main.locator('tbody tr').count();
    const empty = await main.getByText(/no (rows|match|results)|nothing/i).count();
    if (after >= rows && rows > 1 && !empty)
      await report(p, {
        check: 'filter',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: `filtering by text that matches nothing still shows ${after} rows`,
      });
    await flushErrors(p, ctx, `${where} filter`);
    await fresh();
  }

  // Menus and pickers: every "… menu", Group, Columns, Rows per page, Edit layout, link colour.
  const menuNames = [/menu$/, /^Group$/, /^Columns$/, /^Rows per page$/, /link colour/];
  for (const name of menuNames) {
    const b = main.getByRole('button', { name }).or(main.getByRole('combobox', { name }));
    const n = Math.min(await b.count(), 4);
    for (let i = 0; i < n; i++) {
      const el = b.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      // An invisible anchor another control opens (Columns under Add column) isn't clicked directly.
      if (await el.evaluate((e) => getComputedStyle(e).opacity === '0')) continue;
      const label = (await el.getAttribute('aria-label')) ?? (await el.innerText());
      await el.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(300);
      const opened = await checkPopup(
        p,
        ctx,
        `${where} ${label}`,
        '[role=menu]:visible, [role=listbox]:visible, [role=dialog]:visible',
      );
      if (!opened)
        await report(p, {
          check: 'click',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: `${label} opens nothing`,
        });
    }
  }
  await flushErrors(p, ctx, `${where} menus`);

  // Every group and fold open: their rows must hold to one line too.
  const all = main.getByRole('button', { name: /^(Expand or collapse rows|Expand all groups)$/ }).first();
  if (await visible(all)) {
    await all.click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(400);
    await checkLayout(p, ctx, `${where} (groups open)`);
    await fresh();
  }

  // Collapse and expand every card.
  const col = main.getByRole('button', { name: /^Collapse (?!all)/ });
  const cn = Math.min(await col.count(), 6);
  for (let i = 0; i < cn; i++) {
    const c = col.first();
    if (!(await c.isVisible().catch(() => false))) break;
    const label = (await c.getAttribute('aria-label')) ?? '';
    await c.click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(250);
    const back = main.getByRole('button', { name: label.replace(/^Collapse/, 'Expand') }).first();
    if (await visible(back)) {
      await back.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(250);
    } else
      await report(p, {
        check: 'collapse',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: `${label} has no way to open again`,
      });
  }
  await fresh();

  // Paging holds its page when a row is selected.
  const next = main.getByRole('button', { name: 'Next page' }).first();
  if ((await visible(next)) && (await next.isEnabled())) {
    const first = await firstRow();
    await next.click();
    await p.waitForTimeout(300);
    const second = await firstRow();
    if (second === first)
      await report(p, {
        check: 'paging',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: 'Next page shows the same rows',
      });
    const tick = main.locator('tbody [role=checkbox]').first();
    if (await visible(tick)) {
      await tick.click();
      await p.waitForTimeout(300);
      if ((await firstRow()) !== second)
        await report(p, {
          check: 'paging',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'selecting a row jumps back to page 1',
        });
    }
    await fresh();
  }

  // Select a row: the bulk bar shows, Esc or Clear takes it away.
  const tick = main.locator('tbody [role=checkbox]').first();
  if (await visible(tick)) {
    await tick.click();
    await p.waitForTimeout(300);
    const bar = p.locator('[data-slot=bulk-bar], [role=toolbar]').filter({ hasText: /selected/i });
    if (!(await visible(bar)))
      await report(p, {
        check: 'bulk',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: 'selecting a row shows no bulk bar',
      });
    else {
      const box = await bar.first().boundingBox();
      const vp = VPS[ctx.vp];
      if (box && (box.x < 0 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1))
        await report(p, {
          check: 'bulk',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'bulk bar runs off screen',
        });
      const clear = bar.getByRole('button', { name: /clear|cancel|close|deselect/i }).first();
      if (await visible(clear)) await clear.click();
      else
        await report(p, {
          check: 'bulk',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'bulk bar has no Clear',
        });
    }
    await flushErrors(p, ctx, `${where} select`);
    await fresh();
  }

  // Open the first few row drawers; each must scroll, show all of itself, and close.
  const opens = main
    .locator('tbody tr')
    .getByRole('button', { name: /^Show / })
    .or(main.locator('tbody tr td:first-child a'));
  const on = Math.min(await opens.count(), 2);
  for (let i = 0; i < on; i++) {
    const o = opens.nth(i);
    if (!(await o.isVisible().catch(() => false))) continue;
    const label = ((await o.getAttribute('aria-label')) ?? (await o.innerText())).slice(0, 40);
    await o.click({ timeout: 3000 }).catch(() => {});
    await settle(p);
    if (await p.locator('[role=dialog]:visible').count())
      await checkPopup(p, ctx, `${where} drawer ${label}`, '[role=dialog]:visible');
    else if (!p.url().includes(url)) {
      // A link to another page: check it landed, then come back.
      await checkClip(p, ctx, 'main', `${where} → ${label}`);
    }
    await flushErrors(p, ctx, `${where} drawer`);
    await fresh();
  }

  // Hover help and truncated values: a tooltip or title must exist.
  // A few of each: the header's tooltips and the rows' hover cards.
  const tips: Locator[] = [];
  for (const slot of ['tooltip-trigger', 'hover-card-trigger']) {
    const l = main.locator(`[data-slot=${slot}]`);
    for (let i = 0; i < Math.min(await l.count(), 3); i++) tips.push(l.nth(i));
  }
  for (const t of tips) {
    if (!(await t.isVisible().catch(() => false))) continue;
    const tip = p.locator('[role=tooltip], [data-slot=tooltip-content], [data-slot=hover-card-content]');
    let shown = 0;
    for (let k = 0; k < 2 && !shown; k++) {
      await p.mouse.move(VPS[ctx.vp].width / 2, VPS[ctx.vp].height / 2);
      await p.waitForTimeout(300);
      await t.hover({ timeout: 2000 }).catch(() => {});
      await p.waitForTimeout(1000);
      shown = await tip.count();
    }
    // What the hover shows fits the screen and reads like the rest.
    if (shown)
      await checkInvariants(
        p,
        ctx,
        `${where} hover`,
        '[data-slot=hover-card-content], [data-slot=tooltip-content]',
      );
    if (!shown)
      await report(p, {
        check: 'hover',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: `hover on ${await t.evaluate(new Function(`return ${DESCRIBE}`)() as (e: Element) => string)} shows nothing`,
      });
    await p.mouse.move(1, 1);
  }
  await flushErrors(p, ctx, `${where} hover`);
}

/** This page's screenshot against the baseline: more than 0.5% of pixels changed is a visual finding. */
async function visual(p: Page, ctx: Ctx, where: string) {
  if (!BASELINE && !SAVE) return;
  const name = `${where.replace(/[^\w]+/g, '-')}-${ctx.vp}-${ctx.theme}.png`;
  // Times and the status bar change from run to run; they're masked out.
  const png = await p.screenshot({
    mask: [p.locator('time, [data-slot=shell-status]')],
    animations: 'disabled',
  });
  if (SAVE) writeFileSync(`${SAVE}/${name}`, png);
  if (!BASELINE || !existsSync(`${BASELINE}/${name}`)) return;
  const a = PNG.sync.read(readFileSync(`${BASELINE}/${name}`));
  const b = PNG.sync.read(png);
  if (a.width !== b.width || a.height !== b.height) {
    await report(p, {
      check: 'visual',
      where,
      vp: ctx.vp,
      theme: ctx.theme,
      what: `page size changed ${a.width}×${a.height} → ${b.width}×${b.height}`,
    });
    return;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
  const share = n / (a.width * a.height);
  if (share > 0.005) {
    writeFileSync(`${OUT}diff-${name}`, PNG.sync.write(diff));
    await report(p, {
      check: 'visual',
      where,
      vp: ctx.vp,
      theme: ctx.theme,
      what: `${(share * 100).toFixed(1)}% of the page changed (diff-${name})`,
    });
  }
}

/**
 * Checks that hold on every screen whatever is on it: text never overlaps other text, text reads
 * (contrast), a phone's tap targets are big enough, and every control Tab reaches is on screen.
 */
async function checkInvariants(p: Page, ctx: Ctx, where: string, scope = 'body') {
  const issues = await p.evaluate(
    ({ scope, describe, phone }) => {
      const d = new Function(`return ${describe}`)();
      const out: string[] = [];
      const root = document.querySelector(scope);
      if (!root) return out;
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (
          r.width < 1 ||
          r.height < 1 ||
          r.bottom < 0 ||
          r.top > innerHeight ||
          r.right < 0 ||
          r.left > innerWidth
        )
          return null;
        if (el.closest('.sr-only,[aria-hidden=true],[inert]')) return null;
        for (let e: Element | null = el; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.opacity === '0') return null;
        }
        return r;
      };
      // Text boxes: each run of a leaf's own text, so a padded box never counts as overlap.
      const texts: { el: Element; r: DOMRect }[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && texts.length < 1500; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const el = n.parentElement;
        if (!el || !shown(el)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 2 && r.height > 4) texts.push({ el, r });
      }
      // Two texts drawn on top of each other, neither one clipped away by its box.
      const visibleRect = (el: Element, r: DOMRect) => {
        let { left, right, top, bottom } = r;
        for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
            const b = e.getBoundingClientRect();
            left = Math.max(left, b.left);
            right = Math.min(right, b.right);
            top = Math.max(top, b.top);
            bottom = Math.min(bottom, b.bottom);
          }
        }
        return { left, right, top, bottom };
      };
      const seen = new Set<string>();
      for (let i = 0; i < texts.length; i++) {
        const a = visibleRect(texts[i].el, texts[i].r);
        if (a.right - a.left < 2 || a.bottom - a.top < 4) continue;
        for (let j = i + 1; j < texts.length; j++) {
          if (
            texts[i].el === texts[j].el ||
            texts[i].el.contains(texts[j].el) ||
            texts[j].el.contains(texts[i].el)
          )
            continue;
          const b = visibleRect(texts[j].el, texts[j].r);
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 3 && h > 4) {
            // Only when the top one is see-through: a popup or sticky header covering text is fine.
            const x = Math.max(a.left, b.left) + w / 2;
            const y = Math.max(a.top, b.top) + h / 2;
            const top = document.elementsFromPoint(x, y);
            const ia = top.findIndex((e) => e === texts[i].el || texts[i].el.contains(e));
            const ib = top.findIndex((e) => e === texts[j].el || texts[j].el.contains(e));
            if (ia < 0 || ib < 0) continue;
            const key = `${d(texts[i].el)}|${d(texts[j].el)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(`text overlaps: ${d(texts[i].el).slice(-70)} ⟷ ${d(texts[j].el).slice(-70)}`);
          }
        }
      }
      // Contrast: WCAG AA, 4.5:1 (3:1 for large text), against the first opaque background behind.
      // Any CSS colour (oklab, color-mix) to sRGB 0-255 plus alpha 0-1, through a canvas.
      const cv = document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const rgb = (c: string) => {
        cv.clearRect(0, 0, 1, 1);
        cv.fillStyle = '#000';
        cv.fillStyle = c;
        cv.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // The background behind `el`: its see-through tints laid over the first opaque one.
      const bgOf = (el: Element) => {
        const tints: number[][] = [];
        let base = [255, 255, 255, 1];
        for (let e: Element | null = el; e; e = e.parentElement) {
          if (getComputedStyle(e).backgroundImage !== 'none') return null;
          const c = rgb(getComputedStyle(e).backgroundColor);
          if (c[3] > 0.9) {
            base = c;
            break;
          }
          if (c[3] > 0) tints.push(c);
        }
        for (const t of tints.reverse())
          base = [0, 1, 2].map((k) => t[k] * t[3] + base[k] * (1 - t[3])).concat(1);
        return base;
      };
      const lows = new Set<Element>();
      for (const { el } of texts) {
        // Disabled controls and the logo are exempt (WCAG 1.4.3).
        if (
          lows.has(el) ||
          el.closest('[disabled],[aria-disabled=true],[data-disabled],[data-slot=sidebar-header]')
        )
          continue;
        const cs = getComputedStyle(el);
        const fg = rgb(cs.color);
        const bg = bgOf(el);
        if (!bg || fg[3] < 0.5) continue;
        // A see-through text colour reads as its blend with the background.
        const a = fg[3];
        const mixed = [0, 1, 2].map((k) => fg[k] * a + bg[k] * (1 - a));
        const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.6 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) {
          lows.add(el);
          out.push(`low contrast ${ratio.toFixed(2)}:1 ${d(el).slice(-90)}`);
        }
      }
      // Nothing runs off the screen's sides unless a box that scrolls sideways (or clips) holds it.
      const off = new Set<Element>();
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || (r.right <= innerWidth + 1 && r.left >= -1)) continue;
        if (el.closest('.sr-only,[aria-hidden=true]') || [...off].some((o) => o.contains(el))) continue;
        // Held: a box on screen around it scrolls sideways (the rest is a swipe away) or clips it.
        let held = false;
        for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
          if (getComputedStyle(e).overflowX === 'visible') continue;
          const b = e.getBoundingClientRect();
          if (b.right <= innerWidth + 1 && b.left >= -1) {
            held = true;
            break;
          }
        }
        if (held || !shown(el)) continue;
        off.add(el);
        out.push(
          `runs off screen (${Math.round(r.left)}–${Math.round(r.right)}px of ${innerWidth}): ${d(el).slice(-90)}`,
        );
        if (off.size > 4) break;
      }
      // A phone's tap targets: 24px at least (WCAG 2.2), unless inline in a line of text.
      if (phone)
        for (const el of root.querySelectorAll(
          'button, a[href], [role=button], [role=checkbox], [role=tab], [role=radio], [role=combobox], input, select',
        )) {
          const r = shown(el);
          if (!r || getComputedStyle(el).display === 'inline') continue;
          // WCAG's spacing exception: a small target alone in a roomy table row is fine.
          const row = el.closest('tr');
          if (row && row.getBoundingClientRect().height >= 24 && row.querySelectorAll('a,button').length <= 3)
            continue;
          // A ::after that widens the hit area (the kit's Switch) counts toward the target.
          const after = getComputedStyle(el, '::after');
          const grow = (side: string) =>
            after.position === 'absolute' ? Math.max(0, -parseFloat(after.getPropertyValue(side)) || 0) : 0;
          const w = r.width + grow('left') + grow('right');
          const h = r.height + grow('top') + grow('bottom');
          if (w < 24 || h < 24)
            out.push(`tap target ${Math.round(r.width)}×${Math.round(r.height)}px ${d(el).slice(-90)}`);
        }
      return out;
    },
    { scope, describe: DESCRIBE, phone: ctx.vp === 'phone' },
  );
  for (const what of issues.slice(0, 25)) {
    const check = what.startsWith('text overlaps')
      ? 'overlap'
      : what.startsWith('low contrast')
        ? 'contrast'
        : what.startsWith('runs off')
          ? 'offscreen'
          : 'tap';
    await report(p, { check, where, vp: ctx.vp, theme: ctx.theme, what });
  }
  // Keyboard: Tab through the page; every stop must be on screen, uncovered and visibly focused.
  if (scope !== 'body') return;
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await p.keyboard.press('Tab');
    const stop = await p
      .evaluate((describe) => {
        const d = new Function(`return ${describe}`)();
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const name = d(el);
        if (r.width < 2 || r.height < 2) return { name, bad: 'focus lands on something invisible' };
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
          return { name, bad: 'focus lands off screen' };
        for (let e: Element | null = el; e; e = e.parentElement)
          if (getComputedStyle(e).opacity === '0') return { name, bad: 'focus lands on something invisible' };
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        // Its own hover card or tooltip may sit over it; anything else covering it hides the focus.
        if (at && !el.contains(at) && !at.contains(el) && !at.closest('[data-slot$=-content],[role=tooltip]'))
          return { name, bad: `focused control is covered by ${d(at).slice(-60)}` };
        const cs = getComputedStyle(el);
        const ring =
          (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
        if (!ring) return { name, bad: 'no visible focus ring' };
        return { name, bad: null };
      }, DESCRIBE)
      .catch(() => null);
    if (!stop) continue;
    if (seen.has(stop.name)) break;
    seen.add(stop.name);
    if (stop.bad)
      await report(p, {
        check: 'keyboard',
        where,
        vp: ctx.vp,
        theme: ctx.theme,
        what: `${stop.bad}: ${stop.name.slice(-90)}`,
      });
  }
}

/**
 * Every column of a desktop table shows, at the widths people use, with the sidebar open and
 * closed: no column hidden to make the table fit, and a table too wide for its room scrolls
 * sideways with its name column at its cap (`--lead-col-max`), never taking the room from the rest.
 */
async function checkColumns(p: Page, ctx: Ctx, where: string) {
  if (ctx.vp !== 'desktop' || !(await p.locator('table thead th').count())) return;
  const size = p.viewportSize() ?? VPS.desktop;
  const toggle = p.getByRole('button', { name: 'Toggle Sidebar' }).first();
  for (let pass = 0; pass < 2; pass++) {
    const side = await p
      .locator('[data-slot=sidebar][data-state]')
      .first()
      .getAttribute('data-state')
      .catch(() => null);
    for (const width of [1024, 1280, 1440]) {
      await p.setViewportSize({ width, height: size.height });
      await p.waitForTimeout(500);
      const issues = await p.evaluate(() => {
        const out: string[] = [];
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--lead-col-max)';
        document.body.append(probe);
        const cap = probe.getBoundingClientRect().width || 288;
        probe.remove();
        for (const t of document.querySelectorAll<HTMLTableElement>('table')) {
          const head = t.tHead?.rows[0];
          if (!head?.getClientRects().length || t.closest('[aria-hidden=true],[role=dialog]')) continue;
          const name = (c: Element) => c.textContent?.trim().slice(0, 40) ?? '';
          for (const th of head.cells)
            if (name(th) && th.getBoundingClientRect().width < 1)
              out.push(
                `column "${name(th)}" is hidden to fit (${name(head.cells[1] ?? head.cells[0])} table)`,
              );
          const view = t.closest<HTMLElement>('[data-slot=view-scroll]') ?? t.parentElement;
          if (!view) continue;
          const cs = getComputedStyle(view);
          const right = view.getBoundingClientRect().right - parseFloat(cs.paddingRight);
          // A data row's name cell: a group or Total row's label spans several columns by design.
          const lead = t.tBodies[0]?.querySelector<HTMLElement>(
            'tr:not([data-rollup]) > td[data-card=lead]:not([colspan]), tr:not([data-rollup]) > td[data-card=lead][colspan="1"]',
          );
          if (!lead || t.getBoundingClientRect().right <= right + 1) continue;
          const lcs = getComputedStyle(lead);
          const inner =
            lead.getBoundingClientRect().width - parseFloat(lcs.paddingLeft) - parseFloat(lcs.paddingRight);
          if (inner > cap + 48)
            out.push(
              `name column ${Math.round(inner)}px (cap ${Math.round(cap)}px) while columns run off screen (${name(head.cells[1] ?? head.cells[0])} table)`,
            );
        }
        return out.slice(0, 8);
      });
      for (const what of issues)
        await report(p, {
          check: 'columns',
          where: `${where} @${width}px, sidebar ${side ?? 'n/a'}`,
          vp: ctx.vp,
          theme: ctx.theme,
          what,
        });
    }
    if (!(await toggle.count())) break;
    await toggle.click().catch(() => {});
    await p.waitForTimeout(500);
  }
  await p.setViewportSize(size);
  await p.waitForTimeout(300);
}

async function sweepPage(p: Page, ctx: Ctx, url: string, where: string, full: boolean) {
  console.log(`· ${where} ${ctx.vp}/${ctx.theme}`);
  await p.goto(BASE + url);
  await settle(p);
  if (SHOTS) return visual(p, ctx, where);
  await flushErrors(p, ctx, where);
  await checkLayout(p, ctx, where);
  await checkClip(p, ctx, 'body', where);
  await checkScroll(p, ctx, 'body', where);
  // The scroll test leaves the pointer over the table, where a row's hover card opens on its
  // own: park it in a corner so the page is checked as it stands.
  await p.mouse.move(0, 0);
  await p.waitForTimeout(500);
  await checkInvariants(p, ctx, where);
  await visual(p, ctx, where);
  if (ctx.theme === 'light') await checkColumns(p, ctx, where);
  if (full && ctx.theme === 'light') await exercise(p, ctx, url, where);
}

async function sweepShell(p: Page, ctx: Ctx) {
  await p.goto(`${BASE}/app/`);
  await settle(p);
  // Finder (Ctrl K) opens, finds, closes.
  await p.keyboard.press('Control+k');
  await p.waitForTimeout(400);
  if (!(await p.locator('[role=dialog]:visible').count()))
    await report(p, {
      check: 'keyboard',
      where: 'Finder',
      vp: ctx.vp,
      theme: ctx.theme,
      what: 'Ctrl K opens nothing',
    });
  else {
    await p.keyboard.type('a');
    await p.waitForTimeout(300);
    await checkPopup(p, ctx, 'Finder', '[role=dialog]:visible');
  }
  // Phone sidebar: opens as a sheet with a ×, a tap on a link closes it and navigates.
  if (ctx.vp === 'phone') {
    await p.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
    await p.waitForTimeout(400);
    const sheet = p.locator('[role=dialog]:visible');
    if (!(await sheet.count()))
      await report(p, {
        check: 'click',
        where: 'Sidebar',
        vp: ctx.vp,
        theme: ctx.theme,
        what: 'menu button opens no sidebar',
      });
    else {
      await checkClip(p, ctx, '[role=dialog]', 'Sidebar');
      await checkScroll(p, ctx, '[role=dialog]', 'Sidebar');
      await sheet
        .getByRole('link', { name: /All resources/ })
        .first()
        .click()
        .catch(() => {});
      await settle(p);
      if (await p.locator('[role=dialog]:visible').count())
        await report(p, {
          check: 'popup',
          where: 'Sidebar',
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'sidebar stays open after picking a page',
        });
      if (!p.url().includes('/resources'))
        await report(p, {
          check: 'click',
          where: 'Sidebar',
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'All resources link did not navigate',
        });
    }
  }
  // Refresh (skip cache) and What's new.
  await p.goto(`${BASE}/app/`);
  await settle(p);
  const refresh = p.getByRole('button', { name: /^Refresh \(skip cache\)/ }).first();
  if (await visible(refresh)) {
    await refresh.click();
    await settle(p);
  }
  const wn = p.getByRole('button', { name: "What's new" }).first();
  if (await visible(wn)) {
    await wn.click();
    await p.waitForTimeout(500);
    if (!(await checkPopup(p, ctx, "What's new", '[role=dialog]:visible')))
      await report(p, {
        check: 'click',
        where: "What's new",
        vp: ctx.vp,
        theme: ctx.theme,
        what: 'opens nothing',
      });
  }
  await flushErrors(p, ctx, 'Shell');
}

async function sweepSettings(p: Page, ctx: Ctx, sections: string[]) {
  for (const s of sections) {
    const where = `Settings › ${s}`;
    console.log(`· ${where} ${ctx.vp}/${ctx.theme}`);
    await p.goto(`${BASE}/app/?settings=${s}`);
    await settle(p);
    const dlg = p.locator('[role=dialog]:visible');
    if (!(await dlg.count())) {
      await report(p, { check: 'click', where, vp: ctx.vp, theme: ctx.theme, what: 'Settings did not open' });
      continue;
    }
    await flushErrors(p, ctx, where);
    await checkClip(p, ctx, '[role=dialog]', where);
    await checkScroll(p, ctx, '[role=dialog]', where);
    // Open every expandable row and picker in turn; what opens must be reachable and close again.
    const rows = dlg.locator('[aria-expanded=false]');
    const n = Math.min(await rows.count(), 8);
    for (let i = 0; i < n; i++) {
      const r = dlg.locator('[aria-expanded=false]').nth(i);
      if (!(await r.isVisible().catch(() => false))) continue;
      await r.scrollIntoViewIfNeeded().catch(() => {});
      await r.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(350);
      const inner = '[role=listbox]:visible, [role=menu]:visible, [data-slot=popover-content]:visible';
      if (await p.locator(inner).count()) await checkPopup(p, ctx, where, inner);
      if (!(await dlg.count())) {
        await report(p, {
          check: 'popup',
          where,
          vp: ctx.vp,
          theme: ctx.theme,
          what: 'closing a picker inside Settings closed Settings too',
        });
        await p.goto(`${BASE}/app/?settings=${s}`);
        await settle(p);
      }
    }
    await checkClip(p, ctx, '[role=dialog]', `${where} (rows open)`);
    await checkScroll(p, ctx, '[role=dialog]', `${where} (rows open)`);
    await flushErrors(p, ctx, where);
    await checkPopup(p, ctx, where, '[role=dialog]:visible');
  }
}

async function newCtx(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  vp: Vp,
  theme: string,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: VPS[vp],
    isMobile: vp === 'phone',
    hasTouch: vp === 'phone',
    colorScheme: theme as 'light' | 'dark',
  });
  const host = new URL(BASE).host;
  await ctx.addCookies([
    { name: 'usageflare_prefs', value: encodeURIComponent(JSON.stringify({ theme })), url: BASE },
  ]);
  if (LIVE) {
    const id = process.env.USAGEFLARE_ACCESS_CLIENT_ID;
    const secret = process.env.USAGEFLARE_ACCESS_CLIENT_SECRET;
    if (!id || !secret)
      throw new Error('Live runs need USAGEFLARE_ACCESS_CLIENT_ID and USAGEFLARE_ACCESS_CLIENT_SECRET');
    await ctx.route(`**://${host}/**`, (route) => {
      const r = route.request();
      // Read-only: a live sweep never writes.
      if (r.method() !== 'GET' && r.method() !== 'HEAD') return route.abort('blockedbyclient');
      return route.continue({
        headers: { ...r.headers(), 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
      });
    });
  }
  return ctx;
}

const browser = await chromium.launch();
const accounts: { id: string; name: string }[] = await (async () => {
  const ctx = await newCtx(browser, 'desktop', 'light');
  const p = await ctx.newPage();
  const r = await p.goto(`${BASE}/api/accounts`);
  const j = (await r?.json()) as { accounts: { id: string; name: string }[] };
  await ctx.close();
  return j.accounts;
})();
const pages: [string, string][] = [
  ['/app/', 'Overview'],
  ['/app/resources', 'All resources'],
  ['/app/tags', 'Tags'],
];
for (const a of accounts) {
  const n = a.name;
  pages.push(
    [`/app/a/${a.id}`, `${n}`],
    [`/app/a/${a.id}/resources`, `${n} › Resources`],
    [`/app/a/${a.id}/limits`, `${n} › Limits`],
    [`/app/a/${a.id}/tags`, `${n} › Tags`],
  );
}
const SECTIONS = ['tokens', 'accounts', 'limits', 'meter-icons', 'profile'];

for (const vp of vpList)
  for (const theme of themes) {
    const bctx = await newCtx(browser, vp, theme);
    const p = await bctx.newPage();
    const ctx: Ctx = { vp, theme, errors: [] };
    const host = new URL(BASE).host;
    p.on('pageerror', (e) => ctx.errors.push(`page error: ${e.message.slice(0, 160)}`));
    p.on('console', (m) => {
      // Live, the tester token opens this app only: another suite app's Access login (the app
      // switcher's hub) answers it with a CORS error a signed-in person never sees.
      if (
        m.type() === 'error' &&
        !/blockedbyclient|Failed to load resource/i.test(m.text()) &&
        !(LIVE && /cloudflareaccess\.com\/cdn-cgi\/access\/login/.test(m.text()))
      )
        ctx.errors.push(`console: ${m.text().slice(0, 160)}`);
    });
    p.on('response', (r) => {
      if (new URL(r.url()).host === host && r.status() >= 400)
        ctx.errors.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
    });
    p.on('requestfailed', (r) => {
      if (
        new URL(r.url()).host === host &&
        !r.failure()?.errorText.startsWith('net::ERR_BLOCKED_BY_CLIENT') &&
        !/ERR_ABORTED/.test(r.failure()?.errorText ?? '')
      )
        ctx.errors.push(`${r.method()} ${new URL(r.url()).pathname} failed: ${r.failure()?.errorText}`);
    });
    // Same pages on every account read the same, so only the first account is exercised in full.
    for (const [url, where] of pages) {
      if (ONLY && !where.toLowerCase().includes(ONLY.toLowerCase()) && !url.includes(ONLY)) continue;
      // Every account's pages share their code: the first account's are driven in full.
      const full = !accounts.slice(1).some((a) => url.includes(a.id));
      await sweepPage(p, ctx, url, where, full);
    }
    if (!SHOTS && (!ONLY || /settings/i.test(ONLY))) await sweepSettings(p, ctx, SECTIONS);
    if (!SHOTS && (!ONLY || /shell/i.test(ONLY))) await sweepShell(p, ctx);
    await bctx.close();
  }
await browser.close();

const md = [
  `# Interaction smoke: ${BASE}`,
  '',
  `${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
  '',
  ...findings.map((f) => `- **${f.check}** ${f.where} (${f.vp}/${f.theme}): ${f.what} ([shot](${f.shot}))`),
].join('\n');
writeFileSync(`${OUT}report.md`, md);
writeFileSync(`${OUT}report.json`, JSON.stringify(findings, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, { flag: 'a' });
console.log(`\n${findings.length} findings → ${OUT}report.md`);
// A visual change is often the point of a PR: it's listed for review, not a failure.
process.exit(findings.some((f) => f.check !== 'visual') ? 1 : 0);
