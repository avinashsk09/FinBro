import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ArrowDownRight, ArrowUpRight, CalendarDays, CheckCircle2, CircleDollarSign, Copy,
  Database, Download, ExternalLink, Eye, EyeOff, Filter, HelpCircle,
  LayoutDashboard, LogOut, Moon, Pencil, PieChart, Plus, Printer, QrCode,
  ReceiptText, RefreshCw, Send, Settings, Share2, Sparkles, Sun, Target,
  Trash2, TrendingUp, Users, Wallet, X,
} from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  Legend,
  AreaChart,
  Area,
  CartesianGrid,
} from 'recharts';
import QRCode from 'qrcode';

export type PaymentMode = 'UPI' | 'Cash' | 'Credit Card' | 'Debit Card' | 'Net Banking' | 'Wallet';
export const PAYMENT_MODES: PaymentMode[] = ['UPI', 'Cash', 'Credit Card', 'Debit Card', 'Net Banking', 'Wallet'];

export type UpiApp = 'GPay' | 'PhonePe' | 'Paytm' | 'BHIM' | 'Cred' | 'Other';
export const UPI_APPS: UpiApp[] = ['GPay', 'PhonePe', 'Paytm', 'BHIM', 'Cred', 'Other'];

type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'CAD' | 'AUD';
type ParticipantShare = { name: string; amount: number };
type Expense = {
  id: number;
  title: string;
  amount: number;
  currency: Currency;
  category: string;
  date: string;
  note: string;
  shared: boolean;
  people: string[];
  shares: ParticipantShare[];
  payer: string;
  splitMethod: 'equal' | 'custom';
  householdId: number | null;
  accountId: number | null;
  type: 'expense' | 'income';
  paymentMode: PaymentMode;
  upiApp?: string | null;
  upiReference?: string | null;
  source: 'manual' | 'csv';
};

type Goal = { id: number; name: string; target: number; saved: number; currency: Currency };
type Household = { id: number; name: string; members: string[]; my_role?: 'owner' | 'member' };
type User = { id: number; email: string };
type Account = { id: number; name: string; currency: Currency; openingBalance: number; openingDate: string; currentBalance: number };
type Transfer = { id: number; from_account_id: number; to_account_id: number; amount: number; date: string; note: string; currency: Currency; fromAccountName: string; toAccountName: string };
type CategoryBudget = { id: number; month: string; category: string; amount: number; currency: Currency };
type Summary = {
  month: string;
  currency: Currency;
  baseCurrency: 'INR';
  total: number;
  income: number;
  budget: number;
  remaining: number | null;
  daysLeft: number;
  dailyLimit: number | null;
  byCategory: Record<string, number>;
  byPaymentMode?: Record<string, number>;
  dailySpending?: Array<{ date: string; day: number; amount: number }>;
  categoryBudgetAmounts: Record<string, number>;
  budgetUsedPercent: number;
  warningThreshold: number;
  warnings: Array<{ category: string | null; spent: number; budget: number; percent: number; status: 'ok' | 'warning' | 'limit' }>;
  topCategories: Array<{ category: string; amount: number }>;
  priorMonthTotal: number;
  monthOverMonthIncreasePercent: number | null;
  rateNote: string;
  rateSource: string | null;
  rateDate: string | null;
  rateFetchedAt: number | null;
};
type Filters = { from: string; to: string; category: string; currency: string; type: string; paymentMode: string };
type ExpenseForm = {
  title: string; amount: string; currency: Currency; category: string; date: string; note: string;
  type: 'expense' | 'income'; shared: boolean; people: string; payer: string; accountId: string;
  splitMethod: 'equal' | 'custom'; householdId: string; paymentMode: PaymentMode;
  upiApp: string; upiReference: string;
};

const API = (import.meta.env.VITE_API_URL || 'http://localhost:4000/api').replace(/\/+$/, '');
const CURRENCIES: Currency[] = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'CAD', 'AUD'];
const SYMBOL: Record<Currency, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', CAD: 'C$', AUD: 'A$' };

export const EXPENSE_CATEGORIES = [
  'Food & drinks',
  'Groceries',
  'Rent / PG',
  'Utilities',
  'Transport',
  'Mobile recharge',
  'Laundry',
  'Gym/Sports',
  'Trips & outings',
  'Gifts',
  'Stationery & Books',
  'Gaming',
  'Fuel',
  'Party',
  'Education',
  'Health',
  'Subscriptions',
  'Shopping',
  'Entertainment',
  'Other',
];
export const INCOME_CATEGORIES = ['Salary', 'Allowance', 'Freelance income', 'Other income'];
export const CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];

export const CATEGORY_COLORS: Record<string, string> = {
  'Food & drinks': '#f59e0b',
  'Groceries': '#10b981',
  'Rent / PG': '#6366f1',
  'Utilities': '#eab308',
  'Transport': '#3b82f6',
  'Mobile recharge': '#06b6d4',
  'Laundry': '#8b5cf6',
  'Gym/Sports': '#ef4444',
  'Trips & outings': '#14b8a6',
  'Gifts': '#ec4899',
  'Stationery & Books': '#84cc16',
  'Gaming': '#a855f7',
  'Fuel': '#f97316',
  'Party': '#f43f5e',
  'Education': '#0284c7',
  'Health': '#e11d48',
  'Subscriptions': '#64748b',
  'Shopping': '#d946ef',
  'Entertainment': '#a21caf',
  'Other': '#71717a',
  'Salary': '#10b981',
  'Allowance': '#059669',
  'Freelance income': '#047857',
  'Other income': '#16a34a',
};

export const CATEGORY_EMOJIS: Record<string, string> = {
  'Food & drinks': '🍔',
  'Groceries': '🛒',
  'Rent / PG': '🏠',
  'Utilities': '⚡',
  'Transport': '🚌',
  'Mobile recharge': '📱',
  'Laundry': '🧺',
  'Gym/Sports': '🏋️',
  'Trips & outings': '🎒',
  'Gifts': '🎁',
  'Stationery & Books': '📚',
  'Gaming': '🎮',
  'Fuel': '⛽',
  'Party': '🎉',
  'Education': '🎓',
  'Health': '💊',
  'Subscriptions': '📺',
  'Shopping': '🛍️',
  'Entertainment': '🎟️',
  'Other': '🪙',
  'Salary': '💼',
  'Allowance': '💸',
  'Freelance income': '💻',
  'Other income': '📈',
};

export const PAYMENT_MODE_COLORS: Record<string, string> = {
  'UPI': '#10b981',
  'Cash': '#f59e0b',
  'Credit Card': '#8b5cf6',
  'Debit Card': '#3b82f6',
  'Net Banking': '#6366f1',
  'Wallet': '#ec4899',
};

const NAV = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'Transactions', icon: ReceiptText },
  { name: 'Insights', icon: PieChart },
  { name: 'Budget', icon: Target },
  { name: 'Roommates', icon: Users },
  { name: 'Settings', icon: Settings },
] as const;
type Tab = (typeof NAV)[number]['name'];
type Modal = 'expense' | 'goal' | 'budget' | 'household' | 'statement' | null;

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const currentMonth = () => today().slice(0, 7);
const money = (amount: number, currency: Currency) => {
  const absAmount = Math.abs(amount);
  return `${SYMBOL[currency]}${absAmount.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}`;
};
const monthLabel = (month: string) => {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(
      `Could not reach the BachelorBudget API at ${API}. Check that the backend is running and VITE_API_URL is correct.`,
    );
  }
  if (!response.ok) {
    let errorMessage = 'Request failed';
    try {
      const body = await response.json() as { error?: string; details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } };
      errorMessage = body.error || errorMessage;
      const validationMessage = body.details?.formErrors?.[0]
        || Object.values(body.details?.fieldErrors ?? {}).flat()[0];
      if (validationMessage) errorMessage = `${errorMessage}: ${validationMessage}`;
    } catch {
      errorMessage = `Request failed (${response.status})`;
    }
    throw new ApiError(errorMessage, response.status);
  }
  return response;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiResponse(path, init);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function newExpenseForm(): ExpenseForm {
  return {
    title: '', amount: '', currency: 'INR', category: 'Food & drinks', date: today(), note: '', type: 'expense',
    shared: false, people: '', payer: 'Me', splitMethod: 'equal', householdId: '',
    accountId: '', paymentMode: 'UPI', upiApp: 'GPay', upiReference: '',
  };
}

function sharesForExpense(expense: Expense): ParticipantShare[] {
  if (expense.shares.length) return expense.shares;
  const participants = [...new Set(['Me', ...(expense.people ?? [])])];
  const cents = Math.round(expense.amount * 100);
  const each = Math.floor(cents / participants.length);
  return participants.map((name, index) => ({ name, amount: (each + (index < cents - each * participants.length ? 1 : 0)) / 100 }));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [categoryBudgets, setCategoryBudgets] = useState<CategoryBudget[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [settlements, setSettlements] = useState<Array<{
    from: string; to: string; amount: number; currency: Currency; householdId: number | null; householdName: string | null;
  }>>([]);
  const [settlementDetails, setSettlementDetails] = useState<Record<string, { upiId: string | null; settled: boolean; settledAt: string | null; upiReference: string | null }>>({});
  const [upiId, setUpiId] = useState('');
  const [qrModal, setQrModal] = useState<{ payeeName: string; upiId: string; amount: number; note?: string } | null>(null);
  const [settleModal, setSettleModal] = useState<{ from: string; to: string; amount: number; currency: Currency; householdId?: number | null } | null>(null);
  const [supabaseStatus, setSupabaseStatus] = useState<{ connected: boolean; url?: string; projectId?: string; latencyMs?: number; error?: string } | null>(null);
  const [syncingSupabase, setSyncingSupabase] = useState(false);
  const [currency, setCurrency] = useState<Currency>('INR');
  const [profileName, setProfileName] = useState('');
  const [tourOpen, setTourOpen] = useState(false);
  const [month, setMonth] = useState(currentMonth());
  const [monthlyBudget, setMonthlyBudget] = useState(0);
  const [warningThreshold, setWarningThreshold] = useState(80);
  const [tab, setTab] = useState<Tab>('Dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [form, setForm] = useState<ExpenseForm>(newExpenseForm);
  const [customShares, setCustomShares] = useState<Record<string, string>>({});
  const [goalForm, setGoalForm] = useState({ name: '', target: '', saved: '0', currency: 'INR' as Currency });
  const [budgetForm, setBudgetForm] = useState({ category: CATEGORIES[0], amount: '' });
  const [householdForm, setHouseholdForm] = useState({ name: '', members: '' });
  const [filters, setFilters] = useState<Filters>({ from: '', to: '', category: '', currency: '', type: '', paymentMode: '' });

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('bb_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bb_theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const expenseRows = await api<Expense[]>('/transactions');
      setExpenses(expenseRows);
      const query = new URLSearchParams({ currency, month }).toString();
      const [goalRows, dashboard, settings, budgetRows, householdRows, settlementData, accountRows, transferRows] = await Promise.all([
        api<Goal[]>('/goals'),
        api<Summary>(`/summary?${query}`),
        api<{ monthlyBudget: number; warningThreshold: number; upiId?: string; username?: string; preferredCurrency?: Currency }>('/settings'),
        api<CategoryBudget[]>(`/budgets?month=${encodeURIComponent(month)}`),
        api<Household[]>('/households'),
        api<{
          settlements: Array<{
            from: string; to: string; amount: number; currency: Currency; householdId: number | null; householdName: string | null;
          }>;
          details?: Record<string, { upiId: string | null; settled: boolean; settledAt: string | null; upiReference: string | null }>;
          myUpiId?: string | null;
        }>(`/settlements?month=${encodeURIComponent(month)}`),
        api<Account[]>('/accounts'),
        api<Transfer[]>('/transfers'),
      ]);
      setExpenses(expenseRows);
      setGoals(goalRows);
      setSummary(dashboard);
      setMonthlyBudget(settings.monthlyBudget);
      setWarningThreshold(settings.warningThreshold);
      if (settings.upiId !== undefined) setUpiId(settings.upiId);
      if (settings.username) setProfileName(settings.username);
      if (settings.preferredCurrency) setCurrency(settings.preferredCurrency);
      setCategoryBudgets(budgetRows);
      setHouseholds(householdRows);
      setAccounts(accountRows);
      setTransfers(transferRows);
      setSettlements(settlementData.settlements);
      if (settlementData.details) setSettlementDetails(settlementData.details);
      setError('');
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        setUser(null);
        setExpenses([]);
        setGoals([]);
        setHouseholds([]);
        setAccounts([]);
        setTransfers([]);
        setCategoryBudgets([]);
        setSummary(null);
        setSettlements([]);
        setSettlementDetails({});
      }
      setError(requestError instanceof Error ? requestError.message : 'Could not load your budget data.');
    } finally {
      setLoading(false);
    }
  }, [currency, month]);

  const syncWithSupabase = async () => {
    setSyncingSupabase(true);
    try {
      const res = await api<{ total: number; synced: number; failed: number }>('/supabase/sync', { method: 'POST' });
      setNotice(`Synced ${res.synced} of ${res.total} transactions to Supabase Cloud.`);
      const statusRes = await api<{ connected: boolean; url?: string; projectId?: string; latencyMs?: number; error?: string }>('/supabase/status');
      setSupabaseStatus(statusRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sync with Supabase');
    } finally {
      setSyncingSupabase(false);
    }
  };

  const checkSession = useCallback(async () => {
    setAuthError('');
    try {
      const result = await api<{ user: User }>('/auth/me');
      setUser(result.user);
    } catch (requestError) {
      setUser(null);
      if (!(requestError instanceof ApiError && requestError.status === 401)) {
        setAuthError(requestError instanceof Error ? requestError.message : 'Could not connect to the backend.');
      }
    } finally {
      setAuthReady(true);
    }
  }, []);
  useEffect(() => { void checkSession(); }, [checkSession]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    api<{ username: string; preferredCurrency: Currency; upiId?: string }>('/settings')
      .then(settings => {
        if (!active) return;
        setProfileName(settings.username);
        setCurrency(settings.preferredCurrency);
        if (settings.upiId) setUpiId(settings.upiId);
      })
      .catch(requestError => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load your settings.');
      });
    api<{ connected: boolean; url?: string; projectId?: string; latencyMs?: number; error?: string }>('/supabase/status')
      .then(status => { if (active) setSupabaseStatus(status); })
      .catch(() => { if (active) setSupabaseStatus({ connected: false, error: 'Supabase offline' }); });
    try {
      setTourOpen(window.localStorage.getItem(`bachelorbudget-tour-seen-${user.id}`) !== 'true');
    } catch {
      setTourOpen(false);
    }
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    if (user) void refresh();
    else if (authReady) setLoading(false);
  }, [authReady, refresh, user]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (error) setNotice('');
  }, [error]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const monthExpenses = useMemo(() => expenses.filter(expense => expense.date.startsWith(month)), [expenses, month]);
  const visibleExpenses = useMemo(() => expenses.filter(expense => (
    (!filters.from || expense.date >= filters.from)
    && (!filters.to || expense.date <= filters.to)
    && (!filters.category || expense.category === filters.category)
    && (!filters.currency || expense.currency === filters.currency)
    && (!filters.type || expense.type === filters.type)
    && (!filters.paymentMode || (expense.paymentMode || 'UPI') === filters.paymentMode)
  )), [expenses, filters]);
  const participantNames = useMemo(() => {
    const entered = form.people.split(',').map(name => name.trim()).filter(name => name && name.toLowerCase() !== 'me');
    return [...new Set(['Me', form.payer, ...entered])];
  }, [form.people, form.payer]);
  const spent = summary?.total ?? 0;
  const remaining = summary?.remaining ?? 0;
  const percent = summary?.budgetUsedPercent ?? 0;
  const isCurrentMonth = month === currentMonth();
  const currentBalance = accounts
    .filter(account => account.currency === currency)
    .reduce((total, account) => total + account.currentBalance, 0);
  const matchingAccounts = accounts.filter(account => account.currency === currency);

  const completeAuthentication = (authenticatedUser: User) => {
    setUser(authenticatedUser);
    setAuthReady(true);
    setAuthError('');
    setError('');
  };

  if (!authReady) return <div className="loading" role="status">Checking your session…</div>;
  if (!user) return <AuthScreen
    onAuthenticated={completeAuthentication} connectionError={authError} onRetry={() => void checkSession()}
  />;

  const openNewExpense = (shared = false) => {
    setEditingExpense(null);
    const matchingAccounts = accounts.filter(account => account.currency === currency);
    setForm({
      ...newExpenseForm(),
      currency,
      shared,
      householdId: households[0] ? String(households[0].id) : '',
      accountId: matchingAccounts.length === 1 ? String(matchingAccounts[0].id) : '',
    });
    setCustomShares({});
    setModal('expense');
  };
  const openEditExpense = (expense: Expense) => {
    setEditingExpense(expense);
    setForm({
      title: expense.title, amount: String(expense.amount), currency: expense.currency, category: expense.category,
      date: expense.date, note: expense.note, shared: expense.shared, people: expense.people.join(', '),
      payer: expense.payer || 'Me', splitMethod: expense.splitMethod || 'equal',
      householdId: expense.householdId ? String(expense.householdId) : '', type: expense.type || 'expense',
      accountId: expense.accountId ? String(expense.accountId) : '',
      paymentMode: expense.paymentMode || 'UPI',
      upiApp: expense.upiApp || 'GPay',
      upiReference: expense.upiReference || '',
    });
    setCustomShares(Object.fromEntries(sharesForExpense(expense).map(share => [share.name, String(share.amount)])));
    setModal('expense');
  };

  const submitExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = {
      title: form.title.trim(), amount: Number(form.amount), currency: form.currency, category: form.category,
      date: form.date, note: form.note.trim(), shared: form.type === 'expense' && form.shared,
      type: form.type,
      source: 'manual',
      paymentMode: form.paymentMode || 'UPI',
      upiApp: form.paymentMode === 'UPI' ? form.upiApp : null,
      upiReference: form.paymentMode === 'UPI' && form.upiReference.trim() ? form.upiReference.trim() : null,
      people: form.shared ? form.people.split(',').map(name => name.trim()).filter(Boolean) : [],
      payer: form.shared ? form.payer : 'Me',
      splitMethod: form.shared ? form.splitMethod : 'equal',
      shares: form.shared && form.splitMethod === 'custom'
        ? participantNames.map(name => ({ name, amount: Number(customShares[name] ?? 0) }))
        : [],
      householdId: form.shared && form.householdId ? Number(form.householdId) : null,
      accountId: form.accountId ? Number(form.accountId) : null,
    };
    try {
      await api(`/transactions${editingExpense ? `/${editingExpense.id}` : ''}`, {
        method: editingExpense ? 'PUT' : 'POST', body: JSON.stringify(data),
      });
      setModal(null);
      setError('');
      setNotice(editingExpense
        ? 'Transaction updated.'
        : `${form.type === 'income' ? 'Income recorded' : 'Expense saved'}.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save transaction.');
    }
  };

  const deleteExpense = async (expense: Expense) => {
    if (!window.confirm(`Delete "${expense.title}"?`)) return;
    try {
      await api(`/transactions/${expense.id}`, { method: 'DELETE' });
      setNotice('Transaction deleted.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete expense.');
    }
  };

  const openGoal = (goal?: Goal) => {
    setEditingGoal(goal ?? null);
    setGoalForm(goal
      ? { name: goal.name, target: String(goal.target), saved: String(goal.saved), currency: goal.currency }
      : { name: '', target: '', saved: '0', currency: 'INR' });
    setModal('goal');
  };
  const submitGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = { name: goalForm.name.trim(), target: Number(goalForm.target), saved: Number(goalForm.saved), currency: goalForm.currency };
    try {
      await api(`/goals${editingGoal ? `/${editingGoal.id}` : ''}`, {
        method: editingGoal ? 'PUT' : 'POST', body: JSON.stringify(data),
      });
      setModal(null);
      setNotice(editingGoal ? 'Savings goal updated.' : 'Savings goal created.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save goal.');
    }
  };
  const deleteGoal = async (goal: Goal) => {
    if (!window.confirm(`Remove the "${goal.name}" savings goal?`)) return;
    try {
      await api(`/goals/${goal.id}`, { method: 'DELETE' });
      setNotice('Savings goal removed.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not remove goal.');
    }
  };

  const saveMonthlyBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ monthlyBudget: Number(monthlyBudget), baseCurrency: 'INR', warningThreshold }),
      });
      setModal(null);
      setNotice('Monthly budget saved.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save budget settings.');
    }
  };
  const saveCategoryBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api('/budgets', {
        method: 'PUT',
        body: JSON.stringify({ month, category: budgetForm.category, amount: Number(budgetForm.amount), currency: 'INR' }),
      });
      setModal(null);
      setNotice('Category limit saved.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save category budget.');
    }
  };
  const deleteCategoryBudget = async (budget: CategoryBudget) => {
    if (!window.confirm(`Remove the ${budget.category} limit for ${monthLabel(budget.month)}?`)) return;
    try {
      await api(`/budgets/${budget.id}`, { method: 'DELETE' });
      setNotice(`${budget.category} budget limit removed.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not remove category budget.');
    }
  };
  const submitHousehold = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api('/households', {
        method: 'POST',
        body: JSON.stringify({
          name: householdForm.name.trim(),
          members: householdForm.members.split(',').map(name => name.trim()).filter(Boolean),
        }),
      });
      setHouseholdForm({ name: '', members: '' });
      setModal(null);
      setNotice('Household created.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create household.');
    }
  };

  const exportCsv = async () => {
    if (!visibleExpenses.length) return;
    const params = new URLSearchParams();
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.category) params.set('category', filters.category);
    if (filters.currency) params.set('currency', filters.currency);
    if (filters.type) params.set('type', filters.type);
    try {
      const response = await apiResponse(`/export.csv?${params.toString()}`);
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'bachelorbudget-expenses.csv';
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice(`Exported ${visibleExpenses.length} transaction${visibleExpenses.length === 1 ? '' : 's'}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not export transactions.');
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
      setExpenses([]);
      setGoals([]);
      setHouseholds([]);
      setAccounts([]);
      setTransfers([]);
      setCategoryBudgets([]);
      setSummary(null);
      setSettlements([]);
      setNotice('');
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not sign out.');
    }
  };

  const finishTour = () => {
    try {
      if (user) window.localStorage.setItem(`bachelorbudget-tour-seen-${user.id}`, 'true');
    } catch {
      setError('Your browser could not save this tour preference. You can close the welcome message for now.');
    }
    setTourOpen(false);
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ monthlyBudget, warningThreshold, username: profileName.trim(), preferredCurrency: currency }),
      });
      setProfileName(profileName.trim());
      setNotice('Settings saved.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save your settings.');
    }
  };

  const handleMonthChange = (value: string) => {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) setMonth(value);
  };

  const displayName = profileName || user.email.split('@')[0];

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-icon"><Wallet size={20} /></div>
          <span>Bachelor<span className="brand-accent">Budget</span></span>
        </div>
        <div className="sidebar-user">
          <div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div>
          <div className="sidebar-user-info">
            <b>{displayName}</b>
            <small>{user.email}</small>
          </div>
        </div>
        <div className="nav-section-label">Menu</div>
        <nav>
          {NAV.map(({ name, icon: Icon }) => (
            <button
              key={name}
              id={`nav-${name.toLowerCase()}`}
              className={`nav-item ${tab === name ? 'active' : ''}`}
              onClick={() => setTab(name)}
              aria-current={tab === name ? 'page' : undefined}
            >
              <Icon size={17} />
              <span>{name}</span>
              {name === 'Roommates' && monthExpenses.filter(e => e.shared).length > 0 && (
                <span className="nav-badge">{monthExpenses.filter(e => e.shared).length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-theme-btn" type="button" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button className="sidebar-tour-btn" onClick={() => setTourOpen(true)}>
            <HelpCircle size={16} /><span>Help &amp; tour</span>
          </button>
          <button className="sidebar-logout-btn" onClick={() => void logout()}>
            <LogOut size={16} /><span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="page-eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            <h1 className="page-title">{tab === 'Dashboard' ? 'Your money at a glance' : tab}</h1>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <label className="currency-select">
              <CircleDollarSign size={15} />
              <span className="sr-only">Display currency</span>
              <select id="currency-selector" value={currency} onChange={e => setCurrency(e.target.value as Currency)} aria-label="Display currency">
                {CURRENCIES.map(code => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            <label className="month-picker">
              <CalendarDays size={15} />
              <span className="sr-only">Month</span>
              <input id="month-selector" type="month" value={month} onChange={e => handleMonthChange(e.target.value)} aria-label="Select month" />
            </label>
            <button id="add-transaction-btn" className="primary-btn" onClick={() => openNewExpense()}>
              <Plus size={16} /> Add transaction
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button>
          </div>
        )}
        {notice && (
          <div className="success-banner" role="status">
            <span>{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice('')}><X size={15} /></button>
          </div>
        )}

        {loading ? <div className="loading" role="status">Getting your data ready…</div> : <>
          {tourOpen && <WelcomeTour onDismiss={finishTour} />}

          {tab === 'Dashboard' && summary && <Overview
            currency={currency} month={month} summary={summary} currentBalance={currentBalance}
            matchingAccounts={matchingAccounts.length} expenses={monthExpenses} hasAnyTransactions={expenses.length > 0}
            hasAccounts={accounts.length > 0} householdCount={households.length}
            sharedExpenseCount={monthExpenses.filter(e => e.shared).length}
            onEdit={openEditExpense}
            onDelete={deleteExpense} setTab={setTab} onAddExpense={() => openNewExpense()}
            onSetBudget={() => setModal('budget')}
            onOpenStatement={() => setModal('statement')}
          />}

          {tab === 'Transactions' && <>
            <TransactionView
              title="All transactions" description="Filter, review, edit, or remove your records."
              expenses={visibleExpenses} filters={filters} setFilters={setFilters} onEdit={openEditExpense}
              onDelete={deleteExpense} onExport={exportCsv} currency={currency}
              onOpenStatement={() => setModal('statement')}
            />
            <CsvImportPanel onImported={(count, duplicates) => {
              setNotice(`Import complete: ${count} added, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped.`);
              void refresh();
            }} />
          </>}

          {tab === 'Insights' && summary && <InsightsView
            summary={summary} currency={currency} month={month} expenses={monthExpenses}
            onOpenStatement={() => setModal('statement')} onSetBudget={() => setModal('budget')}
          />}

          {tab === 'Roommates' && <SharedView
            expenses={monthExpenses.filter(e => e.shared)} households={households} settlements={settlements}
            currency={currency} onAdd={() => openNewExpense(true)} onCreateHousehold={() => setModal('household')}
            onEdit={openEditExpense} onDelete={deleteExpense} onRefresh={() => void refresh()}
            onSettleViaUpi={s => setSettleModal(s)}
          />}

          {tab === 'Budget' && summary && <MonthlyBudgetView
            month={month} currency={currency} summary={summary} onEditBudget={() => setModal('budget')}
          />}

          {tab === 'Settings' && <>
            <section className="panel settings-panel">
              <div className="panel-heading">
                <div><h2>Account settings</h2><p>Update your display name, theme and preferred currency.</p></div>
              </div>
              <form className="modal-form" onSubmit={e => void saveSettings(e)}>
                <label>Display name<input id="settings-username" required maxLength={40} value={profileName} onChange={e => setProfileName(e.target.value)} placeholder="Your name" /></label>
                <label>Email address<input type="email" value={user.email} disabled /></label>
                <label>Appearance
                  <select value={theme} onChange={e => setTheme(e.target.value as 'light' | 'dark')}>
                    <option value="light">Light Theme (Clean Mint)</option>
                    <option value="dark">Dark Theme (Deep Slate)</option>
                  </select>
                </label>
                <label>Preferred currency
                  <select id="settings-currency" value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
                    {CURRENCIES.map(code => <option key={code}>{code}</option>)}
                  </select>
                </label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button className="submit-btn" type="submit">Save settings</button>
                  <button className="outline-btn" type="button" onClick={() => setTourOpen(true)}>Open tour</button>
                </div>
              </form>
            </section>
            <section className="panel settings-panel">
              <div className="panel-heading">
                <div><h2>Manual accounts</h2><p>Track starting balances separately from monthly income and expenses.</p></div>
              </div>
              <StartingBalanceView accounts={accounts} onChanged={() => void refresh()} />
            </section>
          </>}

          <div className="rate-disclaimer">{summary?.rateNote} Original transaction amounts and currencies are always preserved.</div>
        </>}
      </main>

      {/* Mobile nav */}
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {NAV.map(({ name, icon: Icon }) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} aria-label={name}>
            <Icon size={20} /><span>{name.split(' ')[0]}</span>
          </button>
        ))}
      </nav>

      {/* Modal */}
      {modal && (
        <div
          className="modal-backdrop"
          id="modal-backdrop"
          onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-head">
              <div>
                <h2 id="modal-title">
                  {modal === 'expense' ? (editingExpense ? 'Edit transaction' : form.shared ? 'Add shared bill' : 'Add a transaction')
                    : modal === 'goal' ? (editingGoal ? 'Update savings goal' : 'Create a savings goal')
                      : modal === 'budget' ? 'Budget settings' : 'Create a household'}
                </h2>
                <p>Your data stays private to your account.</p>
              </div>
              <button id="modal-close-btn" className="modal-close" aria-label="Close dialog" onClick={() => setModal(null)}><X size={17} /></button>
            </div>

            {modal === 'expense' && <form className="modal-form" onSubmit={e => void submitExpense(e)}>
              <label>Transaction type
                <select id="tx-type" value={form.type} onChange={e => {
                  const type = e.target.value as 'expense' | 'income';
                  setForm({ ...form, type, category: type === 'income' ? 'Salary' : 'Food & drinks', shared: type === 'income' ? false : form.shared });
                }}>
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                </select>
              </label>
              <label>Description
                <input id="tx-title" autoFocus required maxLength={100} value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder={form.type === 'income' ? 'e.g. Monthly salary' : 'e.g. Groceries'} />
              </label>
              <div className="form-row">
                <label>Amount
                  <input id="tx-amount" type="number" required min="0.01" max="100000000" step="0.01"
                    value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
                </label>
                <label>Currency
                  <select id="tx-currency" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value as Currency })}>
                    {CURRENCIES.map(code => <option key={code}>{code}</option>)}
                  </select>
                </label>
              </div>
              <div className="quick-amounts">
                {[50, 100, 200, 500, 1000].map(amt => (
                  <button
                    key={amt}
                    type="button"
                    className="quick-amt-chip"
                    onClick={() => {
                      const current = Number(form.amount) || 0;
                      setForm({ ...form, amount: String(current + amt) });
                    }}
                  >
                    +{SYMBOL[form.currency] || '₹'}{amt}
                  </button>
                ))}
              </div>
              <div className="form-row">
                <label>Category
                  <select id="tx-category" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                    {(form.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(cat => <option key={cat}>{cat}</option>)}
                  </select>
                </label>
                <label>Date
                  <input id="tx-date" type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                </label>
              </div>
              <div className="form-row">
                <label>Payment mode
                  <select id="tx-payment-mode" value={form.paymentMode} onChange={e => setForm({ ...form, paymentMode: e.target.value as PaymentMode })}>
                    {PAYMENT_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                </label>
                {form.paymentMode === 'UPI' ? (
                  <label>UPI app
                    <select id="tx-upi-app" value={form.upiApp} onChange={e => setForm({ ...form, upiApp: e.target.value })}>
                      {UPI_APPS.map(app => <option key={app} value={app}>{app}</option>)}
                    </select>
                  </label>
                ) : (
                  <label>Ref / Note (optional)
                    <input id="tx-payment-ref" maxLength={50} value={form.upiReference} onChange={e => setForm({ ...form, upiReference: e.target.value })} placeholder="Card #, Cheque, etc." />
                  </label>
                )}
              </div>
              {form.paymentMode === 'UPI' && (
                <label>UPI Reference / UTR (optional)
                  <input id="tx-upi-ref" maxLength={50} value={form.upiReference} onChange={e => setForm({ ...form, upiReference: e.target.value })} placeholder="e.g. 12-digit UTR or Txn ID" />
                </label>
              )}
              {accounts.some(a => a.currency === form.currency) && (
                <label>Account (optional)
                  <select id="tx-account" value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })}>
                    <option value="">No account assigned</option>
                    {accounts.filter(a => a.currency === form.currency).map(a => <option value={a.id} key={a.id}>{a.name} · {a.currency}</option>)}
                  </select>
                </label>
              )}
              <label>Notes (optional)
                <input id="tx-note" maxLength={300} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
              </label>
              {form.type === 'expense' && (
                <label className="check-row">
                  <input id="tx-shared" type="checkbox" checked={form.shared} onChange={e => setForm({ ...form, shared: e.target.checked })} />
                  This is a shared expense
                </label>
              )}
              {form.shared && <>
                {households.length > 0 && (
                  <label>Household (optional)
                    <select id="tx-household" value={form.householdId} onChange={e => {
                      const group = households.find(h => String(h.id) === e.target.value);
                      setForm({ ...form, householdId: e.target.value, people: group ? group.members.filter(m => m !== 'Me').join(', ') : form.people });
                    }}>
                      <option value="">No household</option>
                      {households.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>
                )}
                <label>Participants (comma-separated, excluding you)
                  <input id="tx-people" value={form.people} onChange={e => setForm({ ...form, people: e.target.value })} placeholder="Roommate 1, Roommate 2" />
                </label>
                <div className="form-row">
                  <label>Paid by
                    <select id="tx-payer" value={form.payer} onChange={e => setForm({ ...form, payer: e.target.value })}>
                      {participantNames.map(name => <option key={name}>{name}</option>)}
                    </select>
                  </label>
                  <label>Split method
                    <select id="tx-split" value={form.splitMethod} onChange={e => setForm({ ...form, splitMethod: e.target.value as 'equal' | 'custom' })}>
                      <option value="equal">Equal split</option>
                      <option value="custom">Custom shares</option>
                    </select>
                  </label>
                </div>
                {form.splitMethod === 'custom' && (
                  <fieldset className="share-fields">
                    <legend>Each person's share (must total {money(Number(form.amount) || 0, form.currency)})</legend>
                    {participantNames.map(name => (
                      <label key={name}>{name}
                        <input aria-label={`${name} share`} type="number" min="0" step="0.01" required
                          value={customShares[name] ?? ''} onChange={e => setCustomShares({ ...customShares, [name]: e.target.value })} />
                      </label>
                    ))}
                  </fieldset>
                )}
              </>}
              <div className="modal-actions">
                <button id="tx-cancel-btn" className="secondary-btn" type="button" onClick={() => setModal(null)}>Cancel</button>
                <button id="tx-save-btn" className="submit-btn" type="submit" style={{ width: 'auto', flex: 1 }}>
                  {editingExpense ? 'Save changes' : 'Save transaction'}
                </button>
              </div>
            </form>}

            {modal === 'goal' && <form className="modal-form" onSubmit={e => void submitGoal(e)}>
              <label>Goal name<input autoFocus required maxLength={100} value={goalForm.name} onChange={e => setGoalForm({ ...goalForm, name: e.target.value })} placeholder="e.g. Emergency fund" /></label>
              <div className="form-row">
                <label>Target amount<input type="number" required min="0.01" max="100000000" step="0.01" value={goalForm.target} onChange={e => setGoalForm({ ...goalForm, target: e.target.value })} /></label>
                <label>Saved so far<input type="number" required min="0" max={goalForm.target || undefined} step="0.01" value={goalForm.saved} onChange={e => setGoalForm({ ...goalForm, saved: e.target.value })} /></label>
              </div>
              <label>Currency<select value={goalForm.currency} onChange={e => setGoalForm({ ...goalForm, currency: e.target.value as Currency })}>{CURRENCIES.map(code => <option key={code}>{code}</option>)}</select></label>
              <p className="field-hint">Goal amounts are tracked separately from budget totals.</p>
              <div className="modal-actions">
                <button className="secondary-btn" type="button" onClick={() => setModal(null)}>Cancel</button>
                <button className="submit-btn" type="submit" style={{ width: 'auto', flex: 1 }}>{editingGoal ? 'Save goal' : 'Create goal'}</button>
              </div>
            </form>}

            {modal === 'budget' && <div className="budget-modal-content">
              <form className="modal-form" onSubmit={e => void saveMonthlyBudget(e)}>
                <h3>Monthly spending limit · INR base</h3>
                <label>Monthly budget (INR)<input type="number" required min="0.01" step="0.01" value={monthlyBudget || ''} onChange={e => setMonthlyBudget(Number(e.target.value))} /></label>
                <label>Warning threshold (%)
                  <input type="number" required min="50" max="99" step="1" value={warningThreshold} onChange={e => setWarningThreshold(Number(e.target.value))} />
                </label>
                <button className="submit-btn full-btn" type="submit">Save monthly budget</button>
              </form>
            </div>}

            {modal === 'household' && <form className="modal-form" onSubmit={e => void submitHousehold(e)}>
              <label>Household name<input autoFocus required maxLength={100} value={householdForm.name} onChange={e => setHouseholdForm({ ...householdForm, name: e.target.value })} placeholder="e.g. Flat 2B" /></label>
              <label>Roommates (comma-separated)<input required value={householdForm.members} onChange={e => setHouseholdForm({ ...householdForm, members: e.target.value })} placeholder="Ravi, Priya, Arjun" /></label>
              <p className="field-hint">This is a local list. Invite registered members by token to sync shared bills.</p>
              <div className="modal-actions">
                <button className="secondary-btn" type="button" onClick={() => setModal(null)}>Cancel</button>
                <button className="submit-btn" type="submit" style={{ width: 'auto', flex: 1 }}>Create household</button>
              </div>
            </form>}
          </section>
        </div>
      )}

      {settleModal && (
        <UpiSettleModal
          settle={settleModal}
          upiId={upiId}
          onClose={() => setSettleModal(null)}
          onSettled={() => {
            setNotice('Settlement recorded successfully.');
            void refresh();
          }}
        />
      )}

      {modal === 'statement' && summary && (
        <MonthlyStatementModal
          month={month}
          currency={currency}
          user={user}
          profileName={profileName}
          summary={summary}
          expenses={expenses}
          settlements={settlements}
          onClose={() => setModal(null)}
        />
      )}

      <button className="mobile-fab" onClick={() => openNewExpense()} aria-label="Add transaction" title="Add transaction">
        <Plus size={24} />
      </button>
    </div>
  );
}

/* ─── Insights View ─── */
function InsightsView({
  summary,
  currency,
  month,
  expenses: _expenses,
  onOpenStatement,
  onSetBudget: _onSetBudget,
}: {
  summary: Summary;
  currency: Currency;
  month: string;
  expenses: Expense[];
  onOpenStatement: () => void;
  onSetBudget: () => void;
}) {
  const categoryData = useMemo(() => {
    return Object.entries(summary.byCategory || {})
      .filter(([_, val]) => val > 0)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [summary.byCategory]);

  const paymentModeData = useMemo(() => {
    return Object.entries(summary.byPaymentMode || {})
      .filter(([_, val]) => val > 0)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [summary.byPaymentMode]);

  const incomeVsExpenseData = useMemo(() => [
    { name: 'Income', amount: summary.income, fill: '#10b981' },
    { name: 'Expenses', amount: summary.total, fill: '#f43f5e' },
  ], [summary.income, summary.total]);

  const dailyTrendData = useMemo(() => {
    return (summary.dailySpending || []).map(item => ({
      day: `Day ${item.day}`,
      amount: item.amount,
    }));
  }, [summary.dailySpending]);

  const topCat = categoryData[0];
  const [yearStr, monthStr] = month.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monthStr), 0).getDate();
  const dailyAvg = summary.total > 0 ? (summary.total / (summary.daysLeft > 0 ? (daysInMonth - summary.daysLeft + 1) : daysInMonth)) : 0;

  return (
    <div className="insights-view">
      {/* Metrics Row */}
      <div className="insights-summary-grid">
        <div className="insights-metric-card">
          <span>Total Spent</span>
          <strong>{money(summary.total, currency)}</strong>
          <small>{monthLabel(month)}</small>
        </div>
        <div className="insights-metric-card">
          <span>Daily Average</span>
          <strong>{money(dailyAvg, currency)}</strong>
          <small>Across active days</small>
        </div>
        <div className="insights-metric-card">
          <span>Top Category</span>
          <strong>{topCat ? `${CATEGORY_EMOJIS[topCat.name] || ''} ${topCat.name}` : '—'}</strong>
          <small>{topCat ? `${money(topCat.value, currency)} (${Math.round((topCat.value / (summary.total || 1)) * 100)}%)` : 'No expenses yet'}</small>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Analytics &amp; Financial Health</h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Interactive breakdown of spending patterns for {monthLabel(month)}</p>
        </div>
        <button className="primary-btn" onClick={onOpenStatement}>
          <Printer size={15} /> Export Statement (PDF)
        </button>
      </div>

      {/* Charts Grid */}
      <div className="insights-grid">
        {/* Category Donut */}
        <div className="panel chart-card">
          <div className="chart-header">
            <div>
              <h3>Spending by Category</h3>
              <p>Where your money went this month</p>
            </div>
          </div>
          <div className="chart-container">
            {categoryData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <RechartsPieChart>
                  <Pie
                    data={categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={95}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {categoryData.map(entry => (
                      <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || '#64748b'} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    formatter={(val: number) => [money(val, currency), 'Spent']}
                    contentStyle={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 8, color: 'var(--ink)' }}
                  />
                </RechartsPieChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty">No expense data recorded for this month.</div>
            )}
          </div>
          {categoryData.length > 0 && (
            <div className="chart-legend-list">
              {categoryData.slice(0, 6).map(entry => (
                <div className="chart-legend-item" key={entry.name}>
                  <span className="chart-legend-color" style={{ background: CATEGORY_COLORS[entry.name] || '#64748b' }} />
                  <span>{CATEGORY_EMOJIS[entry.name] || ''} {entry.name}: {money(entry.value, currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Daily Spending Trend Area Chart */}
        <div className="panel chart-card">
          <div className="chart-header">
            <div>
              <h3>Daily Spending Trend</h3>
              <p>Day-by-day expenditure pattern</p>
            </div>
          </div>
          <div className="chart-container">
            {dailyTrendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={dailyTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="spendingGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="day" stroke="var(--muted)" fontSize={10} tickLine={false} />
                  <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} tickFormatter={val => `${SYMBOL[currency]}${val}`} />
                  <RechartsTooltip
                    formatter={(val: number) => [money(val, currency), 'Daily Total']}
                    contentStyle={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 8, color: 'var(--ink)' }}
                  />
                  <Area type="monotone" dataKey="amount" stroke="var(--primary)" strokeWidth={2.5} fillOpacity={1} fill="url(#spendingGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty">No daily spending data available.</div>
            )}
          </div>
        </div>

        {/* Income vs Expenses Bar Chart */}
        <div className="panel chart-card">
          <div className="chart-header">
            <div>
              <h3>Income vs Expenses</h3>
              <p>Monthly cash flow comparison</p>
            </div>
          </div>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={incomeVsExpenseData} margin={{ top: 20, right: 20, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--muted)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} tickFormatter={val => `${SYMBOL[currency]}${val}`} />
                <RechartsTooltip
                  formatter={(val: number) => [money(val, currency), 'Amount']}
                  contentStyle={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 8, color: 'var(--ink)' }}
                />
                <Bar dataKey="amount" radius={[8, 8, 0, 0]}>
                  {incomeVsExpenseData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Spending by Payment Mode */}
        <div className="panel chart-card">
          <div className="chart-header">
            <div>
              <h3>Payment Modes</h3>
              <p>UPI, Cash, Cards &amp; Wallets breakdown</p>
            </div>
          </div>
          <div className="chart-container">
            {paymentModeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <RechartsPieChart>
                  <Pie
                    data={paymentModeData}
                    cx="50%"
                    cy="50%"
                    outerRadius={85}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {paymentModeData.map(entry => (
                      <Cell key={entry.name} fill={PAYMENT_MODE_COLORS[entry.name] || '#10b981'} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    formatter={(val: number) => [money(val, currency), 'Spent']}
                    contentStyle={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 8, color: 'var(--ink)' }}
                  />
                </RechartsPieChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty">No payment mode breakdown available.</div>
            )}
          </div>
          {paymentModeData.length > 0 && (
            <div className="chart-legend-list">
              {paymentModeData.map(entry => (
                <div className="chart-legend-item" key={entry.name}>
                  <span className="chart-legend-color" style={{ background: PAYMENT_MODE_COLORS[entry.name] || '#10b981' }} />
                  <span>{entry.name}: {money(entry.value, currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── UPI Settlement Modal ─── */
function UpiSettleModal({
  settle,
  upiId,
  onClose,
  onSettled,
}: {
  settle: { from: string; to: string; amount: number; currency: Currency; householdId?: number | null };
  upiId: string;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [payeeUpi, setPayeeUpi] = useState(upiId || 'bachelorbudget@upi');
  const [qrUrl, setQrUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reference, setReference] = useState('');

  const upiUrl = useMemo(() => {
    const pn = encodeURIComponent(settle.to);
    const pa = encodeURIComponent(payeeUpi);
    const tn = encodeURIComponent(`BachelorBudget Settlement - ${settle.from} to ${settle.to}`);
    return `upi://pay?pa=${pa}&pn=${pn}&am=${settle.amount}&cu=INR&tn=${tn}`;
  }, [payeeUpi, settle]);

  useEffect(() => {
    QRCode.toDataURL(upiUrl, { width: 240, margin: 1, color: { dark: '#111827', light: '#ffffff' } })
      .then(url => setQrUrl(url))
      .catch(() => {});
  }, [upiUrl]);

  const copyLink = () => {
    navigator.clipboard.writeText(upiUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const markSettled = async () => {
    setSaving(true);
    try {
      await api('/settlements/settle', {
        method: 'POST',
        body: JSON.stringify({
          from: settle.from,
          to: settle.to,
          amount: settle.amount,
          currency: settle.currency,
          householdId: settle.householdId ?? null,
          upiReference: reference.trim() || undefined,
          note: `Settled via UPI QR code on ${today()}`,
        }),
      });
      onSettled();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not record settlement');
    } finally {
      setSaving(false);
    }
  };

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`Hey ${settle.to}! Here is my BachelorBudget settlement payment of ${settle.currency} ${settle.amount}: ${upiUrl}`)}`;

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-card upi-modal" role="dialog" aria-modal="true" aria-labelledby="upi-modal-title">
        <div className="modal-head">
          <div>
            <h2 id="upi-modal-title">Settle with {settle.to}</h2>
            <p>Scan to pay via any UPI app (GPay, PhonePe, Paytm, Cred)</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={17} /></button>
        </div>

        <div className="upi-modal-body">
          <div className="upi-qr-container">
            {qrUrl ? (
              <img className="upi-qr-image" src={qrUrl} alt="UPI Payment QR Code" />
            ) : (
              <div className="upi-qr-placeholder">Generating QR code…</div>
            )}
          </div>

          <div className="upi-details">
            <div className="upi-amount-display">
              <span>Amount Due</span>
              <strong>{money(settle.amount, settle.currency)}</strong>
            </div>

            <div className="upi-info-row">
              <span>Recipient:</span>
              <b>{settle.to}</b>
            </div>

            <div className="upi-info-row">
              <span>Payee UPI ID:</span>
              <div className="upi-copy-group">
                <code>{payeeUpi}</code>
                <button type="button" className="btn-copy-chip" onClick={() => {
                  const newUpi = window.prompt('Enter recipient UPI ID:', payeeUpi);
                  if (newUpi) setPayeeUpi(newUpi.trim());
                }}>Edit</button>
              </div>
            </div>
          </div>

          <div className="upi-modal-actions">
            <a href={upiUrl} className="primary-btn upi-app-btn" style={{ flex: 1 }}>
              <ExternalLink size={15} /> Open UPI App
            </a>
            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="outline-btn upi-app-btn" style={{ flex: 1 }}>
              <Share2 size={15} /> WhatsApp
            </a>
            <button type="button" className="secondary-btn" onClick={copyLink} title="Copy UPI Deep Link">
              <Copy size={15} /> {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>

          <div style={{ width: '100%', marginTop: 8 }}>
            <label style={{ fontSize: 12, display: 'block', marginBottom: 4, color: 'var(--muted)' }}>
              Transaction Reference / UTR (optional)
              <input
                type="text"
                placeholder="e.g. 4281982736"
                value={reference}
                onChange={e => setReference(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', fontSize: 12, marginTop: 4 }}
              />
            </label>
            <button
              type="button"
              className="submit-btn full-btn"
              disabled={saving}
              onClick={() => void markSettled()}
              style={{ marginTop: 10 }}
            >
              <CheckCircle2 size={16} /> {saving ? 'Recording…' : 'Mark as Settled'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─── Monthly Statement Modal ─── */
function MonthlyStatementModal({
  month,
  currency,
  user,
  profileName,
  summary,
  expenses,
  settlements,
  onClose,
}: {
  month: string;
  currency: Currency;
  user: User;
  profileName: string;
  summary: Summary;
  expenses: Expense[];
  settlements: Array<{ from: string; to: string; amount: number; currency: Currency; householdName?: string | null }>;
  onClose: () => void;
}) {
  const monthExpenses = useMemo(() => expenses.filter(e => e.date.startsWith(month)), [expenses, month]);
  const totalExpense = summary.total;
  const totalIncome = summary.income;
  const netSavings = totalIncome - totalExpense;

  const categoryEntries = useMemo(() => {
    return Object.entries(summary.byCategory || {})
      .filter(([_, val]) => val > 0)
      .map(([name, val]) => ({
        name,
        amount: val,
        percent: totalExpense > 0 ? Math.round((val / totalExpense) * 100) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [summary.byCategory, totalExpense]);

  const paymentEntries = useMemo(() => {
    return Object.entries(summary.byPaymentMode || {})
      .filter(([_, val]) => val > 0)
      .map(([mode, val]) => ({
        mode,
        amount: val,
        percent: totalExpense > 0 ? Math.round((val / totalExpense) * 100) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [summary.byPaymentMode, totalExpense]);

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-card statement-modal" role="dialog" aria-modal="true" aria-labelledby="statement-title">
        <div className="statement-sheet" id="printable-statement">
          <div className="statement-header">
            <div className="statement-brand">
              <h1>BachelorBudget</h1>
              <span>Personal Finance &amp; Roommate Expense Statement</span>
            </div>
            <div className="statement-meta">
              <b>{monthLabel(month)}</b>
              <span>Account: {profileName || user.email.split('@')[0]} ({user.email})</span>
              <span>Generated on: {new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
            </div>
          </div>

          {/* Summary Boxes */}
          <div className="statement-summary-boxes">
            <div className="statement-box">
              <span>Total Income</span>
              <strong style={{ color: '#10b981' }}>{money(totalIncome, currency)}</strong>
            </div>
            <div className="statement-box">
              <span>Total Expenses</span>
              <strong style={{ color: '#f43f5e' }}>{money(totalExpense, currency)}</strong>
            </div>
            <div className="statement-box">
              <span>Net Savings</span>
              <strong style={{ color: netSavings >= 0 ? '#10b981' : '#f43f5e' }}>{money(netSavings, currency)}</strong>
            </div>
            <div className="statement-box">
              <span>Budget Status</span>
              <strong>{summary.budget > 0 ? `${Math.round(summary.budgetUsedPercent)}% used` : 'No Limit'}</strong>
            </div>
          </div>

          {/* Category Breakdown Table */}
          <h3 style={{ fontSize: 14, margin: '14px 0 6px', color: 'var(--ink)' }}>Category Breakdown</h3>
          <table className="statement-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Spent ({currency})</th>
                <th className="num">Share (%)</th>
              </tr>
            </thead>
            <tbody>
              {categoryEntries.length > 0 ? (
                categoryEntries.map(cat => (
                  <tr key={cat.name}>
                    <td>{CATEGORY_EMOJIS[cat.name] || '•'} {cat.name}</td>
                    <td className="num">{money(cat.amount, currency)}</td>
                    <td className="num">{cat.percent}%</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>No category spending recorded</td></tr>
              )}
            </tbody>
          </table>

          {/* Payment Mode Breakdown */}
          {paymentEntries.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: '14px 0 6px', color: 'var(--ink)' }}>Payment Mode Breakdown</h3>
              <table className="statement-table">
                <thead>
                  <tr>
                    <th>Payment Method</th>
                    <th className="num">Spent ({currency})</th>
                    <th className="num">Share (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentEntries.map(p => (
                    <tr key={p.mode}>
                      <td>{p.mode}</td>
                      <td className="num">{money(p.amount, currency)}</td>
                      <td className="num">{p.percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Roommate Settlements if any */}
          {settlements.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: '14px 0 6px', color: 'var(--ink)' }}>Roommate Balances</h3>
              <table className="statement-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Household</th>
                    <th className="num">Amount ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s, idx) => (
                    <tr key={idx}>
                      <td>{s.from}</td>
                      <td>{s.to}</td>
                      <td>{s.householdName || 'General'}</td>
                      <td className="num">{money(s.amount, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Itemized Transactions */}
          <h3 style={{ fontSize: 14, margin: '14px 0 6px', color: 'var(--ink)' }}>Itemized Transactions ({monthExpenses.length})</h3>
          <table className="statement-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th>Payment Mode</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {monthExpenses.length > 0 ? (
                monthExpenses
                  .slice()
                  .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
                  .map(tx => (
                    <tr key={tx.id}>
                      <td>{tx.date}</td>
                      <td>{tx.title}{tx.shared ? ' (Shared)' : ''}</td>
                      <td>{CATEGORY_EMOJIS[tx.category] || ''} {tx.category}</td>
                      <td>{tx.paymentMode || 'UPI'}{tx.upiApp ? ` (${tx.upiApp})` : ''}</td>
                      <td className="num" style={{ color: tx.type === 'income' ? '#10b981' : 'inherit' }}>
                        {tx.type === 'income' ? '+' : '−'}{money(tx.amount, tx.currency)}
                      </td>
                    </tr>
                  ))
              ) : (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)' }}>No transactions this month</td></tr>
              )}
            </tbody>
          </table>

          {/* Actions Bar (hidden on print) */}
          <div className="statement-actions-bar">
            <button className="secondary-btn" onClick={onClose}>Close</button>
            <button className="primary-btn" onClick={() => window.print()}>
              <Printer size={15} /> Print / Save as PDF
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─── Auth Screen ─── */
function getPasswordStrength(password: string): { level: 'weak' | 'medium' | 'strong'; label: string } {
  if (password.length < 8) return { level: 'weak', label: 'Weak' };
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const variety = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  if (password.length >= 12 && variety >= 2) return { level: 'strong', label: 'Strong' };
  return { level: 'medium', label: 'Medium' };
}

function AuthScreen({
  onAuthenticated, connectionError, onRetry,
}: {
  onAuthenticated: (user: User) => void;
  connectionError: string;
  onRetry: () => void;
}) {
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const strength = password ? getPasswordStrength(password) : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (registering && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await api<{ user: User }>(`/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not authenticate.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-icon"><Wallet size={20} /></div>
          <span>Bachelor<span className="brand-accent">Budget</span></span>
        </div>
        <p className="auth-eyebrow">Private local account</p>
        <h1>{registering ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-description">
          {registering
            ? 'Your financial records are private to your account.'
            : 'Sign in to access your personal budget.'}
        </p>

        {connectionError && (
          <div className="error-banner" role="alert">
            <span>{connectionError}</span>
            <button className="outline-btn" type="button" onClick={onRetry}>Retry connection</button>
          </div>
        )}
        {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

        <form className="auth-form" id="auth-form" onSubmit={e => void submit(e)}>
          <label>
            Email address
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <div className="password-input">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={registering ? 'new-password' : 'current-password'}
                required
                minLength={8}
                maxLength={128}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={registering ? 'At least 8 characters' : 'Your password'}
              />
              <button
                type="button"
                id="toggle-password"
                className="password-toggle"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {registering && strength && (
              <div className="strength-indicator" aria-live="polite">
                <div className="strength-bars">
                  <div className={`strength-bar ${strength.level === 'weak' || strength.level === 'medium' || strength.level === 'strong' ? strength.level : ''}`} />
                  <div className={`strength-bar ${strength.level === 'medium' || strength.level === 'strong' ? strength.level : ''}`} />
                  <div className={`strength-bar ${strength.level === 'strong' ? strength.level : ''}`} />
                </div>
                <span className={`strength-label ${strength.level}`}>{strength.label}</span>
              </div>
            )}
          </label>

          <button id="auth-submit-btn" className="primary-btn auth-submit" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <button
          id="auth-switch-btn"
          className="text-btn auth-switch"
          type="button"
          onClick={() => { setRegistering(!registering); setError(''); setPassword(''); }}
        >
          {registering ? 'Already have an account? Sign in' : 'New here? Create a free account'}
        </button>
        <p className="auth-footnote">Sessions last 7 days. No email or MFA configured for this local installation.</p>
      </div>
    </main>
  );
}

/* ─── Welcome Tour ─── */
function WelcomeTour({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="welcome-tour" aria-labelledby="tour-title">
      <div className="tour-heading">
        <div>
          <span className="eyebrow" style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.8px', color: 'var(--primary)', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>
            A quick tour
          </span>
          <h2 id="tour-title">Welcome to BachelorBudget</h2>
        </div>
        <button id="tour-close-btn" className="icon-action" aria-label="Close welcome tour" onClick={onDismiss}><X size={16} /></button>
      </div>
      <ol className="tour-steps">
        <li>
          <span>1</span>
          <div><b>Dashboard</b><p>See your income, expenses, and remaining budget in one place.</p></div>
        </li>
        <li>
          <span>2</span>
          <div><b>Transactions</b><p>Add the money you receive and every expense you make.</p></div>
        </li>
        <li>
          <span>3</span>
          <div><b>Budget</b><p>Set your monthly spending limit and track how much you have left.</p></div>
        </li>
      </ol>
      <p className="tour-roommates">
        💡 Want to share expenses? The <strong>Roommates</strong> section lets you record and split bills with others.
      </p>
      <div className="tour-actions">
        <button id="tour-start-btn" className="primary-btn" onClick={onDismiss}>Get started</button>
        <button id="tour-skip-btn" className="text-btn" onClick={onDismiss}>Skip tour</button>
      </div>
    </section>
  );
}

/* ─── Overview / Dashboard ─── */
function Overview({
  currency, month, summary, currentBalance, matchingAccounts, expenses, hasAnyTransactions, householdCount,
  hasAccounts, sharedExpenseCount, onEdit, onDelete, setTab, onAddExpense, onSetBudget, onOpenStatement,
}: {
  currency: Currency; month: string; summary: Summary; currentBalance: number; matchingAccounts: number;
  expenses: Expense[]; hasAnyTransactions: boolean; hasAccounts: boolean;
  householdCount: number; sharedExpenseCount: number;
  onEdit: (expense: Expense) => void; onDelete: (expense: Expense) => void;
  setTab: (tab: Tab) => void; onAddExpense: () => void; onSetBudget: () => void;
  onOpenStatement: () => void;
}) {
  const percent = Math.min(100, Math.max(0, summary.budgetUsedPercent));
  const progressClass = percent >= 100 ? 'danger' : percent >= summary.warningThreshold ? 'warn' : '';
  return (
    <>
      {/* Gamification / Streak Banner */}
      <div className="streak-banner">
        <div className="streak-tag">
          <Sparkles size={16} />
          {summary.budget > 0
            ? percent < (summary.warningThreshold || 80)
              ? `🔥 Under budget streak: ${summary.daysLeft} days left in ${monthLabel(month)}!`
              : percent >= 100
                ? `⚠️ Budget exceeded by ${money(Math.abs(summary.remaining ?? 0), currency)}!`
                : `👀 Approaching limit: ${Math.round(percent)}% spent with ${summary.daysLeft} days left!`
            : `🔥 ${expenses.length} transaction${expenses.length !== 1 ? 's' : ''} in ${monthLabel(month)}`
          }
        </div>
        <div className="streak-tip">
          {summary.budget > 0 && summary.dailyLimit && summary.remaining && summary.remaining > 0
            ? `Safe spending pace: ${money(summary.dailyLimit, currency)}/day`
            : 'Keep building smart financial habits!'}
        </div>
        <button className="outline-btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={onOpenStatement}>
          <Printer size={13} /> Statement (PDF)
        </button>
      </div>

      {/* Summary card */}
      <section className="panel dashboard-summary">
        <div className="dashboard-balance">
          <div className="eyebrow">Current balance · {currency}</div>
          <strong>{matchingAccounts ? money(currentBalance, currency) : '—'}</strong>
          <p>{matchingAccounts
            ? `Across ${matchingAccounts} manually recorded ${matchingAccounts === 1 ? 'account' : 'accounts'}.`
            : hasAccounts
              ? `No accounts use ${currency}. Select another currency or add an account in Settings.`
              : 'Add an account in Settings to track your starting balance.'}
          </p>
          {!matchingAccounts && <button className="balance-setup-btn" onClick={() => setTab('Settings')}>Set up starting balance</button>}
        </div>
        <div className="dashboard-metrics">
          <article>
            <span>Monthly income</span>
            <b>{money(summary.income, currency)}</b>
            <small>{monthLabel(month)}</small>
          </article>
          <article>
            <span>Monthly expenses</span>
            <b>{money(summary.total, currency)}</b>
            <small>{monthLabel(month)}</small>
          </article>
          <article>
            <span>Budget remaining</span>
            <b>{summary.budget > 0 ? money(summary.remaining ?? 0, currency) : 'Not set'}</b>
            <small>{summary.budget > 0 ? `of ${money(summary.budget, currency)}` : 'Set a monthly limit'}</small>
          </article>
        </div>
      </section>

      {/* Budget bar */}
      <section className="panel budget-quick">
        <div>
          <h2>Monthly budget</h2>
          <p>{summary.budget > 0
            ? `${money(summary.total, currency)} spent of ${money(summary.budget, currency)}`
            : 'Add a monthly limit to see how much remains.'}
          </p>
          {summary.budget > 0 && (
            <div className="progress-track" aria-label={`${Math.round(percent)}% of monthly budget used`} style={{ marginTop: 10 }}>
              <div className={`progress-fill ${progressClass}`} style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <button id="set-budget-btn" className="outline-btn" onClick={onSetBudget}>
          {summary.budget > 0 ? 'Edit budget' : 'Set budget'}
        </button>
      </section>

      {/* Recent transactions */}
      <section className="panel transactions-panel">
        <div className="panel-heading">
          <div><h2>Recent transactions</h2><p>{monthLabel(month)}</p></div>
          <div className="transaction-actions">
            <button className="text-btn" onClick={() => setTab('Transactions')}>View all <ArrowUpRight size={13} /></button>
            <button id="add-expense-btn" className="primary-btn" onClick={onAddExpense}><Plus size={15} /> Add</button>
          </div>
        </div>
        {expenses.length
          ? <Transactions
              expenses={expenses.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 5)}
              currency={currency} onEdit={onEdit} onDelete={onDelete}
            />
          : <EmptyState
              title={hasAnyTransactions ? `No transactions for ${monthLabel(month)}` : 'No transactions yet'}
              description={hasAnyTransactions
                ? 'Choose another month or add a transaction for this month.'
                : 'Add your first income or expense to start seeing your monthly totals.'}
            />
        }
      </section>
      <section className="panel dashboard-roommates">
        <div className="roommates-copy">
          <span className="round-icon"><Users size={16} /></span>
          <div>
            <h2>Roommate bills</h2>
            <p>{householdCount
              ? `${sharedExpenseCount} shared ${sharedExpenseCount === 1 ? 'bill' : 'bills'} recorded for ${monthLabel(month)}.`
              : 'Set up a household to split shared bills and keep track of who owes what.'}
            </p>
          </div>
        </div>
        <button className="outline-btn" onClick={() => setTab('Roommates')}>Open roommate bills <ArrowUpRight size={13} /></button>
      </section>
    </>
  );
}

/* ─── Transaction View ─── */
function TransactionView({
  title, description, expenses, filters, setFilters, onEdit, onDelete, onExport, currency, onOpenStatement,
}: {
  title: string; description: string; expenses: Expense[]; filters: Filters;
  currency: Currency;
  setFilters: (filters: Filters) => void; onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void; onExport: () => void;
  onOpenStatement: () => void;
}) {
  return (
    <section className="panel transactions-panel">
      <div className="panel-heading">
        <div><h2>{title}</h2><p>{description}</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="outline-btn" onClick={onOpenStatement}>
            <Printer size={14} /> Statement (PDF)
          </button>
          <button className="outline-btn" onClick={onExport} disabled={!expenses.length}>
            <Download size={14} /> Export CSV ({expenses.length})
          </button>
        </div>
      </div>
      <div className="filter-bar">
        <span className="filter-title"><Filter size={14} /> Filters</span>
        <label>From<input aria-label="Filter from date" type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>To<input aria-label="Filter to date" type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
        <label>Category
          <select aria-label="Filter category" value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}>
            <option value="">All categories</option>
            {CATEGORIES.map(cat => <option key={cat}>{cat}</option>)}
          </select>
        </label>
        <label>Payment
          <select aria-label="Filter payment mode" value={filters.paymentMode} onChange={e => setFilters({ ...filters, paymentMode: e.target.value })}>
            <option value="">All payment modes</option>
            {PAYMENT_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <label>Type
          <select aria-label="Filter type" value={filters.type} onChange={e => setFilters({ ...filters, type: e.target.value })}>
            <option value="">All types</option>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </label>
        <button className="text-btn" onClick={() => setFilters({ from: '', to: '', category: '', currency: '', type: '', paymentMode: '' })}>Clear</button>
      </div>
      <Transactions expenses={expenses} currency={currency} onEdit={onEdit} onDelete={onDelete} />
      {!expenses.length && <p className="no-results" role="status">No transactions match these filters.</p>}
    </section>
  );
}

/* ─── Shared / Roommates View ─── */
function SharedView({
  expenses, households, settlements, currency, onAdd, onCreateHousehold, onEdit, onDelete, onRefresh, onSettleViaUpi,
}: {
  expenses: Expense[]; households: Household[]; settlements: Array<{
    from: string; to: string; amount: number; currency: Currency; householdId: number | null; householdName: string | null;
  }>;
  currency: Currency; onAdd: () => void; onCreateHousehold: () => void;
  onEdit: (expense: Expense) => void; onDelete: (expense: Expense) => void;
  onRefresh: () => void;
  onSettleViaUpi: (settle: { from: string; to: string; amount: number; currency: Currency; householdId: number | null; householdName: string | null }) => void;
}) {
  return (
    <>
      <section className="panel transactions-panel">
        <div className="panel-heading">
          <div><h2>Roommate expenses</h2><p>Local bill tracking — does not sync to others.</p></div>
          <div className="transaction-actions">
            <button className="outline-btn" onClick={onCreateHousehold}><Users size={14} /> New household</button>
            <button className="primary-btn" onClick={onAdd}><Plus size={15} /> Add shared bill</button>
          </div>
        </div>
        <HouseholdSharing households={households} onJoined={onRefresh} />
        {households.length > 0 && (
          <div className="household-list">
            {households.map(g => (
              <div className="household-chip" key={g.id}><Users size={14} /><b>{g.name}</b><span>{g.members.join(', ')}</span></div>
            ))}
          </div>
        )}
        {expenses.length > 0 && (
          <div className="shared-summary">
            <Users size={18} />
            <div>
              <b>{expenses.length} shared bill{expenses.length !== 1 ? 's' : ''} this month</b>
              <span>Your personal share is counted separately in dashboard totals.</span>
            </div>
          </div>
        )}
        <Transactions expenses={expenses} currency={currency} onEdit={onEdit} onDelete={onDelete} />
      </section>
      <section className="panel settlement-panel">
        <div className="panel-heading">
          <div><h2>Roommate balances</h2><p>Calculated from recorded payments and shares.</p></div>
        </div>
        {settlements.length
          ? <div className="settlement-list">{settlements.map((s, i) => (
              <div className="settlement-row" key={`${s.householdId}-${s.currency}-${s.from}-${s.to}-${i}`}>
                <div>
                  <span>{s.from} owes <b>{s.to}</b></span>
                  {s.householdName && <small>{s.householdName}</small>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong>{money(s.amount, s.currency)}</strong>
                  <button
                    type="button"
                    className="btn-upi-action btn-upi-pay"
                    onClick={() => onSettleViaUpi(s)}
                    title="Pay or settle via UPI"
                  >
                    <QrCode size={13} /> Settle via UPI
                  </button>
                </div>
              </div>
            ))}</div>
          : <EmptyState title="All settled up" description="Add a shared bill with participant shares to calculate roommate balances." />
        }
      </section>
    </>
  );
}

/* ─── Household Sharing ─── */
function HouseholdSharing({ households, onJoined }: { households: Household[]; onJoined: () => void }) {
  const [emails, setEmails] = useState<Record<number, string>>({});
  const [joinToken, setJoinToken] = useState('');
  const [invite, setInvite] = useState<{ householdName: string; invitationToken: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const inviteMember = async (event: FormEvent<HTMLFormElement>, household: Household) => {
    event.preventDefault();
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ householdName: string; invitationToken: string }>(`/households/${household.id}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email: emails[household.id] }),
      });
      setInvite(result);
      setEmails({ ...emails, [household.id]: '' });
      setNotice('Invitation token created. Share it manually — it expires in 7 days.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not invite this account.');
    } finally {
      setWorking(false);
    }
  };
  const joinHousehold = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await api('/households/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ invitationToken: joinToken.trim() }),
      });
      setJoinToken('');
      setNotice('You joined the household!');
      onJoined();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not accept this invitation.');
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="household-sharing">
      <div className="household-invite-grid">
        {households.filter(g => g.my_role === 'owner').map(g => (
          <form key={g.id} onSubmit={e => void inviteMember(e, g)}>
            <label>Invite to {g.name}
              <div className="household-invite-controls">
                <input type="email" required maxLength={254} placeholder="roommate@example.com"
                  value={emails[g.id] ?? ''} onChange={e => setEmails({ ...emails, [g.id]: e.target.value })} />
                <button className="outline-btn" disabled={working}>Create invite</button>
              </div>
            </label>
          </form>
        ))}
        <form onSubmit={e => void joinHousehold(e)}>
          <label>Join with a token
            <div className="household-invite-controls">
              <input required minLength={32} maxLength={100} value={joinToken}
                onChange={e => setJoinToken(e.target.value)} placeholder="Paste one-time token" />
              <button className="outline-btn" disabled={working}>Join</button>
            </div>
          </label>
        </form>
      </div>
      {invite && (
        <div className="invitation-token">
          <b>One-time invitation for {invite.householdName}</b>
          <code>{invite.invitationToken}</code>
          <button className="text-btn" onClick={() => void navigator.clipboard.writeText(invite.invitationToken)}>Copy token</button>
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="success-banner" role="status">{notice}</div>}
      <p className="field-hint">Invitations match the registered email and expire after 7 days. No email delivery is configured.</p>
    </section>
  );
}

function MonthlyBudgetView({ month, currency, summary, onEditBudget }: {
  month: string; currency: Currency; summary: Summary; onEditBudget: () => void;
}) {
  const hasBudget = summary.budget > 0;
  const percent = Math.min(100, Math.max(0, summary.budgetUsedPercent));
  return (
    <section className="panel budget-panel">
      <div className="panel-heading">
        <div><h2>Monthly budget</h2><p>{monthLabel(month)}</p></div>
        <span className="round-icon"><Wallet size={16} /></span>
      </div>
      {hasBudget ? <>
        <div className="budget-number">{money(summary.total, currency)} <span>spent of {money(summary.budget, currency)}</span></div>
        <div className="budget-bar" role="progressbar" aria-label="Monthly budget used"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><div style={{ width: `${percent}%` }} /></div>
        <div className="budget-foot"><span>{Math.round(percent)}% used</span><b>{money(summary.remaining ?? 0, currency)} remaining</b></div>
      </> : <EmptyState title="No monthly budget set" description="Choose a monthly spending limit to see how much remains after your recorded expenses." />}
      <button className="outline-btn full-btn" onClick={onEditBudget}>{hasBudget ? 'Edit monthly budget' : 'Set monthly budget'}</button>
    </section>
  );
}

function StartingBalanceView({ accounts, onChanged }: { accounts: Account[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('INR');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingDate, setOpeningDate] = useState(today());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), currency, openingBalance: Number(openingBalance || 0), openingDate }),
      });
      setName('');
      setOpeningBalance('');
      setNotice('Starting balance added.');
      onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save this starting balance.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="account-view">
      {notice && <div className="success-banner" role="status">{notice}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <section className="account-balance-grid">
        {accounts.map(account => <article className="panel account-card" key={account.id}>
          <span className="eyebrow">{account.currency} ACCOUNT</span>
          <h2>{account.name}</h2>
          <strong>{money(account.currentBalance, account.currency)}</strong>
          <small>Starting balance {money(account.openingBalance, account.currency)} · {account.openingDate}</small>
        </article>)}
        {!accounts.length && <div className="panel account-empty"><EmptyState title="No accounts yet" description="Add an optional starting balance to see your current balance on the dashboard. It is entered manually, not verified with a bank." /></div>}
      </section>
      <section className="account-forms-grid">
        <form className="panel modal-form" onSubmit={event => void addAccount(event)}>
          <h2>Add a starting balance</h2>
          <label>Account name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Everyday account" /></label>
          <div className="form-row">
            <label>Currency<select value={currency} onChange={event => setCurrency(event.target.value as Currency)}>{CURRENCIES.map(code => <option key={code}>{code}</option>)}</select></label>
            <label>Starting balance<input type="number" min="0" max="100000000" step="0.01" value={openingBalance} onChange={event => setOpeningBalance(event.target.value)} placeholder="0.00" /></label>
          </div>
          <label>Starting balance date<input type="date" required value={openingDate} onChange={event => setOpeningDate(event.target.value)} /></label>
          <p className="field-hint">This is manually supplied and is not verified with a bank.</p>
          <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add starting balance'}</button>
        </form>
      </section>
    </div>
  );
}

/* ─── Budget & Goals ─── */
function BudgetGoalView({
  month, currency, summary, monthlyBudget, budgets, goals,
  onEditBudget, onSetCategoryBudget, onDeleteBudget, onAddGoal, onEditGoal, onDeleteGoal,
}: {
  month: string; currency: Currency; summary: Summary; monthlyBudget: number; budgets: CategoryBudget[]; goals: Goal[];
  onEditBudget: () => void; onSetCategoryBudget: () => void; onDeleteBudget: (budget: CategoryBudget) => void;
  onAddGoal: () => void; onEditGoal: (goal: Goal) => void; onDeleteGoal: (goal: Goal) => void;
}) {
  return (
    <>
      <div className="goal-top-grid">
        <div className="panel budget-panel">
          <div className="panel-heading">
            <div><h2>Monthly budget</h2><p>{monthLabel(month)} · INR base</p></div>
            <span className="round-icon"><Wallet size={16} /></span>
          </div>
          <div className="budget-number">
            {money(summary.total, currency)} <span>{summary.budget > 0 ? `of ${money(summary.budget, currency)}` : '· no budget set'}</span>
          </div>
          <div className="budget-bar"><div style={{ width: `${Math.min(100, Math.max(0, summary.budgetUsedPercent))}%` }} /></div>
          <div className="budget-foot">
            <span>{summary.budget > 0 ? `${Math.round(summary.budgetUsedPercent)}% used` : 'No limit set'}</span>
            <b>{summary.remaining === null ? 'Set a budget to see remaining' : `${money(summary.remaining, currency)} remaining`}</b>
          </div>
          <button className="outline-btn full-btn" onClick={onEditBudget}>Edit monthly budget</button>
          {summary.warnings.some(w => w.category === null) && (
            <div className="alert-state" role="status">
              {summary.warnings.find(w => w.category === null)?.status === 'limit'
                ? 'Monthly limit reached.'
                : `Warning: ${summary.warningThreshold}% of budget used.`}
            </div>
          )}
        </div>
        <div className="panel budget-panel">
          <div className="panel-heading">
            <div><h2>Category limits</h2><p>{monthLabel(month)}</p></div>
            <button className="outline-btn" onClick={onSetCategoryBudget}><Plus size={14} /> Add</button>
          </div>
          {budgets.length
            ? <div className="category-budget-list">{budgets.map(budget => {
                const spentAmt = summary.byCategory[budget.category] ?? 0;
              const budgetAmount = summary.categoryBudgetAmounts[budget.category] ?? budget.amount;
              const pct = budgetAmount ? spentAmt / budgetAmount * 100 : 0;
              const status = pct >= 100 ? 'limit' : pct >= summary.warningThreshold ? 'warning' : 'ok';
                const statusLabel = status === 'limit' ? 'Limit reached' : status === 'warning' ? 'Near limit' : 'Within limit';
                return (
                  <div className="category-budget-item" key={budget.id}>
                    <div>
                      <div style={{ flex: 1 }}>
                        <b>{budget.category}</b>
                        <span>{money(spentAmt, currency)} spent · {money(budgetAmount, currency)} limit · {Math.round(pct)}%</span>
                      </div>
                      <span className={`budget-status status-${status}`}>{statusLabel}</span>
                      <button className="delete-btn" aria-label={`Remove ${budget.category} budget`} onClick={() => onDeleteBudget(budget)}><Trash2 size={14} /></button>
                    </div>
                    <div className="budget-bar"><div style={{ width: `${Math.min(100, pct)}%` }} /></div>
                  </div>
                );
              })}</div>
            : <EmptyState title="No category limits yet" description="Set category-specific limits to monitor your spending." />
          }
        </div>
      </div>
      <section className="panel goals-panel">
        <div className="panel-heading">
          <div><h2>Savings goals</h2><p>Goals are tracked separately from your budget totals.</p></div>
          <button className="primary-btn" onClick={onAddGoal}><Plus size={15} /> Add goal</button>
        </div>
        {goals.length
          ? <div className="goals-grid">{goals.map((goal, index) => {
              const progress = Math.min(100, goal.saved / goal.target * 100);
              return (
                <div className="goal-card" key={goal.id}>
                  <div className={`goal-illustration goal-color-${(index % 3) + 1}`}><Target size={20} /></div>
                  <div className="goal-info">
                    <b>{goal.name}</b>
                    <span>{money(goal.saved, goal.currency)} of {money(goal.target, goal.currency)}</span>
                    <div className="goal-progress"><div style={{ width: `${progress}%` }} /></div>
                    <small>{Math.round(progress)}% · {money(Math.max(0, goal.target - goal.saved), goal.currency)} to go</small>
                  </div>
                  <button className="icon-action" aria-label={`Update ${goal.name}`} onClick={() => onEditGoal(goal)}><Pencil size={14} /></button>
                  <button className="delete-btn" aria-label={`Remove ${goal.name}`} onClick={() => onDeleteGoal(goal)}><Trash2 size={14} /></button>
                </div>
              );
            })}</div>
          : <EmptyState title="No savings goals yet" description="Create a goal to track your progress towards something important." />
        }
      </section>
    </>
  );
}

/* ─── Transactions List ─── */
function Transactions({
  expenses, currency, onEdit, onDelete,
}: {
  expenses: Expense[]; currency: Currency; onEdit: (expense: Expense) => void; onDelete: (expense: Expense) => void;
}) {
  if (!expenses.length) return <EmptyState title="No transactions yet" description="Add a transaction to get started." />;
  return (
    <div className="transaction-list">
      {expenses.map((expense, index) => (
        <div className="transaction-row" key={expense.id}>
          <div className={`transaction-icon ${expense.type === 'income' ? 'tx-income' : expense.shared ? 'tx-shared' : `tx-${index % 5}`}`}>
            {CATEGORY_EMOJIS[expense.category] ? (
              <span style={{ fontSize: 16 }}>{CATEGORY_EMOJIS[expense.category]}</span>
            ) : expense.type === 'income' ? (
              <ArrowDownRight size={16} />
            ) : expense.shared ? (
              <Users size={16} />
            ) : (
              <ReceiptText size={16} />
            )}
          </div>
          <div className="transaction-name">
            <b>
              {expense.title}
              {expense.shared && <span className="shared-pill">SHARED</span>}
              <span className={`type-pill type-${expense.type}`}>{expense.type}</span>
              <span className="payment-pill">{expense.paymentMode === 'UPI' && expense.upiApp ? expense.upiApp : (expense.paymentMode || 'UPI')}</span>
            </b>
            <span>{expense.category} · {expense.date}{expense.note ? ` · ${expense.note}` : ''}</span>
            {expense.shared && (
              <small>Paid by {expense.payer || 'Me'} · your share: {money(sharesForExpense(expense).find(s => s.name.toLowerCase() === 'me')?.amount ?? 0, expense.currency)}</small>
            )}
          </div>
          <div className={`transaction-amount ${expense.type === 'income' ? 'income-amount' : ''}`}>
            <b>{expense.type === 'income' ? '+' : '−'}{money(expense.amount, expense.currency)}</b>
            <span>{expense.currency !== currency ? `Original ${expense.currency}` : ''}</span>
          </div>
          <div className="transaction-actions">
            <button className="icon-action" aria-label={`Edit ${expense.title}`} onClick={() => onEdit(expense)}><Pencil size={14} /></button>
            <button className="delete-btn" aria-label={`Delete ${expense.title}`} onClick={() => onDelete(expense)}><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Empty State ─── */
function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <ReceiptText size={30} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

/* ─── Account View ─── */
function AccountView({
  accounts, transfers, onChanged,
}: {
  accounts: Account[]; transfers: Transfer[]; onChanged: () => void;
}) {
  const [accountForm, setAccountForm] = useState({ name: '', currency: 'INR' as Currency, openingBalance: '', openingDate: today() });
  const [transferForm, setTransferForm] = useState({ fromAccountId: '', toAccountId: '', amount: '', date: today(), note: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setWorking(true);
    try {
      await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: accountForm.name.trim(),
          currency: accountForm.currency,
          openingBalance: Number(accountForm.openingBalance || 0),
          openingDate: accountForm.openingDate,
        }),
      });
      setAccountForm({ ...accountForm, name: '', openingBalance: '' });
      setNotice('Account added.');
      onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not add account.');
    } finally {
      setWorking(false);
    }
  };
  const addTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setWorking(true);
    try {
      await api('/transfers', {
        method: 'POST',
        body: JSON.stringify({
          fromAccountId: Number(transferForm.fromAccountId),
          toAccountId: Number(transferForm.toAccountId),
          amount: Number(transferForm.amount),
          date: transferForm.date,
          note: transferForm.note.trim(),
        }),
      });
      setTransferForm({ ...transferForm, amount: '', note: '' });
      setNotice('Transfer recorded.');
      onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record transfer.');
    } finally {
      setWorking(false);
    }
  };
  const removeTransfer = async (transfer: Transfer) => {
    if (!window.confirm(`Delete the ${money(transfer.amount, transfer.currency)} transfer?`)) return;
    try {
      await api(`/transfers/${transfer.id}`, { method: 'DELETE' });
      setNotice('Transfer removed.');
      onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete transfer.');
    }
  };
  return (
    <div className="account-view">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="success-banner" role="status">{notice}</div>}
      <section className="account-balance-grid">
        {accounts.map(account => (
          <article className="panel account-card" key={account.id}>
            <div className="mini-icon green"><Wallet size={16} /></div>
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--subtle)', textTransform: 'uppercase' }}>{account.currency} account</span>
            <h2>{account.name}</h2>
            <strong>{money(account.currentBalance, account.currency)}</strong>
            <small>Opening {money(account.openingBalance, account.currency)} on {account.openingDate}</small>
          </article>
        ))}
        {!accounts.length && <div className="panel account-empty"><EmptyState title="No accounts yet" description="Create an account with an optional opening balance." /></div>}
      </section>
      <section className="account-forms-grid">
        <form className="panel modal-form" onSubmit={e => void addAccount(e)}>
          <h2>Add an account</h2>
          <label>Account name<input required maxLength={80} value={accountForm.name} onChange={e => setAccountForm({ ...accountForm, name: e.target.value })} placeholder="e.g. Main bank account" /></label>
          <div className="form-row">
            <label>Currency<select value={accountForm.currency} onChange={e => setAccountForm({ ...accountForm, currency: e.target.value as Currency })}>{CURRENCIES.map(code => <option key={code}>{code}</option>)}</select></label>
            <label>Opening balance<input type="number" min="0" max="100000000" step="0.01" value={accountForm.openingBalance} onChange={e => setAccountForm({ ...accountForm, openingBalance: e.target.value })} placeholder="0.00" /></label>
          </div>
          <label>Opening date<input type="date" required value={accountForm.openingDate} onChange={e => setAccountForm({ ...accountForm, openingDate: e.target.value })} /></label>
          <p className="field-hint">This is a manually supplied balance, not a verified bank balance.</p>
          <button className="primary-btn" disabled={working}>Save account</button>
        </form>
        <form className="panel modal-form" onSubmit={e => void addTransfer(e)}>
          <h2>Record a transfer</h2>
          <label>From account<select required value={transferForm.fromAccountId} onChange={e => setTransferForm({ ...transferForm, fromAccountId: e.target.value })}><option value="">Choose account</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
          <label>To account<select required value={transferForm.toAccountId} onChange={e => setTransferForm({ ...transferForm, toAccountId: e.target.value })}><option value="">Choose account</option>{accounts.filter(a => a.id !== Number(transferForm.fromAccountId)).map(a => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select></label>
          <div className="form-row">
            <label>Amount<input type="number" required min="0.01" max="100000000" step="0.01" value={transferForm.amount} onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })} /></label>
            <label>Date<input type="date" required value={transferForm.date} onChange={e => setTransferForm({ ...transferForm, date: e.target.value })} /></label>
          </div>
          <label>Note (optional)<input maxLength={300} value={transferForm.note} onChange={e => setTransferForm({ ...transferForm, note: e.target.value })} /></label>
          <p className="field-hint">Same-currency only. Transfers are not counted as income or expenses.</p>
          <button className="primary-btn" disabled={working || accounts.length < 2}>Save transfer</button>
        </form>
      </section>
      {transfers.length > 0 && (
        <section className="panel transfer-history">
          <h2>Transfer history</h2>
          <div className="transaction-list">
            {transfers.map(transfer => (
              <div className="transaction-row" key={transfer.id}>
                <div className="transaction-icon tx-shared"><ArrowUpRight size={16} /></div>
                <div className="transaction-name">
                  <b>{transfer.fromAccountName} → {transfer.toAccountName}</b>
                  <span>{transfer.date}{transfer.note ? ` · ${transfer.note}` : ''}</span>
                </div>
                <div className="transaction-amount"><b>{money(transfer.amount, transfer.currency)}</b></div>
                <button className="delete-btn" aria-label={`Delete transfer ${transfer.id}`} onClick={() => void removeTransfer(transfer)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ─── CSV Import Panel ─── */
function CsvImportPanel({ onImported }: { onImported: (count: number, duplicates: number) => void }) {
  type Preview = {
    batchToken: string;
    validCount: number;
    errors: Array<{ line: number; error: string }>;
    rows: Array<{ line: number; title: string; amount: number; currency: Currency; category: string; date: string; type: 'expense' | 'income' }>;
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [fileName, setFileName] = useState('');
  const inspectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPreview(null);
    setError('');
    if (file.size > 2_000_000) { setError('CSV file exceeds the 2 MB limit.'); return; }
    setWorking(true);
    setFileName(file.name);
    try {
      const result = await api<Preview & { errors: Preview['errors'] }>('/imports/csv/preview', {
        method: 'POST',
        body: JSON.stringify({ csv: await file.text() }),
      });
      setPreview(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not read this CSV file.');
    } finally {
      setWorking(false);
    }
  };
  const confirmImport = async () => {
    if (!preview) return;
    setWorking(true);
    setError('');
    try {
      const result = await api<{ imported: number; duplicates: number }>('/imports/csv/confirm', {
        method: 'POST',
        body: JSON.stringify({ batchToken: preview.batchToken }),
      });
      onImported(result.imported, result.duplicates);
      setPreview(null);
      setFileName('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not import these transactions.');
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="panel csv-import-panel">
      <div className="panel-heading">
        <div><h2>Import a bank statement</h2><p>CSV only. No bank credentials used.</p></div>
        <label className="outline-btn csv-file-button">
          {working ? 'Reading…' : 'Choose CSV file'}
          <input type="file" accept=".csv,text/csv" disabled={working} onChange={e => void inspectFile(e)} />
        </label>
      </div>
      <p className="field-hint">Required columns: date, description, amount, currency, category. Add a type column or use negative/positive values.</p>
      {fileName && <p className="field-hint">Selected: {fileName}</p>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {preview && <>
        <p className="import-summary" role="status">{preview.validCount} valid row(s) ready.</p>
        {!!preview.errors.length && <ul className="import-errors">{preview.errors.slice(0, 8).map(item => <li key={item.line}>Line {item.line}: {item.error}</li>)}</ul>}
        <div className="import-preview-list">
          {preview.rows.slice(0, 8).map(row => (
            <div key={row.line}>
              <span>Line {row.line} · {row.date} · {row.title} · {row.category} · {row.type}</span>
              <b>{money(row.amount, row.currency)} {row.currency}</b>
            </div>
          ))}
        </div>
        {preview.rows.length > 8 && <p className="field-hint">Showing 8 of {preview.rows.length} valid rows.</p>}
        <button className="primary-btn" disabled={working} onClick={() => void confirmImport()}>
          {working ? 'Importing…' : `Confirm import (${preview.validCount})`}
        </button>
      </>}
    </section>
  );
}

export default App;
