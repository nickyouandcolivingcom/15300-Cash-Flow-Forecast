import { XeroClient } from "xero-node";
import { db } from "./db";
import { xeroTokens } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { storage } from "./storage";
import crypto from "crypto";

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID!;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET!;

const oauthStates = new Map<string, number>();

function cleanExpiredStates() {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [key, timestamp] of oauthStates) {
    if (timestamp < fiveMinutesAgo) oauthStates.delete(key);
  }
}

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
  "accounting.transactions.read",
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
  oauthStates.set(state, Date.now());
  const scopeStr = SCOPES.join(" ");
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopeStr)}&state=${state}`;
  return { url, state };
}

export function validateOAuthState(state: string): boolean {
  if (!state) return false;
  if (oauthStates.has(state)) {
    oauthStates.delete(state);
    return true;
  }
  console.log("OAuth state not found in memory (server may have restarted), allowing callback");
  return true;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  tenantId: string;
  tenantName: string;
}> {
  const redirectUri = getRedirectUri();

  const tokenResponse = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
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

export async function importBankAccounts(): Promise<{ imported: number; errors: string[] }> {
  const data = await xeroApiGet("Accounts?where=Type%3D%3D%22BANK%22");
  const accounts = data.Accounts || [];
  const existingAccounts = await storage.getBankAccounts();
  const errors: string[] = [];

  let imported = 0;
  for (const acc of accounts) {
    const match = existingAccounts.find(e => e.xeroAccountId === acc.AccountID);

    if (match) {
      await storage.updateBankAccount(match.id, {
        name: acc.Name,
      });
    } else {
      await storage.createBankAccount({
        name: acc.Name,
        xeroAccountId: acc.AccountID,
        currentBalance: "0",
        active: true,
      });
    }
    imported++;
  }

  const bankAccounts = await storage.getBankAccounts();
  try {
    const balData = await xeroApiGet("Reports/BankSummary");
    if (balData?.Reports?.[0]?.Rows) {
      for (const row of balData.Reports[0].Rows) {
        if (row.RowType === "Section" && row.Rows) {
          for (const subRow of row.Rows) {
            const accountId = subRow.Cells?.[0]?.Attributes?.[0]?.Value;
            if (!accountId) continue;
            const ba = bankAccounts.find(b => b.xeroAccountId === accountId);
            if (!ba) continue;
            const balance = subRow.Cells?.[subRow.Cells.length - 1]?.Value;
            if (balance && !isNaN(parseFloat(balance))) {
              await storage.updateBankAccount(ba.id, {
                currentBalance: String(parseFloat(balance)),
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    errors.push(`Balance fetch failed: ${err.message}`);
  }

  await storage.createAuditLog({
    entityType: "xero_sync",
    entityId: null,
    action: "import_bank_accounts",
    newValueJson: { imported, errors },
    userName: "system",
  });

  return { imported, errors };
}

export async function importBankTransactions(monthsBack: number = 3): Promise<{ imported: number; mapped: number; errors: string[] }> {
  const bankAccounts = await storage.getBankAccounts();
  const cashflowLines = await storage.getCashflowLines();
  const existingTransactions = await storage.getActualTransactions({});
  const existingXeroIds = new Set(existingTransactions.map(t => t.xeroTransactionId).filter(Boolean));

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const errors: string[] = [];

  let imported = 0;
  let mapped = 0;

  for (const ba of bankAccounts) {
    if (!ba.xeroAccountId) continue;

    try {
      const data = await xeroApiGet(
        `BankTransactions?where=BankAccount.AccountID%3D%3DGuid("${ba.xeroAccountId}")%26%26Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC`
      );

      const transactions = data.BankTransactions || [];

      for (const tx of transactions) {
        if (tx.Status === "DELETED") continue;
        if (existingXeroIds.has(tx.BankTransactionID)) continue;

        const contactName = tx.Contact?.Name || "";
        const description = tx.Reference || tx.LineItems?.[0]?.Description || contactName;
        const amount = tx.Type === "RECEIVE" ? Math.abs(tx.Total) : -Math.abs(tx.Total);

        let matchedLineId: number | null = null;
        let confidence = "unmatched";
        let method = "none";

        const supplierMatch = cashflowLines.find(
          l => l.supplierName && contactName.toLowerCase().includes(l.supplierName.toLowerCase())
        );
        if (supplierMatch) {
          matchedLineId = supplierMatch.id;
          confidence = "high";
          method = "supplier_match";
        } else {
          const nameMatch = cashflowLines.find(
            l => contactName.toLowerCase().includes(l.name.toLowerCase().split(" ")[0]) ||
                 (description && l.name.toLowerCase().split(" ").some((w: string) => w.length > 3 && description.toLowerCase().includes(w)))
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
          transactionDate: tx.Date.split("T")[0],
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
    } catch (err: any) {
      const msg = `Error importing transactions for ${ba.name}: ${err.message}`;
      console.error(msg);
      errors.push(msg);
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

export { getRedirectUri };
