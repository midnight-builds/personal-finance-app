import { test, expect } from '@playwright/test';

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function stubApi(page: import('@playwright/test').Page) {
  // Minimal stubs to let the app render without a running API.
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
    return route.fulfill(json({ ok: true }));
  });

  await page.route('**/summary*', async (route) =>
    route.fulfill(
      json({
        totalBalance: 0,
        monthlyNet: 0,
        monthlyNetWithTransfers: 0,
        runwayMonths: null,
        accounts: [{ id: 'a1', name: 'Käyttötili', balance: 0, currency: 'EUR', date: '2026-02-01' }],
      })
    )
  );

  await page.route('**/transactions*', async (route) => route.fulfill(json([])));
  await page.route('**/insights*', async (route) => route.fulfill(json([])));
  await page.route('**/monthly*', async (route) => route.fulfill(json([])));
  await page.route('**/raw*', async (route) => route.fulfill(json([])));
  await page.route('**/categories*', async (route) => route.fulfill(json([])));
  await page.route('**/accounts*', async (route) => route.fulfill(json([])));
  await page.route('**/balance-adjustments*', async (route) => route.fulfill(json([])));
  await page.route('**/log*', async (route) => route.fulfill(json([])));
}

test('UI smoke: tabs render and no runtime exceptions on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  await stubApi(page);
  await page.goto('/');

  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analytiikka' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raaka data' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Asetukset' })).toBeVisible();

  // Allow any initial effects to run.
  await page.waitForTimeout(500);

  expect(errors, errors.join('\n')).toEqual([]);
});
