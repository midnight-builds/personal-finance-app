// Shared utility functions

export const API = '/api';

export async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (err: unknown) {
    throw new Error(`Network error: ${String(err)}`, { cause: err });
  }
}

export function formatDate(value: string | null) {
  if (!value) return '-';
  const d = new Date(value);
  return d.toLocaleDateString('fi-FI');
}

export function showToast(setToast: (v: string) => void, msg: string, ms = 2400) {
  setToast(msg);
  window.setTimeout(() => setToast(''), ms);
}

export function formatAmount(amount: number | null | undefined, currency = 'EUR') {
  if (amount === null || amount === undefined) return '—';
  return `${amount.toFixed(2)} ${currency}`;
}
