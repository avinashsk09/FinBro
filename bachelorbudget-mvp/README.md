# BachelorBudget

BachelorBudget is a responsive local-development personal-finance app for students, people living in PGs/hostels, and roommates. The codebase uses React, Vite, TypeScript, Express, Zod, and SQLite.

## Local setup

Requirements: Node.js 20+ and npm 10+.

Run these commands from the `bachelorbudget-mvp` folder (the directory containing this README and the root `package.json`), not its parent folder:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/api/health`. `npm run dev` starts the Vite client and Express server. The server creates `server/data/bachelorbudget.sqlite` when run from the workspace scripts.

Copy the root [`.env.example`](./.env.example) to `.env` if you do not already have a local environment file. The backend loads this root `.env` automatically, and Vite reads the same file while exposing only `VITE_`-prefixed values to browser code. Values already set in the shell take precedence. Keep real credentials out of `.env.example` and do not commit `.env`.

If you prefer setting environment variables in PowerShell instead, do so before starting:

```powershell
$env:PORT = "4000"
$env:CLIENT_ORIGIN = "http://localhost:5173"
$env:DB_PATH = "data/bachelorbudget.sqlite"
$env:VITE_API_URL = "http://localhost:4000/api"
$env:FX_API_URL = "https://api.frankfurter.dev/v1"
npm run dev
```

`FX_API_URL` is optional. Leave it blank to disable FX requests; cross-currency totals that require conversion will fail explicitly rather than use guessed rates. Frankfurter-compatible dated INR-base rates are cached in SQLite for 24 hours. Check the provider's current terms and suitability before using it; rates are for informational reporting, not settlement or trading. Vite uses port 5173 with strict-port behavior so its origin stays aligned with the default CORS configuration; free that port or update `CLIENT_ORIGIN` if it is already in use.

Build/type-check and test:

```powershell
npm run build
npm test
```

## Features & What's New

### Part A: Foundation & Visual Redesign
- **Full Dark Mode**: Vibrant mint/lime on deep slate dark theme (default look) alongside a crisp light mode. Toggles in top bar and sidebar, automatically respects system `prefers-color-scheme`, and remembers preference in `localStorage`.
- **Extended Student Categories**: Retains all original categories plus student essentials: Mobile recharge, Laundry, Gym/Sports, Trips & outings, Gifts, Stationery & Books, Gaming, Fuel, and Party. Each has custom emoji icons and distinct badge colors across client and server validation.
- **UPI & Payment Tracking**: Tag transactions with payment modes (`UPI`, `Cash`, `Credit Card`, `Debit Card`, `Net Banking`, `Wallet`), optional UPI app labels (`GPay`, `PhonePe`, `Paytm`, `BHIM`, `Cred`, `Other`), and UTR/reference notes. Dynamic UPI QR codes and "Settle up via UPI" modal in Roommates.
- **Insights & Visual Charts**: Dedicated Insights tab featuring Recharts visualizations:
  - Category spending donut chart
  - Monthly income vs expense trend comparison
  - Daily spending area / frequency chart
  - Budget vs actual per category comparison
  - Payment mode breakdown
- **Printable Monthly Statement**: Modal with `@media print` layout generating formatted paper/PDF statements including totals, payment breakdown, top spends, and settlements.
- **Percentage Splits**: Roommate bills support equal, exact-cent custom, and percentage-based shares with penny rounding guards.

### Part B: Month-End Analysis & Limits
- **Month-End Spending Digest**: Summary cards calculate transaction count, average spend per day, biggest single spends, and percentage change compared to the previous month.
- **Category Threshold & Frequency Limits**: Users can set monthly spending limits or maximum transaction frequencies per category (`/api/limits`). Dynamic status bars transition green (<80%), yellow (80-99%), and red (100%+).
- **Proactive Nudge Alerts**: Adding or editing a transaction triggers automatic limit evaluation, warning users when they reach 80% or exceed their target cap.

### Part C: Fast Entry & Bachelor Workflow
- **Vibe Onboarding**: Pre-login "What's your vibe?" screen (College Student / PG & Hostel Resident / Working Bachelor) pre-populating tailored quick presets and spending limits.
- **Quick-Tap Presets**: Instant one-tap expense chips with a 5-second floating Undo toast and draining progress bar. Custom presets can be added or deleted dynamically (`/api/presets`).
- **Smart Natural Language Input**: Live parser extracting amounts, notes, categories, payment modes, dates (`today`, `yesterday`), and roommate splits in real time (e.g. `Biryani 340 via UPI`, `Split 800 dinner rahul, priya`).
- **Table Power Actions**:
  - Double-click inline editing on amount and category
  - One-click split toggle popover on transaction rows
  - Multi-row selection with floating batch action bar (change category, change payment mode, bulk delete)
- **Nightly Reconciliation Banner**: Appears after 8 PM summarizing daily logs ("You logged ₹X today across N transactions. Did you spend anything else?") with dismiss state.
- **Notification Reminders**: Bell icon popover for configuring daily reminder times.
- **Telegram Bot Integration**: Single-use 6-digit sync code with 10-minute countdown linking Telegram chats to the SQLite database. Incoming webhook (`/api/telegram-webhook`) logs expenses automatically and broadcasts live updates via Server-Sent Events (`/api/events`).

## Core Architecture

- Email/password registration and login with a minimum 8-character password, `scrypt` password hashes, opaque random session tokens stored as hashes, HttpOnly SameSite cookies, seven-day expiration, logout revocation, and a database-backed authentication attempt limit.
- A streamlined interface with Dashboard, Transactions, Budget, Roommates, and Settings sections, plus a short dismissible welcome tour.
- Owner-scoped transactions, monthly budgets, profile settings, accounts, and roommate bills. Protected API routes require a valid session. Household transactions are readable by joined members; private transactions remain owner-only.
- Manually created accounts with opening amount/date and currency. Balances are computed from opening amounts, assigned income/expense transactions, and same-currency transfers. Transfers are separate from monthly income and expense totals. These are user-entered balances, not verified bank balances.
- Roommate bill equal/custom split calculations and persisted membership. Invitations are email-matched, expire after seven days, and can be used once. The inviter must share the returned token manually; there is no email delivery.
- Statement CSV preview and confirmation: validates required columns and transaction data, skips invalid rows with line-specific errors, uses a short-lived one-use preview token, and avoids re-importing the exact same file. CSV import identity is based on file content and row position; it is not a bank-provider transaction ID.
- Original transaction amounts/currencies are retained. With `FX_API_URL`, dated rates are cached with source and fetch timestamp. If a provider fails and a complete cache exists, totals use the clearly labeled stale cache; without required rates, the summary returns an error rather than inventing a conversion. Without FX configured, same-currency reports are available but INR budget comparisons cannot be converted into a different currency.
- CSV import/export remains available from Transactions. The UI focuses on the dashboard, transactions, one monthly budget, roommate bills, and settings; legacy goals and category-budget API routes remain for compatibility and are not exposed as primary screens.

## API routes

All routes are under `/api`. Except `/health` and `/auth/register`, `/auth/login`, `/auth/me`, and `/auth/logout`, routes require the session cookie.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | API health check |
| `POST` | `/auth/register` | Register (valid email and password of at least 8 characters) |
| `POST` | `/auth/login` | Sign in |
| `GET` | `/auth/me` | Read the current session |
| `POST` | `/auth/logout` | Revoke the current session |
| `GET/POST/PUT/DELETE` | `/transactions[/:id]` | List/create/edit/delete income and expense records |
| `GET/POST/PUT/DELETE` | `/expenses[/:id]` | Legacy expense-only route aliases |
| `GET` | `/summary?month=YYYY-MM&currency=INR` | Monthly spending, income, budget and rate metadata |
| `GET/PUT` | `/settings` | Per-user monthly budget, warning threshold, username, and preferred currency |
| `GET/POST/DELETE` | `/accounts[/:id]` | List, create, or remove an unused account |
| `GET/POST/DELETE` | `/transfers[/:id]` | List, create, or delete same-currency account transfers |
| `GET/POST/PUT/DELETE` | `/goals[/:id]` | Savings goal operations |
| `GET/POST` | `/households` | List memberships and create a household |
| `POST` | `/households/:id/invitations` | Create an email-bound, seven-day invitation token |
| `POST` | `/households/invitations/accept` | Accept a matching account's unused invitation |
| `GET` | `/settlements?month=YYYY-MM` | Calculate balances for visible shared bills |
| `GET/PUT/DELETE` | `/budgets[/:id]` | List, set, or delete category limits |
| `POST` | `/imports/csv/preview` | Validate and preview CSV statement rows |
| `POST` | `/imports/csv/confirm` | Confirm a preview and import its valid rows |
| `GET` | `/months` | Recorded transaction months plus the current month |
| `GET` | `/export.csv` | Export visible transactions using report filters |

The expense schema has been incrementally migrated using `PRAGMA user_version` (current version 8). Migrations preserve existing rows. If a pre-authentication database contains records without an owner, the first newly registered account claims those legacy records so they are not discarded. The integration changes did not reset or destructively migrate the existing database.

## Market and provider status

The app's existing INR budget base, PG/hostel audience, and Indian currency conventions indicate India as its initial target market. A consent-based Account Aggregator integration may be evaluated with providers such as Setu, Finvu, or CAMSfinserv, subject to current eligibility, provider documentation, commercial terms, credentials, and required regulatory approvals. No live bank provider is integrated or tested. The app never asks users for bank passwords, card PINs, UPI PINs, or OTPs.

## Security and release limitations

This remains a local-development MVP, not production-ready financial software. Authentication and per-user ownership isolation are implemented, but there is no password reset, email verification, MFA, account recovery, external security audit, or configured email delivery. Registration is open. The first registered user claims unowned legacy rows in a migrated database; do not expose a database with unclaimed legacy records to an untrusted network.

The session cookie is HttpOnly and SameSite=Lax; `Secure` is enabled when `NODE_ENV=production` or `SECURE_COOKIES=true`. Use HTTPS before enabling Secure cookies. CORS is restricted to `CLIENT_ORIGIN`. Authentication limits are local database-backed and are not a substitute for a production edge/WAF rate limiter. SQLite and local backups are not configured for multi-instance hosting. No production deployment, monitoring, automated backup/recovery, or privacy/legal review is included.

Household invitations are manually shared tokens, not email invitations. Members share bills on this one server/database; this is not bank synchronization. CSV imports have no provider-issued transaction IDs, and exact-file matching cannot eliminate every real-world bank export duplicate. Transfers currently require the same currency. Opening/current account balances are manually entered and must not be represented as verified financial institution balances.

Before public release, perform a threat model and security review; add email verification/recovery, MFA as appropriate, robust CSRF protection, production-grade rate limiting, account lifecycle controls, audit logging, monitored backups/recovery, database and secret management, privacy disclosures, data retention/deletion policy, legal review, and appropriate security testing. A live bank integration requires a vetted provider's official consent/authorization flow and required approvals. Do not collect bank credentials or describe this local MVP as a secure banking service.

## Deployment

There is no production deployment configuration. `npm run build` builds the frontend and type-checks the backend; `npm start` starts the API after setting `PORT`, `CLIENT_ORIGIN`, and `DB_PATH`. Do not expose the development server or SQLite file as a public multi-user service.
