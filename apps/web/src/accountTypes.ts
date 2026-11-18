import type { AccountType, OwnTransferKind } from '@finance-app/shared';

/** Finnish names of the account types (GLOSSARY.md, "Account"). */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Käyttötili',
  savings: 'Säästötili',
  credit_card: 'Luottokortti',
  loan: 'Laina',
  investment: 'Sijoitukset',
  property: 'Kiinteistö tai asunto',
  other_asset: 'Muu varallisuus',
  other_liability: 'Muu velka',
};

/** The types an import can create. */
export const IMPORT_ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'credit_card'];

/** How a transfer to a manual account is reported. */
export const OWN_TRANSFER_LABELS: Record<OwnTransferKind, string> = {
  saving: 'Säästäminen',
  loan_repayment: 'Lainanhoito',
  other: 'Siirto omalle tilille',
};
