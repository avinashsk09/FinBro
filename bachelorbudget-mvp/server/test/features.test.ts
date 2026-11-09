import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { type Server } from 'node:http';
import { createApp, initializeDatabase } from '../src/index.js';

test('category limits, quick presets, and batch operations API', async () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const server: Server = createApp(db).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  try {
    // Register
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com', password: 'Password123!' }),
    });
    assert.equal(regRes.status, 201);
    const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    // Quick presets auto-seed
    const presetsRes = await fetch(`${baseUrl}/presets`, {
      headers: { Cookie: cookie },
    });
    assert.equal(presetsRes.status, 200);
    const presets = await presetsRes.json() as Array<{ title: string; amount: number }>;
    assert.ok(presets.length > 0);

    // Create custom preset
    const createPreset = await fetch(`${baseUrl}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Special Tea', amount: 25, category: 'Food & drinks', paymentMode: 'UPI' }),
    });
    assert.equal(createPreset.status, 201);
    const newPreset = await createPreset.json() as { id: number; title: string };
    assert.equal(newPreset.title, 'Special Tea');

    // Create category limit
    const createLimit = await fetch(`${baseUrl}/limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ category: 'Food & drinks', amountLimit: 500, frequencyLimit: 10 }),
    });
    assert.equal(createLimit.status, 201);
    const newLimit = await createLimit.json() as { id: number; amountLimit: number };
    assert.equal(newLimit.amountLimit, 500);

    // Get limits list
    const getLimits = await fetch(`${baseUrl}/limits`, {
      headers: { Cookie: cookie },
    });
    assert.equal(getLimits.status, 200);
    const limitsList = await getLimits.json() as Array<{ category: string; amountLimit: number }>;
    assert.ok(limitsList.some(l => l.category === 'Food & drinks'));

    // Create 2 transactions for batch testing
    const tx1Res = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Item 1', amount: 100, currency: 'INR', category: 'Food & drinks', date: '2026-11-04', paymentMode: 'Cash' }),
    });
    const tx1 = await tx1Res.json() as { id: number; paymentMode: string };

    const tx2Res = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Item 2', amount: 200, currency: 'INR', category: 'Food & drinks', date: '2026-11-04', paymentMode: 'Cash' }),
    });
    const tx2 = await tx2Res.json() as { id: number; paymentMode: string };

    // Batch update payment mode to UPI
    const batchRes = await fetch(`${baseUrl}/transactions/batch-payment-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ids: [tx1.id, tx2.id], paymentMode: 'UPI' }),
    });
    assert.equal(batchRes.status, 200);

    // Toggle split
    const toggleRes = await fetch(`${baseUrl}/transactions/${tx1.id}/toggle-split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ shared: true, people: ['Roomie'] }),
    });
    assert.equal(toggleRes.status, 200);
    const toggled = await toggleRes.json() as { shared: boolean; people: string[] };
    assert.equal(toggled.shared, true);
    assert.deepEqual(toggled.people, ['Roomie']);

    // Batch delete
    const delBatchRes = await fetch(`${baseUrl}/transactions/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ids: [tx1.id, tx2.id] }),
    });
    assert.equal(delBatchRes.status, 200);

    // Telegram sync code
    const codeRes = await fetch(`${baseUrl}/telegram/code`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(codeRes.status, 200);
    const codeData = await codeRes.json() as { code: string };
    assert.match(codeData.code, /^\d{6}$/);

    // Telegram webhook sync
    const webhookRes = await fetch(`${baseUrl}/telegram-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 998877, username: 'testuser', first_name: 'Test' },
          text: `/start ${codeData.code}`,
        },
      }),
    });
    assert.equal(webhookRes.status, 200);
    const webhookData = await webhookRes.json() as { ok: boolean; linked?: boolean };
    assert.equal(webhookData.ok, true);
    assert.equal(webhookData.linked, true);

    // Verify Telegram status
    const statusRes = await fetch(`${baseUrl}/telegram/status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json() as { connected: boolean; telegramUsername: string };
    assert.equal(statusData.connected, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});
