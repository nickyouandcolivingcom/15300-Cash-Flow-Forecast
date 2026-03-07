import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { generateForecasts, detectVariances, applyVarianceTreatment, getCurrentMonth, getNext12Months } from "./forecast-engine";
import {
  insertBankAccountSchema,
  insertCashflowLineSchema,
  insertActualTransactionSchema,
  insertForecastRuleSchema,
  insertOverrideSchema,
} from "@shared/schema";
import {
  getAuthUrl,
  exchangeCodeForTokens,
  isXeroConnected,
  importBankAccounts,
  importBankTransactions,
  getRedirectUri,
  validateOAuthState,
  fetchXeroInvoices,
} from "./xero";

async function updateActualsForMonth(month: string): Promise<void> {
  const lines = await storage.getCashflowLines();
  const transactions = await storage.getTransactionsByMonth(month);

  for (const line of lines) {
    if (!line.active || line.isRollup) continue;
    const lineTransactions = transactions.filter(t => t.cashflowLineId === line.id);
    const actualTotal = lineTransactions.reduce((sum, t) => sum + (parseFloat(t.amount as string) || 0), 0);

    if (lineTransactions.length > 0) {
      const existing = await storage.getForecastMonths({ cashflowLineId: line.id, startMonth: month, endMonth: month });
      if (existing.length > 0) {
        await storage.updateForecastMonth(existing[0].id, {
          actualAmount: actualTotal.toFixed(2),
          status: "actual",
        });
      } else {
        await storage.upsertForecastMonth({
          cashflowLineId: line.id,
          forecastMonth: month,
          originalForecastAmount: "0",
          currentForecastAmount: "0",
          actualAmount: actualTotal.toFixed(2),
          sourceRuleId: null,
          status: "actual",
        });
      }
    }
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/xero/status", async (_req, res) => {
    try {
      const status = await isXeroConnected();
      res.json({ ...status, redirectUri: getRedirectUri() });
    } catch (err: any) {
      res.json({ connected: false, error: err.message });
    }
  });

  app.get("/api/xero/auth-url", async (_req, res) => {
    const { url } = getAuthUrl();
    res.json({ url, redirectUri: getRedirectUri() });
  });

  app.get("/api/xero/callback", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;
    console.log("Xero callback received:", { hasCode: !!code, hasState: !!state, error: error || "none" });
    if (error) {
      console.error("Xero returned error:", error);
      return res.redirect(`/xero?xero_error=${encodeURIComponent(error)}`);
    }
    if (!code) {
      return res.redirect("/xero?xero_error=Missing+authorization+code");
    }
    const stateResult = validateOAuthState(state);
    if (!stateResult.valid) {
      return res.redirect("/xero?xero_error=Invalid+OAuth+state");
    }
    try {
      const result = await exchangeCodeForTokens(code, stateResult.codeVerifier);
      console.log("Xero connected successfully:", result.tenantName);
      res.redirect(`/xero?xero_connected=true&tenant=${encodeURIComponent(result.tenantName)}`);
    } catch (err: any) {
      console.error("Xero callback error:", err.message);
      res.redirect(`/xero?xero_error=${encodeURIComponent(err.message)}`);
    }
  });

  app.post("/api/xero/import-accounts", async (_req, res) => {
    try {
      const result = await importBankAccounts();
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/import-transactions", async (req, res) => {
    try {
      const monthsBack = req.body.monthsBack || 3;
      const result = await importBankTransactions(monthsBack);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/xero/invoices", async (req, res) => {
    try {
      const monthsBack = parseInt(req.query.monthsBack as string) || 12;
      const invoices = await fetchXeroInvoices(monthsBack);
      const summary = invoices.map((inv: any) => ({
        invoiceNumber: inv.InvoiceNumber,
        reference: inv.Reference,
        contact: inv.Contact?.Name,
        date: inv.Date,
        dueDate: inv.DueDate,
        total: inv.Total,
        amountPaid: inv.AmountPaid,
        amountDue: inv.AmountDue,
        status: inv.Status,
        lineItems: inv.LineItems?.map((li: any) => ({
          description: li.Description,
          accountCode: li.AccountCode,
          amount: li.LineAmount,
        })),
      }));
      res.json({ count: invoices.length, invoices: summary });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/full-sync", async (req, res) => {
    try {
      const accountsResult = await importBankAccounts();
      const monthsBack = req.body.monthsBack || 3;
      const txResult = await importBankTransactions(monthsBack);
      await generateForecasts();
      res.json({
        success: true,
        accounts: accountsResult,
        transactions: txResult,
        message: "Full sync complete - accounts imported, transactions synced, forecasts regenerated",
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/bank-accounts", async (_req, res) => {
    const accounts = await storage.getBankAccounts();
    res.json(accounts);
  });

  app.post("/api/bank-accounts", async (req, res) => {
    const parsed = insertBankAccountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const account = await storage.createBankAccount(parsed.data);
    await storage.createAuditLog({ entityType: "bank_account", entityId: account.id, action: "create", newValueJson: account });
    res.json(account);
  });

  app.patch("/api/bank-accounts/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const old = await storage.getBankAccount(id);
    const account = await storage.updateBankAccount(id, req.body);
    if (!account) return res.status(404).json({ message: "Not found" });
    await storage.createAuditLog({ entityType: "bank_account", entityId: id, action: "update", oldValueJson: old, newValueJson: account });
    res.json(account);
  });

  app.get("/api/cashflow-lines", async (_req, res) => {
    const lines = await storage.getCashflowLines();
    res.json(lines);
  });

  app.post("/api/cashflow-lines", async (req, res) => {
    const parsed = insertCashflowLineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const line = await storage.createCashflowLine(parsed.data);
    await storage.createAuditLog({ entityType: "cashflow_line", entityId: line.id, action: "create", newValueJson: line });
    res.json(line);
  });

  app.patch("/api/cashflow-lines/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const old = await storage.getCashflowLine(id);
    const line = await storage.updateCashflowLine(id, req.body);
    if (!line) return res.status(404).json({ message: "Not found" });
    await storage.createAuditLog({ entityType: "cashflow_line", entityId: id, action: "update", oldValueJson: old, newValueJson: line });
    res.json(line);
  });

  app.delete("/api/cashflow-lines/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.deleteCashflowLine(id);
    await storage.createAuditLog({ entityType: "cashflow_line", entityId: id, action: "delete" });
    res.json({ success: true });
  });

  app.get("/api/transactions", async (req, res) => {
    const filters: any = {};
    if (req.query.bankAccountId) filters.bankAccountId = parseInt(req.query.bankAccountId as string);
    if (req.query.startDate) filters.startDate = req.query.startDate as string;
    if (req.query.endDate) filters.endDate = req.query.endDate as string;
    const transactions = await storage.getActualTransactions(filters);
    res.json(transactions);
  });

  app.post("/api/transactions", async (req, res) => {
    const parsed = insertActualTransactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const transaction = await storage.createActualTransaction(parsed.data);
    await storage.createAuditLog({ entityType: "transaction", entityId: transaction.id, action: "create", newValueJson: transaction });
    const txMonth = (transaction.transactionDate as string).substring(0, 7);
    await updateActualsForMonth(txMonth);
    res.json(transaction);
  });

  app.patch("/api/transactions/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const old = await storage.getActualTransaction(id);
    const transaction = await storage.updateActualTransaction(id, req.body);
    if (!transaction) return res.status(404).json({ message: "Not found" });
    await storage.createAuditLog({ entityType: "transaction", entityId: id, action: "update", oldValueJson: old, newValueJson: transaction });
    const txMonth = (transaction.transactionDate as string).substring(0, 7);
    await updateActualsForMonth(txMonth);
    res.json(transaction);
  });

  app.get("/api/forecast-rules", async (req, res) => {
    const lineId = req.query.cashflowLineId ? parseInt(req.query.cashflowLineId as string) : undefined;
    const rules = await storage.getForecastRules(lineId);
    res.json(rules);
  });

  app.post("/api/forecast-rules", async (req, res) => {
    const parsed = insertForecastRuleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const rule = await storage.createForecastRule(parsed.data);
    await storage.createAuditLog({ entityType: "forecast_rule", entityId: rule.id, action: "create", newValueJson: rule });
    res.json(rule);
  });

  app.patch("/api/forecast-rules/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const old = await storage.getForecastRule(id);
    const rule = await storage.updateForecastRule(id, req.body);
    if (!rule) return res.status(404).json({ message: "Not found" });
    await storage.createAuditLog({ entityType: "forecast_rule", entityId: id, action: "update", oldValueJson: old, newValueJson: rule });
    res.json(rule);
  });

  app.delete("/api/forecast-rules/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.deleteForecastRule(id);
    await storage.createAuditLog({ entityType: "forecast_rule", entityId: id, action: "delete" });
    res.json({ success: true });
  });

  app.get("/api/forecast-months", async (req, res) => {
    const filters: any = {};
    if (req.query.cashflowLineId) filters.cashflowLineId = parseInt(req.query.cashflowLineId as string);
    if (req.query.startMonth) filters.startMonth = req.query.startMonth as string;
    if (req.query.endMonth) filters.endMonth = req.query.endMonth as string;
    const months = await storage.getForecastMonths(filters);
    res.json(months);
  });

  app.post("/api/forecast/generate", async (_req, res) => {
    await generateForecasts();
    res.json({ success: true, message: "Forecasts generated" });
  });

  app.post("/api/forecast/detect-variances", async (req, res) => {
    const month = (req.body.month as string) || getCurrentMonth();
    await detectVariances(month);
    res.json({ success: true, message: `Variances detected for ${month}` });
  });

  app.get("/api/variances", async (req, res) => {
    const filters: any = {};
    if (req.query.cashflowLineId) filters.cashflowLineId = parseInt(req.query.cashflowLineId as string);
    if (req.query.forecastMonth) filters.forecastMonth = req.query.forecastMonth as string;
    const variances = await storage.getVarianceEvents(filters);
    res.json(variances);
  });

  app.post("/api/variances/:id/treat", async (req, res) => {
    const id = parseInt(req.params.id);
    const { treatment, approvedBy } = req.body;
    if (!["timing", "permanent", "one_off"].includes(treatment)) {
      return res.status(400).json({ message: "Invalid treatment type" });
    }
    await applyVarianceTreatment(id, treatment, approvedBy || "user");
    res.json({ success: true });
  });

  app.get("/api/overrides", async (req, res) => {
    const filters: any = {};
    if (req.query.cashflowLineId) filters.cashflowLineId = parseInt(req.query.cashflowLineId as string);
    if (req.query.forecastMonth) filters.forecastMonth = req.query.forecastMonth as string;
    const result = await storage.getOverrides(filters);
    res.json(result);
  });

  app.post("/api/overrides", async (req, res) => {
    const parsed = insertOverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const override = await storage.createOverride(parsed.data);
    await storage.createAuditLog({ entityType: "override", entityId: override.id, action: "create", newValueJson: override });
    await generateForecasts();
    res.json(override);
  });

  app.get("/api/audit-log", async (req, res) => {
    const filters: any = {};
    if (req.query.entityType) filters.entityType = req.query.entityType as string;
    if (req.query.entityId) filters.entityId = parseInt(req.query.entityId as string);
    if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
    const logs = await storage.getAuditLogs(filters);
    res.json(logs);
  });

  app.get("/api/cashflow-grid", async (_req, res) => {
    const currentMonth = getCurrentMonth();
    const months = getNext12Months(currentMonth);
    const lines = await storage.getCashflowLines();
    const forecasts = await storage.getForecastMonths({ startMonth: months[0], endMonth: months[months.length - 1] });
    const allOverrides = await storage.getOverrides();
    const allVariances = await storage.getVarianceEvents();
    const bankAccountsList = await storage.getBankAccounts();
    const currentMonthTransactions = await storage.getTransactionsByMonth(currentMonth);

    const totalBalance = bankAccountsList.reduce((sum, a) => sum + (parseFloat(a.currentBalance as string) || 0), 0);

    const grid = lines.filter(l => l.active).map(line => {
      const lineForecasts = forecasts.filter(f => f.cashflowLineId === line.id);
      const lineOverrides = allOverrides.filter(o => o.cashflowLineId === line.id);
      const lineVariances = allVariances.filter(v => v.cashflowLineId === line.id);
      const lineCurrentTx = currentMonthTransactions.filter(t => t.cashflowLineId === line.id);
      const currentMonthActual = lineCurrentTx.reduce((sum, t) => sum + (parseFloat(t.amount as string) || 0), 0);

      const monthData: Record<string, {
        amount: number;
        status: string;
        hasOverride: boolean;
        hasVariance: boolean;
        originalForecast: number;
        actualAmount: number | null;
        varianceAmount: number | null;
        varianceTreatment: string | null;
      }> = {};

      for (const month of months) {
        const fc = lineForecasts.find(f => f.forecastMonth === month);
        const ov = lineOverrides.find(o => o.forecastMonth === month);
        const va = lineVariances.find(v => v.forecastMonth === month);

        const isCurrentMonth = month === currentMonth;
        const actualAmt = isCurrentMonth && lineCurrentTx.length > 0
          ? currentMonthActual
          : (fc?.actualAmount ? parseFloat(fc.actualAmount as string) : null);

        monthData[month] = {
          amount: isCurrentMonth && lineCurrentTx.length > 0
            ? currentMonthActual
            : (fc ? parseFloat(fc.currentForecastAmount as string) || 0 : 0),
          status: isCurrentMonth ? "actual" : (fc?.status || "forecast"),
          hasOverride: !!ov,
          hasVariance: !!va,
          originalForecast: fc ? parseFloat(fc.originalForecastAmount as string) || 0 : 0,
          actualAmount: actualAmt,
          varianceAmount: va ? parseFloat(va.varianceAmount as string) : null,
          varianceTreatment: va?.approvedTreatment || va?.suggestedTreatment || null,
        };
      }

      return {
        line,
        monthData,
      };
    });

    const categories = [...new Set(lines.filter(l => l.active).map(l => l.category))];
    const categoryTotals: Record<string, Record<string, number>> = {};
    const inflowTotals: Record<string, number> = {};
    const outflowTotals: Record<string, number> = {};
    const netTotals: Record<string, number> = {};

    for (const month of months) {
      inflowTotals[month] = 0;
      outflowTotals[month] = 0;
      netTotals[month] = 0;
    }

    for (const cat of categories) {
      categoryTotals[cat] = {};
      for (const month of months) {
        const catLines = grid.filter(g => g.line.category === cat);
        const total = catLines.reduce((sum, g) => sum + (g.monthData[month]?.amount || 0), 0);
        categoryTotals[cat][month] = total;
      }
    }

    for (const row of grid) {
      for (const month of months) {
        const amount = row.monthData[month]?.amount || 0;
        if (row.line.direction === "inflow") {
          inflowTotals[month] += amount;
        } else {
          outflowTotals[month] += amount;
        }
        netTotals[month] += row.line.direction === "inflow" ? amount : -amount;
      }
    }

    let runningCash = totalBalance;
    const closingCash: Record<string, number> = {};
    const openingCash: Record<string, number> = {};
    for (const month of months) {
      openingCash[month] = runningCash;
      runningCash += netTotals[month];
      closingCash[month] = runningCash;
    }

    res.json({
      months,
      currentMonth,
      grid,
      categories,
      categoryTotals,
      inflowTotals,
      outflowTotals,
      netTotals,
      openingCash,
      closingCash,
      totalBalance,
      bankAccounts: bankAccountsList,
    });
  });

  app.get("/api/dashboard", async (_req, res) => {
    const currentMonth = getCurrentMonth();
    const months = getNext12Months(currentMonth);
    const lines = await storage.getCashflowLines();
    const forecasts = await storage.getForecastMonths({ startMonth: months[0], endMonth: months[months.length - 1] });
    const bankAccountsList = await storage.getBankAccounts();
    const variances = await storage.getVarianceEvents();

    const totalBalance = bankAccountsList.reduce((sum, a) => sum + (parseFloat(a.currentBalance as string) || 0), 0);

    let runningCash = totalBalance;
    const cashTrend: { month: string; closing: number; inflow: number; outflow: number }[] = [];

    for (const month of months) {
      let monthInflow = 0;
      let monthOutflow = 0;
      for (const line of lines.filter(l => l.active && !l.isRollup)) {
        const fc = forecasts.find(f => f.cashflowLineId === line.id && f.forecastMonth === month);
        const amount = fc ? parseFloat(fc.currentForecastAmount as string) || 0 : 0;
        if (line.direction === "inflow") monthInflow += amount;
        else monthOutflow += amount;
      }
      const net = monthInflow - monthOutflow;
      runningCash += net;
      cashTrend.push({ month, closing: runningCash, inflow: monthInflow, outflow: monthOutflow });
    }

    const pendingVariances = variances.filter(v => !v.approvedTreatment).length;
    const totalInflow = cashTrend.reduce((sum, t) => sum + t.inflow, 0);
    const totalOutflow = cashTrend.reduce((sum, t) => sum + t.outflow, 0);
    const freeCashFlow = totalInflow - totalOutflow;

    res.json({
      currentCashPosition: totalBalance,
      freeCashFlow,
      totalInflow,
      totalOutflow,
      pendingVariances,
      cashTrend,
      bankAccounts: bankAccountsList,
      months,
    });
  });

  return httpServer;
}
