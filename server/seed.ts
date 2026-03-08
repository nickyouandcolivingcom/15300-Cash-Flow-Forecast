import { db } from "./db";
import { bankAccounts, cashflowLines, forecastRules, forecastMonths, actualTransactions, varianceEvents, overrides, cashBalanceSnapshots } from "@shared/schema";
import { eq } from "drizzle-orm";

export async function seedDatabase() {
  const accounts = await db.select().from(bankAccounts);
  const hasDummyData = accounts.some(a => a.name.includes("Barclays") || a.name.includes("HSBC"));
  if (hasDummyData) {
    console.log("Detected dummy seed data, clearing...");
    await db.delete(forecastMonths);
    await db.delete(varianceEvents);
    await db.delete(overrides);
    await db.delete(actualTransactions);
    await db.delete(forecastRules);
    await db.delete(cashflowLines);
    await db.delete(cashBalanceSnapshots);
    await db.delete(bankAccounts);
    console.log("Dummy data cleared. Connect to Xero to import real data.");
  }
}
