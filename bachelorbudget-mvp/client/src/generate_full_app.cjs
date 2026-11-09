const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, 'App.original.tsx');
let code = fs.readFileSync(srcPath, 'utf8');

// Replace lucide imports
code = code.replace(
  /import \{[\s\S]*?\} from 'lucide-react';/,
  `import {
  AlertCircle, ArrowDownRight, ArrowUpRight, Bell, CalendarDays, Check, CheckCircle2, CheckSquare,
  CircleDollarSign, Clock, Copy, Database, Download, ExternalLink, Eye, EyeOff, Filter, HelpCircle,
  LayoutDashboard, LogOut, Moon, Pencil, PieChart, Plus, Printer, QrCode,
  ReceiptText, RefreshCw, Send, Settings, Share2, Smartphone, Sparkles, Split, Square, Sun, Target,
  Trash2, TrendingUp, Users, Wallet, X,
} from 'lucide-react';
import { parseNaturalSpend, type ParsedExpense } from './parser.js';`
);

// Replace Modal definition with Vibe, Limit, Preset types
code = code.replace(
  "type Modal = 'expense' | 'goal' | 'budget' | 'household' | 'statement' | null;",
  `export type Vibe = 'College Student' | 'PG / Hostel Resident' | 'Working Bachelor';
export const VIBES: Array<{ vibe: Vibe; title: string; emoji: string; desc: string; sample: string }> = [
  {
    vibe: 'College Student',
    title: 'College Student',
    emoji: '🎓',
    desc: 'Chai breaks, canteen rolls, semester books, bus passes, and pocket money.',
    sample: 'Chai ₹20 · Canteen ₹80 · Printouts ₹30',
  },
  {
    vibe: 'PG / Hostel Resident',
    title: 'PG / Hostel Resident',
    emoji: '🏠',
    desc: 'Room rent, mess fees, shared wifi, weekend laundry, and split groceries.',
    sample: 'Mess ₹3500 · Laundry ₹150 · WiFi Share ₹200',
  },
  {
    vibe: 'Working Bachelor',
    title: 'Working Bachelor',
    emoji: '💼',
    desc: 'Swiggy dinners, gym memberships, fuel, weekend clubbing, and flat rent.',
    sample: 'Swiggy ₹280 · Gym ₹1200 · Fuel ₹500',
  },
];

export type CategoryLimitItem = {
  id: number;
  category: string;
  amountLimit: number;
  frequencyLimit: number | null;
  currency: string;
  currentSpent: number;
  currentCount: number;
  status: 'ok' | 'warning' | 'exceeded';
};

export type PresetItem = {
  id: number;
  title: string;
  amount: number;
  category: string;
  currency: string;
  paymentMode: PaymentMode;
};

type Modal = 'expense' | 'goal' | 'budget' | 'household' | 'statement' | 'preset' | 'limit' | 'vibe' | null;`
);

// Add new state variables right after filters state in App()
const stateHookTarget = "const [filters, setFilters] = useState<Filters>({ from: '', to: '', category: '', currency: '', type: '', paymentMode: '' });";
const stateHookRepl = `${stateHookTarget}

  // Part B & C state
  const [limits, setLimits] = useState<CategoryLimitItem[]>([]);
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [undoToast, setUndoToast] = useState<{ id: number; title: string; amount: number } | null>(null);
  const [nudgeToast, setNudgeToast] = useState<string | null>(null);
  const [selectedTxIds, setSelectedTxIds] = useState<Set<number>>(new Set());
  const [vibe, setVibe] = useState<Vibe>(() => {
    return (localStorage.getItem('bb_vibe') as Vibe) || 'College Student';
  });
  const [showVibePrompt, setShowVibePrompt] = useState<boolean>(() => !localStorage.getItem('bb_vibe'));
  const [telegramCode, setTelegramCode] = useState<string | null>(null);
  const [telegramExpiry, setTelegramExpiry] = useState<number | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<{ connected: boolean; telegramUsername?: string; botUsername?: string }>({ connected: false });
  const [bellOpen, setBellOpen] = useState(false);
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderTime, setReminderTime] = useState('21:00');
  const [nightlyDismissed, setNightlyDismissed] = useState<boolean>(() => {
    return localStorage.getItem('bb_reconcile_dismissed') === today();
  });

  const loadLimits = useCallback(async () => {
    try {
      const data = await api<CategoryLimitItem[]>('/limits');
      setLimits(data);
    } catch {}
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const data = await api<PresetItem[]>('/presets');
      setPresets(data);
    } catch {}
  }, []);

  const loadTelegramStatus = useCallback(async () => {
    try {
      const data = await api<{ connected: boolean; telegramUsername?: string; botUsername?: string }>('/telegram/status');
      setTelegramStatus(data);
    } catch {}
  }, []);

  const logQuickSpend = async (title: string, amount: number, cat: string, mode: PaymentMode, shared = false, people: string[] = []) => {
    try {
      const res = await api<Expense & { limitNudge?: string }>('/transactions', {
        method: 'POST',
        body: JSON.stringify({
          title,
          amount,
          currency,
          category: cat,
          date: today(),
          paymentMode: mode,
          shared,
          people,
          payer: 'Me',
        }),
      });
      if (res?.limitNudge) {
        setNudgeToast(res.limitNudge);
      }
      setUndoToast({ id: res.id, title, amount });
      await refresh();
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log spend');
    }
  };

  const handleUndo = async (id: number) => {
    try {
      await api(\`/transactions/\${id}\`, { method: 'DELETE' });
      setUndoToast(null);
      setNotice('Spend undone!');
      await refresh();
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo spend');
    }
  };

  const handleBatchCategory = async (ids: number[], newCategory: string) => {
    try {
      await api('/transactions/batch-category', {
        method: 'POST',
        body: JSON.stringify({ ids, category: newCategory }),
      });
      setSelectedTxIds(new Set());
      setNotice(\`Updated category for \${ids.length} transactions\`);
      await refresh();
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update category');
    }
  };

  const handleBatchPaymentMode = async (ids: number[], newMode: PaymentMode) => {
    try {
      await api('/transactions/batch-payment-mode', {
        method: 'POST',
        body: JSON.stringify({ ids, paymentMode: newMode }),
      });
      setSelectedTxIds(new Set());
      setNotice(\`Updated payment mode for \${ids.length} transactions\`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update payment mode');
    }
  };

  const handleBatchDelete = async (ids: number[]) => {
    if (!window.confirm(\`Delete \${ids.length} selected transactions?\`)) return;
    try {
      await api('/transactions/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      setSelectedTxIds(new Set());
      setNotice(\`Deleted \${ids.length} transactions\`);
      await refresh();
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete transactions');
    }
  };

  const handleToggleSplit = async (id: number, shared: boolean, people: string[] = ['Roomie']) => {
    try {
      await api(\`/transactions/\${id}/toggle-split\`, {
        method: 'POST',
        body: JSON.stringify({ shared, people }),
      });
      setNotice('Split updated');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update split');
    }
  };

  const handleSaveLimit = async (category: string, amountLimit: number, frequencyLimit?: number | null) => {
    try {
      await api('/limits', {
        method: 'POST',
        body: JSON.stringify({ category, amountLimit, frequencyLimit, currency }),
      });
      setNotice('Category limit saved!');
      setModal(null);
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save limit');
    }
  };

  const handleDeleteLimit = async (id: number) => {
    try {
      await api(\`/limits/\${id}\`, { method: 'DELETE' });
      setNotice('Category limit removed.');
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete limit');
    }
  };

  const handleAddPreset = async (title: string, amount: number, category: string, paymentMode: PaymentMode) => {
    try {
      await api('/presets', {
        method: 'POST',
        body: JSON.stringify({ title, amount, category, currency, paymentMode }),
      });
      setNotice('Quick preset added!');
      setModal(null);
      void loadPresets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add preset');
    }
  };

  const handleSelectVibe = (newVibe: Vibe) => {
    setVibe(newVibe);
    localStorage.setItem('bb_vibe', newVibe);
    setShowVibePrompt(false);
    void api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ vibe: newVibe }),
    }).catch(() => {});
    void loadPresets();
  };

  const handleGenerateTelegramCode = async () => {
    try {
      const data = await api<{ code: string; expiresAt: number; botUsername: string }>('/telegram/code', { method: 'POST' });
      setTelegramCode(data.code);
      setTelegramExpiry(data.expiresAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate sync code');
    }
  };

  const handleUnlinkTelegram = async () => {
    if (!window.confirm('Disconnect your Telegram account?')) return;
    try {
      await api('/telegram/unlink', { method: 'POST' });
      setTelegramStatus({ connected: false });
      setNotice('Telegram unlinked.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink Telegram');
    }
  };

  const handleSaveReminder = async (enabled: boolean, time: string) => {
    setReminderEnabled(enabled);
    setReminderTime(time);
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ reminderEnabled: enabled, reminderTime: time }),
      });
      setNotice(enabled ? \`Daily reminder set for \${time}\` : 'Reminders turned off');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save reminder setting');
    }
  };

  const handleInlineEdit = async (id: number, fields: Partial<Expense>) => {
    try {
      const existing = expenses.find(e => e.id === id);
      if (!existing) return;
      const res = await api<Expense & { limitNudge?: string }>(\`/transactions/\${id}\`, {
        method: 'PUT',
        body: JSON.stringify({
          ...existing,
          ...fields,
        }),
      });
      if (res?.limitNudge) {
        setNudgeToast(res.limitNudge);
      }
      setNotice('Transaction updated');
      await refresh();
      void loadLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update transaction');
    }
  };`;

code = code.replace(stateHookTarget, stateHookRepl);

// Update useEffect to load limits, presets, telegram, and SSE
const sseHookTarget = "  useEffect(() => {\n    if (user) void refresh();\n    else if (authReady) setLoading(false);\n  }, [authReady, refresh, user]);";
const sseHookRepl = `  useEffect(() => {
    if (user) {
      void refresh();
      void loadLimits();
      void loadPresets();
      void loadTelegramStatus();
    } else if (authReady) {
      setLoading(false);
    }
  }, [authReady, refresh, user, loadLimits, loadPresets, loadTelegramStatus]);

  // Real-time Server-Sent Events (SSE) listener
  useEffect(() => {
    if (!user) return;
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(\`\${API}/events\`, { withCredentials: true });
      eventSource.addEventListener('transaction_created', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.limitNudge) setNudgeToast(data.limitNudge);
          setNotice(\`New spend: \${data.title} (\${data.amount})\`);
          void refresh();
          void loadLimits();
        } catch {}
      });
      eventSource.addEventListener('transaction_updated', () => {
        void refresh();
        void loadLimits();
      });
      eventSource.addEventListener('transaction_deleted', () => {
        void refresh();
        void loadLimits();
      });
      eventSource.addEventListener('telegram_connected', (e) => {
        try {
          const data = JSON.parse(e.data);
          setTelegramStatus({ connected: true, telegramUsername: data.telegramUsername });
          setNotice(\`Telegram connected as @\${data.telegramUsername}!\`);
        } catch {}
      });
    } catch {}

    return () => {
      eventSource?.close();
    };
  }, [user, refresh, loadLimits]);`;

code = code.replace(sseHookTarget, sseHookRepl);

console.log('Writing updated App.tsx...');
fs.writeFileSync(path.join(__dirname, 'App.temp.tsx'), code, 'utf8');

