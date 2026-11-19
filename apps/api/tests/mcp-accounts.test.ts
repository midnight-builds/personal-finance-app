import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { db } from '../src/db.js';
import { routes } from '../src/routes/index.js';
import { checksum, processImport } from '../src/importer.js';
import { createApiClient } from '../../mcp/src/apiClient.js';
import { registerTools, selectTools } from '../../mcp/src/tools/index.js';
import { resetDb } from './setup/resetDb.js';
import { compact, testIban } from './setup/iban.js';

// End to end: an agent manages a manual account through the real MCP tools and
// this API. It may set the IBAN, but nothing it reads back contains it.

const app = Fastify();
await app.register(routes);
const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

beforeEach(() => resetDb());

const CHECKING = testIban('22345600000001');
const LOAN = testIban('22345600000002');
const LOAN_DIGITS = compact(LOAN).slice(4);

async function connectAgent() {
  const server = new McpServer({ name: 'finance-app', version: 'test' });
  const api = createApiClient(baseUrl, fetch, { actor: 'agent-under-test' });
  registerTools(server, selectTools(new Set()), { api, proposalSource: 'agent-under-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent', version: 'test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  after(() => client.close());
  const texts: string[] = [];
  return {
    texts,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      texts.push(...res.content.map((c) => c.text));
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    },
  };
}

async function importLoanPayments() {
  const row = (date: string) => ({
    Kirjauspäivä: date,
    Määrä: '-400,00',
    Maksaja: CHECKING,
    Maksunsaaja: LOAN,
    Nimi: 'Lainanhoito',
    Otsikko: '',
    Viesti: '',
    Saldo: '',
    Valuutta: 'EUR',
  });
  const records = [row('2026/09/04'), row('2026/10/04')];
  await processImport({
    records,
    checksum: checksum(Buffer.from(JSON.stringify(records))),
    filename: 'x.csv',
    accountName: 'Käyttötili',
    accountIban: CHECKING,
    sourceBank: 'nordea',
    format: 'csv',
  });
}

test('an agent creates a manual loan account with an IBAN; it never reads the IBAN back', async () => {
  await importLoanPayments();
  const agent = await connectAgent();
  const op = { kind: 'create_account', name: 'Yhteinen asuntolaina', type: 'loan', ownershipShare: 50, iban: LOAN, reason: 'laina' };

  const plan = await agent.call('plan_account_change', { op });
  assert.equal(plan.transfers.recognizedTotal, 2);
  assert.equal(plan.op.recognizesTransfers, true);
  const set = await agent.call('apply_account_change', { op, planToken: plan.planToken });
  assert.equal(set.actor, 'agent-under-test');
  assert.equal(set.kind, 'create_account');
  // A retry with the same token returns the same set.
  assert.equal((await agent.call('apply_account_change', { op, planToken: plan.planToken })).id, set.id);

  const accounts = await agent.call('list_accounts');
  const loan = accounts.find((a: { id: string }) => a.id === set.accountId);
  assert.deepEqual(
    { type: loan.type, tracking: loan.tracking, ownershipShare: loan.ownershipShare, recognizesTransfers: loan.recognizesTransfers },
    { type: 'loan', tracking: 'manual', ownershipShare: 50, recognizesTransfers: true }
  );

  const search = await agent.call('search_transactions', {});
  assert.equal(search.items.length, 2);
  assert.ok(search.items.every((i: any) => i.ownTransfer?.kind === 'loan_repayment' && i.ownTransfer.accountName === 'Yhteinen asuntolaina'));

  const changes = await agent.call('list_account_changes', { accountId: set.accountId });
  assert.equal(changes.items[0].actor, 'agent-under-test');
  await agent.call('get_account_change', { id: set.id });

  // Undo through the agent: the account is archived, the payments count as ordinary ones again.
  const undoOp = { kind: 'undo', changeSetId: set.id };
  const undoPlan = await agent.call('plan_account_change', { op: undoOp });
  assert.equal(undoPlan.transfers.releasedTotal, 2);
  await agent.call('apply_account_change', { op: undoOp, planToken: undoPlan.planToken });
  assert.ok((await agent.call('search_transactions', {})).items.every((i: any) => i.ownTransfer === null));

  // Nothing the agent read contains the IBAN, spaced, compact or as its digits.
  for (const text of agent.texts) {
    assert.equal(text.includes(LOAN), false, text);
    assert.equal(text.includes(compact(LOAN)), false, text);
    assert.equal(text.includes(LOAN_DIGITS), false, text);
  }
  assert.equal((db.prepare('SELECT iban FROM accounts WHERE id = ?').get(set.accountId) as { iban: string }).iban, compact(LOAN));
});

test('an invalid IBAN is refused without echoing it', async () => {
  const agent = await connectAgent();
  const bad = 'FI00 1234 5600 0007 85';
  await assert.rejects(
    () => agent.call('plan_account_change', { op: { kind: 'create_account', name: 'x', type: 'savings', iban: bad } }),
    (err: Error) => /iban_invalid/.test(err.message) && !err.message.includes('1234')
  );
});

test('an agent records, reads and undoes a loan balance; net worth counts its share and no response has the IBAN', async () => {
  await importLoanPayments();
  const agent = await connectAgent();
  const create = { kind: 'create_account', name: 'Yhteinen asuntolaina', type: 'loan', ownershipShare: 50, iban: LOAN, updateIntervalDays: 30 };
  const created = await agent.call('apply_account_change', {
    op: create,
    planToken: (await agent.call('plan_account_change', { op: create })).planToken,
  });
  const loanId = created.accountId;

  // The debt is stated positive; the plan shows how it will be stored.
  const op = { kind: 'add_balance_observation', accountId: loanId, date: '2026-10-04', amount: 1000, note: 'lainan saldoilmoitus' };
  const plan = await agent.call('plan_account_change', { op });
  assert.equal(plan.observation.after.balance, -1000);
  assert.equal(plan.observation.after.debt, 1000);
  const set = await agent.call('apply_account_change', { op, planToken: plan.planToken });
  assert.equal(set.actor, 'agent-under-test');
  assert.equal(set.observation.after.actor, 'agent-under-test');

  const list = await agent.call('list_balance_observations', { accountId: loanId });
  assert.equal(list.observations.length, 1);
  assert.equal(list.observations[0].note, 'lainan saldoilmoitus');
  assert.equal(list.latest.debt, 1000);
  const listed = (await agent.call('list_accounts')).find((a: { id: string }) => a.id === loanId);
  assert.equal(listed.balance, -1000);
  assert.equal(listed.balanceSource, 'manual');
  assert.equal(typeof listed.stale, 'boolean');

  const nw = await agent.call('get_net_worth');
  const row = nw.accounts.find((a: { accountId: string }) => a.accountId === loanId);
  assert.equal(row.ownedBalance, -500);
  assert.ok(nw.coverage.includedAccountIds.includes(loanId));

  // The loan repayments stay cash flow; the observation changes no transaction.
  const search = await agent.call('search_transactions', {});
  assert.equal(search.items.length, 2);

  const undoOp = { kind: 'undo', changeSetId: set.id };
  await agent.call('apply_account_change', { op: undoOp, planToken: (await agent.call('plan_account_change', { op: undoOp })).planToken });
  assert.equal((await agent.call('list_balance_observations', { accountId: loanId })).observations.length, 0);

  for (const text of agent.texts) {
    assert.equal(text.includes(LOAN), false, text);
    assert.equal(text.includes(compact(LOAN)), false, text);
    assert.equal(text.includes(LOAN_DIGITS), false, text);
  }
});
