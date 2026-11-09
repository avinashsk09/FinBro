import { PAYMENT_MODES, type PaymentMode, type UpiApp, UPI_APPS } from './domain.js';

export interface ParsedExpense {
  amount: number;
  title: string;
  category: string;
  paymentMode: PaymentMode;
  upiApp?: UpiApp | null;
  date: string;
  shared: boolean;
  people: string[];
  raw: string;
  valid: boolean;
  confidence: number;
  error?: string;
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Food & drinks': [
    'chai', 'tea', 'coffee', 'biryani', 'pizza', 'burger', 'maggi', 'momo', 'momos', 'samosa',
    'roll', 'dosa', 'idli', 'thali', 'mess', 'canteen', 'swiggy', 'zomato', 'dinner', 'lunch',
    'breakfast', 'snacks', 'snack', 'cafe', 'restaurant', 'food', 'drink', 'drinks', 'juice', 'shawarma',
  ],
  'Groceries': [
    'groceries', 'grocery', 'blinkit', 'zepto', 'instamart', 'milk', 'vegetables', 'veggies',
    'fruits', 'curd', 'bread', 'eggs', 'dmart', 'supermarket', 'ration', 'sabzi',
  ],
  'Rent / PG': [
    'rent', 'pg', 'room rent', 'flat rent', 'hostel fee', 'deposit', 'owner', 'maintenance',
  ],
  'Utilities': [
    'wifi', 'internet', 'broadband', 'electricity', 'current', 'power', 'water', 'gas',
    'cylinder', 'maid', 'cook',
  ],
  'Transport': [
    'auto', 'cab', 'uber', 'ola', 'rapido', 'metro', 'bus', 'train', 'flight', 'ticket',
    'travel', 'toll', 'fare',
  ],
  'Mobile recharge': [
    'recharge', 'jio', 'airtel', 'vi', 'mobile recharge', 'phone recharge', 'data pack',
  ],
  'Laundry': [
    'laundry', 'iron', 'ironing', 'dhobi', 'dry clean', 'washing',
  ],
  'Gym/Sports': [
    'gym', 'fitness', 'protein', 'creatine', 'badminton', 'football', 'cricket', 'turf',
  ],
  'Trips & outings': [
    'trip', 'trek', 'outing', 'travel', 'resort', 'hotel', 'goa', 'manali', 'hill station',
  ],
  'Gifts': [
    'gift', 'present', 'birthday', 'anniversary', 'flowers',
  ],
  'Stationery & Books': [
    'print', 'xerox', 'photocopy', 'notebook', 'pen', 'pencil', 'book', 'stationery', 'binder',
  ],
  'Gaming': [
    'game', 'gaming', 'steam', 'playstation', 'ps5', 'xbox', 'valorant', 'bgmi', 'pubg', 'skin',
  ],
  'Fuel': [
    'petrol', 'diesel', 'fuel', 'gasoline', 'oil',
  ],
  'Party': [
    'party', 'beer', 'alcohol', 'drinks', 'club', 'pub', 'liquor', 'wine', 'bar',
  ],
  'Education': [
    'college fee', 'tuition', 'exam fee', 'course', 'udemy', 'coursera', 'books',
  ],
  'Health': [
    'medicine', 'doctor', 'clinic', 'hospital', 'medical', 'pharmacy', 'tablets', 'meds',
  ],
  'Subscriptions': [
    'netflix', 'prime', 'spotify', 'hotstar', 'youtube', 'subscription', 'apple', 'chatgpt',
  ],
  'Shopping': [
    'shopping', 'clothes', 'myntra', 'amazon', 'flipkart', 'shoes', 'shirt', 'jeans',
  ],
  'Entertainment': [
    'movie', 'theatre', 'cinema', 'show', 'concert', 'standup', 'ticket',
  ],
};

const MODE_KEYWORDS: Record<PaymentMode, string[]> = {
  'UPI': ['upi', 'gpay', 'phonepe', 'paytm', 'bhim', 'cred', 'qr', 'scan'],
  'Cash': ['cash', 'notes', 'offline'],
  'Credit Card': ['credit card', 'credit', 'cc'],
  'Debit Card': ['debit card', 'debit', 'dc', 'card'],
  'Net Banking': ['net banking', 'netbanking', 'neft', 'imps', 'rtgs', 'bank transfer'],
  'Wallet': ['wallet', 'amazon pay', 'paytm wallet'],
};

const UPI_APP_KEYWORDS: Record<UpiApp, string[]> = {
  'GPay': ['gpay', 'google pay', 'googlepay'],
  'PhonePe': ['phonepe', 'phone pe'],
  'Paytm': ['paytm'],
  'BHIM': ['bhim'],
  'Cred': ['cred'],
  'Other': ['other upi'],
};

function getLocalDateString(offsetDays = 0): string {
  const d = new Date();
  if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseNaturalSpend(input: string): ParsedExpense {
  const raw = input.trim();
  if (!raw) {
    return {
      amount: 0,
      title: '',
      category: 'Other',
      paymentMode: 'UPI',
      date: getLocalDateString(0),
      shared: false,
      people: [],
      raw,
      valid: false,
      confidence: 0,
      error: 'Please enter an expense note with an amount (e.g. "140 biryani upi")',
    };
  }

  let text = raw.toLowerCase();
  let amount = 0;
  let date = getLocalDateString(0);
  let shared = false;
  let people: string[] = [];
  let paymentMode: PaymentMode = 'UPI';
  let upiApp: UpiApp | null = null;
  let category = 'Other';

  // 1. Extract Date: "yesterday" or "today" or YYYY-MM-DD
  if (/\byesterday\b/.test(text)) {
    date = getLocalDateString(-1);
    text = text.replace(/\byesterday\b/g, ' ');
  } else if (/\btoday\b/.test(text)) {
    date = getLocalDateString(0);
    text = text.replace(/\btoday\b/g, ' ');
  } else {
    const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) {
      date = dateMatch[1];
      text = text.replace(dateMatch[0], ' ');
    }
  }

  // 2. Extract Split / Shared: "split with rahul, priya" or "split rahul" or "split 50/50" or "split"
  const splitWithMatch = text.match(/\bsplit\s+(?:with\s+)?([a-zA-Z0-9,\s]+)/);
  if (splitWithMatch) {
    shared = true;
    const rawNames = splitWithMatch[1]
      .split(/[,&]+|\band\b/)
      .map(n => n.trim())
      .filter(n => n && !['me', '50/50', 'equal', 'half', 'equally'].includes(n.toLowerCase()));
    if (rawNames.length > 0) {
      people = rawNames.map(n => n.charAt(0).toUpperCase() + n.slice(1));
    }
    text = text.replace(splitWithMatch[0], ' ');
  } else if (/\bsplit\b/.test(text)) {
    shared = true;
    text = text.replace(/\bsplit\b/g, ' ');
  }

  // 3. Extract Amount: e.g. "₹140", "140.50", "rs 140", "inr 140", "140rs"
  const amountMatch = text.match(/(?:(?:rs\.?|inr|₹)\s*)?(\d+(?:\.\d{1,2})?)(?:\s*(?:rs|bucks|rupees))?/);
  if (amountMatch) {
    amount = parseFloat(amountMatch[1]);
    text = text.replace(amountMatch[0], ' ');
  }

  // 4. Extract Payment Mode & UPI App
  for (const [app, keywords] of Object.entries(UPI_APP_KEYWORDS)) {
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(text)) {
        upiApp = app as UpiApp;
        paymentMode = 'UPI';
        text = text.replace(regex, ' ');
        break;
      }
    }
    if (upiApp) break;
  }

  if (!upiApp) {
    for (const [mode, keywords] of Object.entries(MODE_KEYWORDS)) {
      for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(text)) {
          paymentMode = mode as PaymentMode;
          text = text.replace(regex, ' ');
          break;
        }
      }
    }
  }

  // 5. Extract Category based on keyword matching
  let matchedCategory: string | null = null;
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(text)) {
        matchedCategory = cat;
        break;
      }
    }
    if (matchedCategory) break;
  }
  if (matchedCategory) {
    category = matchedCategory;
  }

  // 6. Title / Description is the remaining cleaned-up text
  let title = text
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If title was completely consumed by category/keywords, fall back to meaningful label
  if (!title || title.length < 2) {
    title = matchedCategory ? matchedCategory.split(' ')[0] : 'Expense';
  } else {
    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  const valid = Number.isFinite(amount) && amount > 0;
  const confidence = (valid ? 0.5 : 0) + (matchedCategory ? 0.3 : 0) + (paymentMode ? 0.2 : 0);

  return {
    amount: Math.round(amount * 100) / 100,
    title,
    category,
    paymentMode,
    upiApp,
    date,
    shared,
    people,
    raw,
    valid,
    confidence,
    error: valid ? undefined : 'No valid amount found. Try "140 biryani" or "50 chai upi"',
  };
}

