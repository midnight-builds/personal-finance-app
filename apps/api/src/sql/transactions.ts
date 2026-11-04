// Reusable SQL fragments for normalized transactions. Each rule that several
// queries depend on lives here once, so the rule cannot drift between them.
// Arguments are table aliases chosen by the caller, never user input.

/** ORDER BY terms that pick a duplicate group's canonical row: the earliest imported. */
export function canonicalGroupOrder(alias?: string) {
  const col = alias ? `${alias}.` : '';
  return `${col}created_at ASC, ${col}id ASC`;
}

/** True for rows that are not duplicates, or are their group's canonical row. */
export function isCanonicalGroupRow(tx = 'nt') {
  return `(${tx}.transaction_group_id IS NULL OR ${tx}.id = (
    SELECT g.id FROM normalized_transactions g
    WHERE g.transaction_group_id = ${tx}.transaction_group_id
    ORDER BY ${canonicalGroupOrder('g')}
    LIMIT 1))`;
}

/** LEFT JOIN of each transaction's most recent categorization decision as `as`. */
export function latestCategoryDecisionJoin(tx = 'nt', as = 'cd') {
  return `LEFT JOIN categorization_decisions ${as} ON ${as}.id = (
    SELECT id FROM categorization_decisions
    WHERE transaction_id = ${tx}.id
    ORDER BY created_at DESC
    LIMIT 1)`;
}

/** LEFT JOIN of one transfer link touching the transaction as `as` (null when not a transfer). */
export function transferLinkJoin(tx = 'nt', as = 'tl') {
  return `LEFT JOIN transfer_links ${as} ON ${as}.id = (
    SELECT id FROM transfer_links
    WHERE from_transaction_id = ${tx}.id OR to_transaction_id = ${tx}.id
    LIMIT 1)`;
}
