import { test, expect } from "@playwright/test";

function json(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

async function stubSettingsApi(page: import("@playwright/test").Page) {
  await page.route("**/settings", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        json({
          payday: 15,
          paydayFlexDays: 2,
          openaiConfigured: false,
        })
      );
    }
    if (route.request().method() === "POST") {
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill({ status: 405, body: "method not allowed" });
  });

  await page.route("**/categories", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        json([
          { id: "c_food", name: "Ruoka" },
          { id: "c_rent", name: "Vuokra" },
          { id: "c_misc", name: "Muut ja epäselvät" },
        ])
      );
    }
    return route.fulfill(json({ ok: true }));
  });

  await page.route("**/accounts", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        json([
          { id: "a1", name: "Käyttötili", balance: 123.45, currency: "EUR" },
          { id: "a2", name: "Säästö", balance: 9999.99, currency: "EUR" },
        ])
      );
    }
    if (route.request().method() === "PATCH") {
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill({ status: 405, body: "method not allowed" });
  });

  await page.route("**/logs*", async (route) => route.fulfill(json([])));
  await page.route("**/balance-adjustments*", async (route) => route.fulfill(json([])));

  await page.route("**/summary*", async (route) =>
    route.fulfill(
      json({
        totalBalance: 0,
        monthlyNet: 0,
        monthlyNetWithTransfers: 0,
        runwayMonths: null,
        accounts: [
          { id: "a1", name: "Käyttötili", balance: 123.45, currency: "EUR", date: "2026-02-01" },
          { id: "a2", name: "Säästö", balance: 9999.99, currency: "EUR", date: "2026-02-01" },
        ],
      })
    )
  );
  await page.route("**/transactions*", async (route) => route.fulfill(json([])));
  await page.route("**/insights*", async (route) => route.fulfill(json([])));

  // Vite preview proxies these to the API; stub them to avoid proxy ECONNREFUSED.
  await page.route("**/monthly*", async (route) => route.fulfill(json([])));
  await page.route("**/raw*", async (route) => route.fulfill(json([])));
  await page.route("**/log*", async (route) => route.fulfill(json([])));
}

test("Settings: backup download triggers a browser download", async ({ page }) => {
  await stubSettingsApi(page);

  await page.route("**/backup", async (route) => {
    const sqliteHeader = Buffer.from("SQLite format 3\u0000", "utf-8");
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/x-sqlite3",
        "content-disposition": "attachment; filename=finance-backup-2026-02-25.db",
      },
      body: Buffer.concat([sqliteHeader, Buffer.alloc(1024)]),
    });
  });

  await page.goto("/");
  await expect(page.locator(".tabs")).toBeVisible();

  const settingsTab = page.locator("button.tab", { hasText: "Asetukset" });
  await expect(settingsTab).toBeVisible();
  await settingsTab.click();

  const dlBtn = page.locator("button", { hasText: "Lataa varmuuskopio" });
  await expect(dlBtn).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), dlBtn.click()]);
  expect(download.suggestedFilename()).toContain("finance-backup");
});
