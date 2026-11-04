// Typed API client for finance app
import type { FeatureProposal, FeatureProposalAction } from '@finance-app/shared';
// All fetch functions use /api as base; Vite proxies to http://127.0.0.1:3001

// ============================================================================
// Types (replicated from App.tsx, extended with new types from Task 5)
// ============================================================================

export type Account = {
  id: string;
  name: string;
  iban: string | null;
  type: string;
  account_subtype: 'checking' | 'savings' | 'credit_card';
  owner_label: string | null;
  credit_limit: number | null;
  savings_goal: number | null;
  balance: number;
  currency: string;
  balance_date: string | null;
};

export type Transaction = {
  id: string;
  bookingDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  account: { id: string; name: string; iban: string | null };
  categoryId?: string | null;
  categoryName?: string | null;
  groupSize?: number | null;
  transfer?: { direction: 'in' | 'out'; otherId: string | null } | null;
  isTransfer?: boolean;
};

export type Category = { id: string; name: string };

export type Summary = {
  /** Sum of known balances; partial when `isComplete` is false. */
  totalBalance: number;
  isComplete: boolean;
  missingBalanceAccountCount: number;
  monthlyNet: number;
  monthlyNetWithTransfers: number;
  runwayMonths: number | null;
  /** `balance`, `currency` and `date` are null when the account has no balance yet. */
  accounts: { id: string; name: string; balance: number | null; currency: string | null; date: string | null }[];
};

export type MonthlyRow = { month: string; income: number; expense: number; net: number; direction: string };

export type Insight = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warn';
  transactionIds: string[];
  recommendation?: string;
};

export type RawRow = {
  id: string;
  createdAt: string;
  bookingDate: string | null;
  amount: number | null;
  currency: string | null;
  data: Record<string, unknown>;
  sourceBank: string;
  format: string;
};

export type Settings = { payday: number; paydayFlexDays: number; openaiConfigured: boolean };

export type LogRow = {
  id: string;
  created_at: string;
  type: string;
  scope?: string | null;
  message: string;
  payload?: unknown;
};

export type BalanceAdjustment = {
  id: string;
  created_at: string;
  account_id: string;
  date: string;
  amount: number;
  reason: string | null;
};

// Task 5 new types
export type AccountSignal = {
  id: string;
  name: string;
  subtype: string;
  ownerLabel: string | null;
  balance: number;
  trend: 'up' | 'down' | 'stable' | null;
  warningLevel: 'none' | 'warn' | 'alert';
};

export type HouseholdSummary = {
  liquidAssets: number;
  totalSavings: number;
  creditDebt: number;
  monthlySubscriptions: number;
  runwayMonths: number | null;
  accounts: AccountSignal[];
  dataAgeDays: number;
};

export type RecurringPattern = {
  id: string;
  account_id: string;
  counterparty_name: string;
  pattern_type: 'subscription' | 'recurring' | 'salary';
  interval_days: number;
  typical_amount: number;
  currency: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  is_active: number;
};

export type InsightFinding = {
  id: string;
  findingType: string;
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'alert';
  impactEur: number | null;
  transactionIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type BriefingSession = {
  id: string;
  createdAt: string;
  importSessionId: string | null;
  findingCount: number;
  findings: InsightFinding[];
};

export type PatternConfirmationRecord = {
  id: string;
  created_at: string;
  account_id: string;
  counterparty_name: string;
  typical_month: number;
  typical_amount: number;
  currency: string;
  status: string;
};

export type ForecastItem = { counterparty: string; amount: number };
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };
export type MonthlyForecast = {
  targetMonth: string;
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  projectedTotal: number;
};

export type ImportResult = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  rawCount: number;
  skippedCount: number;
  overlapDetected: boolean;
  alreadyImportedCount: number;
  briefingSessionId?: string;
};

export type BalanceSnapshot = {
  date: string;
  balance: number;
  currency: string;
};

export type RuleSuggestion = {
  id: string;
  created_at: string;
  category_id: string;
  category_name: string;
  pattern: string;
  match_field: string;
  sample_counterparty: string | null;
  ai_reason: string | null;
  confidence: number;
  status: string;
};

// ============================================================================
// Helper
// ============================================================================

const API = '/api';

async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (err: unknown) {
    throw new Error(`Network error: ${String(err)}`, { cause: err });
  }
}

// ============================================================================
// Transactions
// ============================================================================

export async function getTransactions(): Promise<Transaction[]> {
  const res = await safeFetch(`${API}/transactions`);
  if (!res.ok) throw new Error(`getTransactions failed: ${res.statusText}`);
  return res.json();
}

export async function setTransactionCategory(txId: string, categoryId: string): Promise<void> {
  const res = await safeFetch(`${API}/transactions/${txId}/category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryId }),
  });
  if (!res.ok) throw new Error(`setTransactionCategory failed: ${res.statusText}`);
}

// ============================================================================
// Categories
// ============================================================================

export async function getCategories(): Promise<Category[]> {
  const res = await safeFetch(`${API}/categories`);
  if (!res.ok) throw new Error(`getCategories failed: ${res.statusText}`);
  return res.json();
}

export async function createCategory(name: string): Promise<Category> {
  const res = await safeFetch(`${API}/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createCategory failed: ${res.statusText}`);
  return res.json();
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const res = await safeFetch(`${API}/categories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`renameCategory failed: ${res.statusText}`);
}

export async function deleteCategory(id: string): Promise<void> {
  const res = await safeFetch(`${API}/categories/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteCategory failed: ${res.statusText}`);
}

// ============================================================================
// Accounts
// ============================================================================

export async function getAccounts(): Promise<Account[]> {
  const res = await safeFetch(`${API}/accounts`);
  if (!res.ok) throw new Error(`getAccounts failed: ${res.statusText}`);
  return res.json();
}

export async function patchAccount(
  id: string,
  patch: {
    account_subtype?: string;
    owner_label?: string | null;
    credit_limit?: number | null;
    savings_goal?: number | null;
    name?: string;
  }
): Promise<void> {
  const res = await safeFetch(`${API}/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patchAccount failed: ${res.statusText}`);
}

// ============================================================================
// Summary
// ============================================================================

export async function getSummary(): Promise<Summary> {
  const res = await safeFetch(`${API}/summary`);
  if (!res.ok) throw new Error(`getSummary failed: ${res.statusText}`);
  return res.json();
}

export async function getHouseholdSummary(): Promise<HouseholdSummary> {
  const res = await safeFetch(`${API}/household/summary`);
  if (!res.ok) throw new Error(`getHouseholdSummary failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Insights (legacy)
// ============================================================================

export async function getInsights(): Promise<Insight[]> {
  const res = await safeFetch(`${API}/insights`);
  if (!res.ok) throw new Error(`getInsights failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Monthly
// ============================================================================

export async function getMonthlyOverview(): Promise<MonthlyRow[]> {
  const res = await safeFetch(`${API}/monthly`);
  if (!res.ok) throw new Error(`getMonthlyOverview failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Raw
// ============================================================================

export async function getRawTransactions(): Promise<RawRow[]> {
  const res = await safeFetch(`${API}/raw`);
  if (!res.ok) throw new Error(`getRawTransactions failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Settings
// ============================================================================

export async function getSettings(): Promise<Settings> {
  const res = await safeFetch(`${API}/settings`);
  if (!res.ok) throw new Error(`getSettings failed: ${res.statusText}`);
  return res.json();
}

export async function saveSettings(payday: number, paydayFlexDays: number): Promise<void> {
  const res = await safeFetch(`${API}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payday, paydayFlexDays }),
  });
  if (!res.ok) throw new Error(`saveSettings failed: ${res.statusText}`);
}

// ============================================================================
// Logs
// ============================================================================

export async function getLogs(): Promise<LogRow[]> {
  const res = await safeFetch(`${API}/log`);
  if (!res.ok) throw new Error(`getLogs failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Balance Adjustments
// ============================================================================

export async function getBalanceAdjustments(): Promise<BalanceAdjustment[]> {
  const res = await safeFetch(`${API}/balance-adjustments`);
  if (!res.ok) throw new Error(`getBalanceAdjustments failed: ${res.statusText}`);
  return res.json();
}

export async function createBalanceAdjustment(data: {
  accountId: string;
  date: string;
  amount: number;
  reason: string | null;
}): Promise<BalanceAdjustment> {
  const res = await safeFetch(`${API}/balance-adjustments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`createBalanceAdjustment failed: ${res.statusText}`);
  return res.json();
}

export async function deleteBalanceAdjustment(id: string): Promise<void> {
  const res = await safeFetch(`${API}/balance-adjustments/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteBalanceAdjustment failed: ${res.statusText}`);
}

// ============================================================================
// Briefing
// ============================================================================

export async function getLatestBriefing(): Promise<BriefingSession> {
  const res = await safeFetch(`${API}/briefing/latest`);
  if (!res.ok) throw new Error(`getLatestBriefing failed: ${res.statusText}`);
  return res.json();
}

export async function getBriefing(id: string): Promise<BriefingSession> {
  const res = await safeFetch(`${API}/briefing/${id}`);
  if (!res.ok) throw new Error(`getBriefing failed: ${res.statusText}`);
  return res.json();
}

export async function dismissFinding(findingId: string): Promise<void> {
  const res = await safeFetch(`${API}/briefing/${findingId}/dismiss`, { method: 'POST' });
  if (!res.ok) throw new Error(`dismissFinding failed: ${res.statusText}`);
}

export async function getForecast(): Promise<MonthlyForecast[]> {
  const res = await safeFetch(`${API}/forecast`);
  if (!res.ok) throw new Error(`getForecast failed: ${res.statusText}`);
  return res.json();
}

export async function confirmPatternConfirmation(id: string): Promise<void> {
  const res = await safeFetch(`${API}/pattern-confirmations/${id}/confirm`, { method: 'POST' });
  if (!res.ok) throw new Error(`confirmPatternConfirmation failed: ${res.statusText}`);
}

export async function rejectPatternConfirmation(id: string): Promise<void> {
  const res = await safeFetch(`${API}/pattern-confirmations/${id}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`rejectPatternConfirmation failed: ${res.statusText}`);
}

// ============================================================================
// Recurring Patterns
// ============================================================================

export async function getSubscriptions(): Promise<RecurringPattern[]> {
  const res = await safeFetch(`${API}/subscriptions`);
  if (!res.ok) throw new Error(`getSubscriptions failed: ${res.statusText}`);
  return res.json();
}

export async function getRecurringPatterns(): Promise<RecurringPattern[]> {
  const res = await safeFetch(`${API}/recurring`);
  if (!res.ok) throw new Error(`getRecurringPatterns failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// Import
// ============================================================================

export async function importCsv(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await safeFetch(`${API}/imports/nordea/csv`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`importCsv failed: ${res.statusText}`);
  return res.json();
}

export async function importXlsx(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await safeFetch(`${API}/imports/nordea/xlsx`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`importXlsx failed: ${res.statusText}`);
  return res.json();
}

// ============================================================================
// AI
// ============================================================================

export async function aiCategorize(params: {
  counterparty: string | null;
  description: string | null;
  amount: number;
  currency: string;
}): Promise<{ mode: string; categoryId?: string; categoryName?: string; options?: Array<{ categoryId: string; categoryName: string }> } | null> {
  const res = await safeFetch(`${API}/ai/categorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function getBalanceSnapshots(accountId: string): Promise<BalanceSnapshot[]> {
  const res = await safeFetch(`${API}/balance-snapshots/${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`getBalanceSnapshots failed: ${res.statusText}`);
  return res.json();
}

export async function getRuleSuggestions(): Promise<RuleSuggestion[]> {
  const res = await safeFetch(`${API}/rule-suggestions`);
  if (!res.ok) throw new Error(`getRuleSuggestions failed: ${res.statusText}`);
  return res.json();
}

export async function acceptRuleSuggestion(id: string): Promise<void> {
  const res = await safeFetch(`${API}/rule-suggestions/${id}/accept`, { method: 'POST' });
  if (!res.ok) throw new Error(`acceptRuleSuggestion failed: ${res.statusText}`);
}

export async function rejectRuleSuggestion(id: string): Promise<void> {
  const res = await safeFetch(`${API}/rule-suggestions/${id}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`rejectRuleSuggestion failed: ${res.statusText}`);
}

// ============================================================================
// Feature proposals (from external agents via MCP)
// ============================================================================

export type { FeatureProposal };

export async function getFeatureProposals(): Promise<FeatureProposal[]> {
  const res = await safeFetch(`${API}/feature-proposals`);
  if (!res.ok) throw new Error(`getFeatureProposals failed: ${res.statusText}`);
  return res.json();
}

export async function resolveFeatureProposal(
  id: string,
  action: FeatureProposalAction,
  note?: string,
  resolution?: string
): Promise<void> {
  const res = await safeFetch(`${API}/feature-proposals/${id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note || undefined, resolution: resolution || undefined }),
  });
  if (!res.ok) throw new Error(`resolveFeatureProposal failed: ${res.statusText}`);
}
