# CashFlow Pro - 13-Month Cash Flow Forecasting

## Overview
A rolling 13-month cash flow forecasting web app that reconciles to actual bank cash position. The app imports actual cash movements, maps them to cash flow lines, generates forecasts, detects variances, and allows users to classify them as timing/permanent/one-off.

## Architecture
- **Frontend**: React with Wouter routing, TanStack Query, Shadcn/UI, Recharts
- **Backend**: Express.js API server
- **Database**: PostgreSQL with Drizzle ORM
- **Schema**: shared/schema.ts (source of truth for all data types)

## Database Tables
- `bank_accounts` - Two bank accounts for cash reconciliation
- `cashflow_lines` - Individual cash flow line items grouped by category
- `actual_transactions` - Recorded bank transactions (manual entry or Xero import)
- `forecast_rules` - Recurrence rules, uplifts, and schedules for each line
- `forecast_months` - Generated monthly forecast values (13-month window)
- `variance_events` - Actual vs forecast comparisons with treatment classifications
- `overrides` - Manual forecast overrides
- `audit_log` - Complete audit trail of all changes

## Key Features
- Rolling 13-month cash flow grid (current month actual + 12 forecast months)
- Dashboard with charts showing cash trend and monthly flows
- Forecast rules engine (monthly, quarterly, annual, one-off recurrence)
- Annual uplift support (percentage or fixed)
- Variance detection and classification (timing, permanent, one-off)
- Permanent variance auto-rebasing through future months
- Bank account reconciliation
- Full audit trail
- Manual transaction entry

## Pages
- `/` - Dashboard (KPIs, charts, bank accounts)
- `/grid` - Cash flow grid (spreadsheet-style 13-month view)
- `/transactions` - Transaction management
- `/variances` - Variance review and treatment
- `/lines` - Cash flow line configuration
- `/rules` - Forecast rules management
- `/accounts` - Bank account management
- `/audit` - Audit log viewer

## Data Flow
1. Transactions are recorded (manual or Xero import)
2. Transactions are mapped to cash flow lines
3. Forecast rules generate monthly forecasts
4. Variance engine compares actuals vs forecasts
5. User classifies variances
6. Permanent changes rebase future forecasts
7. All changes logged to audit trail

## Xero Integration
- OAuth 2.0 flow via `server/xero.ts`
- Token storage in `xero_tokens` table (auto-refresh)
- Bank account import from Xero
- Bank transaction import with auto-mapping to cash flow lines
- Mapping by supplier name (high confidence) and keyword matching (medium confidence)
- UI at `/xero` for connection management and data import

## Pages
- `/xero` - Xero Integration settings and import controls

## Environment
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- XERO_CLIENT_ID - Xero OAuth app client ID
- XERO_CLIENT_SECRET - Xero OAuth app client secret
