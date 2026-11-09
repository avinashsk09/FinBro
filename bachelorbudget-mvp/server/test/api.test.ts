import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { createApp, initializeDatabase } from '../src/index.js';
import { dateKeyLocal } from '../src/domain.js';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let sessionCookie = '';

before(async () => {
  db = new Database(':memory:');
  initializeDatabase(db);
  server = createApp(db).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test API did not bind to a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}/api`;
  const registration = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'primary@example.test', password: 'correct horse battery staple' }),
  });
  assert.equal(registration.status, 201);
  sessionCookie = registration.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(sessionCookie);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
});

async function request(path: string, init?: RequestInit, cookie = sessionCookie): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init?.headers ?? {}) },
  });
}

async function register(email: string) {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'another correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

test('health endpoint is available without a session', async () => {
  const response = await request('/health', undefined, '');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, app: 'BachelorBudget API' });
});

test('expense API validates, creates, edits, deletes, and reflects totals in dashboard summary', async () => {
  const today = dateKeyLocal();
  const emptyTransactions = await (await request('/transactions')).json() as unknown[];
  const initialSummary = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as {
    total: number; income: number; budget: number; remaining: number | null; dailyLimit: number | null;
    categoryBudgetAmounts: Record<string, number>;
  };
  assert.deepEqual(emptyTransactions, []);
  assert.equal(initialSummary.total, 0);
  assert.equal(initialSummary.income, 0);
  assert.equal(initialSummary.budget, 0);
  assert.equal(initialSummary.remaining, null);
  assert.equal(initialSummary.dailyLimit, null);
  assert.deepEqual(initialSummary.categoryBudgetAmounts, {});
  const initialSettings = await (await request('/settings')).json() as { monthlyBudget: number; preferredCurrency: string };
  assert.equal(initialSettings.monthlyBudget, 0);
  assert.equal(initialSettings.preferredCurrency, 'INR');

  const invalid = await request('/expenses', {
    method: 'POST',
    body: JSON.stringify({ title: '', amount: -1, currency: 'INR', category: 'Food', date: '2026-02-31' }),
  });
  assert.equal(invalid.status, 400);

  const created = await request('/expenses', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Lunch', amount: 120.5, currency: 'INR', category: 'Food', date: today, shared: false,
    }),
  });
  assert.equal(created.status, 201);
  const expense = await created.json() as { id: number };
  const income = await request('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Allowance', amount: 500, currency: 'INR', category: 'Allowance', date: today, type: 'income',
    }),
  });
  assert.equal(income.status, 201);
  assert.equal((await (await request('/expenses')).json() as unknown[]).length, 1);
  assert.equal((await (await request('/transactions')).json() as unknown[]).length, 2);
  assert.equal((await request('/expenses', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Unsupported income alias', amount: 10, currency: 'INR', category: 'Other income', date: today, type: 'income',
    }),
  })).status, 400);
  const summaryBefore = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as { total: number; income: number };
  assert.equal(summaryBefore.total, 120.5);
  assert.equal(summaryBefore.income, 500);
  const saveBudget = await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ monthlyBudget: 1000, baseCurrency: 'INR' }),
  });
  assert.equal(saveBudget.status, 200);
  const summaryWithBudget = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as {
    total: number; budget: number; remaining: number | null;
  };
  assert.equal(summaryWithBudget.budget, 1000);
  assert.equal(summaryWithBudget.remaining, 879.5);

  const updated = await request(`/expenses/${expense.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: 'Dinner', amount: 200, currency: 'INR', category: 'Food', date: today, shared: false,
    }),
  });
  assert.equal(updated.status, 200);
  const summaryAfterEdit = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as {
    total: number; remaining: number | null;
  };
  assert.equal(summaryAfterEdit.total, 200);
  assert.equal(summaryAfterEdit.remaining, 800);

  assert.equal((await request(`/expenses/${expense.id}`, { method: 'DELETE' })).status, 204);
  const summaryAfterDelete = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as {
    total: number; income: number; remaining: number | null;
  };
  assert.equal(summaryAfterDelete.total, 0);
  assert.equal(summaryAfterDelete.income, 500);
  assert.equal(summaryAfterDelete.remaining, 1000);
});

test('shared custom splits preserve original bill values and expose the personal share and settlements', async () => {
  const today = dateKeyLocal();
  const created = await request('/expenses', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Shared groceries', amount: 90, currency: 'INR', category: 'Groceries', date: today,
      shared: true, payer: 'Me', people: ['Ari', 'Sam'], splitMethod: 'custom',
      shares: [{ name: 'Me', amount: 30 }, { name: 'Ari', amount: 20 }, { name: 'Sam', amount: 40 }],
    }),
  });
  assert.equal(created.status, 201);
  const expense = await created.json() as { amount: number; shares: Array<{ amount: number }> };
  assert.equal(expense.amount, 90);
  assert.deepEqual(expense.shares.map(share => share.amount), [30, 20, 40]);
  const summary = await (await request(`/summary?month=${today.slice(0, 7)}`)).json() as { total: number };
  assert.equal(summary.total, 30);
  const settlements = await (await request(`/settlements?month=${today.slice(0, 7)}`)).json() as {
    settlements: Array<{
      from: string; to: string; amount: number; currency: string; householdId: number | null; householdName: string | null;
    }>;
  };
  assert.deepEqual(settlements.settlements, [
    { from: 'Ari', to: 'Me', amount: 20, currency: 'INR', householdId: null, householdName: null },
    { from: 'Sam', to: 'Me', amount: 40, currency: 'INR', householdId: null, householdName: null },
  ]);
  const invalidSplit = await request('/expenses', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Bad split', amount: 90, currency: 'INR', category: 'Groceries', date: today,
      shared: true, people: ['Ari'], splitMethod: 'custom',
      shares: [{ name: 'Me', amount: 10 }, { name: 'Ari', amount: 20 }],
    }),
  });
  assert.equal(invalidSplit.status, 400);
});

test('goal, settings, category budget, and filtered CSV endpoints validate and persist values', async () => {
  const goal = await request('/goals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Trip', target: 500, saved: 600, currency: 'USD' }),
  });
  assert.equal(goal.status, 400);
  const createdGoal = await request('/goals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Trip', target: 500, saved: 100, currency: 'USD' }),
  });
  assert.equal(createdGoal.status, 201);
  const goalJson = await createdGoal.json() as { id: number };
  assert.equal((await request(`/goals/${goalJson.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Trip fund', target: 600, saved: 200, currency: 'USD' }),
  })).status, 200);
  assert.equal((await request(`/goals/${goalJson.id}`, { method: 'DELETE' })).status, 204);

  const invalidSettings = await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ monthlyBudget: 1000, currency: 'USD' }),
  });
  assert.equal(invalidSettings.status, 400);
  const savedSettings = await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({
      monthlyBudget: 20000, baseCurrency: 'INR', warningThreshold: 85,
      username: 'Taylor', preferredCurrency: 'USD',
    }),
  });
  assert.equal(savedSettings.status, 200);
  const profileSettings = await (await request('/settings')).json() as {
    username: string; preferredCurrency: string; monthlyBudget: number;
  };
  assert.equal(profileSettings.username, 'Taylor');
  assert.equal(profileSettings.preferredCurrency, 'USD');
  assert.equal(profileSettings.monthlyBudget, 20000);

  const month = dateKeyLocal().slice(0, 7);
  assert.equal((await request('/budgets', {
    method: 'PUT',
    body: JSON.stringify({ month, category: 'Groceries', amount: 3000 }),
  })).status, 200);
  const budgetRows = await (await request(`/budgets?month=${month}`)).json() as Array<{ amount: number }>;
  assert.equal(budgetRows[0].amount, 3000);
  const csvResponse = await request('/export.csv?category=Groceries');
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /description,amount,currency,type,category/);
  assert.match(csv, /Shared groceries/);
});

test('accounts compute current balances from opening amounts and transactions; transfers stay outside budgets', async () => {
  const summaryUrl = `/summary?month=${dateKeyLocal().slice(0, 7)}`;
  const summaryBefore = await (await request(summaryUrl)).json() as { total: number; income: number };
  const createAccount = async (name: string, currency: string, openingBalance: number) => {
    const response = await request('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, currency, openingBalance, openingDate: dateKeyLocal() }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ id: number }>;
  };
  const cash = await createAccount('Test cash', 'INR', 1000);
  const bank = await createAccount('Test bank', 'INR', 0);
  const foreign = await createAccount('Test USD', 'USD', 50);
  for (const transaction of [
    { title: 'Cash purchase', amount: 100, type: 'expense' },
    { title: 'Cash received', amount: 25, type: 'income' },
  ]) {
    assert.equal((await request('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        ...transaction, currency: 'INR', category: 'Other', date: dateKeyLocal(), accountId: cash.id,
      }),
    })).status, 201);
  }
  assert.equal((await request('/transactions', {
    method: 'POST',
    body: JSON.stringify({ title: 'Wrong currency account', amount: 10, currency: 'USD', category: 'Other', date: dateKeyLocal(), accountId: cash.id }),
  })).status, 400);
  assert.equal((await request('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Future transaction', amount: 700, currency: 'INR', category: 'Other',
      date: '2099-12-31', accountId: cash.id,
    }),
  })).status, 201);
  const transfer = await request('/transfers', {
    method: 'POST',
    body: JSON.stringify({ fromAccountId: cash.id, toAccountId: bank.id, amount: 100, date: dateKeyLocal(), note: 'Move cash' }),
  });
  assert.equal(transfer.status, 201);
  assert.equal((await request('/transfers', {
    method: 'POST',
    body: JSON.stringify({ fromAccountId: cash.id, toAccountId: foreign.id, amount: 1, date: dateKeyLocal() }),
  })).status, 400);
  const accounts = await (await request('/accounts')).json() as Array<{ id: number; currentBalance: number }>;
  assert.equal(accounts.find(account => account.id === cash.id)?.currentBalance, 825);
  assert.equal(accounts.find(account => account.id === bank.id)?.currentBalance, 100);
  assert.equal(accounts.find(account => account.id === foreign.id)?.currentBalance, 50);
  const summary = await (await request(summaryUrl)).json() as { total: number; income: number; byCategory: Record<string, number> };
  assert.equal(summary.total - summaryBefore.total, 100);
  assert.equal(summary.income - summaryBefore.income, 25);
  assert.equal(summary.byCategory.Other, 100);
  assert.equal((await request(`/accounts/${cash.id}`, { method: 'DELETE' })).status, 409);
});

test('households can be created locally without enabling multi-user synchronization', async () => {
  const createHousehold = async (name: string) => {
    const result = await request('/households', {
      method: 'POST',
      body: JSON.stringify({ name, members: ['Ari'] }),
    });
    assert.equal(result.status, 201);
    return result.json() as Promise<{ id: number; members: string[] }>;
  };
  const first = await createHousehold('Flat 2B');
  const second = await createHousehold('Flat 3C');
  assert.deepEqual(first.members, ['Me', 'Ari']);

  const today = dateKeyLocal();
  for (const [householdId, payer] of [[first.id, 'Me'], [second.id, 'Ari']] as const) {
    assert.equal((await request('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        title: `Household bill ${householdId}`, amount: 20, currency: 'INR', category: 'Rent / PG', date: today,
        shared: true, payer, people: ['Ari'], householdId, splitMethod: 'equal',
      }),
    })).status, 201);
  }
  const result = await (await request(`/settlements?month=${today.slice(0, 7)}`)).json() as {
    settlements: Array<{ from: string; to: string; householdName: string; amount: number }>;
  };
  const householdSettlements = result.settlements.filter(settlement => ['Flat 2B', 'Flat 3C'].includes(settlement.householdName));
  assert.deepEqual(householdSettlements.map(({ householdName, from, to, amount }) => ({ householdName, from, to, amount })), [
    { householdName: 'Flat 2B', from: 'Ari', to: 'Me', amount: 10 },
    { householdName: 'Flat 3C', from: 'Me', to: 'Ari', amount: 10 },
  ]);
});

test('household invitations require the matching account, expire, and grant persisted shared-bill visibility', async () => {
  const createdHousehold = await request('/households', {
    method: 'POST',
    body: JSON.stringify({ name: 'Invite-only home', members: ['Me'] }),
  });
  assert.equal(createdHousehold.status, 201);
  const householdId = (await createdHousehold.json() as { id: number }).id;
  const createdInvite = await request(`/households/${householdId}/invitations`, {
    method: 'POST',
    body: JSON.stringify({ email: 'roommate@example.test' }),
  });
  assert.equal(createdInvite.status, 201);
  const invite = await createdInvite.json() as { invitationToken: string };
  const roomieCookie = await register('roommate@example.test');
  assert.equal((await request('/households/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ invitationToken: invite.invitationToken }),
  }, roomieCookie)).status, 200);
  assert.equal((await request('/households/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ invitationToken: invite.invitationToken }),
  }, roomieCookie)).status, 404);
  const memberHouseholds = await (await request('/households', undefined, roomieCookie)).json() as Array<{ id: number; my_role: string }>;
  assert.ok(memberHouseholds.some(household => household.id === householdId && household.my_role === 'member'));

  const bill = await request('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Internet shared bill', amount: 60, currency: 'INR', category: 'Utilities', date: dateKeyLocal(),
      shared: true, householdId, people: ['roommate@example.test'], payer: 'Me', splitMethod: 'equal',
    }),
  });
  assert.equal(bill.status, 201);
  const billId = (await bill.json() as { id: number }).id;
  const memberTransactions = await (await request('/transactions', undefined, roomieCookie)).json() as Array<{ id: number }>;
  assert.deepEqual(memberTransactions.map(transaction => transaction.id), [billId]);
  const memberSummary = await (await request(`/summary?month=${dateKeyLocal().slice(0, 7)}`, undefined, roomieCookie)).json() as { total: number };
  assert.equal(memberSummary.total, 30);
  assert.equal((await request(`/transactions/${billId}`, {
    method: 'DELETE',
  }, roomieCookie)).status, 404);

  const expiring = await request(`/households/${householdId}/invitations`, {
    method: 'POST',
    body: JSON.stringify({ email: 'soon@example.test' }),
  });
  const expiringToken = (await expiring.json() as { invitationToken: string }).invitationToken;
  db.prepare('UPDATE household_invitations SET expires_at=? WHERE token_hash=?')
    .run(Date.now() - 1, createHash('sha256').update(expiringToken).digest('hex'));
  const soonCookie = await register('soon@example.test');
  assert.equal((await request('/households/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ invitationToken: expiringToken }),
  }, soonCookie)).status, 404);
});

test('schema v2 upgrade adds transaction type fields without dropping existing records', () => {
  const legacy = new Database(':memory:');
  legacy.exec(`
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR', category TEXT NOT NULL, date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0,
      people TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payer TEXT NOT NULL DEFAULT 'Me', split_method TEXT NOT NULL DEFAULT 'equal',
      shares TEXT NOT NULL DEFAULT '[]', household_id INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, target REAL NOT NULL, saved REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'INR', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE households (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', UNIQUE(month, category));
    INSERT INTO settings(key,value) VALUES('monthlyBudget','5000');
    INSERT INTO budgets(month,category,amount) VALUES('2026-10','Food',250);
    INSERT INTO expenses(title,amount,category,date) VALUES('Existing local record',25,'Food','2026-10-01');
    PRAGMA user_version=2;
  `);
  initializeDatabase(legacy);
  const saved = legacy.prepare('SELECT title, type, source, updated_at FROM expenses WHERE id=1').get() as {
    title: string; type: string; source: string; updated_at: string;
  };
  assert.equal(legacy.pragma('user_version', { simple: true }), 8);
  assert.equal(saved.title, 'Existing local record');
  assert.equal(saved.type, 'expense');
  assert.equal(saved.source, 'manual');
  assert.ok(saved.updated_at);
  assert.equal((legacy.prepare("SELECT value FROM settings WHERE key='monthlyBudget'").get() as { value: string }).value, '5000');
  assert.equal((legacy.prepare("SELECT amount FROM budgets WHERE month='2026-10' AND category='Food'").get() as { amount: number }).amount, 250);
  legacy.close();
});

test('CSV imports preview validated rows, preserve data, and skip a repeated file', async () => {
  const csv = [
    'date,description,amount,currency,category,type,notes',
    '2026-10-05,"Coffee, with oat milk",-25.50,INR,Food,expense,"office, meeting"',
    '2026-10-06,Monthly allowance,1000,INR,Allowance,income,',
  ].join('\r\n');
  const previewResponse = await request('/imports/csv/preview', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as { batchToken: string; validCount: number; rows: Array<{ title: string; amount: number }> };
  assert.equal(preview.validCount, 2);
  assert.equal(preview.rows[0].title, 'Coffee, with oat milk');
  assert.equal(preview.rows[0].amount, 25.5);
  const confirmation = await request('/imports/csv/confirm', {
    method: 'POST',
    body: JSON.stringify({ batchToken: preview.batchToken }),
  });
  assert.deepEqual(await confirmation.json(), { imported: 2, duplicates: 0 });

  const repeatPreview = await request('/imports/csv/preview', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
  const repeat = await repeatPreview.json() as { batchToken: string };
  const repeatConfirmation = await request('/imports/csv/confirm', {
    method: 'POST',
    body: JSON.stringify({ batchToken: repeat.batchToken }),
  });
  assert.deepEqual(await repeatConfirmation.json(), { imported: 0, duplicates: 2 });
  assert.equal((await request('/imports/csv/confirm', {
    method: 'POST',
    body: JSON.stringify({ batchToken: repeat.batchToken }),
  })).status, 404);
});

test('FX conversion uses a configured dated provider and reports stale-cache fallback', async () => {
  const previousUrl = process.env.FX_API_URL;
  const rateServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ base: 'INR', date: '2026-10-19', rates: { USD: 0.01 } }));
  });
  rateServer.listen(0);
  await new Promise<void>(resolve => rateServer.once('listening', resolve));
  const address = rateServer.address();
  if (!address || typeof address === 'string') throw new Error('FX test provider did not bind to a TCP port');
  const providerUrl = `http://127.0.0.1:${address.port}`;
  process.env.FX_API_URL = providerUrl;
  try {
    const month = dateKeyLocal().slice(0, 7);
    const budgetResponse = await request('/budgets', {
      method: 'PUT',
      body: JSON.stringify({ month, category: 'Food', amount: 1000 }),
    });
    assert.equal(budgetResponse.status, 200);
    const response = await request(`/summary?month=${month}&currency=USD`);
    assert.equal(response.status, 200);
    const summary = await response.json() as {
      rateSource: string; rateDate: string; rateFetchedAt: number; rateNote: string;
      categoryBudgetAmounts: Record<string, number>;
    };
    assert.equal(summary.rateSource, providerUrl);
    assert.equal(summary.rateDate, '2026-10-19');
    assert.ok(summary.rateFetchedAt > 0);
    assert.equal(summary.categoryBudgetAmounts.Food, 10);
    assert.doesNotMatch(summary.rateNote, /illustrative|demo rate/i);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM exchange_rates WHERE currency IN ('INR','USD')").get() as { count: number }).count, 2);

    db.prepare('UPDATE exchange_rates SET fetched_at=0 WHERE currency IN (?,?)').run('INR', 'USD');
    await new Promise<void>((resolve, reject) => rateServer.close(error => error ? reject(error) : resolve()));
    const staleResponse = await request(`/summary?month=${month}&currency=USD`);
    assert.equal(staleResponse.status, 200);
    const staleSummary = await staleResponse.json() as { rateNote: string };
    assert.match(staleSummary.rateNote, /stale cached rates/i);
  } finally {
    if (rateServer.listening) await new Promise<void>(resolve => rateServer.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.FX_API_URL;
    else process.env.FX_API_URL = previousUrl;
  }
});

test('auth requires a session, isolates each user’s records, and rejects expired sessions', async () => {
  assert.equal((await request('/transactions', undefined, '')).status, 401);
  const shortPassword = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'short-password@example.test', password: 'abc1234' }),
  });
  assert.equal(shortPassword.status, 400);
  const mediumPassword = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'medium-password@example.test', password: 'abcdefgh' }),
  });
  assert.equal(mediumPassword.status, 201);
  const mediumCookie = mediumPassword.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(mediumCookie);
  assert.equal((await request('/settings', undefined, mediumCookie)).status, 200);
  const savedProfile = await request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ monthlyBudget: 0, username: 'Casey', preferredCurrency: 'EUR' }),
  }, mediumCookie);
  assert.equal(savedProfile.status, 200);
  const profile = await (await request('/settings', undefined, mediumCookie)).json() as {
    username: string; preferredCurrency: string;
  };
  assert.equal(profile.username, 'Casey');
  assert.equal(profile.preferredCurrency, 'EUR');
  assert.deepEqual(await (await request('/transactions', undefined, mediumCookie)).json(), []);

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'primary@example.test', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const primaryCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(primaryCookie);
  const primarySettings = await (await request('/settings', undefined, primaryCookie)).json() as {
    username: string; preferredCurrency: string;
  };
  assert.equal(primarySettings.username, 'Taylor');
  assert.equal(primarySettings.preferredCurrency, 'USD');
  assert.equal((await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'medium-password@example.test', password: 'abcdefgh' }),
  })).status, 200);

  const created = await request('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Private transaction', amount: 77, currency: 'INR', category: 'Food', date: dateKeyLocal(),
    }),
  }, primaryCookie);
  assert.equal(created.status, 201);
  const transactionId = (await created.json() as { id: number }).id;
  const otherCookie = await register('other@example.test');
  assert.deepEqual(await (await request('/transactions', undefined, otherCookie)).json(), []);
  assert.equal((await request(`/transactions/${transactionId}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: 'Attempted takeover', amount: 1, currency: 'INR', category: 'Food', date: dateKeyLocal(),
    }),
  }, otherCookie)).status, 404);
  assert.equal((await request(`/transactions/${transactionId}`, { method: 'DELETE' }, otherCookie)).status, 404);

  const rawToken = decodeURIComponent(otherCookie.slice(otherCookie.indexOf('=') + 1));
  const digest = createHash('sha256').update(rawToken).digest('hex');
  db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, digest);
  assert.equal((await request('/auth/me', undefined, otherCookie)).status, 401);

  const logoutCookie = await register('logout@example.test');
  assert.equal((await request('/auth/logout', { method: 'POST' }, logoutCookie)).status, 204);
  assert.equal((await request('/transactions', undefined, logoutCookie)).status, 401);
});

test('users, sessions, and transactions persist after reopening the SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bachelorbudget-persistence-'));
  const databasePath = join(directory, 'budget.sqlite');
  let persistentDb: Database.Database | undefined;
  let persistentServer: Server | undefined;

  try {
    persistentDb = new Database(databasePath);
    initializeDatabase(persistentDb);
    persistentServer = createApp(persistentDb).listen(0);
    await new Promise<void>(resolve => persistentServer!.once('listening', resolve));
    const firstAddress = persistentServer.address();
    if (!firstAddress || typeof firstAddress === 'string') throw new Error('Persistence test API did not bind to a TCP port');
    const firstApi = `http://127.0.0.1:${firstAddress.port}/api`;
    const registration = await fetch(`${firstApi}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'persistent@example.test', password: 'persistent test password' }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(cookie);
    const created = await fetch(`${firstApi}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        title: 'Persisted lunch', amount: 12.34, currency: 'INR', category: 'Food', date: dateKeyLocal(),
      }),
    });
    assert.equal(created.status, 201);

    await new Promise<void>((resolve, reject) => persistentServer!.close(error => error ? reject(error) : resolve()));
    persistentServer = undefined;
    persistentDb.close();
    persistentDb = undefined;

    persistentDb = new Database(databasePath);
    initializeDatabase(persistentDb);
    persistentServer = createApp(persistentDb).listen(0);
    await new Promise<void>(resolve => persistentServer!.once('listening', resolve));
    const secondAddress = persistentServer.address();
    if (!secondAddress || typeof secondAddress === 'string') throw new Error('Restarted persistence API did not bind to a TCP port');
    const secondApi = `http://127.0.0.1:${secondAddress.port}/api`;

    const session = await fetch(`${secondApi}/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const transactions = await fetch(`${secondApi}/transactions`, { headers: { Cookie: cookie } });
    assert.equal(transactions.status, 200);
    assert.deepEqual(await transactions.json().then(rows => (rows as Array<{ title: string; amount: number }>).map(row => ({
      title: row.title, amount: row.amount,
    }))), [{ title: 'Persisted lunch', amount: 12.34 }]);
  } finally {
    if (persistentServer?.listening) {
      await new Promise<void>((resolve, reject) => persistentServer!.close(error => error ? reject(error) : resolve()));
    }
    if (persistentDb?.open) persistentDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
