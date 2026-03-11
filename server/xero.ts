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

  const today = new Date().toISOString().split("T")[0];
  let reportData: any;
  try {
    reportData = await xeroApiGet(`Reports/BankSummary`);
    console.log("Bank Summary report response:", JSON.stringify(reportData).substring(0, 2000));
  } catch (e: any) {
    console.error("Bank Summary report failed, trying account-level approach:", e.message);
    for (const account of activeAccounts) {
      try {
        const data = await xeroApiGet(`Accounts/${account.xeroAccountId}`);
        const xeroAccount = data.Accounts?.[0];
        console.log(`Account ${account.name} raw:`, JSON.stringify(xeroAccount).substring(0, 500));
      } catch (e2: any) {
        console.error(`Account fetch failed for ${account.name}: ${e2.message}`);
      }
    }
    throw e;
  }

  const report = reportData.Reports?.[0];
  if (report?.Rows) {
    for (const section of report.Rows) {
      if (section.RowType === "Section" && section.Rows) {
        for (const row of section.Rows) {
          if (row.RowType === "Row" && row.Cells) {
            const accountName = row.Cells[0]?.Value || "";
            const closingBalance = parseFloat(row.Cells[4]?.Value || row.Cells[3]?.Value || "0");
            console.log(`Bank Summary row: "${accountName}" closing=${closingBalance} (cells: ${row.Cells.map((c: any) => c.Value).join(", ")})`);

            const match = activeAccounts.find(a => a.xeroAccountId && accountName.toLowerCase().includes(a.name.split(" ")[0].toLowerCase()));
            if (!match) {
              const matchByXeroName = activeAccounts.find(a => {
                const dbWords = a.name.toLowerCase().split(/\s+/);
                const xeroWords = accountName.toLowerCase().split(/\s+/);
                return dbWords.some(w => w.length > 3 && xeroWords.some(xw => xw.includes(w)));
              });
              if (matchByXeroName) {
                result.push({ name: matchByXeroName.name, balance: closingBalance });
                totalBalance += closingBalance;
                await storage.updateBankAccount(matchByXeroName.id, { currentBalance: closingBalance.toFixed(2) });
                console.log(`Matched "${accountName}" to ${matchByXeroName.name}: £${closingBalance.toFixed(2)}`);
              } else {
                console.log(`No match for Bank Summary row: "${accountName}"`);
              }
            } else {
              result.push({ name: match.name, balance: closingBalance });
              totalBalance += closingBalance;
              await storage.updateBankAccount(match.id, { currentBalance: closingBalance.toFixed(2) });
              console.log(`Matched "${accountName}" to ${match.name}: £${closingBalance.toFixed(2)}`);
            }
          }
        }
      }
    }
  } else {
    console.log("Bank Summary report returned no rows");
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
          const isInflow = tx.Type === "RECEIVE" || tx.Type === "RECEIVE-TRANSFER";
          const amount = isInflow ? Math.abs(tx.Total) : -Math.abs(tx.Total);

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

          const isBankTransfer = tx.Type === "SPEND-TRANSFER" || tx.Type === "RECEIVE-TRANSFER" ||
            (description && description.toLowerCase().includes("bank transfer")) ||
            (tx.Type === "SPEND" && description && /bank transfer to/i.test(description)) ||
            (tx.Type === "RECEIVE" && description && /bank transfer from/i.test(description));

          if (isBankTransfer) {
            const interbankLine = cashflowLines.find(l => l.code === "TR-IB");
            if (interbankLine) {
              matchedLineId = interbankLine.id;
              confidence = "high";
              method = "bank_transfer_match";
            }
          }

          if (!matchedLineId) {
            const isFxCharge = (description === "OTT DEBIT" || description === "FEES AND CHARGES" || description === "MONTHLY CORPORATE ACCOUNT CHARGE") 
              && contactName === "SANTANDER BUSINESS";
            if (isFxCharge) {
              const santFeeLine = cashflowLines.find(l => l.code === "SANT-FEE");
              if (santFeeLine) {
                matchedLineId = santFeeLine.id;
                confidence = "medium";
                method = "fx_fee_match";
              }
            }
          }

          const paymentProcessorAliases: Record<string, string> = {
            "GOCARDLESS": "ARTHUR",
          };

          if (!matchedLineId) {
            const resolvedName = paymentProcessorAliases[contactName.toUpperCase()] || contactName;
            const supplierMatch = cashflowLines.find(
              l => l.supplierName && resolvedName && resolvedName.toLowerCase().includes(l.supplierName.toLowerCase())
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
                    resolvedName.toLowerCase().includes(w) ||
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

  }

  for (const ba of activeBankAccounts) {
    let paymentPage = 1;
    let paymentHasMore = true;
    while (paymentHasMore) {
      try {
        const data = await xeroApiGet(
          `Payments?where=Date>%3DDateTime(${startDate.getFullYear()},${startDate.getMonth() + 1},${startDate.getDate()})&order=Date%20DESC&page=${paymentPage}`
        );
        const payments = data.Payments || [];
        console.log(`Fetched ${payments.length} payments for page ${paymentPage}`);

        if (payments.length === 0) {
          paymentHasMore = false;
          break;
        }

        for (const pmt of payments) {
          if (pmt.Status === "DELETED" || pmt.Status === "VOIDED") continue;
          const pmtId = pmt.PaymentID;
          if (!pmtId) continue;
          if (existingXeroIds.has(pmtId)) continue;

          const pmtAccountId = pmt.Account?.AccountID || "";
          if (pmtAccountId !== ba.xeroAccountId) continue;

          let pmtDate: string;
          if (typeof pmt.Date === "string" && pmt.Date.startsWith("/Date(")) {
            const ms = parseInt(pmt.Date.match(/\d+/)?.[0] || "0");
            pmtDate = new Date(ms).toISOString().split("T")[0];
          } else if (typeof pmt.Date === "string" && pmt.Date.includes("T")) {
            pmtDate = pmt.Date.split("T")[0];
          } else {
            pmtDate = String(pmt.Date);
          }


          const contactName = pmt.Invoice?.Contact?.Name || "";
          const invoiceNumber = pmt.Invoice?.InvoiceNumber || "";
          const description = pmt.Reference || invoiceNumber || "Payment";
          const isInflow = pmt.PaymentType === "ACCRECPAYMENT";
          const amount = isInflow ? Math.abs(pmt.Amount) : -Math.abs(pmt.Amount);

          const existingByDateAndAmount = existingTransactions.find(t => {
            const tDate = typeof t.transactionDate === 'string' ? t.transactionDate : (t.transactionDate as Date)?.toISOString?.()?.split("T")?.[0];
            const tAmt = parseFloat(t.amount as string);
            return tDate === pmtDate && Math.abs(tAmt - amount) < 0.01 && t.bankAccountId === ba.id;
          });
          if (existingByDateAndAmount) continue;

          const paymentProcessorAliases: Record<string, string> = {
            "GOCARDLESS": "ARTHUR",
          };

          let matchedLineId: number | null = null;
          let confidence = "unmatched";
          let method = "none";

          const resolvedName = paymentProcessorAliases[contactName.toUpperCase()] || contactName;
          const supplierMatch = cashflowLines.find(
            l => l.supplierName && resolvedName && resolvedName.toLowerCase().includes(l.supplierName.toLowerCase())
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
                  resolvedName.toLowerCase().includes(w) ||
                  contactName.toLowerCase().includes(w) ||
                  description.toLowerCase().includes(w)
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
            xeroTransactionId: pmtId,
            xeroSourceType: pmt.PaymentType,
            transactionDate: pmtDate,
            amount: String(amount),
            description,
            supplierOrCounterparty: contactName,
            bankAccountId: ba.id,
            cashflowLineId: matchedLineId,
            mappedConfidence: confidence,
            mappingMethod: method,
            reconciledFlag: pmt.IsReconciled || true,
          });

          existingXeroIds.add(pmtId);
          imported++;
          if (matchedLineId) mapped++;
          console.log(`Imported payment: ${pmtDate} ${contactName} ${amount}`);
        }

        if (payments.length < 100) {
          paymentHasMore = false;
        } else {
          paymentPage++;
        }
      } catch (err: any) {
        console.log(`Payments import error: ${err.message}`);
        paymentHasMore = false;
      }
    }
  }

  for (const ba of activeBankAccounts) {
    try {
      const fromDate = startDate.toISOString().split("T")[0];
      const toDate = new Date().toISOString().split("T")[0];
      console.log(`Fetching bank statement lines for ${ba.name} from ${fromDate} to ${toDate}`);
      const statementsData = await xeroFinanceApiGet(
        `BankStatements?bankAccountId=${ba.xeroAccountId}&fromDate=${fromDate}&toDate=${toDate}`
      );
      const statements = statementsData?.statements || [];
      console.log(`Got ${statements.length} statements for ${ba.name}`);
      let stmtImported = 0;
      for (const stmt of statements) {
        const stmtLines = stmt?.statementLines || [];
        console.log(`Statement has ${stmtLines.length} lines`);
        for (const sl of stmtLines) {
          const slId = sl.statementLineId;
          if (!slId) continue;
          if (existingXeroIds.has(slId)) continue;

          const alreadyMatched = existingXeroIds.has(sl.paymentId || "");
          if (alreadyMatched) continue;

          const isCredit = sl.creditAmount && parseFloat(sl.creditAmount) > 0;
          const amount = isCredit
            ? Math.abs(parseFloat(sl.creditAmount || "0"))
            : -Math.abs(parseFloat(sl.debitAmount || "0"));

          if (amount === 0) continue;

          const txDate = sl.postedDate ? sl.postedDate.split("T")[0] : "";
          if (!txDate) continue;

          const description = sl.description || sl.payeeName || "";
          const payeeName = sl.payeeName || "";

          const existingByDateAndAmount = existingTransactions.find(t => {
            const tDate = typeof t.transactionDate === 'string' ? t.transactionDate : (t.transactionDate as Date)?.toISOString?.()?.split("T")?.[0];
            const tAmt = parseFloat(t.amount as string);
            return tDate === txDate && Math.abs(tAmt - amount) < 0.01 && t.bankAccountId === ba.id;
          });
          if (existingByDateAndAmount) continue;

          let matchedLineId: number | null = null;
          let confidence = "unmatched";
          let method = "none";

          const isBankTransfer = description.toLowerCase().includes("bank transfer") ||
            payeeName.toLowerCase().includes("bank transfer");
          if (isBankTransfer) {
            const interbankLine = cashflowLines.find(l => l.code === "TR-IB");
            if (interbankLine) {
              matchedLineId = interbankLine.id;
              confidence = "high";
              method = "bank_transfer_match";
            }
          }

          if (!matchedLineId) {
            const stmtPaymentProcessorAliases: Record<string, string> = {
              "GOCARDLESS": "ARTHUR",
            };
            const resolvedPayee = stmtPaymentProcessorAliases[payeeName.toUpperCase()] || payeeName;
            const supplierMatch = cashflowLines.find(
              l => l.supplierName && resolvedPayee && resolvedPayee.toLowerCase().includes(l.supplierName.toLowerCase())
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
                    resolvedPayee.toLowerCase().includes(w) ||
                    payeeName.toLowerCase().includes(w) ||
                    description.toLowerCase().includes(w)
                  );
                }
              );
              if (nameMatch) {
                matchedLineId = nameMatch.id;
                confidence = "medium";
                method = "keyword_match";
              }
            }
          }

          await storage.createActualTransaction({
            xeroTransactionId: slId,
            xeroSourceType: isCredit ? "STATEMENT_RECEIVE" : "STATEMENT_SPEND",
            transactionDate: txDate,
            amount: String(amount),
            description,
            supplierOrCounterparty: payeeName,
            bankAccountId: ba.id,
            cashflowLineId: matchedLineId,
            mappedConfidence: confidence,
            mappingMethod: method,
            reconciledFlag: false,
          });

          existingXeroIds.add(slId);
          imported++;
          stmtImported++;
          if (matchedLineId) mapped++;
        }
      }
      console.log(`Imported ${stmtImported} new statement lines for ${ba.name}`);
    } catch (err: any) {
      console.log(`Statement lines import for ${ba.name} skipped: ${err.message}`);
    }
  }

  try {
    const usdSupplierCodes = ['OUT-046', 'OUT-052', 'OUT-036', 'OUT-070'];
    const usdSupplierLines = cashflowLines.filter(l => usdSupplierCodes.includes(l.code));
    const usdSupplierIds = usdSupplierLines.map(l => l.id);
    if (usdSupplierIds.length > 0) {
      const santFee = cashflowLines.find(l => l.code === "SANT-FEE");
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
        if (sameDaySupplier && sameDaySupplier.cashflowLineId) {
          await storage.updateActualTransaction(ott.id, { 
            cashflowLineId: sameDaySupplier.cashflowLineId,
            mappedConfidence: "high",
            mappingMethod: "fx_same_day_match"
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

export async function fetchXeroBankTransactionsForContact(contactName: string): Promise<any> {
  const encoded = encodeURIComponent(`Contact.Name=="${contactName}"`);
  const data = await xeroApiGet(`BankTransactions?where=${encoded}&page=1&order=Date%20DESC`);
  return data;
}

export { getRedirectUri };
