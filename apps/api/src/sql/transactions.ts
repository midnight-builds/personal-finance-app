// Reusable SQL fragments for normalized transactions. Each rule that several
// queries depend on lives here once, so the rule cannot drift between them.
// Arguments are table aliases chosen by the caller, never user input.

/**
 * ORDER BY terms that put a transaction's most recent categorization decision
 * first. Decisions are kept as history; rowid breaks ties between decisions
 * written within the same millisecond (the later insert wins).
 */
export const LATEST_DECISION_ORDER = 'created_at DESC, rowid DESC';

/** LEFT JOIN of each transaction's most recent categorization decision as `as`. */
export function latestCategoryDecisionJoin(tx = 'nt', as = 'cd') {
  return `LEFT JOIN categorization_decisions ${as} ON ${as}.id = (
    SELECT id FROM categorization_decisions
    WHERE transaction_id = ${tx}.id
    ORDER BY ${LATEST_DECISION_ORDER}
    LIMIT 1)`;
}

/** LEFT JOIN of one transfer link touching the transaction as `as` (null when not a transfer). */
export function transferLinkJoin(tx = 'nt', as = 'tl') {
  return `LEFT JOIN transfer_links ${as} ON ${as}.id = (
    SELECT id FROM transfer_links
    WHERE from_transaction_id = ${tx}.id OR to_transaction_id = ${tx}.id
    LIMIT 1)`;
}

/**
 * True unless the transaction is a void pending row: a reservation a newer
 * export showed cancelled. Void rows are kept but are no transaction anywhere.
 */
export function notVoid(tx = 'nt') {
  return `NOT EXISTS (SELECT 1 FROM pending_transactions pv WHERE pv.transaction_id = ${tx}.id AND pv.status = 'void')`;
}

/**
 * The id of the manual account (not archived) whose IBAN is the transaction's
 * counterparty IBAN, or NULL: the other end of a transfer to a manual account.
 * IBANs are compared without spaces or case. A transaction on the account
 * itself never matches.
 */
export function manualAccountByIban(tx = 'nt') {
  return `(SELECT ma.id FROM accounts ma
    WHERE ma.tracking = 'manual' AND ma.archived_at IS NULL AND ma.iban IS NOT NULL
      AND ${tx}.counterparty_iban IS NOT NULL
      AND REPLACE(UPPER(ma.iban), ' ', '') = REPLACE(UPPER(${tx}.counterparty_iban), ' ', '')
      AND ma.id != ${tx}.account_id
    ORDER BY ma.created_at ASC, ma.id ASC
    LIMIT 1)`;
}
