// Run after the web production build and Vite preview. All API/media responses are isolated fixtures.
// UX_BENCH_BASE_URL=http://127.0.0.1:14173 node tests/benchmarks/catalog-ui.mjs
import { chromium } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { mkdir } from 'node:fs/promises';

const baseURL = process.env.UX_BENCH_BASE_URL ?? 'http://127.0.0.1:14173';
if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Use an isolated local preview.');
const output = process.env.UX_BENCH_OUTPUT ?? '/tmp/denicheur-catalog-audit';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const size of [100, 1000, 5000]) {
    for (const mode of ['table', 'cards']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const time = '2026-09-06T10:00:00.000Z';
      const records = Array.from({ length: size }, (_, index) => ({
        source: 'leboncoin', externalId: `bench-${index}`, id: `leboncoin:bench-${index}`,
        url: `https://www.leboncoin.fr/ad/ventes_immobilieres/bench-${index}`,
        title: `Synthetic property ${String(index).padStart(4, '0')}`, location: 'Quimper', propertyType: 'Maison',
        priceEuros: 150000 + index * 100, surfaceM2: 80 + index % 100,
        features: ['Jardin', 'Garage'], description: 'Synthetic property description. '.repeat(80),
        imageUrls: [1, 2, 3].map(image => `https://img.leboncoin.fr/benchmark-${index}-${image}.png`),
        status: 'detailed', scrapedAt: time, lastRunId: 'benchmark', firstSeenAt: time, lastSeenAt: time, updatedAt: time,
      }));
      const traffic = { listings: 0, metadata: 0, details: 0, images: 0, payloadBytes: 0 };
      await page.addInitScript(() => {
        localStorage.setItem('denicheur:locale', 'en');
        window.__catalogTasks = [];
        new PerformanceObserver(list => window.__catalogTasks.push(...list.getEntries().map(entry => entry.duration)))
          .observe({ type: 'longtask', buffered: true });
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        const json = value => {
          const body = JSON.stringify(value);
          traffic.payloadBytes += Buffer.byteLength(body);
          return route.fulfill({ contentType: 'application/json', body });
        };
        if (url.pathname === '/v1/health/details') return json({ status: 'ok', service: 'denicheur-api', database: { status: 'ok' }, media: { status: 'disabled', pending: 0, processing: 0, ready: 0, failed: 0 }, openAiConfigured: false });
        if (url.pathname === '/v1/listings/metadata') {
          traffic.metadata++;
          if (route.request().headers()['if-none-match']) return route.fulfill({ status: 304, headers: { etag: '"fixture-1"' } });
          const body = JSON.stringify({ revision: '1', total: size, sources: [{ source: 'leboncoin', count: size }] });
          traffic.payloadBytes += Buffer.byteLength(body);
          return route.fulfill({ contentType: 'application/json', body, headers: { etag: '"fixture-1"', 'access-control-expose-headers': 'ETag' } });
        }
        if (url.pathname === '/v1/listings') {
          traffic.listings++;
          const offset = Number(url.searchParams.get('cursor') ?? 0);
          const limit = Number(url.searchParams.get('limit') ?? 100);
          const sorted = url.searchParams.get('sort') === 'priceEuros' && url.searchParams.get('order') === 'desc' ? [...records].reverse() : records;
          return json({ items: sorted.slice(offset, offset + limit), total: size, nextCursor: offset + limit < size ? String(offset + limit) : null });
        }
        if (url.pathname.startsWith('/v1/listings/leboncoin/bench-')) {
          traffic.details++;
          const index = Number(url.pathname.split('bench-')[1]);
          return json({ ...records[index], runs: [], evaluations: [] });
        }
        if (url.hostname === 'img.leboncoin.fr') {
          traffic.images++;
          return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=', 'base64') });
        }
        if (url.pathname.startsWith('/v1/')) return route.abort();
        if (url.origin === new URL(baseURL).origin) return route.continue();
        return route.abort();
      });
      const selector = mode === 'table' ? 'tbody tr' : 'article:has(button[aria-label^="Show details for"])';
      const started = performance.now();
      await page.goto(`${baseURL}/?view=properties&pmode=${mode}`);
      await page.locator(selector).nth(49).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const initial = await page.evaluate(selector => ({
        rendered: document.querySelectorAll(selector).length,
        elements: document.querySelectorAll('*').length,
        longestTaskMs: Math.round(Math.max(0, ...window.__catalogTasks)),
        heapBytes: performance.memory?.usedJSHeapSize,
      }), selector);
      const initialTraffic = { ...traffic };
      const loadMs = Math.round(performance.now() - started);
      // Observe the real five-second refresh, including conditional headers.
      await page.waitForFunction(() => performance.now() > 5600);
      const refreshTraffic = Object.fromEntries(Object.keys(traffic).map(key => [key, traffic[key] - initialTraffic[key]]));
      const nextStarted = performance.now();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('51–100'));
      const nextMs = Math.round(performance.now() - nextStarted);
      if (size === 5000) await page.screenshot({ path: `${output}/${mode}-5000.png`, fullPage: false });
      console.log(JSON.stringify({ size, mode, loadMs, nextMs, ...initial, initialTraffic, refreshTraffic }));
      if (initial.rendered !== 50) throw new Error('The catalog DOM is no longer bounded.');
      if (initialTraffic.listings !== 1 || refreshTraffic.listings !== 0) throw new Error('Unchanged refresh traversed the rich catalog.');
      await context.close();
    }
  }
} finally { await browser.close(); }
