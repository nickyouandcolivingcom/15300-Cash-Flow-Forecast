import type { Express } from "express";
import { createServer, type Server } from "http";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { generateForecasts, detectVariances, applyVarianceTreatment, reconcileCurrentMonth, getCurrentMonth, getNext12Months } from "./forecast-engine";
import {
  insertBankAccountSchema,
  insertCashflowLineSchema,
  insertActualTransactionSchema,
  insertForecastRuleSchema,
  insertOverrideSchema,
  insertCashBalanceSnapshotSchema,
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
  fetchXeroInvoicesWithPayments,
  fetchXeroBankTransactionsForContact,
  fetchBankBalances,
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
      const reconciliation = await reconcileCurrentMonth();
      let bankBalances;
      try {
        bankBalances = await fetchBankBalances();
      } catch (e: any) {
        console.error("Failed to fetch bank balances:", e.message);
      }
      res.json({ success: true, ...result, reconciliation, bankBalances });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/fetch-balances", async (_req, res) => {
    try {
      const balances = await fetchBankBalances();
      res.json({ success: true, ...balances });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/disconnect", async (_req, res) => {
    try {
      const { db } = await import("./db");
      const { xeroTokens } = await import("@shared/schema");
      await db.delete(xeroTokens);
      await storage.createAuditLog({
        entityType: "xero_connection",
        entityId: null,
        action: "disconnected",
        newValueJson: {},
        userName: "system",
      });
      res.json({ success: true, message: "Disconnected from Xero" });
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

  app.post("/api/xero/import-invoices", async (req, res) => {
    try {
      const monthsBack = req.body.monthsBack || 12;
      const rawInvoices = await fetchXeroInvoicesWithPayments(monthsBack);

      const rentInvoices = rawInvoices.filter((inv: any) =>
        inv.LineItems && inv.LineItems.some((li: any) => li.AccountCode === "200")
      );

      function parseXeroDate(d: string): Date | null {
        const m = d.match(/Date\((\d+)/);
        return m ? new Date(parseInt(m[1])) : null;
      }

      const tenantMap: Record<string, {
        contact: string;
        teRef: string;
        propertyCode: string;
        months: Record<string, number>;
        latestRent: number;
        latestMonth: string;
        invoiceIds: string[];
      }> = {};

      for (const inv of rentInvoices) {
        const contact = inv.Contact?.Name || "Unknown";
        const dt = parseXeroDate(inv.Date);
        if (!dt) continue;
        const month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;

        for (const li of (inv.LineItems || [])) {
          if (li.AccountCode !== "200") continue;

          const teMatch = (li.Description || "").match(/TE\d+/);
          const teRef = teMatch ? teMatch[0] : "";
          const key = contact;

          const tracking = (li.Tracking || []).find((t: any) => t.Name === "PROPERTY");
          let propertyCode = "";
          if (tracking) {
            const propMatch = tracking.Option.match(/#\d+[.:]\s*(.+)/);
            propertyCode = propMatch ? propMatch[1].trim() : tracking.Option;
          }

          if (!tenantMap[key]) {
            tenantMap[key] = { contact, teRef, propertyCode, months: {}, latestRent: 0, latestMonth: "", invoiceIds: [] };
          }

          if (!tenantMap[key].months[month]) tenantMap[key].months[month] = 0;
          tenantMap[key].months[month] += li.LineAmount;
          tenantMap[key].invoiceIds.push(inv.InvoiceNumber);
          if (teRef) tenantMap[key].teRef = teRef;
          if (propertyCode) tenantMap[key].propertyCode = propertyCode;

          if (month >= tenantMap[key].latestMonth) {
            tenantMap[key].latestMonth = month;
            tenantMap[key].latestRent = li.LineAmount;
          }
        }
      }

      const currentMonth = getCurrentMonth();
      const activeTenants = Object.entries(tenantMap)
        .filter(([_, t]) => t.latestMonth >= currentMonth || t.latestMonth >= "2026-02")
        .sort((a, b) => a[0].localeCompare(b[0]));

      const propOrder = ["16RC", "10KG", "32LFR", "84DD", "4WS", "26BLA", "26BLB", "26BLC", "27BLA", "27BLB", "27BLC", "27BLD"];
      const byProp: Record<string, { contact: string; tenant: typeof tenantMap[string]; cleanName: string; surname: string; firstInitial: string }[]> = {};
      for (const [contactName, tenant] of activeTenants) {
        const prop = tenant.propertyCode || "UNKNOWN";
        if (!byProp[prop]) byProp[prop] = [];
        const cleanName = contactName.replace(/\s*\(\d+\)\s*$/, "").trim();
        const parts = cleanName.split(" ");
        const surname = parts[parts.length - 1];
        const firstInitial = parts[0][0];
        byProp[prop].push({ contact: contactName, tenant, cleanName, surname, firstInitial });
      }

      const sortedTenants: { contact: string; tenant: typeof tenantMap[string]; displayName: string; code: string; prop: string; sortOrder: number }[] = [];
      let sortIdx = 0;
      for (const prop of propOrder) {
        const tenants = byProp[prop] || [];
        tenants.sort((a, b) => a.surname.localeCompare(b.surname));
        for (let i = 0; i < tenants.length; i++) {
          sortIdx++;
          const t = tenants[i];
          const unitNum = i + 1;
          const code = `${prop}#${unitNum}`;
          const displayName = `${code} ${t.firstInitial} ${t.surname}`;
          sortedTenants.push({ contact: t.contact, tenant: t.tenant, displayName, code, prop, sortOrder: sortIdx });
        }
      }
      if (byProp["UNKNOWN"]) {
        for (const t of byProp["UNKNOWN"]) {
          sortIdx++;
          const cleanName = t.cleanName;
          sortedTenants.push({ contact: t.contact, tenant: t.tenant, displayName: cleanName, code: `UNK-${sortIdx}`, prop: "UNKNOWN", sortOrder: sortIdx });
        }
      }

      const { db: dbInstance } = await import("./db");
      const {
        cashflowLines: clTable,
        forecastRules: frTable,
        forecastMonths: fmTable,
        actualTransactions: atTable,
        varianceEvents: veTable,
        overrides: orTable,
      } = await import("@shared/schema");

      const existingLines = await storage.getCashflowLines();
      const revenueLines = existingLines.filter(l => l.category === "Rent Revenue" || l.category === "Revenue");
      for (const line of revenueLines) {
        await dbInstance.delete(fmTable).where(eq(fmTable.cashflowLineId, line.id));
        await dbInstance.delete(frTable).where(eq(frTable.cashflowLineId, line.id));
        await dbInstance.delete(veTable).where(eq(veTable.cashflowLineId, line.id));
        await dbInstance.delete(orTable).where(eq(orTable.cashflowLineId, line.id));
        await dbInstance.delete(atTable).where(eq(atTable.cashflowLineId, line.id));
        await dbInstance.delete(clTable).where(eq(clTable.id, line.id));
      }

      const prepaidLine = await storage.createCashflowLine({
        code: "RENT-PRE",
        name: "Prepaid Topline",
        category: "Rent Revenue",
        subcategory: "Timing Adjustment",
        direction: "inflow",
        lineType: "recurring_fixed",
        isRollup: false,
        sortOrder: 0,
        active: true,
      });

      await storage.createForecastRule({
        cashflowLineId: prepaidLine.id,
        recurrenceType: "monthly",
        frequency: 1,
        baseAmount: "0.00",
        startDate: "2026-03-01",
        endDate: null,
        upliftType: "none",
        upliftValue: "0",
        upliftFrequency: "annual",
        paymentTimingRule: null,
        timingFlexibility: "fixed",
        forecastConfidence: "high",
        active: true,
      });

      let created = 0;
      let actualsImported = 0;
      const bankAccounts = await storage.getBankAccounts();
      const santander = bankAccounts.find(a => a.name.toLowerCase().includes("santander"));
      const defaultBankId = santander?.id || bankAccounts[0]?.id || 1;

      for (const st of sortedTenants) {
        const { contact: contactName, tenant, displayName, code, prop, sortOrder } = st;

        const line = await storage.createCashflowLine({
          code,
          name: displayName,
          category: "Rent Revenue",
          subcategory: prop,
          supplierName: contactName,
          bankAccountId: defaultBankId,
          direction: "inflow",
          lineType: "recurring_fixed",
          isRollup: false,
          parentLineId: prepaidLine.id,
          sortOrder,
          active: true,
        });

        await storage.createForecastRule({
          cashflowLineId: line.id,
          recurrenceType: "monthly",
          frequency: 1,
          baseAmount: tenant.latestRent.toFixed(2),
          startDate: "2026-03-01",
          endDate: null,
          upliftType: "none",
          upliftValue: "0",
          upliftFrequency: "annual",
          paymentTimingRule: null,
          timingFlexibility: "fixed",
          forecastConfidence: "high",
          active: true,
        });

        for (const [month, amount] of Object.entries(tenant.months)) {
          const firstOfMonth = `${month}-01`;

          await storage.createActualTransaction({
            xeroTransactionId: `inv-rent-${tenant.teRef || shortName}-${month}`,
            xeroSourceType: "invoice",
            transactionDate: firstOfMonth,
            amount: amount.toFixed(2),
            description: `Rent - ${shortName} (${month})`,
            supplierOrCounterparty: contactName,
            bankAccountId: defaultBankId,
            cashflowLineId: line.id,
            mappedConfidence: "auto_xero",
            mappingMethod: "xero_invoice",
            reconciledFlag: true,
          });
          actualsImported++;

          await storage.upsertForecastMonth({
            cashflowLineId: line.id,
            forecastMonth: month,
            originalForecastAmount: tenant.latestRent.toFixed(2),
            currentForecastAmount: tenant.latestRent.toFixed(2),
            actualAmount: amount.toFixed(2),
            sourceRuleId: null,
            status: "actual",
          });
        }

        created++;
      }

      await generateForecasts();

      await storage.createAuditLog({
        entityType: "invoice_import",
        entityId: null,
        action: "import_rent_invoices",
        newValueJson: {
          tenantsCreated: created,
          actualsImported,
          invoicesProcessed: rentInvoices.length,
          monthsBack,
        },
        userName: "system",
      });

      res.json({
        success: true,
        tenantsCreated: created,
        actualsImported,
        totalMonthlyRent: sortedTenants.reduce((sum, st) => sum + st.tenant.latestRent, 0),
        tenants: sortedTenants.map(st => ({
          name: st.displayName,
          code: st.code,
          property: st.prop,
          teRef: st.tenant.teRef,
          currentRent: st.tenant.latestRent,
          historicalMonths: Object.keys(st.tenant.months).length,
        })),
      });
    } catch (err: any) {
      console.error("Invoice import error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/xero/invoices-raw", async (req, res) => {
    try {
      const monthsBack = parseInt(req.query.monthsBack as string) || 1;
      const invoices = await fetchXeroInvoicesWithPayments(monthsBack);
      const rentInvoices = invoices.filter((inv: any) =>
        inv.LineItems && inv.LineItems.some((li: any) => li.AccountCode === "200")
      );
      const mapped = rentInvoices.map((inv: any) => ({
        InvoiceNumber: inv.InvoiceNumber,
        Contact: inv.Contact?.Name,
        ContactID: inv.Contact?.ContactID,
        Date: inv.Date,
        LineItems: inv.LineItems?.map((li: any) => ({
          Description: li.Description,
          AccountCode: li.AccountCode,
          LineAmount: li.LineAmount,
          Tracking: li.Tracking,
        })),
        Payments: inv.Payments,
      }));
      res.json({ count: rentInvoices.length, invoices: mapped });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/xero/bank-transactions-contact", async (req, res) => {
    try {
      const contact = req.query.contact as string || "EON";
      const data = await fetchXeroBankTransactionsForContact(contact);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/calculate-prepaid", async (req, res) => {
    try {
      const monthsBack = req.body.monthsBack || 3;
      const invoices = await fetchXeroInvoicesWithPayments(monthsBack);

      function parseXeroDate(d: string): Date | null {
        const m = d.match(/Date\((\d+)/);
        return m ? new Date(parseInt(m[1])) : null;
      }
      function toMonth(d: Date): string {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }

      const rentInvoices = invoices.filter((inv: any) =>
        inv.LineItems && inv.LineItems.some((li: any) => li.AccountCode === "200")
      );

      const prepaidByMonth: Record<string, number> = {};

      for (const inv of rentInvoices) {
        if (inv.Status !== "PAID") continue;

        const invoiceDate = parseXeroDate(inv.Date);
        if (!invoiceDate) continue;
        const dueMonth = toMonth(invoiceDate);

        const rentAmount = inv.LineItems
          .filter((li: any) => li.AccountCode === "200")
          .reduce((sum: number, li: any) => sum + li.LineAmount, 0);

        const payments = inv.Payments || [];
        for (const payment of payments) {
          const payDate = parseXeroDate(payment.Date);
          if (!payDate) continue;
          const payMonth = toMonth(payDate);

          if (payMonth < dueMonth) {
            const payAmount = payment.Amount || rentAmount;
            if (!prepaidByMonth[payMonth]) prepaidByMonth[payMonth] = 0;
            if (!prepaidByMonth[dueMonth]) prepaidByMonth[dueMonth] = 0;
            prepaidByMonth[payMonth] += payAmount;
            prepaidByMonth[dueMonth] -= payAmount;
          }
        }
      }

      const prepaidLine = (await storage.getCashflowLines()).find(l => l.code === "RENT-PRE");
      if (!prepaidLine) {
        return res.status(404).json({ message: "Prepaid Topline (RENT-PRE) not found" });
      }

      let updated = 0;
      for (const [month, amount] of Object.entries(prepaidByMonth)) {
        if (Math.abs(amount) < 0.01) continue;
        await storage.upsertForecastMonth({
          cashflowLineId: prepaidLine.id,
          forecastMonth: month,
          originalForecastAmount: "0.00",
          currentForecastAmount: amount.toFixed(2),
          actualAmount: amount.toFixed(2),
          sourceRuleId: null,
          status: "actual",
        });
        updated++;
      }

      await storage.createAuditLog({
        entityType: "prepaid_topline",
        entityId: prepaidLine.id,
        action: "calculate_prepaid",
        newValueJson: { prepaidByMonth, monthsAnalysed: monthsBack },
        userName: "system",
      });

      res.json({
        success: true,
        prepaidLine: prepaidLine.id,
        monthsUpdated: updated,
        prepaidByMonth,
      });
    } catch (err: any) {
      console.error("Prepaid calculation error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/import-outflows", async (_req, res) => {
    try {
      const allTransactions = await storage.getActualTransactions();
      const outflows = allTransactions.filter(t => parseFloat(t.amount as string) < 0);

      const skipPatterns = [
        /^bank transfer (to|from)/i,
      ];

      const depositRefundPattern = /\(deposit\)$/i;

      const bySupplier: Record<string, {
        supplier: string;
        total: number;
        count: number;
        months: Record<string, number>;
        recentAmount: number;
        recentMonth: string;
        bankAccountId: number;
        txIds: number[];
      }> = {};

      for (const t of outflows) {
        const supplier = t.supplierOrCounterparty || t.description || "Unknown";

        if (skipPatterns.some(p => p.test(supplier))) continue;
        if (depositRefundPattern.test(supplier)) continue;

        const amount = Math.abs(parseFloat(t.amount as string));
        const month = (t.transactionDate as string).substring(0, 7);

        if (!bySupplier[supplier]) {
          bySupplier[supplier] = {
            supplier,
            total: 0,
            count: 0,
            months: {},
            recentAmount: 0,
            recentMonth: "",
            bankAccountId: t.bankAccountId,
            txIds: [],
          };
        }

        bySupplier[supplier].total += amount;
        bySupplier[supplier].count++;
        if (!bySupplier[supplier].months[month]) bySupplier[supplier].months[month] = 0;
        bySupplier[supplier].months[month] += amount;
        bySupplier[supplier].txIds.push(t.id);

        if (month >= bySupplier[supplier].recentMonth) {
          bySupplier[supplier].recentMonth = month;
          bySupplier[supplier].recentAmount = bySupplier[supplier].months[month];
        }
      }

      const { db: dbInstance } = await import("./db");
      const {
        cashflowLines: clTable,
        forecastRules: frTable,
        forecastMonths: fmTable,
        varianceEvents: veTable,
        overrides: orTable,
      } = await import("@shared/schema");

      const existingLines = await storage.getCashflowLines();
      const outflowLines = existingLines.filter(l => l.direction === "outflow");
      for (const line of outflowLines) {
        await dbInstance.delete(fmTable).where(eq(fmTable.cashflowLineId, line.id));
        await dbInstance.delete(frTable).where(eq(frTable.cashflowLineId, line.id));
        await dbInstance.delete(veTable).where(eq(veTable.cashflowLineId, line.id));
        await dbInstance.delete(orTable).where(eq(orTable.cashflowLineId, line.id));
        await dbInstance.delete(clTable).where(eq(clTable.id, line.id));
      }

      const suppliers = Object.values(bySupplier).sort((a, b) => b.total - a.total);
      let created = 0;
      let mapped = 0;

      for (let i = 0; i < suppliers.length; i++) {
        const s = suppliers[i];
        const code = `OUT-${String(i + 1).padStart(3, "0")}`;
        const monthCount = Object.keys(s.months).length;

        const monthlyAmounts = Object.values(s.months);
        const avgMonthly = s.total / monthCount;
        const isRecurring = monthCount >= 3;

        let recurrenceType = "monthly";
        let forecastAmount = avgMonthly;

        if (monthCount === 1) {
          recurrenceType = "one_off";
          forecastAmount = s.total;
        } else if (monthCount <= 3 && s.count <= 3) {
          recurrenceType = "one_off";
          forecastAmount = s.recentAmount;
        } else if (monthCount >= 3 && monthCount <= 5) {
          const recentMonths = Object.entries(s.months).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3);
          forecastAmount = recentMonths.reduce((sum, [_, v]) => sum + v, 0) / recentMonths.length;
        } else {
          const recentMonths = Object.entries(s.months).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3);
          forecastAmount = recentMonths.reduce((sum, [_, v]) => sum + v, 0) / recentMonths.length;
        }

        const line = await storage.createCashflowLine({
          code,
          name: s.supplier,
          category: "Outflows",
          subcategory: null,
          supplierName: s.supplier,
          bankAccountId: s.bankAccountId,
          direction: "outflow",
          lineType: isRecurring ? "recurring_fixed" : "one_off",
          isRollup: false,
          parentLineId: null,
          sortOrder: i + 1,
          active: true,
        });

        if (isRecurring) {
          await storage.createForecastRule({
            cashflowLineId: line.id,
            recurrenceType: "monthly",
            frequency: 1,
            baseAmount: forecastAmount.toFixed(2),
            startDate: "2026-03-01",
            endDate: null,
            upliftType: "none",
            upliftValue: "0",
            upliftFrequency: "annual",
            paymentTimingRule: null,
            timingFlexibility: "fixed",
            forecastConfidence: isRecurring ? "high" : "medium",
            active: true,
          });
        }

        for (const txId of s.txIds) {
          await storage.updateActualTransaction(txId, { cashflowLineId: line.id });
          mapped++;
        }

        for (const [month, amount] of Object.entries(s.months)) {
          await storage.upsertForecastMonth({
            cashflowLineId: line.id,
            forecastMonth: month,
            originalForecastAmount: forecastAmount.toFixed(2),
            currentForecastAmount: forecastAmount.toFixed(2),
            actualAmount: amount.toFixed(2),
            sourceRuleId: null,
            status: "actual",
          });
        }

        created++;
      }

      await generateForecasts();

      await storage.createAuditLog({
        entityType: "outflow_import",
        entityId: null,
        action: "import_supplier_outflows",
        newValueJson: { suppliersCreated: created, transactionsMapped: mapped },
        userName: "system",
      });

      res.json({
        success: true,
        suppliersCreated: created,
        transactionsMapped: mapped,
        suppliers: suppliers.map(s => ({
          name: s.supplier,
          totalSpend: s.total,
          monthsActive: Object.keys(s.months).length,
          forecastAmount: s.total / Object.keys(s.months).length,
          transactions: s.count,
        })),
      });
    } catch (err: any) {
      console.error("Outflow import error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/xero/full-sync", async (req, res) => {
    try {
      const accountsResult = await importBankAccounts();
      const monthsBack = req.body.monthsBack || 3;
      const txResult = await importBankTransactions(monthsBack);
      await generateForecasts();

      let balances;
      try {
        balances = await fetchBankBalances();
      } catch (e: any) {
        console.error("Balance fetch failed during full-sync:", e.message);
      }

      res.json({
        success: true,
        accounts: accountsResult,
        transactions: txResult,
        balances,
        message: "Full sync complete - accounts imported, transactions synced, forecasts regenerated, balances updated",
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

  app.get("/api/cash-snapshots", async (_req, res) => {
    const snapshots = await storage.getSnapshots();
    res.json(snapshots);
  });

  app.post("/api/cash-snapshots", async (req, res) => {
    const parsed = insertCashBalanceSnapshotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const snap = await storage.createSnapshot(parsed.data);
    await storage.createAuditLog({ entityType: "cash_snapshot", entityId: snap.id, action: "create", newValueJson: snap });
    res.json(snap);
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

  app.post("/api/forecast/reconcile", async (_req, res) => {
    const result = await reconcileCurrentMonth();
    await storage.createAuditLog({
      entityType: "reconciliation",
      entityId: 0,
      action: "reconcile",
      newValueJson: {
        matched: result.matched,
        variances: result.variances.length,
        missing: result.missing.length,
        unmapped: result.unmapped,
      },
    });
    res.json({ success: true, ...result });
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
    const allRules = await storage.getForecastRules();

    const snapshot = await storage.getLatestSnapshot(currentMonth + "-01");
    const openingBalanceTotal = snapshot ? parseFloat(snapshot.balance as string) : 0;

    const activeBankAccounts = bankAccountsList.filter(ba => ba.active);
    const currentCashPosition = activeBankAccounts.reduce(
      (sum, ba) => sum + (parseFloat(ba.currentBalance as string) || 0), 0
    );
    const lastTxResult = await db.execute(sql`SELECT MAX(transaction_date)::text as d FROM actual_transactions`);
    const lastActualDate = lastTxResult.rows?.[0]?.d?.substring(0, 10) || new Date().toISOString().split("T")[0];

    const propDevOrder = ["16RC", "10KG", "32LFR", "84DD", "4WS", "26BLA", "26BLB", "26BLC", "27BLA", "27BLB", "27BLC", "27BLD", "26BL", "27BL"];
    const getOutflowSortKey = (name: string) => {
      const match = name.match(/\(([^)]+)\)\s*$/);
      const prop = match ? match[1] : "";
      const supplier = match ? name.slice(0, name.lastIndexOf("(")).trim() : name;
      const propIdx = propDevOrder.indexOf(prop);
      return { supplier, propIdx: propIdx >= 0 ? propIdx : 99 };
    };

    const activeLines = lines.filter(l => l.active).sort((a, b) => {
      const dirOrder = (d: string) => d === "inflow" ? 0 : 1;
      if (dirOrder(a.direction) !== dirOrder(b.direction)) return dirOrder(a.direction) - dirOrder(b.direction);
      if (a.direction === "outflow") {
        const aDue = a.dueDay ?? 99;
        const bDue = b.dueDay ?? 99;
        if (aDue !== bDue) return aDue - bDue;
        const aKey = getOutflowSortKey(a.name);
        const bKey = getOutflowSortKey(b.name);
        const supplierCmp = aKey.supplier.localeCompare(bKey.supplier);
        if (supplierCmp !== 0) return supplierCmp;
        return aKey.propIdx - bKey.propIdx;
      }
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });

    const grid = activeLines.map(line => {
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
        const fcActual = fc?.actualAmount ? parseFloat(fc.actualAmount as string) : null;
        const actualAmt = isCurrentMonth && lineCurrentTx.length > 0
          ? currentMonthActual
          : fcActual;

        let displayAmount: number;
        let displayStatus: string;
        if (isCurrentMonth) {
          if (lineCurrentTx.length > 0) {
            displayAmount = currentMonthActual;
            displayStatus = "actual";
          } else if (fcActual !== null) {
            displayAmount = fcActual;
            displayStatus = "actual";
          } else {
            displayAmount = fc ? parseFloat(fc.currentForecastAmount as string) || 0 : 0;
            displayStatus = "forecast";
          }
        } else {
          displayAmount = fc ? parseFloat(fc.currentForecastAmount as string) || 0 : 0;
          displayStatus = fc?.status || "forecast";
        }

        monthData[month] = {
          amount: displayAmount,
          status: displayStatus,
          hasOverride: !!ov,
          hasVariance: !!va,
          originalForecast: fc ? parseFloat(fc.originalForecastAmount as string) || 0 : 0,
          actualAmount: actualAmt,
          varianceAmount: va ? parseFloat(va.varianceAmount as string) : null,
          varianceTreatment: va?.approvedTreatment || va?.suggestedTreatment || null,
        };
      }

      const lineRules = allRules.filter(r => r.cashflowLineId === line.id && r.active);
      const recurrenceType = lineRules.length > 0 ? lineRules[0].recurrenceType : null;

      const activeRule = lineRules.length > 0 ? lineRules[0] : null;

      return {
        line,
        monthData,
        recurrenceType,
        ruleId: activeRule?.id || null,
        ruleBaseAmount: activeRule ? parseFloat(activeRule.baseAmount as string) || 0 : null,
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
        netTotals[month] += amount;
      }
    }

    let runningCash = openingBalanceTotal;
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
      currentCashPosition,
      lastActualDate,
      openingBalanceTotal,
      bankAccounts: bankAccountsList,
    });
  });

  app.get("/api/dashboard", async (_req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    const currentMonth = getCurrentMonth();
    const months = getNext12Months(currentMonth);
    const lines = await storage.getCashflowLines();
    const forecasts = await storage.getForecastMonths({ startMonth: months[0], endMonth: months[months.length - 1] });
    const bankAccountsList = await storage.getBankAccounts();
    const variances = await storage.getVarianceEvents();

    const snapshot = await storage.getLatestSnapshot(currentMonth + "-01");
    const openingBalanceTotal = snapshot ? parseFloat(snapshot.balance as string) : 0;

    const activeBankAccounts = bankAccountsList.filter(ba => ba.active);
    const currentCashPosition = activeBankAccounts.reduce(
      (sum, ba) => sum + (parseFloat(ba.currentBalance as string) || 0), 0
    );
    const lastTxResult = await db.execute(sql`SELECT MAX(transaction_date)::text as d FROM actual_transactions`);
    const lastActualDate = lastTxResult.rows?.[0]?.d?.substring(0, 10) || new Date().toISOString().split("T")[0];

    let runningCash = openingBalanceTotal;
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
      const net = monthInflow + monthOutflow;
      runningCash += net;
      cashTrend.push({ month, closing: runningCash, inflow: monthInflow, outflow: monthOutflow });
    }

    const pendingVariances = variances.filter(v => !v.approvedTreatment).length;
    const totalInflow = cashTrend.reduce((sum, t) => sum + t.inflow, 0);
    const totalOutflow = cashTrend.reduce((sum, t) => sum + t.outflow, 0);
    const freeCashFlow = totalInflow + totalOutflow;

    const futureMonths = months.slice(1);
    const salaryLine = lines.find(l => l.code === "OUT-002") || lines.find(l => l.name?.toUpperCase().includes("NICK DAVIDSON"));
    const dlaLine = lines.find(l => l.code === "TR-DLA") || lines.find(l => l.name?.toUpperCase() === "DLA");
    let annualNet = 0;
    let annualSalary = 0;
    let annualDLA = 0;
    for (const month of futureMonths) {
      for (const line of lines.filter(l => l.active && !l.isRollup && l.code !== "RENT-PRE")) {
        const fc = forecasts.find(f => f.cashflowLineId === line.id && f.forecastMonth === month);
        const amt = fc ? parseFloat(fc.currentForecastAmount as string) || 0 : 0;
        annualNet += amt;
        if (salaryLine && line.id === salaryLine.id) annualSalary += amt;
        if (dlaLine && line.id === dlaLine.id) annualDLA += amt;
      }
    }
    const annualGross = annualNet - annualSalary - annualDLA;

    const activeNonRollup = lines.filter(l => l.active && !l.isRollup);

    const currentMonthForecasts = forecasts.filter(f => f.forecastMonth === currentMonth);
    const categoryBridge: Record<string, number> = {};
    const bridgeCategories = ["Rent Revenue", "Recurring", "Tenancies", "Tradesmen", "Transfers", "Other"];
    for (const cat of bridgeCategories) categoryBridge[cat] = 0;

    const currentMonthStart = currentMonth + "-01";

    // Rent Revenue: always use forecast (prepayments distort actuals)
    for (const line of lines.filter(l => l.active && !l.isRollup && l.category === "Rent Revenue")) {
      const fc = currentMonthForecasts.find(f => f.cashflowLineId === line.id);
      if (!fc) continue;
      const amt = parseFloat(fc.currentForecastAmount as string) || 0;
      categoryBridge["Rent Revenue"] += amt;
    }

    // All other categories: use actuals
    const actualTxRows = await db.execute(sql`
      SELECT COALESCE(SUM(at.amount), 0)::text as total, cl.category
      FROM actual_transactions at
      LEFT JOIN cashflow_lines cl ON cl.id = at.cashflow_line_id
      WHERE at.transaction_date >= ${currentMonthStart}::date
        AND at.transaction_date <= ${lastActualDate}::date
        AND cl.category != 'Rent Revenue'
      GROUP BY cl.category
    `);

    for (const row of actualTxRows.rows) {
      const cat = (row.category as string) || "Other";
      const normalizedCat = bridgeCategories.includes(cat) ? cat : "Other";
      const amt = parseFloat(row.total as string) || 0;
      categoryBridge[normalizedCat] = (categoryBridge[normalizedCat] || 0) + amt;
    }

    // Tradesmen: if no actuals, fall back to forecast
    if (categoryBridge["Tradesmen"] === 0) {
      for (const line of lines.filter(l => l.active && !l.isRollup && l.category === "Tradesmen")) {
        const fc = currentMonthForecasts.find(f => f.cashflowLineId === line.id);
        if (!fc) continue;
        const amt = parseFloat(fc.currentForecastAmount as string) || 0;
        categoryBridge["Tradesmen"] += amt;
      }
    }

    const bridgeTotal = Object.values(categoryBridge).reduce((a, b) => a + b, 0);
    const monthEndCash = openingBalanceTotal + bridgeTotal;
    res.json({
      currentCashPosition,
      lastActualDate,
      openingBalanceTotal,
      freeCashFlow,
      monthEndCash,
      annualCash: { gross: annualGross, salary: annualSalary, dla: annualDLA, net: annualNet },
      totalInflow,
      totalOutflow,
      pendingVariances,
      cashTrend,
      bankAccounts: bankAccountsList,
      months,
      categoryBridge,
    });
  });

  app.post("/api/fix-production-v12", async (_req, res) => {
    try {
      const marker = await db.execute(sql`SELECT 1 FROM overrides WHERE reason = 'fix-production-v12-applied' LIMIT 1`);
      if (marker.rows?.length) {
        return res.json({ success: false, message: "Fix v12 already applied" });
      }

      const count = await db.execute(sql`
        SELECT COUNT(*) as n FROM actual_transactions WHERE xero_source_type = 'ACCRECPAYMENT'
      `);
      const n = count.rows?.[0]?.n || 0;

      await db.execute(sql`
        DELETE FROM actual_transactions WHERE xero_source_type = 'ACCRECPAYMENT'
      `);

      const dlaId = 1;
      await db.execute(sql`INSERT INTO overrides (cashflow_line_id, forecast_month, override_amount, reason) VALUES (${dlaId}, '2099-03', '0', 'fix-production-v12-applied')`);

      res.json({ success: true, deleted: n, message: `Removed ${n} duplicate ACCRECPAYMENT entries (rent income already captured via invoices)` });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/refresh-balances", async (_req, res) => {
    try {
      const balances = await fetchBankBalances();
      res.json({ success: true, ...balances });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get("/api/debug-xero-march10", async (_req, res) => {
    try {
      const { xeroApiGet, isXeroConnected } = await import("./xero");
      const connected = await isXeroConnected();
      if (!connected.connected) return res.json({ error: "Not connected to Xero" });

      const santanderId = "d1540370-4214-4637-b4fa-d48bcdb8749e";

      const bankTxData = await xeroApiGet(
        `BankTransactions?where=BankAccount.AccountID%3D%3DGuid("${santanderId}")%26%26Date%3D%3DDateTime(2026,3,10)&order=Date%20DESC`
      );
      const bankTxs = (bankTxData.BankTransactions || []).map((tx: any) => ({
        id: tx.BankTransactionID,
        type: tx.Type,
        status: tx.Status,
        date: tx.Date,
        total: tx.Total,
        contact: tx.Contact?.Name,
        ref: tx.Reference,
        lineDesc: tx.LineItems?.[0]?.Description,
        isReconciled: tx.IsReconciled,
      }));

      const pmtData = await xeroApiGet(
        `Payments?where=Date%3D%3DDateTime(2026,3,10)&order=Date%20DESC`
      );
      const payments = (pmtData.Payments || []).map((p: any) => ({
        id: p.PaymentID,
        type: p.PaymentType,
        status: p.Status,
        date: p.Date,
        amount: p.Amount,
        contact: p.Invoice?.Contact?.Name,
        invoiceNum: p.Invoice?.InvoiceNumber,
        accountId: p.Account?.AccountID,
        ref: p.Reference,
      }));

      const existingTxs = await storage.getActualTransactions({});
      const march10 = existingTxs.filter(t => {
        const d = typeof t.transactionDate === 'string' ? t.transactionDate : '';
        return d.startsWith('2026-03-10');
      });

      res.json({
        xeroBankTransactions: bankTxs,
        xeroPayments: payments,
        existingMarch10: march10.map(t => ({
          id: t.id,
          xeroId: t.xeroTransactionId,
          type: t.xeroSourceType,
          amount: t.amount,
          desc: t.description,
          supplier: t.supplierOrCounterparty,
        })),
      });
    } catch (err: any) {
      res.json({ error: err.message });
    }
  });

  app.post("/api/fix-production", async (_req, res) => {
    try {
      const marker = await db.execute(sql`SELECT 1 FROM overrides WHERE reason = 'fix-production-v10-applied' LIMIT 1`);
      if (marker.rows?.length) {
        return res.json({ success: false, message: "Fix v10 already applied" });
      }

      const results: string[] = [];

      await db.execute(sql`UPDATE cashflow_lines SET active = true WHERE code IN ('OUT-002', 'TR-DLA')`);
      results.push("Ensured OUT-002 and TR-DLA are active");

      const dlaRow = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TR-DLA'`);
      const dlaId = dlaRow.rows?.[0]?.id;

      if (dlaId) {
        await db.execute(sql`UPDATE forecast_rules SET base_amount = '-3000.00' WHERE cashflow_line_id = ${dlaId} AND active = true`);
        results.push("Fixed DLA forecast rule base_amount to -3000.00");

        const existingOverride = await db.execute(sql`SELECT id FROM overrides WHERE cashflow_line_id = ${dlaId} AND forecast_month = '2026-04'`);
        if (!existingOverride.rows?.length) {
          await db.execute(sql`INSERT INTO overrides (cashflow_line_id, forecast_month, override_amount, reason) VALUES (${dlaId}, '2026-04', '7000.00', 'April: -3K DLA + 10K salary returned')`);
          results.push("Created override for DLA April 2026 = +7000");
        } else {
          results.push("DLA April 2026 override already exists");
        }
      }

      const existing27bla2 = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = '27BLA#2'`);
      if (!existing27bla2.rows?.length) {
        const newLine = await db.execute(sql`
          INSERT INTO cashflow_lines (code, name, category, subcategory, supplier_name, bank_account_id, line_type, is_rollup, parent_line_id, direction, active, sort_order, due_day)
          VALUES ('27BLA#2', '27BLA#2 J HIBBERT', 'Rent Revenue', '27BLA', 'J HIBBERT', 
            (SELECT bank_account_id FROM cashflow_lines WHERE code = '27BLA#1' LIMIT 1),
            'recurring_fixed', false,
            (SELECT parent_line_id FROM cashflow_lines WHERE code = '27BLA#1' LIMIT 1),
            'inflow', true, 37, 11)
          RETURNING id
        `);
        const newId = newLine.rows?.[0]?.id;
        if (newId) {
          await db.execute(sql`
            INSERT INTO forecast_rules (cashflow_line_id, base_amount, recurrence_type, start_date, active, uplift_type)
            VALUES (${newId}, '650.00', 'monthly', '2026-04-01', true, 'none')
          `);
          results.push(`Created 27BLA#2 J HIBBERT (id=${newId}) with £650/month from April 2026`);
        }
      } else {
        results.push("27BLA#2 already exists");
      }

      const renames = [
        { from: '32LFR#6', to: '32LFR#7', fromName: '32LFR#6 J LOWE', toName: '32LFR#7 J LOWE' },
        { from: '32LFR#5', to: '32LFR#6', fromName: '32LFR#5 B FOSTER', toName: '32LFR#6 B FOSTER' },
        { from: '32LFR#4', to: '32LFR#5', fromName: '32LFR#4 S HATHAWAY', toName: '32LFR#5 S HATHAWAY' },
        { from: '32LFR#3', to: '32LFR#4', fromName: '32LFR#3 J BARTON', toName: '32LFR#4 J BARTON' },
        { from: '32LFR#2', to: '32LFR#3', fromName: '32LFR#2 E RIGBY', toName: '32LFR#3 E RIGBY' },
        { from: '32LFR#1', to: '32LFR#2', fromName: '32LFR#1 T TOGY', toName: '32LFR#2 T TOGY' },
      ];
      for (const r of renames) {
        await db.execute(sql`UPDATE cashflow_lines SET code = ${r.to}, name = ${r.toName} WHERE code = ${r.from}`);
      }
      results.push("Renamed 32LFR rooms: #1→#2, #2→#3, #3→#4, #4→#5, #5→#6, #6→#7");

      const tradesmenLines = [
        { code: 'TM-MAINT', name: 'MAINTENANCE', sub: 'Maintenance' },
        { code: 'TM-GARDEN', name: 'GARDENING', sub: 'Gardening' },
        { code: 'TM-COMPL', name: 'COMPLIANCE', sub: 'Compliance' },
        { code: 'TM-OVENS', name: 'OVENS', sub: 'Ovens' },
      ];
      const bankAcctId = (await db.execute(sql`SELECT bank_account_id FROM cashflow_lines WHERE code = '27BLA#1' LIMIT 1`)).rows?.[0]?.bank_account_id || 6;
      for (const tl of tradesmenLines) {
        const exists = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = ${tl.code}`);
        if (!exists.rows?.length) {
          await db.execute(sql`
            INSERT INTO cashflow_lines (code, name, category, subcategory, supplier_name, bank_account_id, line_type, is_rollup, direction, active, sort_order, due_day)
            VALUES (${tl.code}, ${tl.name}, 'Tradesmen', ${tl.sub}, ${tl.sub}, ${bankAcctId}, 'recurring_fixed', false, 'outflow', true, 0, null)
          `);
          results.push(`Created ${tl.code} ${tl.name}`);
        }
      }

      const maintLine = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TM-MAINT'`);
      const gardenLine = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TM-GARDEN'`);
      const complLine = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TM-COMPL'`);
      const ovensLine = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TM-OVENS'`);
      const maintId = maintLine.rows?.[0]?.id;
      const gardenId = gardenLine.rows?.[0]?.id;
      const complId = complLine.rows?.[0]?.id;
      const ovensId = ovensLine.rows?.[0]?.id;

      if (maintId) {
        const ruleExists = await db.execute(sql`SELECT id FROM forecast_rules WHERE cashflow_line_id = ${maintId}`);
        if (!ruleExists.rows?.length) {
          await db.execute(sql`INSERT INTO forecast_rules (cashflow_line_id, base_amount, recurrence_type, start_date, active, uplift_type) VALUES (${maintId}, '-1500.00', 'monthly', '2026-03-01', true, 'none')`);
          results.push("Maintenance rule: -1500/month");
        }
      }
      if (gardenId) {
        const ruleExists = await db.execute(sql`SELECT id FROM forecast_rules WHERE cashflow_line_id = ${gardenId}`);
        if (!ruleExists.rows?.length) {
          const gv = '{"jan":0,"feb":0,"mar":0,"apr":1,"may":1,"jun":1,"jul":1,"aug":1,"sep":1,"oct":0,"nov":0,"dec":0}';
          await db.execute(sql`INSERT INTO forecast_rules (cashflow_line_id, base_amount, recurrence_type, start_date, active, uplift_type, monthly_volumes) VALUES (${gardenId}, '-500.00', 'monthly', '2026-04-01', true, 'none', ${gv}::jsonb)`);
          results.push("Gardening rule: -500/month Apr-Sep");
        }
      }
      if (complId) {
        const ruleExists = await db.execute(sql`SELECT id FROM forecast_rules WHERE cashflow_line_id = ${complId}`);
        if (!ruleExists.rows?.length) {
          const cv = '{"jan":240,"feb":0,"mar":470,"apr":70,"may":80,"jun":160,"jul":310,"aug":80,"sep":240,"oct":0,"nov":0,"dec":0}';
          await db.execute(sql`INSERT INTO forecast_rules (cashflow_line_id, base_amount, recurrence_type, start_date, active, uplift_type, monthly_volumes) VALUES (${complId}, '-1.00', 'monthly', '2026-03-01', true, 'none', ${cv}::jsonb)`);
          results.push("Compliance rule: variable monthly");
        }
      }
      if (ovensId) {
        const ruleExists = await db.execute(sql`SELECT id FROM forecast_rules WHERE cashflow_line_id = ${ovensId}`);
        if (!ruleExists.rows?.length) {
          await db.execute(sql`INSERT INTO forecast_rules (cashflow_line_id, base_amount, recurrence_type, start_date, active, uplift_type) VALUES (${ovensId}, '-500.00', 'semi_annual', '2026-04-01', true, 'none')`);
          results.push("Ovens rule: -500 semi-annual Apr/Oct");
        }
      }

      await db.execute(sql`UPDATE cashflow_lines SET active = true, category = 'Recurring' WHERE code = 'OUT-011'`);
      await db.execute(sql`UPDATE forecast_rules SET active = true WHERE cashflow_line_id = (SELECT id FROM cashflow_lines WHERE code = 'OUT-011')`);
      results.push("Reactivated BRIGHT & BEAUTIFUL (OUT-011) as Recurring");

      const { generateForecasts } = await import("./forecast-engine");
      await generateForecasts();
      results.push("Regenerated all forecasts");

      const interbankLine = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TR-IB'`);
      const interbankId = interbankLine.rows?.[0]?.id;
      if (interbankId) {
        await db.execute(sql`
          UPDATE actual_transactions 
          SET cashflow_line_id = ${interbankId}, mapped_confidence = 'high', mapping_method = 'bank_transfer_match'
          WHERE description LIKE '%Bank Transfer%' AND cashflow_line_id IS NULL
        `);
        const starlingAcct = await db.execute(sql`SELECT id FROM bank_accounts WHERE name LIKE '%Starling%' LIMIT 1`);
        const starlingId = starlingAcct.rows?.[0]?.id;
        if (starlingId) {
          await db.execute(sql`
            UPDATE actual_transactions 
            SET amount = ABS(amount)
            WHERE description LIKE 'Bank Transfer from%' AND amount < 0 AND bank_account_id = ${starlingId}
          `);
        }
        results.push("Fixed bank transfers: mapped to INTERBANK, corrected Starling inflow signs");
      }

      const interbankId2 = interbankLine.rows?.[0]?.id;
      const santFeeId = (await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'SANT-FEE'`)).rows?.[0]?.id;
      const bbLoanId = (await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'OUT-014'`)).rows?.[0]?.id;
      
      if (santFeeId && bbLoanId) {
        await db.execute(sql`
          UPDATE actual_transactions 
          SET cashflow_line_id = ${santFeeId}, mapped_confidence = 'high', mapping_method = 'fee_match'
          WHERE supplier_or_counterparty = 'SANTANDER BUSINESS'
            AND (description = 'FEES AND CHARGES' OR description = 'MONTHLY CORPORATE ACCOUNT CHARGE' OR (description = 'SANTANDER BUSINESS' AND amount = -9.99))
            AND cashflow_line_id = ${bbLoanId}
        `);
        results.push("Remapped bank fees from BB loan to SANT-FEE");
      }

      const usdCodes = ['OUT-046', 'OUT-052', 'OUT-036', 'OUT-070'];
      for (const code of usdCodes) {
        const line = await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = ${code}`);
        const lineId = line.rows?.[0]?.id;
        if (lineId) {
          await db.execute(sql`
            UPDATE actual_transactions ott
            SET cashflow_line_id = ${lineId}, mapped_confidence = 'high', mapping_method = 'fx_same_day_match'
            FROM actual_transactions supplier_tx
            WHERE ott.description = 'OTT DEBIT'
              AND ott.supplier_or_counterparty = 'SANTANDER BUSINESS'
              AND supplier_tx.transaction_date = ott.transaction_date
              AND supplier_tx.id != ott.id
              AND supplier_tx.cashflow_line_id = ${lineId}
          `);
        }
      }
      if (santFeeId) {
        await db.execute(sql`
          UPDATE actual_transactions 
          SET cashflow_line_id = ${santFeeId}, mapped_confidence = 'medium', mapping_method = 'fx_fee_fallback'
          WHERE description = 'OTT DEBIT' AND supplier_or_counterparty = 'SANTANDER BUSINESS'
            AND cashflow_line_id = ${bbLoanId}
        `);
      }
      results.push("Remapped OTT DEBIT FX charges to USD suppliers or SANT-FEE");

      const depLineId = (await db.execute(sql`SELECT id FROM cashflow_lines WHERE code = 'TEN-DEPIO'`)).rows?.[0]?.id;
      if (depLineId) {
        await db.execute(sql`
          UPDATE actual_transactions 
          SET cashflow_line_id = ${depLineId}, mapped_confidence = 'high', mapping_method = 'deposit_match'
          WHERE supplier_or_counterparty = 'HAMED KARGBO' AND description IN ('DEPOSIT IN LATER REFUNDED', 'DEPOSIT OUT REFUNDED')
        `);
        results.push("Mapped HAMED KARGBO deposit in/out to DEPOSITS IN/OUT");
      }

      await db.execute(sql`INSERT INTO overrides (cashflow_line_id, forecast_month, override_amount, reason) VALUES (${dlaId}, '2099-01', '0', 'fix-production-v10-applied')`);

      const verify = await db.execute(sql`
        SELECT cl.code, cl.name, cl.active, fm.forecast_month, fm.current_forecast_amount 
        FROM cashflow_lines cl 
        JOIN forecast_months fm ON fm.cashflow_line_id = cl.id 
        WHERE cl.code IN ('OUT-002', 'TR-DLA') AND fm.forecast_month >= '2026-03'
        ORDER BY cl.code, fm.forecast_month LIMIT 20
      `);
      res.json({ success: true, actions: results, verification: verify.rows });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/fix-production-v11", async (_req, res) => {
    try {
      const marker = await db.execute(sql`SELECT 1 FROM overrides WHERE reason = 'fix-production-v11-applied' LIMIT 1`);
      if (marker.rows?.length) {
        return res.json({ success: false, message: "Fix v11 already applied" });
      }

      const results: string[] = [];

      const arthurExists = await db.execute(sql`
        SELECT id FROM actual_transactions WHERE xero_transaction_id = '489156d1-6f2d-4fb4-bb05-df21c5902dfd'
      `);
      if (!arthurExists.rows?.length) {
        const arthurLine = await db.execute(sql`
          SELECT id FROM cashflow_lines WHERE supplier_name = 'ARTHUR' AND active = true LIMIT 1
        `);
        const arthurLineId = arthurLine.rows?.[0]?.id || null;

        await db.execute(sql`
          INSERT INTO actual_transactions (xero_transaction_id, xero_source_type, transaction_date, amount, description, supplier_or_counterparty, bank_account_id, cashflow_line_id, mapped_confidence, mapping_method, reconciled_flag)
          VALUES ('489156d1-6f2d-4fb4-bb05-df21c5902dfd', 'ACCPAYPAYMENT', '2026-03-10', '-45.58', 'INV-154675', 'ARTHUR', 3, ${arthurLineId}, 'high', 'supplier_match', true)
        `);
        results.push("Inserted ARTHUR payment -45.58 for 2026-03-10");
      } else {
        results.push("ARTHUR payment already exists");
      }

      const tdsExists = await db.execute(sql`
        SELECT id FROM actual_transactions WHERE xero_transaction_id = 'c344fec2-5240-4944-a22a-1cc5ec0b750d'
      `);
      if (!tdsExists.rows?.length) {
        await db.execute(sql`
          INSERT INTO actual_transactions (xero_transaction_id, xero_source_type, transaction_date, amount, description, supplier_or_counterparty, bank_account_id, cashflow_line_id, mapped_confidence, mapping_method, reconciled_flag)
          VALUES ('c344fec2-5240-4944-a22a-1cc5ec0b750d', 'ACCPAYPAYMENT', '2026-03-10', '-17.95', 'HD 887388387', 'THE DISPUTE SERVICE (TDS)', 4, null, 'unmatched', 'none', true)
        `);
        results.push("Inserted TDS payment -17.95 for 2026-03-10");
      } else {
        results.push("TDS payment already exists");
      }

      const dlaId = 1;
      await db.execute(sql`INSERT INTO overrides (cashflow_line_id, forecast_month, override_amount, reason) VALUES (${dlaId}, '2099-02', '0', 'fix-production-v11-applied')`);

      res.json({ success: true, actions: results });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/data-export", async (_req, res) => {
    try {
      const accounts = await storage.getBankAccounts();
      const lines = await storage.getCashflowLines();
      const rules = await storage.getForecastRules();
      const transactions = await storage.getActualTransactions({});
      const forecasts = await storage.getForecastMonths({});
      const snapshots = await storage.getSnapshots();
      const overridesList = await storage.getOverrides();
      res.json({ accounts, lines, rules, transactions, forecasts, snapshots, overrides: overridesList });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/data-import", async (req, res) => {
    try {
      const data = req.body;
      if (!data.accounts || !data.lines) {
        return res.status(400).json({ message: "Invalid import data" });
      }

      const existingAccounts = await storage.getBankAccounts();
      if (existingAccounts.length > 0) {
        return res.status(400).json({ message: "Database already has data. Clear it first." });
      }

      const accountIdMap: Record<number, number> = {};
      for (const acc of data.accounts) {
        const created = await storage.createBankAccount({
          name: acc.name,
          xeroAccountId: acc.xeroAccountId,
          currentBalance: acc.currentBalance || "0",
          active: acc.active,
        });
        accountIdMap[acc.id] = created.id;
      }

      const lineIdMap: Record<number, number> = {};
      for (const line of data.lines) {
        const created = await storage.createCashflowLine({
          code: line.code,
          name: line.name,
          category: line.category,
          direction: line.direction,
          lineType: line.lineType,
          sortOrder: line.sortOrder,
          bankAccountId: line.bankAccountId ? (accountIdMap[line.bankAccountId] || null) : null,
          supplierName: line.supplierName || null,
          active: line.active,
          isRollup: line.isRollup || false,
          parentLineId: null,
          xeroContactId: line.xeroContactId || null,
        });
        lineIdMap[line.id] = created.id;
      }

      for (const line of data.lines) {
        if (line.parentLineId && lineIdMap[line.parentLineId]) {
          await storage.updateCashflowLine(lineIdMap[line.id], { parentLineId: lineIdMap[line.parentLineId] });
        }
      }

      for (const rule of (data.rules || [])) {
        if (!lineIdMap[rule.cashflowLineId]) continue;
        await storage.createForecastRule({
          cashflowLineId: lineIdMap[rule.cashflowLineId],
          recurrenceType: rule.recurrenceType,
          frequency: rule.frequency,
          baseAmount: rule.baseAmount,
          startDate: rule.startDate,
          endDate: rule.endDate || null,
          upliftType: rule.upliftType || "none",
          upliftValue: rule.upliftValue || "0",
          upliftFrequency: rule.upliftFrequency || "annual",
          forecastConfidence: rule.forecastConfidence || "medium",
          monthlyVolumes: rule.monthlyVolumes || null,
          active: rule.active,
        });
      }

      for (const tx of (data.transactions || [])) {
        if (!lineIdMap[tx.cashflowLineId] && tx.cashflowLineId) continue;
        await storage.createActualTransaction({
          transactionDate: tx.transactionDate,
          amount: tx.amount,
          description: tx.description,
          supplierOrCounterparty: tx.supplierOrCounterparty,
          bankAccountId: tx.bankAccountId ? (accountIdMap[tx.bankAccountId] || null) : null,
          cashflowLineId: tx.cashflowLineId ? (lineIdMap[tx.cashflowLineId] || null) : null,
          xeroTransactionId: tx.xeroTransactionId || null,
          xeroSourceType: tx.xeroSourceType || null,
          mappedConfidence: tx.mappedConfidence || "low",
          mappingMethod: tx.mappingMethod || "auto",
          reconciledFlag: tx.reconciledFlag || false,
        });
      }

      for (const snap of (data.snapshots || [])) {
        await storage.createSnapshot({
          snapshotDate: snap.snapshotDate,
          balance: snap.balance,
          bankAccountId: snap.bankAccountId || null,
          source: snap.source || "import",
        });
      }

      const { generateForecasts } = await import("./forecast-engine");
      await generateForecasts();

      res.json({ success: true, message: `Imported ${Object.keys(accountIdMap).length} accounts, ${Object.keys(lineIdMap).length} lines` });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });
  app.post("/api/cleanup-duplicates", async (_req, res) => {
      try {
        await db.execute(sql`DELETE FROM actual_transactions WHERE xero_source_type = 'ACCRECPAYMENT'`);
        await db.execute(sql`DELETE FROM actual_transactions WHERE xero_source_type IN ('STATEMENT_RECEIVE', 'STATEMENT_SPEND')`);
        await db.execute(sql`
          DELETE FROM actual_transactions WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY xero_transaction_id ORDER BY id ASC) as rn
              FROM actual_transactions WHERE xero_transaction_id IS NOT NULL
            ) ranked WHERE rn > 1
          )
        `);
        const count = await db.execute(sql`SELECT COUNT(*) as n FROM actual_transactions`);
        res.json({ success: true, remainingTransactions: count.rows[0].n });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    });
  app.get("/api/cleanup-duplicates", async (req, res) => {
    if (req.query.token !== "cleanup123") {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      await db.execute(sql`DELETE FROM actual_transactions WHERE xero_source_type = 'ACCRECPAYMENT'`);
      await db.execute(sql`DELETE FROM actual_transactions WHERE xero_source_type IN ('STATEMENT_RECEIVE', 'STATEMENT_SPEND')`);
      await db.execute(sql`
        DELETE FROM actual_transactions WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY xero_transaction_id ORDER BY id ASC) as rn
            FROM actual_transactions WHERE xero_transaction_id IS NOT NULL
          ) ranked WHERE rn > 1
        )
      `);
      const count = await db.execute(sql`SELECT COUNT(*) as n FROM actual_transactions`);
      res.json({ success: true, remainingTransactions: count.rows[0].n });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });
  
  return httpServer;
}
