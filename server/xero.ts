import { XeroClient } from "xero-node";
import { db } from "./db";
import { xeroTokens } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { storage } from "./storage";
import crypto from "crypto";

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID!;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET!;

const oauthStates = new Map<string, { timestamp: number; codeVerifier: string }>();

function cleanExpiredStates() {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [key, data] of oauthStates) {
    if (data.timestamp < fiveMinutesAgo) oauthStates.delete(key);
  }
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

let lastCodeVerifier: string | null = null;

function getRedirectUri(): string {
  if (process.env.APP_URL) {
    return `${process.env.APP_URL}/api/xero/callback`;
  }
  const replitDomains = process.env.REPLIT_DOMAINS;
  if (replitDomains) {
    const domain = replitDomains.split(",")[0];
    return `https://${domain}/api/xero/callback`;
  }
  return `http://localhost:5000/api/xero/callback`;
}

const SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.banktransactions.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.reports.banksummary.read",
  "offline_access",
];

export function createXeroClient(): XeroClient {
  return new XeroClient({
    clientId: XERO_CLIENT_ID,
    clientSecret: XERO_CLIENT_SECRET,
    redirectUris: [getRedirectUri()],
    scopes: SCOPES,
  });
}

export function getAuthUrl(): { url: string; state: string } {
  cleanExpiredStates();
  const redirectUri = getRedirectUri();
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { timestamp: Date.now(), codeVerifier: "" });
  const scopeStr = SCOPES.join(" ");
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopeStr)}&state=${state}`;
  return { url, state };
}

export function validateOAuthState(state: string): { valid: boolean; codeVerifier: string | null } {
  if (!state) return { valid: false, codeVerifier: null };
  if (oauthStates.has(state)) {
    const data = oauthStates.get(state)!;
    oauthStates.delete(state);
    return { valid: true, codeVerifier: data.codeVerifier };
  }
  console.log("OAuth state not found in memory (server may have restarted), using last known verifier");
  return { valid: true, codeVerifier: lastCodeVerifier };
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string | null): Promise<{
  tenantId: string;
  tenantName: string;
}> {
  const redirectUri = getRedirectUri();

  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  };

  const tokenResponse = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams(bodyParams),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errText}`);
  }

  const tokenData = await tokenResponse.json();

  const connectionsResponse = await fetch("https://api.xero.com/connections", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
    },
  });

  if (!connectionsResponse.ok) {
    throw new Error("Failed to fetch Xero connections");
  }

  const connections = await connectionsResponse.json();
  if (!connections.length) {
    throw new Error("No Xero organisations found");
  }

  const tenant = connections[0];
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  await db.delete(xeroTokens).where(eq(xeroTokens.tenantId, tenant.tenantId));

  await db.insert(xeroTokens).values({
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName || "Unknown",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scope: tokenData.scope,
  });

  await storage.createAuditLog({
    entityType: "xero_connection",
    entityId: null,
    action: "connected",
    newValueJson: { tenantId: tenant.tenantId, tenantName: tenant.tenantName },
    userName: "system",
  });

  return {
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
  };
}

async function getValidToken(): Promise<{ accessToken: string; tenantId: string } | null> {
  const [token] = await db.select().from(xeroTokens).orderBy(desc(xeroTokens.updatedAt)).limit(1);
  if (!token) return null;

  if (new Date() >= token.expiresAt) {
    const tokenResponse = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
    });

    if (!tokenResponse.ok) {
      await db.delete(xeroTokens).where(eq(xeroTokens.id, token.id));
      return null;
    }

    const tokenData = await tokenResponse.json();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    await db.update(xeroTokens).set({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      updatedAt: new Date(),
    }).where(eq(xeroTokens.id, token.id));

    return { accessToken: tokenData.access_token, tenantId: token.tenantId };
  }

  return { accessToken: token.accessToken, tenantId: token.tenantId };
}

export async function xeroApiGet(path: string): Promise<any> {
  const auth = await getValidToken();
  if (!auth) throw new Error("Not connected to Xero");

  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Xero-Tenant-Id": auth.tenantId,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Xero API error: ${response.status} ${errText}`);
  }

  return response.json();
}

async function xeroFinanceApiGet(path: string): Promise<any> {
  const auth = await getValidToken();
  if (!auth) throw new Error("Not connected to Xero");

  const response = await fetch(`https://api.xero.com/finance.xro/1.0/${path}`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Xero-Tenant-Id": auth.tenantId,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Xero Finance API error: ${response.status} ${errText}`);
  }

  return response.json();
}

export async function isXeroConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const auth = await getValidToken();
  if (!auth) return { connected: false };

  const [token] = await db.select().from(xeroTokens).orderBy(desc(xeroTokens.updatedAt)).limit(1);
  return { connected: true, tenantName: token?.tenantName || undefined };
}

export async function fetchBankBalances(): Promise<{ totalBalance: number; accounts: { name: string; balance: number }[] }> {
  const existingAccounts = await storage.getBankAccounts();
  const activeAccounts = existingAccounts.filter(a => a.active && a.xeroAccountId);
  const result: { name: string; balance: number }[] = [];
  let totalBalance = 0;

  const XERO_NAME_MAP: Record<string, string> = {
    "SANTANDER BUSINESS ACCOUNT": "Santander",
    "STARLING BUSINESS ACCOUNT": "Starling",
  };

  let reportData: any;
  try {
    reportData = await xeroApiGet(`Reports/BankSummary`);
    console.log("Bank Summary response:", JSON.stringify(reportData).substring(0, 1000));
  } catch (e: any) {
    console.error("Bank Summary failed:", e.message);
    throw e;
  }

  const report = reportData.Reports?.[0];
  if (!report?.Rows) {
    console.log("Bank Summary returned no rows");
    return { totalBalance: 0, accounts: [] };
  }

  for (const section of report.Rows) {
    if (section.RowType !== "Section" || !section.Rows) continue;
    for (const row of section.Rows) {
      if (row.RowType !== "Row" || !row.Cells) continue;

      const xeroAccountName = (row.Cells[0]?.Value || "").trim().toUpperCase();
      const closingBalance = parseFloat(row.Cells[4]?.Value || row.Cells[3]?.Value || "0");

      console.log(`Bank Summary row: "${xeroAccountName}" closing=£${closingBalance}`);

      const dbName = XERO_NAME_MAP[xeroAccountName];
      const match = dbName
        ? activeAccounts.find(a => a.name.toLowerCase() === dbName.toLowerCase())
        : activeAccounts.find(a => xeroAccountName.includes(a.name.toUpperCase()));

      if (match) {
        result.push({ name: match.name, balance: closingBalance });
        totalBalance += closingBalance;
        await storage.updateBankAccount(match.id, { currentBalance: closingBalance.toFixed(2) });
        console.log(`✓ Matched "${xeroAccountName}" → ${match.name}: £${closingBalance.toFixed(2)}`);
      } else {
        console.log(`✗ No DB match for Xero account: "${xeroAccountName}"`);
      }
    }
  }

  if (result.length === 0) {
    console.log("WARNING: No balances matched. Active DB accounts:", activeAccounts.map(a => `"${a.name}" (xeroId: ${a.xeroAccountId})`).join(", "));
  }

  return { totalBalance, accounts: result };
}

export async function importBankAccounts(): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const data = await xeroApiGet("Accounts?where=Type%3D%3D%22BANK%22");
  const accounts = data.Accounts || [];
  const existingAccounts = await storage.getBankAccounts();
  const errors: string[] = [];

  let imported = 0;
  let skipped = 0;

  for (const acc of accounts) {
    const match = existingAccounts.find(e => e.xeroAccountId === acc.AccountID);

    if (match) {
      imported++;
    } else {
      const isExcluded = existingAccounts.some(e => e.xeroAccountId === acc.AccountID && !e.active);
      if (isExcluded) {
        skipped++;
        continue;
      }
      await storage.createBankAccount({
        name: acc.Name,
        xeroAccountId: acc.AccountID,
        currentBalance: "0",
        active: true,
      });
      imported++;
    }
  }

  await storage.createAuditLog({
    entityType: "xero_sync",
    entityId: null,
    action: "import_bank_accounts",
    newValueJson: { imported, skipped, errors },
    userName: "system",
  });

  return { imported, skipped, errors };
}

export async function importBankTransactions(monthsBack: number = 3): Promise<{ imported: number; mapped: number; errors: string[] }> {
  const bankAccounts = await storage.getBankAccounts();
  const activeBankAccounts = bankAccounts.filter(ba => ba.active && ba.xeroAccountId);
  const cashflowLines = await storage.getCashflowLines();

  const existingTransactions = await storage.getActualTransactions({});
  const existingXeroIds = new Set(
    existingTransactions
      .map(t => t.xeroTransactionId)
      .filter(Boolean)
  );

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const errors: string[] = [];

  let imported = 0;
  let mapped = 0;

  const paymentProcessorAliases: Record<string, string> = {
    "GOCARDLESS": "ARTHUR",
  };

  function parseTxDate(raw: string): string {
    if (raw.startsWith("/Date(")) {
      const ms = parseInt(raw.match(/\d+/)?.[0] || "0");
      return new Date(ms).toISOString().split("T")[0];
    }
    if (raw.includes("T")) return raw.split("T")[0];
    return raw;
  }

  function matchCashflowLine(
    contactName: string,
    description: string,
    cashflowLines: any[]
  ): { lineId: number | null; confidence: string; method: string } {
    const resolvedName = paymentProcessorAliases[contactName.toUpperCase()] || contactName;

    const isBankTransfer =
      description.toLowerCase().includes("bank transfer") ||
      /transfer (to|from)/i.test(description);
    if (isBankTransfer) {
      const interbankLine = cashflowLines.find(l => l.code === "TR-IB");
      if (interbankLine) return { lineId: interbankLine.id, confidence: "high", method: "bank_transfer_match" };
    }

    const isFxCharge =
      (description === "OTT DEBIT" || description === "FEES AND CHARGES" || description === "MONTHLY CORPORATE ACCOUNT CHARGE") &&
      contactName === "SANTANDER BUSINESS";
    if (isFxCharge) {
      const santFeeLine = cashflowLines.find(l => l.code === "SANT-FEE");
      if (santFeeLine) return { lineId: santFeeLine.id, confidence: "medium", method: "fx_fee_match" };
    }

    const supplierMatch = cashflowLines.find(
      l => l.supplierName && resolvedName && resolvedName.toLowerCase().includes(l.supplierName.toLowerCase())
    );
    if (supplierMatch) return { lineId: supplierMatch.id, confidence: "high", method: "supplier_match" };

    const nameMatch = cashflowLines.find(l => {
      const words = l.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      return words.some((w: string) =>
        resolvedName.toLowerCase().includes(w) ||
        contactName.toLowerCase().includes(w) ||
        description.toLowerCase().includes(w)
      );
    });
    if (nameMatch) return { lineId: nameMatch.id, confidence: "medium", method: "keyword_match" };

    return { lineId: null, confidence: "unmatched", method: "none" };
  }

  for (const ba of activeBankAccounts) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const data = await xeroApiGet(
          `BankTransactions?where=BankAccount.AccountID%3D%3DGuid("${ba.xeroAccountId}")%26%26Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC&page=${page}`
        );

        const transactions = data.BankTransactions || [];
        console.log(`[${ba.name}] page ${page}: ${transactions.length} transactions`);

        if (transactions.length === 0) {
          hasMore = false;
          break;
        }

        for (const tx of transactions) {
          if (tx.Status === "DELETED" || tx.Status === "VOIDED") continue;

          const txId = tx.BankTransactionID;
          if (existingXeroIds.has(txId)) continue;

          const contactName = tx.Contact?.Name || "";
          const description = tx.Reference || tx.LineItems?.[0]?.Description || contactName;
          const isInflow = tx.Type === "RECEIVE" || tx.Type === "RECEIVE-TRANSFER";
          const amount = isInflow ? Math.abs(tx.Total) : -Math.abs(tx.Total);
          const txDate = parseTxDate(String(tx.Date));

          const { lineId, confidence, method } = matchCashflowLine(contactName, description, cashflowLines);

          await storage.createActualTransaction({
            xeroTransactionId: txId,
            xeroSourceType: tx.Type,
            transactionDate: txDate,
            amount: String(amount),
            description,
            supplierOrCounterparty: contactName,
            bankAccountId: ba.id,
            cashflowLineId: lineId,
            mappedConfidence: confidence,
            mappingMethod: method,
            reconciledFlag: tx.IsReconciled || false,
          });

          existingXeroIds.add(txId);
          imported++;
          if (lineId) mapped++;
        }

        hasMore = transactions.length === 100;
        page++;

      } catch (err: any) {
        const msg = `Error importing transactions for ${ba.name} (page ${page}): ${err.message}`;
        console.error(msg);
        errors.push(msg);
        hasMore = false;
      }
    }
  }

  try {
    const usdSupplierCodes = ["OUT-046", "OUT-052", "OUT-036", "OUT-070"];
    const usdSupplierLines = cashflowLines.filter(l => usdSupplierCodes.includes(l.code));
    const usdSupplierIds = usdSupplierLines.map(l => l.id);
    const santFee = cashflowLines.find(l => l.code === "SANT-FEE");

    if (usdSupplierIds.length > 0) {
      const allTxs = await storage.getActualTransactions({});
      const ottTxs = allTxs.filter(t =>
        t.description === "OTT DEBIT" &&
        t.supplierOrCounterparty === "SANTANDER BUSINESS" &&
        (!t.cashflowLineId || t.cashflowLineId === santFee?.id)
      );
      for (const ott of ottTxs) {
        const sameDaySupplier = allTxs.find(t =>
          t.transactionDate === ott.transactionDate &&
          t.id !== ott.id &&
          t.cashflowLineId &&
          usdSupplierIds.includes(t.cashflowLineId)
        );
        if (sameDaySupplier?.cashflowLineId) {
          await storage.updateActualTransaction(ott.id, {
            cashflowLineId: sameDaySupplier.cashflowLineId,
            mappedConfidence: "high",
            mappingMethod: "fx_same_day_match",
          });
        }
      }
    }
  } catch (fxErr: any) {
    console.error("FX remapping error:", fxErr.message);
  }

  await storage.createAuditLog({
    entityType: "xero_sync",
    entityId: null,
    action: "import_transactions",
    newValueJson: { imported, mapped, monthsBack, errors, source: "bank_transactions_only" },
    userName: "system",
  });

  console.log(`Import complete: ${imported} imported, ${mapped} mapped, ${errors.length} errors`);
  return { imported, mapped, errors };
}

export async function fetchXeroInvoices(monthsBack: number = 12): Promise<any[]> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  
  let allInvoices: any[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await xeroApiGet(
      `Invoices?where=Type%3D%3D%22ACCREC%22%26%26Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC&page=${page}`
    );
    const invoices = data.Invoices || [];
    allInvoices = allInvoices.concat(invoices);
    if (invoices.length < 100) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return allInvoices;
}

export async function fetchXeroInvoicesWithPayments(monthsBack: number = 3): Promise<any[]> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);

  let allInvoices: any[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await xeroApiGet(
      `Invoices?where=Type%3D%3D%22ACCREC%22%26%26Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC&page=${page}&includePayments=true`
    );
    const invoices = data.Invoices || [];
    allInvoices = allInvoices.concat(invoices);
    if (invoices.length < 100) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return allInvoices;
}

export async function fetchXeroBankTransactionsForContact(contactName: string): Promise<any> {
  const encoded = encodeURIComponent(`Contact.Name=="${contactName}"`);
  const data = await xeroApiGet(`BankTransactions?where=${encoded}&page=1&order=Date%20DESC`);
  return data;
}

export { getRedirectUri };
