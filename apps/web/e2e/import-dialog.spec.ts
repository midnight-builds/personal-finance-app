import { test, expect, type Page, type Request } from '@playwright/test';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function stubBase(page: Page) {
  await page.route('**/settings', (route) => route.fulfill(json({ payday: 15, paydayFlexDays: 2, openaiConfigured: false })));
  await page.route('**/categories', (route) => route.fulfill(json([])));
  await page.route('**/accounts', (route) => route.fulfill(json([])));
  await page.route('**/log*', (route) => route.fulfill(json([])));
  await page.route('**/balance-adjustments*', (route) => route.fulfill(json([])));
  await page.route('**/summary*', (route) =>
    route.fulfill(json({ totalBalance: 0, monthlyNet: 0, monthlyNetWithTransfers: 0, runwayMonths: null, accounts: [] }))
  );
  await page.route('**/transactions*', (route) => route.fulfill(json([])));
  await page.route('**/insights*', (route) => route.fulfill(json([])));
  await page.route('**/monthly*', (route) => route.fulfill(json([])));
  await page.route('**/raw*', (route) => route.fulfill(json([])));
  await page.route('**/household/summary*', (route) =>
    route.fulfill(json({ liquidAssets: 0, totalSavings: 0, creditDebt: 0, monthlySubscriptions: 0, runwayMonths: null, accounts: [], dataAgeDays: 0 }))
  );
  await page.route('**/briefing/latest*', (route) => route.fulfill(json(null)));
  await page.route('**/forecast*', (route) => route.fulfill(json([])));
  await page.route('**/rule-suggestions*', (route) => route.fulfill(json([])));
  await page.route('**/pattern-confirmations*', (route) => route.fulfill(json([])));
  await page.route('**/data-status*', (route) => route.fulfill(json({ dataset: 'real' })));
}

const CARD = { id: 'card-1', name: 'Visa', iban: null, subtype: 'credit_card', firstDate: '2026-09-01', lastDate: '2026-09-30', transactionCount: 12 };
const analysis = (over: object = {}) => ({
  accountId: null,
  duplicates: 0,
  newRows: 3,
  overlap: null,
  transfers: 0,
  gapBefore: null,
  gapAfter: null,
  quietPeriods: [],
  balanceBreaks: [],
  openingMismatch: null,
  ibanMismatch: false,
  ...over,
});
const fileInfo = (filename: string) => ({
  filename,
  rowCount: 3,
  bookedCount: 3,
  pendingCount: 1,
  skippedCount: 0,
  firstDate: '2026-10-01',
  lastDate: '2026-10-20',
  ownIban: null,
  suggestedName: 'Mastercard',
  hasRunningBalance: true,
});

/** The multipart text fields of a request (the file part is skipped). */
function fieldsOf(request: Request): Record<string, string> {
  const body = request.postData() ?? '';
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) out[m[1]] = m[2];
  return out;
}

const csv = (name: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from('Kirjauspäivä;Määrä\n') });

test('import dialog: no guess means the user must choose; a new account is sent with the import', async ({ page }) => {
  await stubBase(page);
  const previews: Record<string, string>[] = [];
  const imports: Record<string, string>[] = [];
  await page.route('**/imports/nordea/preview', (route) => {
    const fields = fieldsOf(route.request());
    previews.push(fields);
    const filename = (route.request().postData() ?? '').includes('Mastercard.csv') ? 'Mastercard.csv' : 'Visa.csv';
    if (filename === 'Visa.csv') {
      return route.fulfill(
        json({
          file: fileInfo(filename),
          accounts: [CARD],
          guess: { accountId: 'card-1', reason: 'overlap', overlapCount: 2, newAccount: { name: 'Visa 2', subtype: 'credit_card' } },
          analysis: analysis({ accountId: 'card-1', duplicates: 2, newRows: 1, gapBefore: { from: '2026-09-01', to: '2026-09-30', days: 30 } }),
        })
      );
    }
    return route.fulfill(
      json({
        file: fileInfo(filename),
        accounts: [CARD],
        guess: { accountId: null, reason: 'none', newAccount: { name: 'Mastercard', subtype: 'credit_card' } },
        analysis: fields.asNewAccount
          ? analysis({ balanceBreaks: [{ date: '2026-03-12', expected: 100, actual: 54.8, difference: -45.2 }] })
          : analysis(),
      })
    );
  });
  await page.route('**/imports/nordea/csv', (route) => {
    imports.push(fieldsOf(route.request()));
    return route.fulfill(
      json({ importSessionId: 's', accountId: 'a', normalizedCount: 3, rawCount: 3, skippedCount: 0, overlapDetected: false, alreadyImportedCount: 0, duplicateCount: 0, transferCount: 0 })
    );
  });

  await page.goto('/');
  await page.locator('.hero input[type=file]').setInputFiles([csv('Mastercard.csv'), csv('Visa.csv')]);

  const dialog = page.getByRole('dialog', { name: 'Tuo tiliotteet' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Tiedosto 1 / 2')).toBeVisible();
  await expect(dialog.getByText('Tiliä ei tunnistettu — valitse tili')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tuo tiedosto' })).toBeDisabled();

  await dialog.getByLabel('Kohdetili').selectOption('new');
  await expect(dialog.getByText('Saldo ei täsmää 12.3.: puuttuu −45,20 €', { exact: false })).toBeVisible();
  expect(previews.at(-1)).toEqual({ asNewAccount: '1' });
  await expect(dialog.getByLabel('Tilin nimi')).toHaveValue('Mastercard');
  await expect(dialog.getByLabel('Tyyppi')).toHaveValue('credit_card');
  await dialog.getByRole('button', { name: 'Tuo tiedosto' }).click();

  // The next file is previewed after the import: guessed by overlap.
  await expect(dialog.getByText('Tiedosto 2 / 2')).toBeVisible();
  await expect(dialog.getByText('2 päällekkäistä tapahtumaa tilin Visa kanssa')).toBeVisible();
  await expect(dialog.getByText('30 päivää puuttuu ennen tätä tiedostoa', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Tuo tiedosto' }).click();

  await expect(dialog.getByText('Valmis')).toBeVisible();
  expect(imports).toEqual([{ newAccountName: 'Mastercard', newAccountSubtype: 'credit_card' }, { accountId: 'card-1' }]);
  await dialog.getByRole('button', { name: 'Sulje', exact: true }).last().click();
  await expect(dialog).toBeHidden();
});

test('import dialog: an IBAN that belongs elsewhere needs an explicit yes; a failed preview blocks the import', async ({ page }) => {
  await stubBase(page);
  const CHECKING = { id: 'chk', name: 'Käyttötili', iban: 'FI1111111111111111', subtype: 'checking', firstDate: '2026-09-01', lastDate: '2026-09-30', transactionCount: 40 };
  const imports: Record<string, string>[] = [];
  await page.route('**/imports/nordea/preview', (route) => {
    const fields = fieldsOf(route.request());
    if (fields.accountId === 'card-1') return route.fulfill(json({ error: 'internal_error' }, 500));
    return route.fulfill(
      json({
        file: { ...fileInfo('Tili.csv'), ownIban: 'FI2222222222222222', ownIbanAccount: null },
        accounts: [CHECKING, CARD],
        guess: fields.accountId ? null : { accountId: null, reason: 'none', newAccount: { name: 'Tili 2222', subtype: 'checking' } },
        analysis: analysis({ accountId: fields.accountId ?? null, ibanMismatch: fields.accountId === 'chk' }),
      })
    );
  });
  await page.route('**/imports/nordea/csv', (route) => {
    imports.push(fieldsOf(route.request()));
    return route.fulfill(
      json({ importSessionId: 's', accountId: 'chk', normalizedCount: 3, rawCount: 3, skippedCount: 0, overlapDetected: false, alreadyImportedCount: 0, duplicateCount: 0, transferCount: 0 })
    );
  });

  await page.goto('/');
  await page.locator('.hero input[type=file]').setInputFiles([csv('Tili.csv')]);
  const dialog = page.getByRole('dialog', { name: 'Tuo tiliotteet' });
  const confirm = dialog.getByRole('button', { name: 'Tuo tiedosto' });

  // A failing preview: no numbers, an error, nothing to confirm.
  await dialog.getByLabel('Kohdetili').selectOption('card-1');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByText('tapahtumaa on jo tuotu')).toHaveCount(0);
  await expect(confirm).toBeDisabled();

  // The checking account has another IBAN: the checkbox gates the import.
  await dialog.getByLabel('Kohdetili').selectOption('chk');
  await expect(dialog.getByText('Tiedoston IBAN (FI2222222222222222) on eri kuin tilin Käyttötili', { exact: false })).toBeVisible();
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Tuo silti tälle tilille').check();
  await confirm.click();
  await expect(dialog.getByText('Valmis')).toBeVisible();
  expect(imports).toEqual([{ accountId: 'chk', allowIbanMismatch: '1' }]);
});
