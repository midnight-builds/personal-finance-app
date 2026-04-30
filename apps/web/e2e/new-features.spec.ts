import { test, expect } from '@playwright/test';

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function stubBase(page: import('@playwright/test').Page) {
  await page.route('**/settings', async (route) => route.fulfill(json({ payday: 15, paydayFlexDays: 2, openaiConfigured: false })));
  await page.route('**/categories', async (route) => route.fulfill(json([])));
  await page.route('**/accounts', async (route) => route.fulfill(json([])));
  await page.route('**/logs*', async (route) => route.fulfill(json([])));
  await page.route('**/log*', async (route) => route.fulfill(json([])));
  await page.route('**/balance-adjustments*', async (route) => route.fulfill(json([])));
  await page.route('**/summary*', async (route) =>
    route.fulfill(json({ totalBalance: 0, monthlyNet: 0, monthlyNetWithTransfers: 0, runwayMonths: null, accounts: [] }))
  );
  await page.route('**/transactions*', async (route) => route.fulfill(json([])));
  await page.route('**/insights*', async (route) => route.fulfill(json([])));
  await page.route('**/monthly*', async (route) => route.fulfill(json([])));
  await page.route('**/raw*', async (route) => route.fulfill(json([])));
  await page.route('**/household/summary*', async (route) =>
    route.fulfill(json({ liquidAssets: 0, totalSavings: 0, creditDebt: 0, monthlySubscriptions: 0, runwayMonths: null, accounts: [], dataAgeDays: 0 }))
  );
  await page.route('**/briefing/latest*', async (route) => route.fulfill(json(null)));
  await page.route('**/forecast*', async (route) => route.fulfill(json([])));
  await page.route('**/rule-suggestions*', async (route) => route.fulfill(json([])));
  await page.route('**/pattern-confirmations*', async (route) => route.fulfill(json([])));
}

test.describe('ForecastPanel', () => {
  test('shows 3-month forecast when data is non-zero', async ({ page }) => {
    await stubBase(page);
    await page.unroute('**/forecast*');
    await page.route('**/forecast*', async (route) =>
      route.fulfill(json([
        { targetMonth: '2026-05', knownFixed: [{ counterparty: 'Vuokra', amount: 800 }], historicalAvg: 1200, annualItems: [], projectedTotal: 1200 },
        { targetMonth: '2026-06', knownFixed: [], historicalAvg: 1100, annualItems: [{ counterparty: 'Vakuutus', amount: 300 }], projectedTotal: 1400 },
        { targetMonth: '2026-07', knownFixed: [], historicalAvg: 900, annualItems: [], projectedTotal: 900 },
      ]))
    );

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    // Forecast panel heading
    await expect(page.getByText('3 kuukauden ennuste')).toBeVisible();

    // Three month columns rendered
    await expect(page.locator('.forecast-month')).toHaveCount(3);

    // Annual item chip from second month
    await expect(page.locator('.chip-annual', { hasText: 'Vakuutus' })).toBeVisible();
  });

  test('hidden when all projected totals are zero', async ({ page }) => {
    await stubBase(page);

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    await expect(page.getByText('3 kuukauden ennuste')).not.toBeVisible();
  });
});

test.describe('RuleSuggestionsPanel', () => {
  test('shows suggestions and approve removes the row', async ({ page }) => {
    const suggestionId = 'sug-1';
    await stubBase(page);
    await page.unroute('**/rule-suggestions*');
    await page.route('**/rule-suggestions*', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill(json([
          { id: suggestionId, category_id: 'c1', category_name: 'Ruoka', pattern: 'K-Market', match_field: 'counterparty', sample_counterparty: 'K-Market Tikkurila', ai_reason: 'supermarket', confidence: 0.9, status: 'pending' },
        ]));
      }
      return route.fulfill(json({ ok: true }));
    });
    await page.route(`**/rule-suggestions/${suggestionId}/accept`, async (route) =>
      route.fulfill(json({ ok: true }))
    );

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    // Panel heading and suggestion row
    await expect(page.getByText('Kategoriasäännöt')).toBeVisible();
    await expect(page.getByText('K-Market Tikkurila')).toBeVisible();

    // Click approve — row disappears (text may also appear in toast, so check the row count)
    const acceptBtn = page.locator('button', { hasText: 'Hyväksy sääntö' }).first();
    await acceptBtn.click();
    await expect(page.locator('.rule-suggestion-row')).toHaveCount(0);
  });

  test('hidden when no pending suggestions', async ({ page }) => {
    await stubBase(page);

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    await expect(page.getByText('Kategoriasäännöt')).not.toBeVisible();
  });
});

test.describe('PatternConfirmationCard', () => {
  test('confirm button calls API and removes card', async ({ page }) => {
    const confirmationId = 'conf-1';
    const findingId = 'f-1';

    await stubBase(page);
    await page.unroute('**/briefing/latest*');
    await page.route('**/briefing/latest*', async (route) =>
      route.fulfill(json({
        id: 'brief-1',
        createdAt: new Date().toISOString(),
        importSessionId: null,
        findingCount: 1,
        findings: [
          {
            id: findingId,
            findingType: 'pattern_confirmation',
            title: 'Onko tämä vuosittainen?',
            description: 'Suuri maksu havaittu',
            severity: 'info',
            impactEur: 350,
            transactionIds: [],
            metadata: { confirmationId, counterparty: 'LähiTapiola', month: 1 },
            dismissedAt: null,
          },
        ],
      }))
    );
    await page.route(`**/pattern-confirmations/${confirmationId}/confirm`, async (route) =>
      route.fulfill(json({ ok: true }))
    );

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    // Card shows the pattern confirmation question
    await expect(page.getByText('LähiTapiola')).toBeVisible();
    await expect(page.getByText('Kyllä, vuosittainen')).toBeVisible();

    // Confirm — card disappears (toast may still show the name, so check the card itself)
    await page.locator('button', { hasText: 'Kyllä, vuosittainen' }).click();
    await expect(page.locator('.finding-card', { hasText: 'LähiTapiola' })).toHaveCount(0);
  });

  test('reject button calls API and removes card', async ({ page }) => {
    const confirmationId = 'conf-2';
    const findingId = 'f-2';

    await stubBase(page);
    await page.unroute('**/briefing/latest*');
    await page.route('**/briefing/latest*', async (route) =>
      route.fulfill(json({
        id: 'brief-2',
        createdAt: new Date().toISOString(),
        importSessionId: null,
        findingCount: 1,
        findings: [
          {
            id: findingId,
            findingType: 'pattern_confirmation',
            title: 'Onko tämä vuosittainen?',
            description: 'Suuri maksu havaittu',
            severity: 'info',
            impactEur: 200,
            transactionIds: [],
            metadata: { confirmationId, counterparty: 'Folksam', month: 3 },
            dismissedAt: null,
          },
        ],
      }))
    );
    await page.route(`**/pattern-confirmations/${confirmationId}/reject`, async (route) =>
      route.fulfill(json({ ok: true }))
    );

    await page.goto('/');
    await expect(page.locator('.tabs')).toBeVisible();

    await expect(page.getByText('Folksam')).toBeVisible();

    // Reject — card disappears
    await page.locator('button', { hasText: 'Ei, kertaluonteinen' }).click();
    await expect(page.getByText('Folksam')).not.toBeVisible();
  });
});
