# CashFlow Pro - 13-Month Cash Flow Forecasting

## Overview
A rolling 13-month cash flow forecasting web app for YOU & CO. LIVING LIMITED, a UK property lettings business. Syncs actual cash movements from Xero (Santander Business + Starling Business bank accounts), produces a rolling 13-month forecast with 41 individual tenancy revenue lines and supplier-level outflow lines, variance classification, and full audit trail.

## Architecture
- **Frontend**: React with Wouter routing, TanStack Query, Shadcn/UI, Recharts
- **Backend**: Express.js API server
- **Database**: PostgreSQL with Drizzle ORM
- **Schema**: shared/schema.ts (source of truth for all data types)

## Database Tables
- `bank_accounts` - Santander Business (£5,011.62) and Starling Business (£23.48)
- `cashflow_lines` - Individual cash flow line items: 41 tenancy inflow lines + 75 supplier outflow lines
- `actual_transactions` - Bank transactions from Xero + invoice-derived rent actuals
- `forecast_rules` - Recurrence rules per line (monthly rent amounts, supplier payment patterns)
- `forecast_months` - Generated monthly forecast values (13-month window)
- `variance_events` - Actual vs forecast comparisons with treatment classifications
- `overrides` - Manual forecast overrides
- `cash_balance_snapshots` - Opening balance snapshots (anchor for cash position calculations)
- `audit_log` - Complete audit trail of all changes
- `xero_tokens` - OAuth 2.0 token storage for Xero API

## Key Features
- Rolling 13-month cash flow grid (current month actual + 12 forecast months)
- Dynamic current cash position = opening balance + actuals through last completed day
- 41 individual tenancy revenue lines from Xero invoices (account 200)
- 75 supplier outflow lines from bank transaction data (one line per supplier)
- Dashboard with charts showing cash trend and monthly flows
- Forecast rules engine (monthly, quarterly, quadrimestral, annual, one-off recurrence)
- Monthly volume profiles for variable-volume lines (e.g. TDS deposits: 1/month, 2 in Jul-Sep)
- Variance detection and classification (timing, permanent, one-off)
- Xero OAuth 2.0 integration with PKCE flow
- Full audit trail

## Xero Integration
- OAuth 2.0 Web App with PKCE flow via `server/xero.ts`
- Granular scopes: accounting.banktransactions.read, accounting.invoices.read, accounting.settings.read, accounting.contacts.read
- Tenant: YOU & CO. LIVING LIMITED
- Token auto-refresh, stored in `xero_tokens` table
- Bank transaction import with auto-mapping to supplier lines
- Invoice import (account 200) for rent revenue - creates tenancy lines
- Xero date format: /Date(timestamp+0000)/ parsed with regex
- Redirect URI configured for Replit dev environment

## Data Model
### Revenue (Inflows)
- RENT-000: Rollup parent line
- RENT-001 to RENT-041: Individual tenant lines (e.g., ALEXANDER MEE, CHARLES BRIAN ROPER)
- Each tenant has: TE reference, current rent amount, forecast rule, historical actuals

### Outflows
- OUT-001 to OUT-075: One line per supplier (e.g., KENT RELIANCE, OCTOPUS ENERGY, LANDBAY)
- Each supplier has: forecast rule based on recent payment pattern, historical actuals
- No category grouping - each supplier is independent with its own payment timing

## Pages
- `/` - Dashboard (KPIs, charts, bank accounts)
- `/grid` - Cash flow grid (spreadsheet-style 13-month view)
- `/transactions` - Transaction management
- `/variances` - Variance review and treatment
- `/lines` - Cash flow line configuration
- `/rules` - Forecast rules management (edit unit costs, volume profiles, recurrence)
- `/accounts` - Bank account management
- `/audit` - Audit log viewer
- `/xero` - Xero Integration settings and import controls

## Environment
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- XERO_CLIENT_ID - Xero OAuth app client ID
- XERO_CLIENT_SECRET - Xero OAuth app client secret
