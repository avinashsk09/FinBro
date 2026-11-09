export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_MODES = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Wallet'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const UPI_APPS = ['GPay', 'PhonePe', 'Paytm', 'BHIM', 'Cred', 'Other'] as const;
export type UpiApp = (typeof UPI_APPS)[number];

export interface ExchangeRateProvider {
  toBase(amount: number, currency: Currency): number;
}

export function convertCurrency(
  amount: number,
  from: Currency,
  to: Currency,
  provider: ExchangeRateProvider,
): number {
  if (!Number.isFinite(amount)) throw new Error('Amount must be finite');
  const inBase = provider.toBase(amount, from);
  const converted = inBase / provider.toBase(1, to);
  return Math.round((converted + Number.EPSILON) * 100) / 100;
}

export interface ParticipantShare {
  name: string;
  amount: number;
}

export function splitEqual(total: number, names: string[]): ParticipantShare[] {
  const uniqueNames = [...new Set(names.map(name => name.trim()).filter(Boolean))];
  if (!Number.isFinite(total) || total < 0 || uniqueNames.length === 0) {
    throw new Error('A non-negative total and at least one participant are required');
  }
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / uniqueNames.length);
  const remainder = cents - each * uniqueNames.length;
  return uniqueNames.map((name, index) => ({
    name,
    amount: (each + (index < remainder ? 1 : 0)) / 100,
  }));
}

export function validateShares(total: number, shares: ParticipantShare[]): boolean {
  if (shares.length === 0 || shares.some(s => !s.name.trim() || !Number.isFinite(s.amount) || s.amount < 0)) {
    return false;
  }
  const names = shares.map(s => s.name.trim().toLowerCase());
  return new Set(names).size === names.length
    && Math.round(shares.reduce((sum, s) => sum + s.amount, 0) * 100) === Math.round(total * 100);
}

export interface ParticipantPercentage {
  name: string;
  percent: number;
}

export function validatePercentages(percentages: ParticipantPercentage[]): boolean {
  if (percentages.length === 0 || percentages.some(p => !p.name.trim() || !Number.isFinite(p.percent) || p.percent < 0)) {
    return false;
  }
  const names = percentages.map(p => p.name.trim().toLowerCase());
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) return false;
  const totalPercent = Math.round(percentages.reduce((sum, p) => sum + p.percent, 0) * 100) / 100;
  return Math.abs(totalPercent - 100) < 0.01;
}

export function splitPercentage(total: number, percentages: ParticipantPercentage[]): ParticipantShare[] {
  if (!Number.isFinite(total) || total < 0 || percentages.length === 0) {
    throw new Error('A non-negative total and valid percentages are required');
  }
  if (!validatePercentages(percentages)) {
    throw new Error('Percentages must sum to 100%');
  }
  const cents = Math.round(total * 100);
  let allocated = 0;
  const shares: ParticipantShare[] = [];
  for (let i = 0; i < percentages.length; i++) {
    const p = percentages[i];
    if (i === percentages.length - 1) {
      const shareCents = cents - allocated;
      shares.push({ name: p.name.trim(), amount: Math.round(shareCents) / 100 });
    } else {
      const shareCents = Math.round((cents * p.percent) / 100);
      allocated += shareCents;
      shares.push({ name: p.name.trim(), amount: shareCents / 100 });
    }
  }
  return shares;
}

export function daysRemainingInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() - date.getDate() + 1;
}

export function getBudgetStatus(spent: number, budget: number, warningThreshold = 80): 'ok' | 'warning' | 'limit' {
  if (budget <= 0) return 'ok';
  const percent = spent / budget * 100;
  if (percent >= 100) return 'limit';
  return percent >= warningThreshold ? 'warning' : 'ok';
}

export function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM format');
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}` };
}

export function dateKeyLocal(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function personalShare(
  amount: number,
  shared: boolean,
  shares: ParticipantShare[],
  legacyPeople: string[] = [],
  participantName = 'Me',
): number {
  if (!shared) return amount;
  if (shares.length) return shares.find(share => share.name.toLowerCase() === participantName.toLowerCase())?.amount ?? 0;
  if (participantName.toLowerCase() !== 'me') return 0;
  return splitEqual(amount, ['Me', ...legacyPeople]).find(share => share.name === 'Me')?.amount ?? amount;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
  upiId?: string;
  settled?: boolean;
}

export interface MonthlyExpense {
  date: string;
  amount: number;
  currency: Currency;
  category: string;
  shared: boolean;
  shares: ParticipantShare[];
  people: string[];
  type?: 'expense' | 'income';
  paymentMode?: PaymentMode;
  upiApp?: string | null;
  upiReference?: string | null;
  personalName?: string;
}

export function calculatePaymentModeSpending(
  expenses: MonthlyExpense[],
  month: string,
  displayCurrency: Currency,
  provider: ExchangeRateProvider,
): Record<string, number> {
  const { start, end } = monthBounds(month);
  const byMode: Record<string, number> = {};
  for (const expense of expenses) {
    if (expense.date < start || expense.date > end || expense.type === 'income') continue;
    const amount = convertCurrency(
      personalShare(expense.amount, expense.shared, expense.shares, expense.people, expense.personalName),
      expense.currency,
      displayCurrency,
      provider,
    );
    const mode = expense.paymentMode || 'UPI';
    byMode[mode] = Math.round(((byMode[mode] ?? 0) + amount) * 100) / 100;
  }
  return byMode;
}

export function calculateDailySpending(
  expenses: MonthlyExpense[],
  month: string,
  displayCurrency: Currency,
  provider: ExchangeRateProvider,
): Array<{ date: string; day: number; amount: number }> {
  const { start, end } = monthBounds(month);
  const byDate: Record<string, number> = {};
  for (const expense of expenses) {
    if (expense.date < start || expense.date > end || expense.type === 'income') continue;
    const amount = convertCurrency(
      personalShare(expense.amount, expense.shared, expense.shares, expense.people, expense.personalName),
      expense.currency,
      displayCurrency,
      provider,
    );
    byDate[expense.date] = Math.round(((byDate[expense.date] ?? 0) + amount) * 100) / 100;
  }
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const result: Array<{ date: string; day: number; amount: number }> = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dayStr = String(d).padStart(2, '0');
    const dateStr = `${month}-${dayStr}`;
    result.push({
      date: dateStr,
      day: d,
      amount: byDate[dateStr] ?? 0,
    });
  }
  return result;
}

export function calculateMonthlySpending(
  expenses: MonthlyExpense[],
  month: string,
  displayCurrency: Currency,
  provider: ExchangeRateProvider,
): { total: number; income: number; byCategory: Record<string, number> } {
  const { start, end } = monthBounds(month);
  const byCategory: Record<string, number> = {};
  let income = 0;
  for (const expense of expenses) {
    if (expense.date < start || expense.date > end) continue;
    const amount = convertCurrency(
      personalShare(expense.amount, expense.shared, expense.shares, expense.people, expense.personalName),
      expense.currency,
      displayCurrency,
      provider,
    );
    if (expense.type === 'income') {
      income = Math.round((income + amount) * 100) / 100;
      continue;
    }
    byCategory[expense.category] = Math.round(((byCategory[expense.category] ?? 0) + amount) * 100) / 100;
  }
  const total = Math.round(Object.values(byCategory).reduce((sum, amount) => sum + amount, 0) * 100) / 100;
  return {
    total,
    income,
    byCategory,
  };
}

export interface SettlementRecord {
  from: string;
  to: string;
  amount: number;
}

export function calculateSettlements(
  bills: Array<{ amount: number; payer: string; shares: ParticipantShare[] }>,
  payments: SettlementRecord[] = [],
): Settlement[] {
  const balances = new Map<string, number>();
  for (const bill of bills) {
    balances.set(bill.payer, (balances.get(bill.payer) ?? 0) + bill.amount);
    for (const share of bill.shares) {
      balances.set(share.name, (balances.get(share.name) ?? 0) - share.amount);
    }
  }
  for (const p of payments) {
    balances.set(p.from, (balances.get(p.from) ?? 0) + p.amount);
    balances.set(p.to, (balances.get(p.to) ?? 0) - p.amount);
  }
  const creditors = [...balances].filter(([, value]) => value > 0.005).map(([name, value]) => ({ name, value }));
  const debtors = [...balances].filter(([, value]) => value < -0.005).map(([name, value]) => ({ name, value: -value }));
  const settlements: Settlement[] = [];
  for (const debtor of debtors) {
    for (const creditor of creditors) {
      const amount = Math.min(debtor.value, creditor.value);
      if (amount > 0.005) settlements.push({ from: debtor.name, to: creditor.name, amount: Math.round(amount * 100) / 100 });
      debtor.value -= amount;
      creditor.value -= amount;
      if (debtor.value < 0.005) break;
    }
  }
  return settlements;
}
