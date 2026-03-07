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
  "accounting.settings.read",
  "accounting.contacts.read",
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
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  oauthStates.set(state, { timestamp: Date.now(), codeVerifier });
  lastCodeVerifier = codeVerifier;
  const scopeStr = SCOPES.join(" ");
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopeStr)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
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
  if (codeVerifier) {
    bodyParams.code_verifier = codeVerifier;
  }

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

async function xeroApiGet(path: string): Promise<any> {
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

export async function isXeroConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const auth = await getValidToken();
  if (!auth) return { connected: false };

  const [token] = await db.select().from(xeroTokens).orderBy(desc(xeroTokens.updatedAt)).limit(1);
  return { connected: true, tenantName: token?.tenantName || undefined };
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
  const existingXeroIds = new Set(existingTransactions.map(t => t.xeroTransactionId).filter(Boolean));

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const errors: string[] = [];

  let imported = 0;
  let mapped = 0;

  for (const ba of activeBankAccounts) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const data = await xeroApiGet(
          `BankTransactions?where=BankAccount.AccountID%3D%3DGuid("${ba.xeroAccountId}")%26%26Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC&page=${page}`
        );

        const transactions = data.BankTransactions || [];
        console.log(`Fetched ${transactions.length} transactions for ${ba.name} (page ${page})`);

        if (transactions.length === 0) {
          hasMore = false;
          break;
        }

        for (const tx of transactions) {
          if (tx.Status === "DELETED" || tx.Status === "VOIDED") continue;
          if (existingXeroIds.has(tx.BankTransactionID)) continue;

          const contactName = tx.Contact?.Name || "";
          const description = tx.Reference || tx.LineItems?.[0]?.Description || contactName;
          const amount = tx.Type === "RECEIVE" ? Math.abs(tx.Total) : -Math.abs(tx.Total);

          let txDate: string;
          if (typeof tx.Date === "string" && tx.Date.startsWith("/Date(")) {
            const ms = parseInt(tx.Date.match(/\d+/)?.[0] || "0");
            txDate = new Date(ms).toISOString().split("T")[0];
          } else if (typeof tx.Date === "string" && tx.Date.includes("T")) {
            txDate = tx.Date.split("T")[0];
          } else {
            txDate = String(tx.Date);
          }

          let matchedLineId: number | null = null;
          let confidence = "unmatched";
          let method = "none";

          const supplierMatch = cashflowLines.find(
            l => l.supplierName && contactName && contactName.toLowerCase().includes(l.supplierName.toLowerCase())
          );
          if (supplierMatch) {
            matchedLineId = supplierMatch.id;
            confidence = "high";
            method = "supplier_match";
          } else {
            const nameMatch = cashflowLines.find(
              l => {
                const words = l.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
                return words.some((w: string) =>
                  contactName.toLowerCase().includes(w) ||
                  (description && description.toLowerCase().includes(w))
                );
              }
            );
            if (nameMatch) {
              matchedLineId = nameMatch.id;
              confidence = "medium";
              method = "keyword_match";
            }
          }

          await storage.createActualTransaction({
            xeroTransactionId: tx.BankTransactionID,
            xeroSourceType: tx.Type,
            transactionDate: txDate,
            amount: String(amount),
            description,
            supplierOrCounterparty: contactName,
            bankAccountId: ba.id,
            cashflowLineId: matchedLineId,
            mappedConfidence: confidence,
            mappingMethod: method,
            reconciledFlag: tx.IsReconciled || false,
          });

          existingXeroIds.add(tx.BankTransactionID);
          imported++;
          if (matchedLineId) mapped++;
        }

        if (transactions.length < 100) {
          hasMore = false;
        } else {
          page++;
        }
      } catch (err: any) {
        const msg = `Error importing transactions for ${ba.name} (page ${page}): ${err.message}`;
        console.error(msg);
        errors.push(msg);
        hasMore = false;
      }
    }

    try {
      const allTx = await storage.getActualTransactions({ bankAccountId: ba.id });
      if (allTx.length > 0) {
        const totalBalance = allTx.reduce((sum, t) => sum + parseFloat(t.amount), 0);
        await storage.updateBankAccount(ba.id, {
          currentBalance: String(Math.round(totalBalance * 100) / 100),
        });
        console.log(`Updated ${ba.name} balance from transactions: ${totalBalance.toFixed(2)}`);
      }
    } catch (err: any) {
      errors.push(`Balance calculation failed for ${ba.name}: ${err.message}`);
    }
  }

  await storage.createAuditLog({
    entityType: "xero_sync",
    entityId: null,
    action: "import_transactions",
    newValueJson: { imported, mapped, monthsBack, errors },
    userName: "system",
  });

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

export { getRedirectUri };
