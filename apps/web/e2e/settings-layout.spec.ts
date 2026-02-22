import { test, expect } from '@playwright/test';

type RouteFulfill = Parameters<Parameters<typeof test>[0]>;

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function stubSettingsApi(page: import('@playwright/test').Page) {
  // Stub only the endpoints the Settings tab uses.
  // Match by suffix so it works regardless of API base URL.
  await page.route('**/settings', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(
        json({
          payday: 15,
          paydayFlexDays: 2,
          openaiConfigured: false,
        })
      );
    }
    if (route.request().method() === 'POST') {
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  await page.route('**/categories', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(
        json([
          { id: 'c_food', name: 'Ruoka' },
          { id: 'c_rent', name: 'Vuokra' },
          { id: 'c_misc', name: 'Muut ja epäselvät' },
        ])
      );
    }
    return route.fulfill(json({ ok: true }));
  });

  await page.route('**/accounts', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(
        json([
          { id: 'a1', name: 'Käyttötili', balance: 123.45, currency: 'EUR' },
          { id: 'a2', name: 'Säästö', balance: 9999.99, currency: 'EUR' },
        ])
      );
    }
    if (route.request().method() === 'PATCH') {
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  await page.route('**/logs*', async (route) => route.fulfill(json([])));
  await page.route('**/balance-adjustments*', async (route) => route.fulfill(json([])));

  // A few extra endpoints are queried during initial app load (default tab).
  await page.route('**/summary*', async (route) =>
    route.fulfill(
      json({
        totalBalance: 0,
        monthlyNet: 0,
        monthlyNetWithTransfers: 0,
        runwayMonths: null,
        accounts: [
          { id: 'a1', name: 'Käyttötili', balance: 123.45, currency: 'EUR', date: '2026-02-01' },
          { id: 'a2', name: 'Säästö', balance: 9999.99, currency: 'EUR', date: '2026-02-01' },
        ],
      })
    )
  );
  await page.route('**/transactions*', async (route) => route.fulfill(json([])));
  await page.route('**/insights*', async (route) => route.fulfill(json([])));

  // Vite preview proxies these to the API; stub them to avoid proxy ECONNREFUSED.
  await page.route('**/monthly*', async (route) => route.fulfill(json([])));
  await page.route('**/raw*', async (route) => route.fulfill(json([])));
  await page.route('**/log*', async (route) => route.fulfill(json([])));
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const ok = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth <= doc.clientWidth;
  });
  expect(ok).toBeTruthy();
}

test.describe('Settings layout', () => {
  for (const vp of [
    { width: 1280, height: 720 },
    { width: 900, height: 700 },
  ]) {
    test(`no horizontal overflow at ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubSettingsApi(page);

      await page.goto('/');
      await expect(page.locator('.tabs')).toBeVisible();

      // Click Settings tab; the button can re-render during initial loads.
      const settingsTab = page.locator('button.tab', { hasText: 'Asetukset' });
      await expect(settingsTab).toBeVisible();
      await settingsTab.click();

      await expect(page.locator('.settings-layout')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
