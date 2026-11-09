import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { config as loadEnv } from 'dotenv';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENCIES,
  PAYMENT_MODES,
  calculateDailySpending,
  calculateMonthlySpending,
  calculatePaymentModeSpending,
  calculateSettlements,
  convertCurrency,
  dateKeyLocal,
  daysRemainingInMonth,
  getBudgetStatus,
  monthBounds,
  personalShare,
  splitEqual,
  validateShares,
  type Currency,
  type ParticipantShare,
  type PaymentMode,
} from './domain.js';
import {
  checkSupabaseConnection,
  syncTransactionToSupabase,
  syncSettlementToSupabase,
} from './supabase.js';
import { parseNaturalSpend } from './parser.js';

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const DEFAULT_WARNING_THRESHOLD = 80;
const SESSION_COOKIE = 'bachelorbudget_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const currencySchema = z.enum(CURRENCIES);
const moneySchema = z.number().finite().positive().max(100_000_000)
  .refine(amount => Math.abs(Math.round(amount * 100) - amount * 100) < 1e-7, 'Amount can have at most two decimal places');
const nonNegativeMoneySchema = z.number().finite().min(0).max(100_000_000)
  .refine(amount => Math.abs(Math.round(amount * 100) - amount * 100) < 1e-7, 'Amount can have at most two decimal places');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Date must be a real calendar date in YYYY-MM-DD format');
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function cookieValue(req: express.Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator >= 0 && item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return null;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === 'true';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type ImportedCsvRow = {
  line: number;
  title: string;
  amount: number;
  currency: Currency;
  category: string;
  date: string;
  note: string;
  type: 'expense' | 'income';
  importKey: string;
};

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some(value => value.trim())) records.push(record);
      record = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field');
  if (field.length || record.length) {
    record.push(field);
    if (record.some(value => value.trim())) records.push(record);
  }
  return records;
}

function parseBankCsv(text: string, userId: number): {
  rows: ImportedCsvRow[];
  errors: Array<{ line: number; error: string }>;
} {
  if (Buffer.byteLength(text, 'utf8') > 2_000_000) throw new Error('CSV file exceeds the 2 MB limit');
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new Error('CSV must contain a header row and at least one transaction');
  if (records.length > 5001) throw new Error('CSV is limited to 5,000 transaction rows');
  const headers = records[0].map(header => header.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const column = (...names: string[]) => headers.findIndex(header => names.includes(header));
  const dateIndex = column('date', 'transaction_date');
  const titleIndex = column('description', 'title', 'transaction', 'narration');
  const amountIndex = column('amount');
  const currencyIndex = column('currency');
  const categoryIndex = column('category');
  const typeIndex = column('type');
  const noteIndex = column('notes', 'note', 'reference');
  if ([dateIndex, titleIndex, amountIndex, currencyIndex, categoryIndex].some(index => index < 0)) {
    throw new Error('CSV headers must include date, description, amount, currency, and category');
  }
  const digest = createHash('sha256').update(text).digest('hex');
  const rows: ImportedCsvRow[] = [];
  const errors: Array<{ line: number; error: string }> = [];
  records.slice(1).forEach((record, index) => {
    const line = index + 2;
    const fail = (error: string) => errors.push({ line, error });
    if (record.length !== headers.length) {
      fail('Column count does not match the header row');
      return;
    }
    const date = dateSchema.safeParse(record[dateIndex].trim());
    const title = record[titleIndex].trim();
    const category = record[categoryIndex].trim();
    const currency = currencySchema.safeParse(record[currencyIndex].trim().toUpperCase());
    const numeric = record[amountIndex].trim().replace(/,/g, '');
    const amountValue = Number(numeric);
    if (!date.success) { fail('Date must be a real date in YYYY-MM-DD format'); return; }
    if (!title || title.length > 100) { fail('Description must contain 1–100 characters'); return; }
    if (!category || category.length > 40) { fail('Category must contain 1–40 characters'); return; }
    if (!currency.success) { fail('Currency must be one of INR, USD, EUR, GBP, AED, CAD, or AUD'); return; }
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(numeric) || !Number.isFinite(amountValue) || amountValue === 0 || Math.abs(amountValue) > 100_000_000) {
      fail('Amount must be non-zero and have at most two decimal places');
      return;
    }
    let type: 'expense' | 'income';
    if (typeIndex >= 0) {
      const rawType = record[typeIndex].trim().toLowerCase();
      if (['income', 'credit', 'deposit'].includes(rawType)) type = 'income';
      else if (['expense', 'debit', 'withdrawal'].includes(rawType)) type = 'expense';
      else { fail('Type must be expense/income (or debit/credit)'); return; }
    } else {
      if (amountValue > 0) { fail('Add a type column or use negative expenses and positive income'); return; }
      type = amountValue > 0 ? 'income' : 'expense';
    }
    const note = noteIndex >= 0 ? record[noteIndex].trim() : '';
    if (note.length > 300) { fail('Notes may not exceed 300 characters'); return; }
    rows.push({
      line,
      title,
      amount: Math.abs(amountValue),
      currency: currency.data,
      category,
      date: date.data,
      note,
      type,
      importKey: createHash('sha256').update(`${userId}:${digest}:${line}`).digest('hex'),
    });
  });
  return { rows, errors };
}

type RateRow = { currency: Currency; inr_per_unit: number; source: string; rate_date: string; fetched_at: number };

async function loadExchangeRates(db: Database.Database, currencies: Currency[]): Promise<{
  rates: Map<Currency, number>;
  warning: string;
  source: string;
  rateDate: string;
  fetchedAt: number | null;
}> {
  const requested: Currency[] = [...new Set<Currency>(['INR', ...currencies])];
  const now = Date.now();
  const cached = db.prepare(`SELECT currency,inr_per_unit,source,rate_date,fetched_at FROM exchange_rates
    WHERE currency IN (${requested.map(() => '?').join(',')})`).all(...requested) as RateRow[];
  const cacheByCurrency = new Map(cached.map(row => [row.currency, row]));
  const completeCache = requested.every(currency => cacheByCurrency.has(currency));
  const latestFetchedAt = cached.length ? Math.min(...cached.map(row => row.fetched_at)) : null;
  const providerUrl = process.env.FX_API_URL?.trim().replace(/\/+$/, '');
  const cacheMatchesConfiguredProvider = !providerUrl || cached.every(row => row.source === providerUrl);
  const cacheIsFresh = completeCache && cacheMatchesConfiguredProvider
    && latestFetchedAt !== null && now - latestFetchedAt < 24 * 60 * 60 * 1000;
  if (cacheIsFresh) {
    return {
      rates: new Map(cached.map(row => [row.currency, row.inr_per_unit])),
      warning: '',
      source: cached[0].source,
      rateDate: cached[0].rate_date,
      fetchedAt: latestFetchedAt,
    };
  }

  if (providerUrl) {
    try {
      const symbols = requested.filter(currency => currency !== 'INR').join(',');
      const url = `${providerUrl}/latest?base=INR&symbols=${encodeURIComponent(symbols)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const body = await response.json() as { base?: string; date?: string; rates?: Record<string, unknown> };
      if (body.base !== 'INR' || !body.rates || !body.date) throw new Error('Provider response did not include INR-based dated rates');
      const fetchedAt = Date.now();
      const result = new Map<Currency, number>([['INR', 1]]);
      const save = db.prepare(`INSERT INTO exchange_rates(currency,inr_per_unit,source,rate_date,fetched_at) VALUES(?,?,?,?,?)
        ON CONFLICT(currency) DO UPDATE SET inr_per_unit=excluded.inr_per_unit,source=excluded.source,rate_date=excluded.rate_date,fetched_at=excluded.fetched_at`);
      const persist = db.transaction(() => {
        save.run('INR', 1, providerUrl, body.date, fetchedAt);
        for (const currency of requested.filter(code => code !== 'INR')) {
          const unitsPerInr = Number(body.rates?.[currency]);
          if (!Number.isFinite(unitsPerInr) || unitsPerInr <= 0) {
            throw new Error(`Provider did not return a valid ${currency} rate`);
          }
          const inrPerUnit = 1 / unitsPerInr;
          result.set(currency, inrPerUnit);
          save.run(currency, inrPerUnit, providerUrl, body.date, fetchedAt);
        }
      });
      persist();
      return { rates: result, warning: '', source: providerUrl, rateDate: body.date, fetchedAt };
    } catch (error) {
      if (!completeCache) {
        const reason = error instanceof Error ? error.message : 'unknown provider error';
        throw new Error(`Exchange rates are required for these currencies but could not be retrieved (${reason}). Configure FX_API_URL or select one transaction currency.`);
      }
    }
  }

  if (!completeCache) {
    throw new Error('Exchange rates are required to combine these currencies. Configure FX_API_URL or select one transaction currency.');
  }
  const sourceSet = new Set(cached.map(row => row.source));
  return {
    rates: new Map(cached.map(row => [row.currency, row.inr_per_unit])),
    warning: 'Exchange-rate provider is unavailable or unconfigured; using stale cached rates. Verify before relying on converted totals.',
    source: sourceSet.size === 1 ? cached[0].source : 'multiple cached sources',
    rateDate: latestFetchedAt === null ? '' : cached[0].rate_date,
    fetchedAt: latestFetchedAt,
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error('Stored application data is invalid JSON', { cause: error });
  }
}

function columnsFor(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
}

export function initializeDatabase(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion > 8) {
    throw new Error(`Database schema version ${currentVersion} is newer than this application supports`);
  }
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      shared INTEGER NOT NULL DEFAULT 0,
      people TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL DEFAULT 'expense',
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target REAL NOT NULL,
      saved REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'INR',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      UNIQUE(month, category)
    );
    CREATE TABLE IF NOT EXISTS settlement_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      upi_reference TEXT,
      note TEXT NOT NULL DEFAULT '',
      settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const expenseColumns = columnsFor(db, 'expenses');
  for (const [column, type] of Object.entries({
    payer: "TEXT NOT NULL DEFAULT 'Me'",
    split_method: "TEXT NOT NULL DEFAULT 'equal'",
    shares: "TEXT NOT NULL DEFAULT '[]'",
    household_id: 'INTEGER',
    payment_mode: "TEXT NOT NULL DEFAULT 'UPI'",
    upi_app: 'TEXT',
    upi_reference: 'TEXT',
  })) {
    if (!expenseColumns.has(column)) db.exec(`ALTER TABLE expenses ADD COLUMN ${column} ${type}`);
  }
  if (currentVersion < 3) {
    if (!expenseColumns.has('type')) db.exec("ALTER TABLE expenses ADD COLUMN type TEXT NOT NULL DEFAULT 'expense'");
    if (!expenseColumns.has('source')) db.exec("ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    if (!expenseColumns.has('updated_at')) {
      db.exec('ALTER TABLE expenses ADD COLUMN updated_at TEXT');
      db.exec('UPDATE expenses SET updated_at=created_at WHERE updated_at IS NULL');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_expenses_date_type ON expenses(date, type);
    `);
  }
  if (currentVersion < 4) {
    const migrateOwnership = db.transaction(() => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE auth_rate_limits (
          bucket TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL,
          window_started_at INTEGER NOT NULL
        );
      `);
      for (const table of ['expenses', 'goals', 'households', 'budgets']) {
        if (!columnsFor(db, table).has('user_id')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id)`);
        }
      }
      db.exec(`
        ALTER TABLE budgets RENAME TO budgets_legacy_v3;
        CREATE TABLE budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          month TEXT NOT NULL,
          category TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          user_id INTEGER REFERENCES users(id),
          UNIQUE(user_id,month,category)
        );
        INSERT INTO budgets(id,month,category,amount,currency,user_id)
          SELECT id,month,category,amount,currency,user_id FROM budgets_legacy_v3;
        DROP TABLE budgets_legacy_v3;
      `);
      if (!columnsFor(db, 'settings').has('user_id')) {
        db.exec(`
          ALTER TABLE settings RENAME TO settings_legacy_v3;
          CREATE TABLE settings (
            user_id INTEGER REFERENCES users(id),
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(user_id, key)
          );
          INSERT INTO settings(user_id,key,value) SELECT NULL,key,value FROM settings_legacy_v3;
          DROP TABLE settings_legacy_v3;
        `);
      }
      db.exec(`
        CREATE INDEX idx_expenses_user_date ON expenses(user_id,date);
        CREATE INDEX idx_goals_user ON goals(user_id);
        CREATE INDEX idx_households_user ON households(user_id);
        CREATE INDEX idx_budgets_user_month ON budgets(user_id,month);
      `);
    });
    migrateOwnership();
  }
  if (currentVersion < 5) {
    const migrateImports = db.transaction(() => {
      if (!columnsFor(db, 'expenses').has('import_key')) {
        db.exec('ALTER TABLE expenses ADD COLUMN import_key TEXT');
      }
      db.exec(`
        CREATE UNIQUE INDEX idx_expenses_user_import_key
          ON expenses(user_id,import_key) WHERE import_key IS NOT NULL;
        CREATE TABLE csv_import_batches (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rows_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    });
    migrateImports();
  }
  if (currentVersion < 6) {
    db.exec(`CREATE TABLE exchange_rates (
      currency TEXT PRIMARY KEY,
      inr_per_unit REAL NOT NULL,
      source TEXT NOT NULL,
      rate_date TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
  }
  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE household_members (
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','member')),
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(household_id,user_id)
      );
      CREATE TABLE household_invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        inviter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_email TEXT NOT NULL COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_household_members_user ON household_members(user_id,household_id);
      CREATE INDEX idx_household_invitations_household ON household_invitations(household_id,expires_at);
      INSERT INTO household_members(household_id,user_id,role)
        SELECT id,user_id,'owner' FROM households WHERE user_id IS NOT NULL;
    `);
  }
  if (currentVersion < 8) {
    const migrateAccounts = db.transaction(() => {
      db.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          currency TEXT NOT NULL,
          opening_balance REAL NOT NULL DEFAULT 0 CHECK(opening_balance >= 0),
          opening_date TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id,name)
        );
        CREATE TABLE transfers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          from_account_id INTEGER NOT NULL REFERENCES accounts(id),
          to_account_id INTEGER NOT NULL REFERENCES accounts(id),
          amount REAL NOT NULL CHECK(amount > 0),
          date TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK(from_account_id != to_account_id)
        );
        CREATE INDEX idx_accounts_user ON accounts(user_id);
        CREATE INDEX idx_transfers_user_date ON transfers(user_id,date);
      `);
      if (!columnsFor(db, 'expenses').has('account_id')) {
        db.exec('ALTER TABLE expenses ADD COLUMN account_id INTEGER REFERENCES accounts(id)');
      }
    });
    migrateAccounts();
  }
  db.pragma('user_version = 8');

  db.exec(`
    CREATE TABLE IF NOT EXISTS category_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      amount_limit REAL NOT NULL,
      frequency_limit INTEGER,
      currency TEXT NOT NULL DEFAULT 'INR',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_category_limits_user ON category_limits(user_id);

    CREATE TABLE IF NOT EXISTS quick_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      payment_mode TEXT NOT NULL DEFAULT 'UPI',
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_quick_presets_user ON quick_presets(user_id, display_order);

    CREATE TABLE IF NOT EXISTS telegram_sync_codes (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_sync_codes_user ON telegram_sync_codes(user_id);
  `);

  if (columnsFor(db, 'users').size > 0) {
    const userCols = columnsFor(db, 'users');
    if (!userCols.has('telegram_chat_id')) {
      db.exec('ALTER TABLE users ADD COLUMN telegram_chat_id TEXT');
    }
    if (!userCols.has('telegram_username')) {
      db.exec('ALTER TABLE users ADD COLUMN telegram_username TEXT');
    }
    if (!userCols.has('vibe')) {
      db.exec('ALTER TABLE users ADD COLUMN vibe TEXT');
    }
  }
}

const DEFAULT_VIBE_PRESETS: Record<string, Array<{ title: string; amount: number; category: string; paymentMode: PaymentMode }>> = {
  college: [
    { title: 'Chai / Coffee', amount: 20, category: 'Food & drinks', paymentMode: 'UPI' },
    { title: 'Canteen Lunch', amount: 80, category: 'Food & drinks', paymentMode: 'UPI' },
    { title: 'Printouts / Xerox', amount: 30, category: 'Stationery & Books', paymentMode: 'UPI' },
    { title: 'Auto / Bus Fare', amount: 40, category: 'Transport', paymentMode: 'Cash' },
    { title: 'Mobile Recharge', amount: 299, category: 'Mobile recharge', paymentMode: 'UPI' },
  ],
  hostel: [
    { title: 'Milk & Snacks', amount: 60, category: 'Groceries', paymentMode: 'UPI' },
    { title: 'PG Rent / Mess', amount: 5000, category: 'Rent / PG', paymentMode: 'UPI' },
    { title: 'Laundry', amount: 150, category: 'Laundry', paymentMode: 'UPI' },
    { title: 'WiFi Share', amount: 200, category: 'Utilities', paymentMode: 'UPI' },
    { title: 'Weekend Treat', amount: 350, category: 'Food & drinks', paymentMode: 'UPI' },
  ],
  bachelor: [
    { title: 'Swiggy / Zomato', amount: 250, category: 'Food & drinks', paymentMode: 'UPI' },
    { title: 'Gym Monthly', amount: 1200, category: 'Gym/Sports', paymentMode: 'UPI' },
    { title: 'Petrol / Fuel', amount: 500, category: 'Fuel', paymentMode: 'UPI' },
    { title: 'Weekend Party', amount: 1500, category: 'Party', paymentMode: 'UPI' },
    { title: 'Supermarket Groceries', amount: 800, category: 'Groceries', paymentMode: 'UPI' },
  ],
};

function checkCategoryLimit(
  db: Database.Database,
  userId: number,
  category: string,
  date: string,
  _currency: Currency,
): string | null {
  const limit = db.prepare('SELECT * FROM category_limits WHERE user_id=? AND category=?')
    .get(userId, category) as {
      id: number;
      amount_limit: number;
      frequency_limit: number | null;
      currency: Currency;
    } | undefined;
  if (!limit) return null;

  const month = date.slice(0, 7);
  let bounds: ReturnType<typeof monthBounds>;
  try {
    bounds = monthBounds(month);
  } catch {
    return null;
  }

  const account = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string };
  const rows = db.prepare(`SELECT amount, currency, shared, shares, people, user_id FROM expenses
    WHERE (user_id=? OR (household_id IS NOT NULL AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id=expenses.household_id AND hm.user_id=?)))
    AND category=? AND type='expense' AND date BETWEEN ? AND ?`)
    .all(userId, userId, category, bounds.start, bounds.end) as Array<Record<string, unknown>>;

  let totalSpent = 0;
  for (const row of rows) {
    const amt = Number(row.amount);
    const sh = personalShare(amt, Boolean(row.shared), parseJson<ParticipantShare[]>(row.shares as string, []), parseJson<string[]>(row.people as string, []), Number(row.user_id) === userId ? 'Me' : account.email);
    totalSpent += sh;
  }
  const count = rows.length;

  if (limit.amount_limit > 0 && totalSpent > limit.amount_limit) {
    return `🚨 Exceeded your ${category} monthly limit of ₹${limit.amount_limit.toLocaleString('en-IN')}! (Spent: ₹${Math.round(totalSpent).toLocaleString('en-IN')})`;
  }
  if (limit.frequency_limit && count > limit.frequency_limit) {
    return `🚨 Hit your ${category} frequency limit of ${limit.frequency_limit} spends this month!`;
  }
  if (limit.amount_limit > 0 && totalSpent >= limit.amount_limit * 0.8) {
    return `⚠️ Heads up: You've used ${Math.round((totalSpent / limit.amount_limit) * 100)}% of your ₹${limit.amount_limit.toLocaleString('en-IN')} ${category} limit.`;
  }
  if (limit.frequency_limit && count === limit.frequency_limit) {
    return `⚠️ Heads up: You've reached your ${limit.frequency_limit} spend limit for ${category} this month.`;
  }
  return null;
}

function expenseSchema(peopleDefault: string[] = []) {
  return z.object({
    title: z.string().trim().min(1, 'Description is required').max(100),
    amount: moneySchema,
    currency: currencySchema,
    category: z.string().trim().min(1).max(40),
    date: dateSchema,
    note: z.string().trim().max(300).optional().default(''),
    shared: z.boolean().optional().default(false),
    type: z.enum(['expense', 'income']).optional().default('expense'),
    source: z.literal('manual').optional().default('manual'),
    people: z.array(z.string().trim().min(1).max(60)).max(20).optional().default(peopleDefault),
    payer: z.string().trim().min(1).max(60).optional().default('Me'),
    splitMethod: z.enum(['equal', 'custom']).optional().default('equal'),
    shares: z.array(z.object({
      name: z.string().trim().min(1).max(60),
      amount: nonNegativeMoneySchema,
    })).max(21).optional().default([]),
    householdId: z.number().int().positive().nullable().optional().default(null),
    accountId: z.number().int().positive().nullable().optional().default(null),
    paymentMode: z.enum(PAYMENT_MODES).optional().default('UPI'),
    upiApp: z.string().trim().max(40).nullable().optional().default(null),
    upiReference: z.string().trim().max(100).nullable().optional().default(null),
  }).superRefine((expense, context) => {
    if (expense.shared && expense.type !== 'expense') {
      context.addIssue({ code: 'custom', path: ['shared'], message: 'Only expenses can be shared' });
    }
    if (!expense.shared) return;
    const participants = [...new Set(['Me', expense.payer, ...expense.people])];
    if (!participants.some(name => name.toLowerCase() === 'me')) {
      context.addIssue({ code: 'custom', path: ['people'], message: 'Me must be included in a shared bill' });
    }
    if (expense.splitMethod === 'custom') {
      if (!expense.shares.length || !validateShares(expense.amount, expense.shares)) {
        context.addIssue({ code: 'custom', path: ['shares'], message: 'Custom shares must be unique, non-negative, and add up to the bill total' });
      }
      const participantNames = new Set(participants.map(name => name.toLowerCase()));
      const shareNames = new Set(expense.shares.map(share => share.name.toLowerCase()));
      if (participantNames.size !== shareNames.size || [...participantNames].some(name => !shareNames.has(name))) {
        context.addIssue({ code: 'custom', path: ['shares'], message: 'Provide exactly one share for every participant, including Me and the payer' });
      }
    }
  });
}

function expenseForResponse(row: Record<string, any>) {
  return {
    ...row,
    id: Number(row.id),
    title: String(row.title ?? ''),
    amount: Number(row.amount ?? 0),
    currency: row.currency as Currency,
    category: String(row.category ?? 'Other'),
    date: String(row.date ?? ''),
    note: String(row.note ?? ''),
    shared: Boolean(row.shared),
    type: (row.type as 'expense' | 'income') || 'expense',
    source: (row.source as 'manual' | 'csv') || 'manual',
    paymentMode: (row.payment_mode as PaymentMode) || 'UPI',
    upiApp: row.upi_app ? String(row.upi_app) : null,
    upiReference: row.upi_reference ? String(row.upi_reference) : null,
    people: parseJson<string[]>(row.people as string, []),
    shares: parseJson<ParticipantShare[]>(row.shares as string, []),
    householdId: row.household_id ? Number(row.household_id) : null,
    accountId: row.account_id ? Number(row.account_id) : null,
    splitMethod: (row.split_method as 'equal' | 'custom') || 'equal',
    payer: String(row.payer ?? 'Me'),
    user_id: row.user_id ? Number(row.user_id) : null,
  };
}

function normalizedExpense(data: z.infer<ReturnType<typeof expenseSchema>>) {
  const shared = data.shared ?? false;
  const distinctNames = (names: string[]) => {
    const unique = new Map<string, string>();
    for (const value of names) {
      const name = value.trim();
      if (name && !unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
    }
    return [...unique.values()];
  };
  const people = distinctNames(data.people ?? []).filter(name => name.toLowerCase() !== 'me');
  const payerInput = data.payer ?? 'Me';
  const participants = distinctNames(['Me', payerInput, ...people]);
  const payer = participants.find(name => name.toLowerCase() === payerInput.toLowerCase()) ?? 'Me';
  const inputShares = shared
    ? data.splitMethod === 'custom'
      ? data.shares ?? []
      : splitEqual(data.amount, participants)
    : [];
  const shares = inputShares.map(share => ({
    ...share,
    name: participants.find(name => name.toLowerCase() === share.name.toLowerCase()) ?? share.name,
  }));
  return {
    title: data.title,
    amount: data.amount,
    currency: data.currency,
    category: data.category,
    date: data.date,
    note: data.note ?? '',
    shared,
    type: data.type ?? 'expense',
    source: data.source ?? 'manual',
    people,
    shares,
    payer: shared ? payer : 'Me',
    splitMethod: shared ? (data.splitMethod ?? 'equal') : 'equal',
    householdId: shared ? (data.householdId ?? null) : null,
    accountId: data.accountId ?? null,
    paymentMode: data.paymentMode ?? 'UPI',
    upiApp: data.upiApp ?? null,
    upiReference: data.upiReference ?? null,
  };
}

function expensePersonalAmount(row: Record<string, unknown>, participantName = 'Me'): number {
  return personalShare(
    Number(row.amount),
    Boolean(row.shared),
    parseJson<ParticipantShare[]>(row.shares as string, []),
    parseJson<string[]>(row.people as string, []),
    participantName,
  );
}

export function createApp(db: Database.Database) {
  const app = express();
  const configuredOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || configuredOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '3mb' }));

  const respondWithValidation = <Schema extends z.ZodTypeAny>(
    schema: Schema,
    body: unknown,
    res: express.Response,
  ): z.output<Schema> | undefined => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return undefined;
    }
    return parsed.data;
  };

  const sseClients = new Map<number, Set<express.Response>>();
  const broadcastToUser = (userId: number, event: string, data: unknown) => {
    const clients = sseClients.get(userId);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'BachelorBudget API' }));

  const authSchema = z.object({
    email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
    password: z.string().min(8).max(128),
  });
  const rateBucket = (req: express.Request, email: string) =>
    createHash('sha256').update(`${req.ip ?? 'unknown'}:${email}`).digest('hex');
  const allowAuthAttempt = (bucket: string): boolean => {
    const now = Date.now();
    const attempt = db.prepare('SELECT attempts,window_started_at FROM auth_rate_limits WHERE bucket=?')
      .get(bucket) as { attempts: number; window_started_at: number } | undefined;
    if (!attempt || now - attempt.window_started_at >= AUTH_WINDOW_MS) {
      db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,window_started_at) VALUES(?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET attempts=1,window_started_at=excluded.window_started_at`).run(bucket, now);
      return true;
    }
    if (attempt.attempts >= AUTH_MAX_ATTEMPTS) return false;
    db.prepare('UPDATE auth_rate_limits SET attempts=attempts+1 WHERE bucket=?').run(bucket);
    return true;
  };
  const issueSession = (userId: number, res: express.Response) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(tokenHash(token), userId, expiresAt);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DURATION_MS / 1000));
    return expiresAt;
  };
  app.post('/api/auth/register', (req, res) => {
    const input = respondWithValidation(authSchema, req.body, res);
    if (!input) return;
    const bucket = rateBucket(req, input.email);
    if (!allowAuthAttempt(bucket)) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(input.email)) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const user = db.transaction(() => {
      const result = db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)')
        .run(input.email, hashPassword(input.password));
      const id = Number(result.lastInsertRowid);
      for (const table of ['expenses', 'goals', 'households', 'budgets', 'settings']) {
        db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(id);
      }
      db.prepare(`INSERT OR IGNORE INTO household_members(household_id,user_id,role)
        SELECT id,?,'owner' FROM households WHERE user_id=?`).run(id, id);
      return { id, email: input.email };
    })();
    const expiresAt = issueSession(user.id, res);
    return res.status(201).json({ user, expiresAt });
  });
  app.post('/api/auth/login', (req, res) => {
    const input = respondWithValidation(authSchema, req.body, res);
    if (!input) return;
    const bucket = rateBucket(req, input.email);
    if (!allowAuthAttempt(bucket)) return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    const user = db.prepare('SELECT id,email,password_hash FROM users WHERE email=?').get(input.email) as {
      id: number; email: string; password_hash: string;
    } | undefined;
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    db.prepare('DELETE FROM auth_rate_limits WHERE bucket=?').run(bucket);
    const expiresAt = issueSession(user.id, res);
    return res.json({ user: { id: user.id, email: user.email }, expiresAt });
  });
  app.get('/api/auth/me', (req, res) => {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const session = db.prepare(`SELECT users.id,users.email,sessions.expires_at FROM sessions
      JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`)
      .get(tokenHash(token), Date.now()) as { id: number; email: string; expires_at: number } | undefined;
    if (!session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return res.json({ user: { id: session.id, email: session.email }, expiresAt: session.expires_at });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return res.status(204).end();
  });

  const insertExpense = db.prepare(`
    INSERT INTO expenses (title, amount, currency, category, date, note, shared, people, payer, split_method, shares, household_id, type, source, user_id, account_id, payment_mode, upi_app, upi_reference)
    VALUES (@title, @amount, @currency, @category, @date, @note, @shared, @people, @payer, @split_method, @shares, @household_id, @type, @source, @user_id, @account_id, @payment_mode, @upi_app, @upi_reference)
  `);
  const updateExpense = db.prepare(`
    UPDATE expenses SET title=@title, amount=@amount, currency=@currency, category=@category,
      date=@date, note=@note, shared=@shared, people=@people, payer=@payer,
      split_method=@split_method, shares=@shares, household_id=@household_id, account_id=@account_id,
      type=@type, source=@source, payment_mode=@payment_mode, upi_app=@upi_app, upi_reference=@upi_reference, updated_at=CURRENT_TIMESTAMP WHERE id=@id AND
        (user_id=@user_id OR household_id IN (SELECT id FROM households WHERE user_id=@user_id))
  `);

  app.post('/api/telegram-webhook', async (req, res) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      return res.status(403).json({ error: 'Unauthorized webhook request' });
    }
    const body = req.body as {
      message?: {
        chat: { id: number; username?: string; first_name?: string };
        text?: string;
        date?: number;
      };
    };
    const message = body?.message;
    if (!message || !message.text) {
      return res.status(200).json({ ok: true });
    }
    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const token = process.env.TELEGRAM_BOT_TOKEN;

    const sendTelegram = async (reply: string) => {
      if (!token) {
        console.log(`[Telegram Bot to ${chatId}]: ${reply}`);
        return;
      }
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'Markdown' }),
        });
      } catch (err) {
        console.error('Failed to send Telegram message:', err);
      }
    };

    // Check if it's a sync code
    const codeMatch = text.match(/\b(\d{6})\b/);
    if (codeMatch && (text.includes('/start') || text.includes('/sync') || text.length === 6)) {
      const code = codeMatch[1];
      const syncRecord = db.prepare('SELECT user_id FROM telegram_sync_codes WHERE code=? AND expires_at>?')
        .get(code, Date.now()) as { user_id: number } | undefined;
      if (syncRecord) {
        const username = message.chat.username || message.chat.first_name || 'Roomie';
        db.prepare('UPDATE users SET telegram_chat_id=?, telegram_username=? WHERE id=?')
          .run(chatId, username, syncRecord.user_id);
        db.prepare('DELETE FROM telegram_sync_codes WHERE code=?').run(code);
        broadcastToUser(syncRecord.user_id, 'telegram_connected', { telegramUsername: username });
        await sendTelegram(`🎉 *Connected to BachelorBudget!*\n\nHey ${username}, you're all set! Whenever you spend, just text me here.\n\nExamples:\n• \`Chai 20\`\n• \`Biryani 340 via UPI\`\n• \`Auto 60 cash\`\n• \`Split 800 dinner rahul, priya\``);
        return res.status(200).json({ ok: true, linked: true });
      }
    }

    // Check if user is linked
    const user = db.prepare('SELECT id, email FROM users WHERE telegram_chat_id=?').get(chatId) as { id: number; email: string } | undefined;
    if (!user) {
      await sendTelegram(`👋 *Welcome to BachelorBudget!*\n\nPlease link your account first:\n1. Open BachelorBudget web app\n2. Go to Settings → Telegram Bot Sync\n3. Click "Generate Sync Code"\n4. Send that 6-digit code here!`);
      return res.status(200).json({ ok: true });
    }

    if (text === '/help' || text === '/start') {
      await sendTelegram(`💡 *How to log spends in BachelorBudget:*\n\nJust type naturally:\n• \`Chai 20\`\n• \`Biryani 340 via UPI\`\n• \`Metro recharge 200\`\n• \`Split 600 wifi arjun\`\n\nI automatically extract amount, category, payment mode, and roommate shares!`);
      return res.status(200).json({ ok: true });
    }

    // Parse natural spend!
    const parsed = parseNaturalSpend(text);
    if (!parsed.valid || parsed.amount <= 0) {
      await sendTelegram(`❓ Couldn't understand the amount in "${text}". Try: \`Chai 20\` or \`Swiggy 280\``);
      return res.status(200).json({ ok: true });
    }

    const todayDate = dateKeyLocal();
    const result = insertExpense.run({
      title: parsed.title,
      amount: parsed.amount,
      currency: 'INR',
      category: parsed.category,
      date: parsed.date || todayDate,
      note: `via Telegram bot: "${text}"`,
      shared: parsed.shared ? 1 : 0,
      people: JSON.stringify(parsed.people),
      payer: 'Me',
      split_method: 'equal',
      shares: parsed.shared ? JSON.stringify(splitEqual(parsed.amount, ['Me', ...parsed.people])) : '[]',
      household_id: null,
      type: 'expense',
      source: 'manual',
      user_id: user.id,
      account_id: null,
      payment_mode: parsed.paymentMode,
      upi_app: parsed.upiApp ?? null,
      upi_reference: null,
    });

    const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    const expense = expenseForResponse(row);
    const limitNudge = checkCategoryLimit(db, user.id, parsed.category, expense.date, expense.currency);
    broadcastToUser(user.id, 'transaction_created', { ...expense, limitNudge });
    syncTransactionToSupabase(expense, user.id).catch(() => {});

    let reply = `✅ Logged *₹${parsed.amount}* for *${parsed.category}* (${parsed.title})\nMode: ${parsed.paymentMode}`;
    if (parsed.shared) {
      reply += `\nSplit with: ${parsed.people.join(', ')}`;
    }
    if (limitNudge) {
      reply += `\n\n${limitNudge}`;
    }
    await sendTelegram(reply);
    return res.status(200).json({ ok: true, created: true });
  });

  app.use('/api', (req, res, next) => {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const session = db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(tokenHash(token)) as {
      user_id: number; expires_at: number;
    } | undefined;
    if (!session || session.expires_at <= Date.now()) {
      if (session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    const origin = req.get('origin');
    if (origin && !configuredOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Request origin is not allowed' });
    }
    req.userId = session.user_id;
    return next();
  });

  app.get('/api/events', (req, res) => {
    const userId = req.userId!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(':connected\n\n');

    if (!sseClients.has(userId)) {
      sseClients.set(userId, new Set());
    }
    const userSet = sseClients.get(userId)!;
    userSet.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(':ping\n\n');
      } catch {
        clearInterval(heartbeat);
        userSet.delete(res);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      userSet.delete(res);
    });
  });

  app.get(['/api/expenses', '/api/transactions'], (req, res) => {
    const userId = req.userId!;
    const filterSchema = z.object({
      from: dateSchema.optional(),
      to: dateSchema.optional(),
      category: z.string().max(40).optional(),
      currency: currencySchema.optional(),
      type: z.enum(['expense', 'income']).optional(),
      paymentMode: z.enum(PAYMENT_MODES).optional(),
    }).refine(filters => !filters.from || !filters.to || filters.from <= filters.to, 'Start date must not be after end date');
    const filters = respondWithValidation(filterSchema, req.query, res);
    if (!filters) return;
    const clauses: string[] = ['(e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))'];
    const params: unknown[] = [userId, userId];
    if (filters.from) { clauses.push('e.date >= ?'); params.push(filters.from); }
    if (filters.to) { clauses.push('e.date <= ?'); params.push(filters.to); }
    if (filters.category) { clauses.push('e.category = ?'); params.push(filters.category); }
    if (filters.currency) { clauses.push('e.currency = ?'); params.push(filters.currency); }
    if (filters.paymentMode) { clauses.push('e.payment_mode = ?'); params.push(filters.paymentMode); }
    if (filters.type) { clauses.push('e.type = ?'); params.push(filters.type); }
    else if (req.path === '/api/expenses') clauses.push("e.type = 'expense'");
    const rows = db.prepare(`SELECT e.* FROM expenses e WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC, e.id DESC`).all(...params) as Array<Record<string, unknown>>;
    res.json(rows.map(expenseForResponse));
  });

  app.post('/api/imports/csv/preview', (req, res) => {
    const input = respondWithValidation(z.object({ csv: z.string().min(1).max(2_000_000) }), req.body, res);
    if (!input) return;
    let parsed: ReturnType<typeof parseBankCsv>;
    try {
      parsed = parseBankCsv(input.csv, req.userId!);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not parse CSV' });
    }
    if (!parsed.rows.length) return res.status(400).json({ error: 'No valid transaction rows found', errors: parsed.errors });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 20 * 60 * 1000;
    db.prepare('DELETE FROM csv_import_batches WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO csv_import_batches(token_hash,user_id,rows_json,expires_at) VALUES(?,?,?,?)')
      .run(tokenHash(token), req.userId, JSON.stringify(parsed.rows), expiresAt);
    return res.json({
      batchToken: token,
      expiresAt,
      validCount: parsed.rows.length,
      errors: parsed.errors,
      rows: parsed.rows.map(({ importKey: _importKey, ...row }) => row),
    });
  });
  app.post('/api/imports/csv/confirm', (req, res) => {
    const input = respondWithValidation(z.object({ batchToken: z.string().min(32).max(100) }), req.body, res);
    if (!input) return;
    const batch = db.prepare('SELECT rows_json FROM csv_import_batches WHERE token_hash=? AND user_id=? AND expires_at>?')
      .get(tokenHash(input.batchToken), req.userId, Date.now()) as { rows_json: string } | undefined;
    if (!batch) return res.status(404).json({ error: 'Import preview expired or was already confirmed. Upload the CSV again.' });
    const rows = parseJson<ImportedCsvRow[]>(batch.rows_json, []);
    const confirmImport = db.transaction(() => {
      let imported = 0;
      let duplicates = 0;
      const insert = db.prepare(`INSERT OR IGNORE INTO expenses
        (title,amount,currency,category,date,note,shared,people,payer,split_method,shares,household_id,type,source,user_id,import_key)
        VALUES(?,?,?,?,?,?,0,'[]','Me','equal','[]',NULL,?,'csv',?,?)`);
      for (const row of rows) {
        const result = insert.run(
          row.title, row.amount, row.currency, row.category, row.date, row.note,
          row.type, req.userId, row.importKey,
        );
        if (result.changes) imported += 1;
        else duplicates += 1;
      }
      db.prepare('DELETE FROM csv_import_batches WHERE token_hash=? AND user_id=?')
        .run(tokenHash(input.batchToken), req.userId);
      return { imported, duplicates };
    })();
    return res.json(confirmImport);
  });

  app.post(['/api/expenses', '/api/transactions'], (req, res) => {
    const userId = req.userId!;
    const parsed = respondWithValidation(expenseSchema(), req.body, res);
    if (!parsed) return;
    if (req.path === '/api/expenses' && parsed.type === 'income') {
      return res.status(400).json({ error: 'Use /api/transactions to record income' });
    }
    const expense = normalizedExpense(parsed);
    if (expense.householdId && !db.prepare('SELECT household_id FROM household_members WHERE household_id=? AND user_id=?').get(expense.householdId, userId)) {
      return res.status(400).json({ error: 'Household not found or you are not a member' });
    }
    if (expense.accountId) {
      const account = db.prepare('SELECT currency FROM accounts WHERE id=? AND user_id=?').get(expense.accountId, userId) as { currency: Currency } | undefined;
      if (!account) return res.status(400).json({ error: 'Account not found' });
      if (account.currency !== expense.currency) return res.status(400).json({ error: 'Transaction currency must match the selected account' });
    }
    const result = insertExpense.run({
      title: expense.title, amount: expense.amount, currency: expense.currency, category: expense.category,
      date: expense.date, note: expense.note, shared: Number(expense.shared), people: JSON.stringify(expense.people),
      payer: expense.payer, split_method: expense.splitMethod, shares: JSON.stringify(expense.shares),
      household_id: expense.householdId, type: expense.type, source: expense.source, user_id: userId, account_id: expense.accountId,
      payment_mode: expense.paymentMode, upi_app: expense.upiApp, upi_reference: expense.upiReference,
    });
    const row = db.prepare('SELECT * FROM expenses WHERE id=? AND user_id=?').get(Number(result.lastInsertRowid), userId) as Record<string, unknown>;
    const responseExpense = expenseForResponse(row);
    const limitNudge = checkCategoryLimit(db, userId, expense.category, expense.date, expense.currency);
    broadcastToUser(userId, 'transaction_created', { ...responseExpense, limitNudge });
    syncTransactionToSupabase(responseExpense, userId).catch(() => {});
    return res.status(201).json({ ...responseExpense, limitNudge });
  });
  app.put(['/api/expenses/:id', '/api/transactions/:id'], (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid expense id' });
    if (!db.prepare(`SELECT e.id FROM expenses e WHERE e.id=? AND
      (e.user_id=? OR (e.shared=1 AND e.household_id IN (SELECT id FROM households WHERE user_id=?)))`).get(id, userId, userId)) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const parsed = respondWithValidation(expenseSchema(), req.body, res);
    if (!parsed) return;
    if (req.path === '/api/expenses' && parsed.type === 'income') {
      return res.status(400).json({ error: 'Use /api/transactions to record income' });
    }
    const expense = normalizedExpense(parsed);
    if (expense.householdId && !db.prepare('SELECT household_id FROM household_members WHERE household_id=? AND user_id=?').get(expense.householdId, userId)) {
      return res.status(400).json({ error: 'Household not found or you are not a member' });
    }
    if (expense.accountId) {
      const account = db.prepare('SELECT currency FROM accounts WHERE id=? AND user_id=?').get(expense.accountId, userId) as { currency: Currency } | undefined;
      if (!account) return res.status(400).json({ error: 'Account not found' });
      if (account.currency !== expense.currency) return res.status(400).json({ error: 'Transaction currency must match the selected account' });
    }
    updateExpense.run({
      id, title: expense.title, amount: expense.amount, currency: expense.currency, category: expense.category,
      date: expense.date, note: expense.note, shared: Number(expense.shared), people: JSON.stringify(expense.people),
      payer: expense.payer, split_method: expense.splitMethod, shares: JSON.stringify(expense.shares),
      household_id: expense.householdId, type: expense.type, source: expense.source, user_id: userId, account_id: expense.accountId,
      payment_mode: expense.paymentMode, upi_app: expense.upiApp, upi_reference: expense.upiReference,
    });
    const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(id) as Record<string, unknown>;
    const responseExpense = expenseForResponse(row);
    const limitNudge = checkCategoryLimit(db, userId, expense.category, expense.date, expense.currency);
    broadcastToUser(userId, 'transaction_updated', { ...responseExpense, limitNudge });
    syncTransactionToSupabase(responseExpense, userId).catch(() => {});
    return res.json({ ...responseExpense, limitNudge });
  });
  app.delete(['/api/expenses/:id', '/api/transactions/:id'], (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid expense id' });
    const result = db.prepare(`DELETE FROM expenses WHERE id=? AND
      (user_id=? OR (shared=1 AND household_id IN (SELECT id FROM households WHERE user_id=?)))`).run(id, userId, userId);
    if (!result.changes) return res.status(404).json({ error: 'Expense not found' });
    broadcastToUser(userId, 'transaction_deleted', { id });
    return res.status(204).end();
  });

  app.get('/api/settings', (req, res) => {
    const values = db.prepare("SELECT key, value FROM settings WHERE user_id=? AND key IN ('monthlyBudget','warningThreshold','vibe','reminderEnabled','reminderTime')")
      .all(req.userId).map(row => row as { key: string; value: string });
    const settings = Object.fromEntries(values.map(({ key, value }) => [key, value]));
    const profileValues = db.prepare("SELECT key,value FROM settings WHERE user_id=? AND key IN ('username','preferredCurrency','upiId')")
      .all(req.userId).map(row => row as { key: string; value: string });
    const profile = Object.fromEntries(profileValues.map(({ key, value }) => [key, value]));
    const user = db.prepare('SELECT email, vibe FROM users WHERE id=?').get(req.userId) as { email: string; vibe?: string | null };
    res.json({
      monthlyBudget: Number(settings.monthlyBudget ?? 0),
      baseCurrency: 'INR',
      warningThreshold: Number(settings.warningThreshold ?? DEFAULT_WARNING_THRESHOLD),
      supportedCurrencies: CURRENCIES,
      username: profile.username ?? user.email.split('@')[0],
      preferredCurrency: CURRENCIES.includes(profile.preferredCurrency as Currency) ? profile.preferredCurrency : 'INR',
      upiId: profile.upiId ?? '',
      vibe: settings.vibe || user.vibe || 'College Student',
      reminderEnabled: settings.reminderEnabled === 'true',
      reminderTime: settings.reminderTime || '21:00',
    });
  });
  app.put('/api/settings', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      monthlyBudget: nonNegativeMoneySchema.optional(),
      baseCurrency: z.literal('INR').optional(),
      warningThreshold: z.number().int().min(50).max(99).optional().default(DEFAULT_WARNING_THRESHOLD),
      username: z.string().trim().min(1).max(40).optional(),
      preferredCurrency: currencySchema.optional(),
      upiId: z.string().trim().max(100).optional(),
      vibe: z.string().trim().max(60).optional(),
      reminderEnabled: z.boolean().optional(),
      reminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }).strict();
    const input = respondWithValidation(schema, req.body, res);
    if (!input) return;
    const save = db.transaction(() => {
      if (input.monthlyBudget !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'monthlyBudget',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, String(input.monthlyBudget));
      }
      db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'warningThreshold',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, String(input.warningThreshold));
      if (input.username !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'username',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, input.username);
      }
      if (input.preferredCurrency !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'preferredCurrency',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, input.preferredCurrency);
      }
      if (input.upiId !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'upiId',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, input.upiId);
      }
      if (input.vibe !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'vibe',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, input.vibe);
        db.prepare("UPDATE users SET vibe=? WHERE id=?").run(input.vibe, userId);
      }
      if (input.reminderEnabled !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'reminderEnabled',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, String(input.reminderEnabled));
      }
      if (input.reminderTime !== undefined) {
        db.prepare("INSERT INTO settings(user_id,key,value) VALUES(?,'reminderTime',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").run(userId, input.reminderTime);
      }
    });
    save();
    res.json({ ...input, baseCurrency: 'INR', supportedCurrencies: CURRENCIES });
  });

  /* ─── Category Limits API ─── */
  app.get('/api/limits', (req, res) => {
    const userId = req.userId!;
    const limits = db.prepare('SELECT * FROM category_limits WHERE user_id=? ORDER BY category ASC').all(userId) as Array<Record<string, unknown>>;
    const currentMonthKey = dateKeyLocal().slice(0, 7);
    const bounds = monthBounds(currentMonthKey);
    const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string };
    const monthExpenses = db.prepare(`SELECT amount, currency, category, shared, shares, people, user_id FROM expenses
      WHERE (user_id=? OR (household_id IS NOT NULL AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id=expenses.household_id AND hm.user_id=?)))
      AND type='expense' AND date BETWEEN ? AND ?`).all(userId, userId, bounds.start, bounds.end) as Array<Record<string, unknown>>;

    const result = limits.map(l => {
      const cat = String(l.category);
      const catExpenses = monthExpenses.filter(e => String(e.category) === cat);
      let spent = 0;
      for (const e of catExpenses) {
        spent += personalShare(Number(e.amount), Boolean(e.shared), parseJson<ParticipantShare[]>(e.shares as string, []), parseJson<string[]>(e.people as string, []), Number(e.user_id) === userId ? 'Me' : user.email);
      }
      spent = Math.round(spent * 100) / 100;
      const count = catExpenses.length;
      const amtLimit = Number(l.amount_limit);
      const freqLimit = l.frequency_limit ? Number(l.frequency_limit) : null;
      let status: 'ok' | 'warning' | 'exceeded' = 'ok';
      if ((amtLimit > 0 && spent > amtLimit) || (freqLimit && count > freqLimit)) {
        status = 'exceeded';
      } else if ((amtLimit > 0 && spent >= amtLimit * 0.8) || (freqLimit && count >= freqLimit)) {
        status = 'warning';
      }
      return {
        id: Number(l.id),
        category: cat,
        amountLimit: amtLimit,
        frequencyLimit: freqLimit,
        currency: String(l.currency || 'INR'),
        currentSpent: spent,
        currentCount: count,
        status,
      };
    });
    res.json(result);
  });

  app.post('/api/limits', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      category: z.string().trim().min(1).max(40),
      amountLimit: moneySchema,
      frequencyLimit: z.number().int().min(1).max(365).nullable().optional(),
      currency: currencySchema.optional().default('INR'),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    db.prepare(`INSERT INTO category_limits(user_id, category, amount_limit, frequency_limit, currency)
      VALUES(?,?,?,?,?)
      ON CONFLICT(user_id, category) DO UPDATE SET amount_limit=excluded.amount_limit, frequency_limit=excluded.frequency_limit, currency=excluded.currency`)
      .run(userId, parsed.category, parsed.amountLimit, parsed.frequencyLimit ?? null, parsed.currency);
    const row = db.prepare('SELECT * FROM category_limits WHERE user_id=? AND category=?').get(userId, parsed.category) as Record<string, unknown>;
    return res.status(201).json({
      id: Number(row.id),
      category: parsed.category,
      amountLimit: parsed.amountLimit,
      frequencyLimit: parsed.frequencyLimit ?? null,
      currency: parsed.currency,
      currentSpent: 0,
      currentCount: 0,
      status: 'ok',
    });
  });

  app.delete('/api/limits/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid limit id' });
    const result = db.prepare('DELETE FROM category_limits WHERE id=? AND user_id=?').run(id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Limit not found' });
    return res.status(204).end();
  });

  /* ─── Quick Presets API ─── */
  app.get('/api/presets', (req, res) => {
    const userId = req.userId!;
    let rows = db.prepare('SELECT * FROM quick_presets WHERE user_id=? ORDER BY display_order ASC, id ASC').all(userId) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      const user = db.prepare('SELECT vibe FROM users WHERE id=?').get(userId) as { vibe?: string } | undefined;
      const vibeKey = user?.vibe?.toLowerCase().includes('hostel') || user?.vibe?.toLowerCase().includes('pg')
        ? 'hostel'
        : user?.vibe?.toLowerCase().includes('bachelor') || user?.vibe?.toLowerCase().includes('working')
        ? 'bachelor'
        : 'college';
      const defaults = DEFAULT_VIBE_PRESETS[vibeKey] || DEFAULT_VIBE_PRESETS.college;
      const insert = db.prepare('INSERT INTO quick_presets(user_id, title, amount, category, currency, payment_mode, display_order) VALUES(?,?,?,?,?,?,?)');
      db.transaction(() => {
        defaults.forEach((p, idx) => {
          insert.run(userId, p.title, p.amount, p.category, 'INR', p.paymentMode, idx);
        });
      })();
      rows = db.prepare('SELECT * FROM quick_presets WHERE user_id=? ORDER BY display_order ASC, id ASC').all(userId) as Array<Record<string, unknown>>;
    }
    res.json(rows.map(r => ({
      id: Number(r.id),
      title: String(r.title),
      amount: Number(r.amount),
      category: String(r.category),
      currency: String(r.currency),
      paymentMode: String(r.payment_mode || 'UPI'),
      displayOrder: Number(r.display_order ?? 0),
    })));
  });

  app.post('/api/presets', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      title: z.string().trim().min(1).max(60),
      amount: moneySchema,
      category: z.string().trim().min(1).max(40),
      currency: currencySchema.optional().default('INR'),
      paymentMode: z.enum(PAYMENT_MODES).optional().default('UPI'),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const maxOrder = db.prepare('SELECT MAX(display_order) as m FROM quick_presets WHERE user_id=?').get(userId) as { m: number | null };
    const order = (maxOrder?.m ?? -1) + 1;
    const result = db.prepare('INSERT INTO quick_presets(user_id, title, amount, category, currency, payment_mode, display_order) VALUES(?,?,?,?,?,?,?)')
      .run(userId, parsed.title, parsed.amount, parsed.category, parsed.currency, parsed.paymentMode, order);
    return res.status(201).json({ id: Number(result.lastInsertRowid), ...parsed, displayOrder: order });
  });

  app.put('/api/presets/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid preset id' });
    const schema = z.object({
      title: z.string().trim().min(1).max(60),
      amount: moneySchema,
      category: z.string().trim().min(1).max(40),
      currency: currencySchema.optional().default('INR'),
      paymentMode: z.enum(PAYMENT_MODES).optional().default('UPI'),
      displayOrder: z.number().int().min(0).optional(),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const result = db.prepare('UPDATE quick_presets SET title=?, amount=?, category=?, currency=?, payment_mode=?, display_order=COALESCE(?, display_order) WHERE id=? AND user_id=?')
      .run(parsed.title, parsed.amount, parsed.category, parsed.currency, parsed.paymentMode, parsed.displayOrder ?? null, id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Preset not found' });
    return res.json({ id, ...parsed });
  });

  app.delete('/api/presets/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid preset id' });
    const result = db.prepare('DELETE FROM quick_presets WHERE id=? AND user_id=?').run(id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Preset not found' });
    return res.status(204).end();
  });

  /* ─── Batch Transaction Endpoints ─── */
  app.post('/api/transactions/batch-category', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      ids: z.array(z.number().int().positive()).min(1),
      category: z.string().trim().min(1).max(40),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const update = db.prepare("UPDATE expenses SET category=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND (user_id=? OR household_id IN (SELECT id FROM households WHERE user_id=?))");
    let count = 0;
    db.transaction(() => {
      for (const id of parsed.ids) {
        const r = update.run(parsed.category, id, userId, userId);
        count += r.changes;
      }
    })();
    broadcastToUser(userId, 'transactions_batch_updated', { ids: parsed.ids, category: parsed.category });
    res.json({ updated: count });
  });

  app.post('/api/transactions/batch-payment-mode', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      ids: z.array(z.number().int().positive()).min(1),
      paymentMode: z.enum(PAYMENT_MODES),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const update = db.prepare("UPDATE expenses SET payment_mode=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND (user_id=? OR household_id IN (SELECT id FROM households WHERE user_id=?))");
    let count = 0;
    db.transaction(() => {
      for (const id of parsed.ids) {
        const r = update.run(parsed.paymentMode, id, userId, userId);
        count += r.changes;
      }
    })();
    broadcastToUser(userId, 'transactions_batch_updated', { ids: parsed.ids, paymentMode: parsed.paymentMode });
    res.json({ updated: count });
  });

  app.post('/api/transactions/batch-delete', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      ids: z.array(z.number().int().positive()).min(1),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const del = db.prepare("DELETE FROM expenses WHERE id=? AND (user_id=? OR household_id IN (SELECT id FROM households WHERE user_id=?))");
    let count = 0;
    db.transaction(() => {
      for (const id of parsed.ids) {
        const r = del.run(id, userId, userId);
        count += r.changes;
      }
    })();
    broadcastToUser(userId, 'transactions_batch_deleted', { ids: parsed.ids });
    res.json({ deleted: count });
  });

  app.post('/api/transactions/:id/toggle-split', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid transaction id' });
    const row = db.prepare("SELECT * FROM expenses WHERE id=? AND (user_id=? OR household_id IN (SELECT id FROM households WHERE user_id=?))").get(id, userId, userId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    const schema = z.object({
      shared: z.boolean(),
      people: z.array(z.string().trim().min(1)).optional(),
      payer: z.string().trim().optional(),
    });
    const parsed = respondWithValidation(schema, req.body, res);
    if (!parsed) return;
    const newShared = parsed.shared ? 1 : 0;
    const people = parsed.people ?? (row.people ? parseJson<string[]>(row.people as string, []) : []);
    const payer = parsed.payer ?? (row.payer ? String(row.payer) : 'Me');
    const splitMethod = 'equal';
    const shares = newShared && people.length ? JSON.stringify(splitEqual(Number(row.amount), ['Me', ...people])) : '[]';

    db.prepare("UPDATE expenses SET shared=?, people=?, payer=?, split_method=?, shares=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(newShared, JSON.stringify(people), payer, splitMethod, shares, id);
    const updated = db.prepare("SELECT * FROM expenses WHERE id=?").get(id) as Record<string, unknown>;
    const expense = expenseForResponse(updated);
    broadcastToUser(userId, 'transaction_updated', expense);
    res.json(expense);
  });

  /* ─── Telegram Bot Sync Endpoints ─── */
  app.post('/api/telegram/code', (req, res) => {
    const userId = req.userId!;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    db.prepare('DELETE FROM telegram_sync_codes WHERE expires_at<=? OR user_id=?').run(Date.now(), userId);
    db.prepare('INSERT INTO telegram_sync_codes(code, user_id, expires_at) VALUES(?,?,?)').run(code, userId, expiresAt);
    res.json({
      code,
      expiresAt,
      botUsername: process.env.TELEGRAM_BOT_USERNAME || 'BachelorBudgetBot',
    });
  });

  app.get('/api/telegram/status', (req, res) => {
    const userId = req.userId!;
    const user = db.prepare('SELECT telegram_chat_id, telegram_username FROM users WHERE id=?').get(userId) as {
      telegram_chat_id: string | null;
      telegram_username: string | null;
    } | undefined;
    res.json({
      connected: Boolean(user?.telegram_chat_id),
      telegramUsername: user?.telegram_username ?? null,
      botUsername: process.env.TELEGRAM_BOT_USERNAME || 'BachelorBudgetBot',
    });
  });

  app.post('/api/telegram/unlink', (req, res) => {
    const userId = req.userId!;
    db.prepare('UPDATE users SET telegram_chat_id=NULL, telegram_username=NULL WHERE id=?').run(userId);
    res.json({ success: true });
  });

  app.get('/api/accounts', (req, res) => {
    const rows = db.prepare(`SELECT a.id,a.name,a.currency,a.opening_balance AS openingBalance,a.opening_date AS openingDate,
      a.opening_balance
        + COALESCE((SELECT SUM(CASE WHEN e.type='income' THEN e.amount ELSE -e.amount END)
          FROM expenses e WHERE e.account_id=a.id AND e.user_id=a.user_id AND e.date>=a.opening_date AND e.date<=?),0)
        + COALESCE((SELECT SUM(t.amount) FROM transfers t WHERE t.to_account_id=a.id AND t.user_id=a.user_id AND t.date>=a.opening_date AND t.date<=?),0)
        - COALESCE((SELECT SUM(t.amount) FROM transfers t WHERE t.from_account_id=a.id AND t.user_id=a.user_id AND t.date>=a.opening_date AND t.date<=?),0)
        AS currentBalance
      FROM accounts a WHERE a.user_id=? ORDER BY a.id`).all(dateKeyLocal(), dateKeyLocal(), dateKeyLocal(), req.userId);
    res.json(rows);
  });
  app.post('/api/accounts', (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(1).max(80),
      currency: currencySchema,
      openingBalance: nonNegativeMoneySchema.optional().default(0),
      openingDate: dateSchema,
    }).strict();
    const input = respondWithValidation(schema, req.body, res);
    if (!input) return;
    try {
      const result = db.prepare('INSERT INTO accounts(user_id,name,currency,opening_balance,opening_date) VALUES(?,?,?,?,?)')
        .run(req.userId, input.name, input.currency, input.openingBalance, input.openingDate);
      return res.status(201).json({ id: Number(result.lastInsertRowid), ...input, currentBalance: input.openingBalance });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'An account with that name already exists' });
      }
      throw error;
    }
  });
  app.delete('/api/accounts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid account id' });
    const used = db.prepare(`SELECT 1 FROM expenses WHERE account_id=? UNION ALL
      SELECT 1 FROM transfers WHERE from_account_id=? OR to_account_id=? LIMIT 1`).get(id, id, id);
    if (used) return res.status(409).json({ error: 'Accounts with transaction history cannot be deleted' });
    const result = db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(id, req.userId);
    if (!result.changes) return res.status(404).json({ error: 'Account not found' });
    return res.status(204).end();
  });
  app.get('/api/transfers', (req, res) => {
    const rows = db.prepare(`SELECT t.*,source.name AS fromAccountName,destination.name AS toAccountName,source.currency
      FROM transfers t JOIN accounts source ON source.id=t.from_account_id
      JOIN accounts destination ON destination.id=t.to_account_id
      WHERE t.user_id=? ORDER BY t.date DESC,t.id DESC`).all(req.userId);
    res.json(rows);
  });
  app.post('/api/transfers', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      fromAccountId: z.number().int().positive(),
      toAccountId: z.number().int().positive(),
      amount: moneySchema,
      date: dateSchema,
      note: z.string().trim().max(300).optional().default(''),
    }).refine(transfer => transfer.fromAccountId !== transfer.toAccountId, {
      path: ['toAccountId'], message: 'Select two different accounts',
    });
    const input = respondWithValidation(schema, req.body, res);
    if (!input) return;
    const accounts = db.prepare('SELECT id,currency FROM accounts WHERE user_id=? AND id IN (?,?)')
      .all(userId, input.fromAccountId, input.toAccountId) as Array<{ id: number; currency: Currency }>;
    if (accounts.length !== 2) return res.status(400).json({ error: 'Both accounts must belong to you' });
    if (accounts[0].currency !== accounts[1].currency) {
      return res.status(400).json({ error: 'Transfers between different currencies are not supported; no conversion was applied' });
    }
    const result = db.prepare(`INSERT INTO transfers(user_id,from_account_id,to_account_id,amount,date,note)
      VALUES(?,?,?,?,?,?)`).run(userId, input.fromAccountId, input.toAccountId, input.amount, input.date, input.note);
    return res.status(201).json({ id: Number(result.lastInsertRowid), ...input, currency: accounts[0].currency });
  });
  app.delete('/api/transfers/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid transfer id' });
    const result = db.prepare('DELETE FROM transfers WHERE id=? AND user_id=?').run(id, req.userId);
    if (!result.changes) return res.status(404).json({ error: 'Transfer not found' });
    return res.status(204).end();
  });

  app.get('/api/goals', (req, res) => {
    const rows = db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY id DESC').all(req.userId) as Array<Record<string, unknown>>;
    res.json(rows);
  });
  const goalSchema = z.object({
    name: z.string().trim().min(1).max(100),
    target: moneySchema,
    saved: nonNegativeMoneySchema,
    currency: currencySchema,
  }).refine(goal => goal.saved <= goal.target, { path: ['saved'], message: 'Saved amount cannot exceed the target' });
  app.post('/api/goals', (req, res) => {
    const userId = req.userId!;
    const goal = respondWithValidation(goalSchema, { saved: 0, ...req.body }, res);
    if (!goal) return;
    const result = db.prepare('INSERT INTO goals(name,target,saved,currency,user_id) VALUES(?,?,?,?,?)')
      .run(goal.name, goal.target, goal.saved, goal.currency, userId);
    return res.status(201).json({ id: Number(result.lastInsertRowid), ...goal });
  });
  app.put('/api/goals/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid goal id' });
    const goal = respondWithValidation(goalSchema, req.body, res);
    if (!goal) return;
    const result = db.prepare('UPDATE goals SET name=?,target=?,saved=?,currency=? WHERE id=? AND user_id=?')
      .run(goal.name, goal.target, goal.saved, goal.currency, id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Goal not found' });
    return res.json({ id, ...goal });
  });
  app.delete('/api/goals/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid goal id' });
    const result = db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').run(id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Goal not found' });
    return res.status(204).end();
  });

  app.get('/api/households', (req, res) => {
    const rows = db.prepare(`SELECT h.*,hm.role AS my_role FROM households h
      JOIN household_members hm ON hm.household_id=h.id
      WHERE hm.user_id=? ORDER BY h.id DESC`).all(req.userId) as Array<Record<string, unknown>>;
    res.json(rows.map(row => ({ ...row, members: parseJson<string[]>(row.members as string, []) })));
  });
  app.post('/api/households', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      name: z.string().trim().min(1).max(100),
      members: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
    }).transform(group => ({ ...group, members: [...new Set(['Me', ...group.members])] }));
    const group = respondWithValidation(schema, req.body, res);
    if (!group) return;
    const result = db.transaction(() => {
      const created = db.prepare('INSERT INTO households(name,members,user_id) VALUES(?,?,?)')
        .run(group.name, JSON.stringify(group.members), userId);
      const householdId = Number(created.lastInsertRowid);
      db.prepare("INSERT INTO household_members(household_id,user_id,role) VALUES(?,?,'owner')")
        .run(householdId, userId);
      return householdId;
    })();
    return res.status(201).json({ id: result, ...group });
  });
  app.post('/api/households/:id/invitations', (req, res) => {
    const userId = req.userId!;
    const householdId = Number(req.params.id);
    if (!Number.isSafeInteger(householdId) || householdId < 1) return res.status(400).json({ error: 'Invalid household id' });
    const invite = respondWithValidation(z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()) }), req.body, res);
    if (!invite) return;
    const household = db.prepare(`SELECT h.id,h.name FROM households h
      JOIN household_members hm ON hm.household_id=h.id WHERE h.id=? AND hm.user_id=? AND hm.role='owner'`)
      .get(householdId, userId) as { id: number; name: string } | undefined;
    if (!household) return res.status(404).json({ error: 'Household not found or you are not its owner' });
    if (db.prepare(`SELECT 1 FROM household_members hm JOIN users u ON u.id=hm.user_id
      WHERE hm.household_id=? AND lower(u.email)=?`).get(householdId, invite.email)) {
      return res.status(409).json({ error: 'That account is already a household member' });
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO household_invitations(household_id,inviter_user_id,invitee_email,token_hash,expires_at)
      VALUES(?,?,?,?,?)`).run(householdId, userId, invite.email, tokenHash(token), expiresAt);
    return res.status(201).json({
      householdId,
      householdName: household.name,
      inviteeEmail: invite.email,
      invitationToken: token,
      expiresAt,
      delivery: 'Share this one-time token with the invited account; no email delivery is configured.',
    });
  });
  app.post('/api/households/invitations/accept', (req, res) => {
    const userId = req.userId!;
    const input = respondWithValidation(z.object({ invitationToken: z.string().min(32).max(100) }), req.body, res);
    if (!input) return;
    const account = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string };
    const invitation = db.prepare('SELECT id,household_id,invitee_email FROM household_invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?')
      .get(tokenHash(input.invitationToken), Date.now()) as { id: number; household_id: number; invitee_email: string } | undefined;
    if (!invitation) return res.status(404).json({ error: 'Invitation is expired or has already been used' });
    if (invitation.invitee_email.toLowerCase() !== account.email.toLowerCase()) {
      return res.status(403).json({ error: 'This invitation was issued to a different account' });
    }
    const accepted = db.transaction(() => {
      const consumed = db.prepare(`UPDATE household_invitations SET used_at=?
        WHERE id=? AND used_at IS NULL AND expires_at>?`).run(Date.now(), invitation.id, Date.now());
      if (!consumed.changes) return false;
      db.prepare("INSERT OR IGNORE INTO household_members(household_id,user_id,role) VALUES(?,?,'member')")
        .run(invitation.household_id, userId);
      const household = db.prepare('SELECT members FROM households WHERE id=?').get(invitation.household_id) as { members: string };
      const members = parseJson<string[]>(household.members, []);
      if (!members.some(member => member.toLowerCase() === account.email.toLowerCase())) {
        members.push(account.email);
        db.prepare('UPDATE households SET members=? WHERE id=?').run(JSON.stringify(members), invitation.household_id);
      }
      return true;
    })();
    if (!accepted) return res.status(404).json({ error: 'Invitation is expired or has already been used' });
    return res.json({ householdId: invitation.household_id, joined: true });
  });

  app.get('/api/budgets', (req, res) => {
    const parsed = respondWithValidation(z.object({ month: monthSchema }), req.query, res);
    if (!parsed) return;
    res.json(db.prepare('SELECT id,month,category,amount,currency FROM budgets WHERE month=? AND user_id=? ORDER BY category')
      .all(parsed.month, req.userId));
  });
  app.put('/api/budgets', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      month: monthSchema,
      category: z.string().trim().min(1).max(40),
      amount: moneySchema,
      currency: z.literal('INR').optional().default('INR'),
    });
    const budget = respondWithValidation(schema, req.body, res);
    if (!budget) return;
    const existing = db.prepare('SELECT id FROM budgets WHERE month=? AND category=? AND user_id=?')
      .get(budget.month, budget.category, userId) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE budgets SET amount=?,currency=? WHERE id=? AND user_id=?')
        .run(budget.amount, budget.currency, existing.id, userId);
    } else {
      db.prepare('INSERT INTO budgets(month,category,amount,currency,user_id) VALUES(?,?,?,?,?)')
        .run(budget.month, budget.category, budget.amount, budget.currency, userId);
    }
    return res.json(budget);
  });
  app.delete('/api/budgets/:id', (req, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid budget id' });
    const result = db.prepare('DELETE FROM budgets WHERE id=? AND user_id=?').run(id, userId);
    if (!result.changes) return res.status(404).json({ error: 'Budget not found' });
    return res.status(204).end();
  });

  app.get('/api/summary', async (req, res) => {
    const userId = req.userId!;
    const account = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string };
    const parsed = respondWithValidation(z.object({
      currency: currencySchema.optional().default('INR'),
      month: monthSchema.optional(),
    }), req.query, res);
    if (!parsed) return;
    const currentMonth = dateKeyLocal().slice(0, 7);
    const month = parsed.month ?? currentMonth;
    const displayCurrency: Currency = parsed.currency ?? 'INR';
    let bounds: ReturnType<typeof monthBounds>;
    try {
      bounds = monthBounds(month);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid month' });
    }
    const records = db.prepare(`SELECT e.* FROM expenses e WHERE
      (e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS
        (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))
      AND e.date BETWEEN ? AND ?`).all(userId, userId, bounds.start, bounds.end) as Array<Record<string, unknown>>;
    const current = month === currentMonth;
    const daysLeft = current ? daysRemainingInMonth(new Date()) : 0;
    const budgetRow = db.prepare("SELECT value FROM settings WHERE user_id=? AND key='monthlyBudget'").get(userId) as { value: string } | undefined;
    const thresholdRow = db.prepare("SELECT value FROM settings WHERE user_id=? AND key='warningThreshold'").get(userId) as { value: string } | undefined;
    const baseBudget = Number(budgetRow?.value ?? 0);
    const warningThreshold = Number(thresholdRow?.value ?? DEFAULT_WARNING_THRESHOLD);
    const allExpenses = db.prepare(`SELECT e.* FROM expenses e WHERE e.user_id=? OR
      (e.household_id IS NOT NULL AND EXISTS (SELECT 1 FROM household_members hm
        WHERE hm.household_id=e.household_id AND hm.user_id=?)) ORDER BY e.date DESC`)
      .all(userId, userId) as Array<Record<string, unknown>>;
    const categoryBudgets = db.prepare('SELECT * FROM budgets WHERE month=? AND user_id=?').all(month, userId) as Array<Record<string, unknown>>;
    const categoryBudgetCurrencies = categoryBudgets.map(row => row.currency as Currency);
    const transactionCurrencies = [...new Set(allExpenses.map(row => row.currency as Currency))];
    const needsRates = transactionCurrencies.some(code => code !== displayCurrency)
      || categoryBudgetCurrencies.some(code => code !== displayCurrency)
      || (displayCurrency !== 'INR' && (baseBudget > 0 || categoryBudgets.length > 0));
    let rateInfo: Awaited<ReturnType<typeof loadExchangeRates>> | null = null;
    if (needsRates) {
      try {
        rateInfo = await loadExchangeRates(db, [...transactionCurrencies, ...categoryBudgetCurrencies, displayCurrency]);
      } catch (error) {
        return res.status(503).json({ error: error instanceof Error ? error.message : 'Exchange rates are unavailable' });
      }
    }
    const calculationCurrency: Currency = rateInfo ? 'INR' : displayCurrency;
    const rateProvider = rateInfo
      ? { toBase: (amount: number, code: Currency) => amount * (rateInfo?.rates.get(code) ?? NaN) }
      : { toBase: (amount: number) => amount };
    const monthlySpending = calculateMonthlySpending(records.map(row => ({
      date: String(row.date),
      amount: Number(row.amount),
      currency: row.currency as Currency,
      category: String(row.category),
      shared: Boolean(row.shared),
      shares: parseJson<ParticipantShare[]>(row.shares as string, []),
      people: parseJson<string[]>(row.people as string, []),
      type: row.type === 'income' ? 'income' : 'expense',
      personalName: Number(row.user_id) === userId ? 'Me' : account.email,
    })), month, calculationCurrency, rateProvider);
    const totalBase = monthlySpending.total;
    const incomeBase = monthlySpending.income;
    const byCategoryBase = monthlySpending.byCategory;
    const canCompareBudgets = calculationCurrency === 'INR';
    const warnings = canCompareBudgets ? [{
      category: null as string | null,
      spent: totalBase,
      budget: baseBudget,
      percent: baseBudget ? totalBase / baseBudget * 100 : 0,
      status: getBudgetStatus(totalBase, baseBudget, warningThreshold),
    }, ...categoryBudgets.map(categoryBudget => {
      const spentAmount = byCategoryBase[String(categoryBudget.category)] ?? 0;
      const amount = Number(categoryBudget.amount);
      return {
        category: String(categoryBudget.category),
        spent: spentAmount,
        budget: amount,
        percent: amount ? spentAmount / amount * 100 : 0,
        status: getBudgetStatus(spentAmount, amount, warningThreshold),
      };
    })].filter(warning => warning.status !== 'ok') : [];
    const total = rateInfo ? convertCurrency(totalBase, 'INR', displayCurrency, rateProvider) : totalBase;
    const income = rateInfo ? convertCurrency(incomeBase, 'INR', displayCurrency, rateProvider) : incomeBase;
    const budget = canCompareBudgets
      ? (rateInfo ? convertCurrency(baseBudget, 'INR', displayCurrency, rateProvider) : baseBudget)
      : 0;
    const categoryBudgetAmounts = Object.fromEntries(categoryBudgets.map(categoryBudget => {
      const amount = Number(categoryBudget.amount);
      const budgetCurrency = categoryBudget.currency as Currency;
      return [
        String(categoryBudget.category),
        rateInfo ? convertCurrency(amount, budgetCurrency, displayCurrency, rateProvider) : amount,
      ];
    }));
    const byCategory = Object.fromEntries(Object.entries(byCategoryBase).map(([category, value]) => [
      category, rateInfo ? convertCurrency(value, 'INR', displayCurrency, rateProvider) : value,
    ]));
    const topCategories = Object.entries(byCategoryBase).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([category, value]) => ({ category, amount: rateInfo ? convertCurrency(value, 'INR', displayCurrency, rateProvider) : value }));
    const priorMonth = monthBounds(`${String(Number(month.slice(0, 4)) - (month.endsWith('-01') ? 1 : 0)).padStart(4, '0')}-${month.endsWith('-01') ? '12' : String(Number(month.slice(5)) - 1).padStart(2, '0')}`);
    const priorBase = allExpenses.filter(row => row.type !== 'income' && String(row.date) >= priorMonth.start && String(row.date) <= priorMonth.end)
      .reduce((sum, row) => sum + convertCurrency(
        expensePersonalAmount(row, Number(row.user_id) === userId ? 'Me' : account.email),
        row.currency as Currency,
        calculationCurrency,
        rateProvider,
      ), 0);
    const increase = priorBase > 0 ? (totalBase - priorBase) / priorBase * 100 : null;
    const paymentModeSpendingBase = calculatePaymentModeSpending(records.map(row => ({
      date: String(row.date),
      amount: Number(row.amount),
      currency: row.currency as Currency,
      category: String(row.category),
      shared: Boolean(row.shared),
      shares: parseJson<ParticipantShare[]>(row.shares as string, []),
      people: parseJson<string[]>(row.people as string, []),
      type: row.type === 'income' ? 'income' : 'expense',
      paymentMode: (row.payment_mode as PaymentMode) || 'UPI',
      personalName: Number(row.user_id) === userId ? 'Me' : account.email,
    })), month, calculationCurrency, rateProvider);
    const byPaymentMode = Object.fromEntries(Object.entries(paymentModeSpendingBase).map(([mode, value]) => [
      mode, rateInfo ? convertCurrency(value, 'INR', displayCurrency, rateProvider) : value,
    ]));

    const dailySpendingRaw = calculateDailySpending(records.map(row => ({
      date: String(row.date),
      amount: Number(row.amount),
      currency: row.currency as Currency,
      category: String(row.category),
      shared: Boolean(row.shared),
      shares: parseJson<ParticipantShare[]>(row.shares as string, []),
      people: parseJson<string[]>(row.people as string, []),
      type: row.type === 'income' ? 'income' : 'expense',
      personalName: Number(row.user_id) === userId ? 'Me' : account.email,
    })), month, calculationCurrency, rateProvider);
    const dailySpending = dailySpendingRaw.map(item => ({
      ...item,
      amount: rateInfo ? convertCurrency(item.amount, 'INR', displayCurrency, rateProvider) : item.amount,
    }));

    const biggestSpends = records
      .filter(row => row.type !== 'income')
      .slice()
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 3)
      .map(expenseForResponse);
    const transactionCount = records.length;
    const daysElapsed = current ? Math.max(1, new Date().getDate()) : (bounds.end ? Number(bounds.end.slice(8, 10)) : 30);
    const averagePerDay = Math.round((total / daysElapsed) * 100) / 100;
    const priorMonthComparison = {
      priorMonthTotal: rateInfo ? convertCurrency(priorBase, 'INR', displayCurrency, rateProvider) : priorBase,
      increasePercent: increase,
    };

    res.json({
      month,
      currency: displayCurrency,
      baseCurrency: 'INR',
      total,
      income,
      budget,
      remaining: canCompareBudgets && baseBudget > 0 ? budget - total : null,
      daysLeft,
      dailyLimit: canCompareBudgets && baseBudget > 0 && current && daysLeft ? Math.max(0, budget - total) / daysLeft : null,
      byCategory,
      byPaymentMode,
      dailySpending,
      biggestSpends,
      transactionCount,
      averagePerDay,
      priorMonthComparison,
      categoryBudgetAmounts,
      budgetUsedPercent: canCompareBudgets && budget ? total / budget * 100 : 0,
      warningThreshold,
      warnings,
      topCategories,
      priorMonthTotal: rateInfo ? convertCurrency(priorBase, 'INR', displayCurrency, rateProvider) : priorBase,
      monthOverMonthIncreasePercent: increase,
      recent: records.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5).map(expenseForResponse),
      rateNote: rateInfo
        ? `${rateInfo.warning ? `${rateInfo.warning} ` : ''}Rates from ${rateInfo.source}, dated ${rateInfo.rateDate}, cached ${rateInfo.fetchedAt ? new Date(rateInfo.fetchedAt).toISOString() : 'unknown'}.`
        : `No currency conversion applied. Totals are in ${calculationCurrency}.${canCompareBudgets ? '' : ' INR budget comparisons are unavailable in this currency until an exchange-rate provider is configured.'}`,
      rateSource: rateInfo?.source ?? null,
      rateDate: rateInfo?.rateDate ?? null,
      rateFetchedAt: rateInfo?.fetchedAt ?? null,
    });
  });

  app.get('/api/months', (req, res) => {
    const rows = db.prepare(`SELECT DISTINCT substr(e.date,1,7) AS month FROM expenses e
      WHERE e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS
        (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?))
      ORDER BY month DESC`).all(req.userId, req.userId) as Array<{ month: string }>;
    res.json([dateKeyLocal().slice(0, 7), ...rows.map(row => row.month)].filter((value, index, all) => all.indexOf(value) === index));
  });

  app.get('/api/settlements', (req, res) => {
    const userId = req.userId!;
    const parsed = respondWithValidation(z.object({ month: monthSchema.optional() }), req.query, res);
    if (!parsed) return;
    const month = parsed.month ?? dateKeyLocal().slice(0, 7);
    let bounds: ReturnType<typeof monthBounds>;
    try { bounds = monthBounds(month); } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid month' });
    }
    const rows = db.prepare(`SELECT e.amount,e.currency,e.payer,e.shared,e.shares,e.people,e.household_id,
      h.name AS household_name FROM expenses e LEFT JOIN households h ON h.id=e.household_id
      WHERE e.shared=1 AND e.date BETWEEN ? AND ? AND
        (e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS
          (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))`)
      .all(bounds.start, bounds.end, userId, userId) as Array<Record<string, unknown>>;
    const groups = new Map<string, {
      householdId: number | null;
      householdName: string | null;
      currency: Currency;
      bills: Array<{ amount: number; payer: string; shares: ParticipantShare[] }>;
    }>();
    for (const row of rows) {
      const currency = row.currency as Currency;
      const householdId = row.household_id === null ? null : Number(row.household_id);
      const groupKey = `${householdId ?? 'unassigned'}:${currency}`;
      const group = groups.get(groupKey) ?? {
        householdId,
        householdName: row.household_name ? String(row.household_name) : null,
        currency,
        bills: [],
      };
      let shares = parseJson<ParticipantShare[]>(row.shares as string, []);
      if (!shares.length) shares = splitEqual(Number(row.amount), ['Me', ...parseJson<string[]>(row.people as string, [])]);
      group.bills.push({
        amount: Number(row.amount),
        payer: String(row.payer || 'Me'),
        shares,
      });
      groups.set(groupKey, group);
    }
    const userUpiRow = db.prepare("SELECT value FROM settings WHERE user_id=? AND key='upiId'").get(userId) as { value: string } | undefined;
    const myUpiId = userUpiRow?.value ?? '';
    const userProfileRow = db.prepare("SELECT value FROM settings WHERE user_id=? AND key='username'").get(userId) as { value: string } | undefined;
    const myUsername = userProfileRow?.value ?? '';
    const userEmailRow = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string } | undefined;
    const myEmail = userEmailRow?.email ?? '';

    const details: Record<string, { upiId: string | null; settled: boolean; settledAt: string | null; upiReference: string | null }> = {};
    const records = db.prepare('SELECT * FROM settlement_records WHERE user_id=? ORDER BY id DESC').all(userId);

    const result = [...groups.values()].flatMap(group =>
      calculateSettlements(group.bills).map(settlement => {
        const key = `${group.householdId ?? 'local'}:${settlement.from}:${settlement.to}:${settlement.amount}`;
        const isToMe = settlement.to.toLowerCase() === 'me'
          || (myUsername && settlement.to.toLowerCase() === myUsername.toLowerCase())
          || (myEmail && settlement.to.toLowerCase() === myEmail.toLowerCase());

        let upiId = isToMe ? myUpiId : '';
        if (!upiId) {
          const memberUpi = db.prepare(`
            SELECT s.value FROM settings s
            JOIN users u ON u.id = s.user_id
            WHERE s.key='upiId' AND (LOWER(u.email) LIKE LOWER(?) OR s.user_id IN (
              SELECT user_id FROM settings WHERE key='username' AND LOWER(value)=LOWER(?)
            )) LIMIT 1
          `).get(`%${settlement.to}%`, settlement.to) as { value: string } | undefined;
          if (memberUpi) upiId = memberUpi.value;
        }

        const settledRecord = db.prepare(`
          SELECT id, upi_reference, settled_at FROM settlement_records
          WHERE (household_id IS ? OR household_id IS NULL)
            AND LOWER(from_name)=LOWER(?) AND LOWER(to_name)=LOWER(?)
          ORDER BY id DESC LIMIT 1
        `).get(group.householdId, settlement.from, settlement.to) as { id: number; upi_reference: string; settled_at: string } | undefined;

        details[key] = {
          upiId: upiId || null,
          settled: Boolean(settledRecord),
          settledAt: settledRecord?.settled_at ?? null,
          upiReference: settledRecord?.upi_reference ?? null,
        };

        return {
          from: settlement.from,
          to: settlement.to,
          amount: settlement.amount,
          currency: group.currency,
          householdId: group.householdId,
          householdName: group.householdName,
        };
      }),
    );
    res.json({ month, settlements: result, details, myUpiId: myUpiId || null, records });
  });

  app.post('/api/settlements/settle', (req, res) => {
    const userId = req.userId!;
    const schema = z.object({
      from: z.string().trim().min(1).max(60),
      to: z.string().trim().min(1).max(60),
      amount: nonNegativeMoneySchema,
      currency: currencySchema.default('INR'),
      householdId: z.number().int().positive().nullable().optional(),
      upiReference: z.string().trim().max(100).optional(),
      note: z.string().trim().max(300).optional().default(''),
    });
    const input = respondWithValidation(schema, req.body, res);
    if (!input) return;

    const result = db.prepare(`
      INSERT INTO settlement_records (user_id, household_id, from_name, to_name, amount, currency, upi_reference, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, input.householdId ?? null, input.from, input.to, input.amount, input.currency, input.upiReference ?? null, input.note ?? '');

    syncSettlementToSupabase({
      householdId: input.householdId ?? null,
      from: input.from,
      to: input.to,
      amount: input.amount,
      currency: input.currency,
      settled: true,
      upiReference: input.upiReference,
    }).catch(() => {});

    res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
  });

  app.get('/api/supabase/status', async (_req, res) => {
    const status = await checkSupabaseConnection();
    res.json(status);
  });

  app.post('/api/supabase/sync', async (req, res) => {
    const userId = req.userId!;
    const rows = db.prepare('SELECT * FROM expenses WHERE user_id=?').all(userId) as Array<Record<string, unknown>>;
    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      const outcome = await syncTransactionToSupabase(expenseForResponse(row), userId);
      if (outcome.success) synced += 1;
      else failed += 1;
    }
    res.json({ total: rows.length, synced, failed });
  });

  app.get('/api/export.csv', (req, res) => {
    const userId = req.userId!;
    const filterSchema = z.object({
      from: dateSchema.optional(),
      to: dateSchema.optional(),
      category: z.string().max(40).optional(),
      currency: currencySchema.optional(),
      type: z.enum(['expense', 'income']).optional(),
    }).refine(filters => !filters.from || !filters.to || filters.from <= filters.to, 'Start date must not be after end date');
    const filters = respondWithValidation(filterSchema, req.query, res);
    if (!filters) return;
    const clauses: string[] = ['(e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))'];
    const params: unknown[] = [userId, userId];
    if (filters.from) { clauses.push('e.date >= ?'); params.push(filters.from); }
    if (filters.to) { clauses.push('e.date <= ?'); params.push(filters.to); }
    if (filters.category) { clauses.push('e.category = ?'); params.push(filters.category); }
    if (filters.currency) { clauses.push('e.currency = ?'); params.push(filters.currency); }
    if (filters.type) { clauses.push('e.type = ?'); params.push(filters.type); }
    const rows = db.prepare(`SELECT e.id,e.title,e.amount,e.currency,e.category,e.date,e.note,e.shared,e.people,e.payer,e.split_method,e.shares,e.type,e.source,e.payment_mode,e.upi_app,e.upi_reference FROM expenses e WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC,e.id DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    const csvValue = (value: unknown) => {
      const text = String(value ?? '');
      const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safeText.replaceAll('"', '""')}"`;
    };
    const header = ['id', 'description', 'amount', 'currency', 'type', 'category', 'payment_mode', 'upi_app', 'upi_reference', 'date', 'notes', 'shared', 'payer', 'split_method', 'shares', 'source'];
    const csv = [
      header.join(','),
      ...rows.map(row => [
        row.id, row.title, row.amount, row.currency, row.type, row.category, row.payment_mode || 'UPI', row.upi_app || '', row.upi_reference || '', row.date, row.note, Boolean(row.shared),
        row.payer, row.split_method, row.shares, row.source,
      ].map(csvValue).join(',')),
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bachelorbudget-expenses.csv"');
    res.send(csv);
  });

  app.get('/api/report/statement', (req, res) => {
    const userId = req.userId!;
    const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string };
    const parsed = respondWithValidation(z.object({
      month: monthSchema.optional(),
      currency: currencySchema.optional().default('INR'),
    }), req.query, res);
    if (!parsed) return;
    const currentMonth = dateKeyLocal().slice(0, 7);
    const month = parsed.month ?? currentMonth;
    const displayCurrency = parsed.currency ?? 'INR';
    const bounds = monthBounds(month);

    const userProfileRow = db.prepare("SELECT key,value FROM settings WHERE user_id=? AND key IN ('username','upiId','monthlyBudget','warningThreshold')").all(userId) as Array<{ key: string; value: string }>;
    const profile = Object.fromEntries(userProfileRow.map(r => [r.key, r.value]));

    const records = db.prepare(`SELECT e.* FROM expenses e WHERE
      (e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS
        (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))
      AND e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC`).all(userId, userId, bounds.start, bounds.end) as Array<Record<string, unknown>>;

    const transactions = records.map(expenseForResponse);
    let totalExpense = 0;
    let totalIncome = 0;
    const byCategory: Record<string, number> = {};
    const byPaymentMode: Record<string, number> = {};

    for (const tx of transactions) {
      const amt = Number(tx.amount);
      if (tx.type === 'income') {
        totalIncome += amt;
      } else {
        const share = personalShare(amt, tx.shared, tx.shares, tx.people, Number(tx.user_id) === userId ? 'Me' : user.email);
        totalExpense += share;
        byCategory[tx.category] = Math.round(((byCategory[tx.category] ?? 0) + share) * 100) / 100;
        const mode = tx.paymentMode || 'UPI';
        byPaymentMode[mode] = Math.round(((byPaymentMode[mode] ?? 0) + share) * 100) / 100;
      }
    }

    const budget = Number(profile.monthlyBudget || 0);
    const settlementsRows = db.prepare(`SELECT e.amount,e.currency,e.payer,e.shared,e.shares,e.people,e.household_id,
      h.name AS household_name FROM expenses e LEFT JOIN households h ON h.id=e.household_id
      WHERE e.shared=1 AND e.date BETWEEN ? AND ? AND
        (e.user_id=? OR (e.household_id IS NOT NULL AND EXISTS
          (SELECT 1 FROM household_members hm WHERE hm.household_id=e.household_id AND hm.user_id=?)))`)
      .all(bounds.start, bounds.end, userId, userId) as Array<Record<string, unknown>>;

    const bills = settlementsRows.map(r => ({
      amount: Number(r.amount),
      payer: String(r.payer || 'Me'),
      shares: parseJson<ParticipantShare[]>(r.shares as string, []),
    }));
    const settlements = calculateSettlements(bills);

    res.json({
      statementId: `BB-${month.replace('-', '')}-${userId}`,
      generatedAt: new Date().toISOString(),
      month,
      currency: displayCurrency,
      user: {
        email: user.email,
        name: profile.username || user.email.split('@')[0],
        upiId: profile.upiId || null,
      },
      summary: {
        totalExpense: Math.round(totalExpense * 100) / 100,
        totalIncome: Math.round(totalIncome * 100) / 100,
        netSavings: Math.round((totalIncome - totalExpense) * 100) / 100,
        budget,
        budgetUsedPercent: budget > 0 ? Math.round((totalExpense / budget) * 100) : 0,
        transactionCount: transactions.length,
      },
      byCategory,
      byPaymentMode,
      transactions,
      settlements,
    });
  });

  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    console.error('Unhandled API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);
  return app;
}

function createDatabase(): Database.Database {
  const dbPath = resolve(process.env.DB_PATH || 'data/bachelorbudget.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initializeDatabase(db);
  return db;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const db = createDatabase();
  const port = Number(process.env.PORT || 4000);
  createApp(db).listen(port, () => console.log(`BachelorBudget API running on http://localhost:${port}`));
}
