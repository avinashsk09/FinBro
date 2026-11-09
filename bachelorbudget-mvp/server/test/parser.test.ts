import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalSpend } from '../src/parser.js';
import { splitPercentage, validatePercentages } from '../src/domain.js';

test('parseNaturalSpend parses simple expense with amount and food item', () => {
  const result = parseNaturalSpend('140 biryani upi');
  assert.equal(result.valid, true);
  assert.equal(result.amount, 140);
  assert.equal(result.category, 'Food & drinks');
  assert.equal(result.paymentMode, 'UPI');
  assert.match(result.title.toLowerCase(), /biryani/);
  assert.equal(result.shared, false);
});

test('parseNaturalSpend parses split expense with roommate name', () => {
  const result = parseNaturalSpend('600 wifi split rahul');
  assert.equal(result.valid, true);
  assert.equal(result.amount, 600);
  assert.equal(result.category, 'Utilities');
  assert.equal(result.shared, true);
  assert.deepEqual(result.people, ['Rahul']);
});

test('parseNaturalSpend parses cash transport with currency symbol', () => {
  const result = parseNaturalSpend('₹50 auto cash');
  assert.equal(result.valid, true);
  assert.equal(result.amount, 50);
  assert.equal(result.category, 'Transport');
  assert.equal(result.paymentMode, 'Cash');
});

test('parseNaturalSpend recognizes UPI app names like GPay and PhonePe', () => {
  const result = parseNaturalSpend('250 pizza gpay');
  assert.equal(result.valid, true);
  assert.equal(result.amount, 250);
  assert.equal(result.paymentMode, 'UPI');
  assert.equal(result.upiApp, 'GPay');
});

test('parseNaturalSpend recognizes yesterday date keyword', () => {
  const result = parseNaturalSpend('1200 room rent card yesterday');
  assert.equal(result.valid, true);
  assert.equal(result.amount, 1200);
  assert.equal(result.category, 'Rent / PG');
  assert.equal(result.paymentMode, 'Debit Card');
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const expectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(result.date, expectedDate);
});

test('parseNaturalSpend handles unparseable string gracefully without throwing', () => {
  const result = parseNaturalSpend('just some random text without number');
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test('percentage splits validate and balance exact cents without rounding gaps', () => {
  assert.equal(validatePercentages([
    { name: 'Me', percent: 60 },
    { name: 'Arjun', percent: 40 },
  ]), true);

  assert.equal(validatePercentages([
    { name: 'Me', percent: 50 },
    { name: 'Arjun', percent: 40 },
  ]), false);

  // Total 100 with 33.33%, 33.33%, 33.34%
  const shares = splitPercentage(100, [
    { name: 'Me', percent: 33.33 },
    { name: 'Arjun', percent: 33.33 },
    { name: 'Ravi', percent: 33.34 },
  ]);
  assert.equal(shares.length, 3);
  const total = shares.reduce((sum, s) => sum + s.amount, 0);
  assert.equal(Math.round(total * 100) / 100, 100);
});

