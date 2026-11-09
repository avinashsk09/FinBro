import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMonthlySpending,
  calculateSettlements,
  convertCurrency,
  daysRemainingInMonth,
  getBudgetStatus,
  splitEqual,
  validateShares,
} from '../src/domain.js';

const testRates = {
  toBase(amount: number, currency: 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'CAD' | 'AUD') {
    const fixture: Record<typeof currency, number> = { INR: 1, USD: 83, EUR: 90, GBP: 105, AED: 22.6, CAD: 61, AUD: 54.5 };
    return amount * fixture[currency];
  },
};

test('currency conversion uses the injected provider and rounds to cents', () => {
  assert.equal(convertCurrency(10, 'USD', 'INR', testRates), 830);
  assert.equal(convertCurrency(83, 'INR', 'USD', testRates), 1);
  assert.equal(convertCurrency(1, 'GBP', 'USD', testRates), 1.27);
});

test('month-end daily guidance includes the current day and handles leap years', () => {
  assert.equal(daysRemainingInMonth(new Date(2024, 1, 29)), 1);
  assert.equal(daysRemainingInMonth(new Date(2026, 9, 19)), 13);
});

test('budget thresholds distinguish normal, warning, and limit states', () => {
  assert.equal(getBudgetStatus(79, 100, 80), 'ok');
  assert.equal(getBudgetStatus(80, 100, 80), 'warning');
  assert.equal(getBudgetStatus(100, 100, 80), 'limit');
});

test('monthly spending applies month bounds, currency conversion, and only the local share of shared bills', () => {
  const result = calculateMonthlySpending([
    { date: '2026-10-04', amount: 83, currency: 'INR', category: 'Food', shared: false, shares: [], people: [] },
    {
      date: '2026-10-06', amount: 90, currency: 'INR', category: 'Groceries', shared: true,
      shares: [{ name: 'Me', amount: 30 }, { name: 'Ari', amount: 30 }, { name: 'Sam', amount: 30 }],
      people: ['Ari', 'Sam'],
    },
    { date: '2026-11-01', amount: 500, currency: 'INR', category: 'Food', shared: false, shares: [], people: [] },
  ], '2026-10', 'USD', testRates);
  assert.equal(result.total, 1.36);
  assert.deepEqual(result.byCategory, { Food: 1, Groceries: 0.36 });
});

test('monthly income is reported separately and never included in expense categories or spending totals', () => {
  const result = calculateMonthlySpending([
    { date: '2026-10-01', amount: 30000, currency: 'INR', category: 'Salary', shared: false, shares: [], people: [], type: 'income' },
    { date: '2026-10-04', amount: 1200, currency: 'INR', category: 'Food', shared: false, shares: [], people: [], type: 'expense' },
  ], '2026-10', 'INR', testRates);
  assert.equal(result.total, 1200);
  assert.equal(result.income, 30000);
  assert.deepEqual(result.byCategory, { Food: 1200 });
});

test('monthly spending rounds repeated decimal amounts to cents', () => {
  const result = calculateMonthlySpending([
    { date: '2026-10-01', amount: 0.1, currency: 'INR', category: 'Other', shared: false, shares: [], people: [] },
    { date: '2026-10-02', amount: 0.2, currency: 'INR', category: 'Other', shared: false, shares: [], people: [] },
  ], '2026-10', 'INR', testRates);
  assert.equal(result.total, 0.3);
  assert.deepEqual(result.byCategory, { Other: 0.3 });
});

test('equal splits distribute remainder cents and custom shares must balance exactly', () => {
  const shares = splitEqual(10, ['Me', 'Roommate 1', 'Roommate 2']);
  assert.deepEqual(shares.map(share => share.amount), [3.34, 3.33, 3.33]);
  assert.equal(validateShares(10, shares), true);
  assert.equal(validateShares(10, [...shares, { name: 'Other', amount: 0.01 }]), false);
});

test('settlements net each participant share against what they paid', () => {
  const settlements = calculateSettlements([{
    amount: 90,
    payer: 'Me',
    shares: [
      { name: 'Me', amount: 30 },
      { name: 'Ari', amount: 30 },
      { name: 'Sam', amount: 30 },
    ],
  }]);
  assert.deepEqual(settlements, [
    { from: 'Ari', to: 'Me', amount: 30 },
    { from: 'Sam', to: 'Me', amount: 30 },
  ]);
});
