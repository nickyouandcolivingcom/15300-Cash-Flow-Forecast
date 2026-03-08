import { db } from "./db";
import { eq, and, desc, gte, lte, asc, sql } from "drizzle-orm";
import {
  users, type InsertUser, type User,
  bankAccounts, type InsertBankAccount, type BankAccount,
  cashflowLines, type InsertCashflowLine, type CashflowLine,
  actualTransactions, type InsertActualTransaction, type ActualTransaction,
  forecastRules, type InsertForecastRule, type ForecastRule,
  forecastMonths, type InsertForecastMonth, type ForecastMonth,
  varianceEvents, type InsertVarianceEvent, type VarianceEvent,
  overrides, type InsertOverride, type Override,
  auditLog, type InsertAuditLog, type AuditLog,
  cashBalanceSnapshots, type InsertCashBalanceSnapshot, type CashBalanceSnapshot,
} from "@shared/schema";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(data: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;

  getBankAccounts(): Promise<BankAccount[]>;
  getBankAccount(id: number): Promise<BankAccount | undefined>;
  createBankAccount(data: InsertBankAccount): Promise<BankAccount>;
  updateBankAccount(id: number, data: Partial<InsertBankAccount>): Promise<BankAccount | undefined>;

  getCashflowLines(): Promise<CashflowLine[]>;
  getCashflowLine(id: number): Promise<CashflowLine | undefined>;
  createCashflowLine(data: InsertCashflowLine): Promise<CashflowLine>;
  updateCashflowLine(id: number, data: Partial<InsertCashflowLine>): Promise<CashflowLine | undefined>;
  deleteCashflowLine(id: number): Promise<void>;

  getActualTransactions(filters?: { bankAccountId?: number; startDate?: string; endDate?: string }): Promise<ActualTransaction[]>;
  getActualTransaction(id: number): Promise<ActualTransaction | undefined>;
  createActualTransaction(data: InsertActualTransaction): Promise<ActualTransaction>;
  updateActualTransaction(id: number, data: Partial<InsertActualTransaction>): Promise<ActualTransaction | undefined>;
  getTransactionsByMonth(month: string): Promise<ActualTransaction[]>;

  getForecastRules(cashflowLineId?: number): Promise<ForecastRule[]>;
  getForecastRule(id: number): Promise<ForecastRule | undefined>;
  createForecastRule(data: InsertForecastRule): Promise<ForecastRule>;
  updateForecastRule(id: number, data: Partial<InsertForecastRule>): Promise<ForecastRule | undefined>;
  deleteForecastRule(id: number): Promise<void>;

  getForecastMonths(filters?: { cashflowLineId?: number; startMonth?: string; endMonth?: string }): Promise<ForecastMonth[]>;
  getForecastMonth(id: number): Promise<ForecastMonth | undefined>;
  createForecastMonth(data: InsertForecastMonth): Promise<ForecastMonth>;
  updateForecastMonth(id: number, data: Partial<InsertForecastMonth>): Promise<ForecastMonth | undefined>;
  upsertForecastMonth(data: InsertForecastMonth): Promise<ForecastMonth>;
  deleteForecastMonthsByLine(cashflowLineId: number): Promise<void>;

  getVarianceEvents(filters?: { cashflowLineId?: number; forecastMonth?: string }): Promise<VarianceEvent[]>;
  createVarianceEvent(data: InsertVarianceEvent): Promise<VarianceEvent>;
  updateVarianceEvent(id: number, data: Partial<InsertVarianceEvent>): Promise<VarianceEvent | undefined>;

  getOverrides(filters?: { cashflowLineId?: number; forecastMonth?: string }): Promise<Override[]>;
  createOverride(data: InsertOverride): Promise<Override>;

  getAuditLogs(filters?: { entityType?: string; entityId?: number; limit?: number }): Promise<AuditLog[]>;
  createAuditLog(data: InsertAuditLog): Promise<AuditLog>;

  getLatestSnapshot(beforeDate?: string): Promise<CashBalanceSnapshot | undefined>;
  createSnapshot(data: InsertCashBalanceSnapshot): Promise<CashBalanceSnapshot>;
  getSnapshots(): Promise<CashBalanceSnapshot[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(data: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getBankAccounts(): Promise<BankAccount[]> {
    return db.select().from(bankAccounts).orderBy(asc(bankAccounts.name));
  }

  async getBankAccount(id: number): Promise<BankAccount | undefined> {
    const [result] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
    return result;
  }

  async createBankAccount(data: InsertBankAccount): Promise<BankAccount> {
    const [result] = await db.insert(bankAccounts).values(data).returning();
    return result;
  }

  async updateBankAccount(id: number, data: Partial<InsertBankAccount>): Promise<BankAccount | undefined> {
    const [result] = await db.update(bankAccounts).set(data).where(eq(bankAccounts.id, id)).returning();
    return result;
  }

  async getCashflowLines(): Promise<CashflowLine[]> {
    return db.select().from(cashflowLines).orderBy(asc(cashflowLines.sortOrder), asc(cashflowLines.name));
  }

  async getCashflowLine(id: number): Promise<CashflowLine | undefined> {
    const [result] = await db.select().from(cashflowLines).where(eq(cashflowLines.id, id));
    return result;
  }

  async createCashflowLine(data: InsertCashflowLine): Promise<CashflowLine> {
    const [result] = await db.insert(cashflowLines).values(data).returning();
    return result;
  }

  async updateCashflowLine(id: number, data: Partial<InsertCashflowLine>): Promise<CashflowLine | undefined> {
    const [result] = await db.update(cashflowLines).set(data).where(eq(cashflowLines.id, id)).returning();
    return result;
  }

  async deleteCashflowLine(id: number): Promise<void> {
    await db.delete(cashflowLines).where(eq(cashflowLines.id, id));
  }

  async getActualTransactions(filters?: { bankAccountId?: number; startDate?: string; endDate?: string }): Promise<ActualTransaction[]> {
    let query = db.select().from(actualTransactions);
    const conditions = [];
    if (filters?.bankAccountId) conditions.push(eq(actualTransactions.bankAccountId, filters.bankAccountId));
    if (filters?.startDate) conditions.push(gte(actualTransactions.transactionDate, filters.startDate));
    if (filters?.endDate) conditions.push(lte(actualTransactions.transactionDate, filters.endDate));
    if (conditions.length > 0) {
      return db.select().from(actualTransactions).where(and(...conditions)).orderBy(desc(actualTransactions.transactionDate));
    }
    return db.select().from(actualTransactions).orderBy(desc(actualTransactions.transactionDate));
  }

  async getActualTransaction(id: number): Promise<ActualTransaction | undefined> {
    const [result] = await db.select().from(actualTransactions).where(eq(actualTransactions.id, id));
    return result;
  }

  async createActualTransaction(data: InsertActualTransaction): Promise<ActualTransaction> {
    const [result] = await db.insert(actualTransactions).values(data).returning();
    return result;
  }

  async updateActualTransaction(id: number, data: Partial<InsertActualTransaction>): Promise<ActualTransaction | undefined> {
    const [result] = await db.update(actualTransactions).set({ ...data, updatedAt: new Date() }).where(eq(actualTransactions.id, id)).returning();
    return result;
  }

  async getTransactionsByMonth(month: string): Promise<ActualTransaction[]> {
    const startDate = `${month}-01`;
    const [year, m] = month.split("-").map(Number);
    const nextMonth = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
    const endDate = `${nextMonth}-01`;
    return db.select().from(actualTransactions)
      .where(and(gte(actualTransactions.transactionDate, startDate), lte(actualTransactions.transactionDate, endDate)))
      .orderBy(desc(actualTransactions.transactionDate));
  }

  async getForecastRules(cashflowLineId?: number): Promise<ForecastRule[]> {
    if (cashflowLineId) {
      return db.select().from(forecastRules).where(eq(forecastRules.cashflowLineId, cashflowLineId));
    }
    return db.select().from(forecastRules);
  }

  async getForecastRule(id: number): Promise<ForecastRule | undefined> {
    const [result] = await db.select().from(forecastRules).where(eq(forecastRules.id, id));
    return result;
  }

  async createForecastRule(data: InsertForecastRule): Promise<ForecastRule> {
    const [result] = await db.insert(forecastRules).values(data).returning();
    return result;
  }

  async updateForecastRule(id: number, data: Partial<InsertForecastRule>): Promise<ForecastRule | undefined> {
    const [result] = await db.update(forecastRules).set(data).where(eq(forecastRules.id, id)).returning();
    return result;
  }

  async deleteForecastRule(id: number): Promise<void> {
    await db.delete(forecastRules).where(eq(forecastRules.id, id));
  }

  async getForecastMonths(filters?: { cashflowLineId?: number; startMonth?: string; endMonth?: string }): Promise<ForecastMonth[]> {
    const conditions = [];
    if (filters?.cashflowLineId) conditions.push(eq(forecastMonths.cashflowLineId, filters.cashflowLineId));
    if (filters?.startMonth) conditions.push(gte(forecastMonths.forecastMonth, filters.startMonth));
    if (filters?.endMonth) conditions.push(lte(forecastMonths.forecastMonth, filters.endMonth));
    if (conditions.length > 0) {
      return db.select().from(forecastMonths).where(and(...conditions)).orderBy(asc(forecastMonths.forecastMonth));
    }
    return db.select().from(forecastMonths).orderBy(asc(forecastMonths.forecastMonth));
  }

  async getForecastMonth(id: number): Promise<ForecastMonth | undefined> {
    const [result] = await db.select().from(forecastMonths).where(eq(forecastMonths.id, id));
    return result;
  }

  async createForecastMonth(data: InsertForecastMonth): Promise<ForecastMonth> {
    const [result] = await db.insert(forecastMonths).values(data).returning();
    return result;
  }

  async updateForecastMonth(id: number, data: Partial<InsertForecastMonth>): Promise<ForecastMonth | undefined> {
    const [result] = await db.update(forecastMonths).set(data).where(eq(forecastMonths.id, id)).returning();
    return result;
  }

  async upsertForecastMonth(data: InsertForecastMonth): Promise<ForecastMonth> {
    const existing = await db.select().from(forecastMonths)
      .where(and(
        eq(forecastMonths.cashflowLineId, data.cashflowLineId),
        eq(forecastMonths.forecastMonth, data.forecastMonth)
      ));
    if (existing.length > 0) {
      const updateData: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          updateData[key] = value;
        }
      }
      const [result] = await db.update(forecastMonths)
        .set(updateData)
        .where(eq(forecastMonths.id, existing[0].id))
        .returning();
      return result;
    }
    return this.createForecastMonth(data);
  }

  async deleteForecastMonthsByLine(cashflowLineId: number): Promise<void> {
    await db.delete(forecastMonths).where(eq(forecastMonths.cashflowLineId, cashflowLineId));
  }

  async getVarianceEvents(filters?: { cashflowLineId?: number; forecastMonth?: string }): Promise<VarianceEvent[]> {
    const conditions = [];
    if (filters?.cashflowLineId) conditions.push(eq(varianceEvents.cashflowLineId, filters.cashflowLineId));
    if (filters?.forecastMonth) conditions.push(eq(varianceEvents.forecastMonth, filters.forecastMonth));
    if (conditions.length > 0) {
      return db.select().from(varianceEvents).where(and(...conditions)).orderBy(desc(varianceEvents.createdAt));
    }
    return db.select().from(varianceEvents).orderBy(desc(varianceEvents.createdAt));
  }

  async createVarianceEvent(data: InsertVarianceEvent): Promise<VarianceEvent> {
    const [result] = await db.insert(varianceEvents).values(data).returning();
    return result;
  }

  async updateVarianceEvent(id: number, data: Partial<InsertVarianceEvent>): Promise<VarianceEvent | undefined> {
    const [result] = await db.update(varianceEvents).set(data).where(eq(varianceEvents.id, id)).returning();
    return result;
  }

  async getOverrides(filters?: { cashflowLineId?: number; forecastMonth?: string }): Promise<Override[]> {
    const conditions = [];
    if (filters?.cashflowLineId) conditions.push(eq(overrides.cashflowLineId, filters.cashflowLineId));
    if (filters?.forecastMonth) conditions.push(eq(overrides.forecastMonth, filters.forecastMonth));
    if (conditions.length > 0) {
      return db.select().from(overrides).where(and(...conditions)).orderBy(desc(overrides.createdAt));
    }
    return db.select().from(overrides).orderBy(desc(overrides.createdAt));
  }

  async createOverride(data: InsertOverride): Promise<Override> {
    const [result] = await db.insert(overrides).values(data).returning();
    return result;
  }

  async getAuditLogs(filters?: { entityType?: string; entityId?: number; limit?: number }): Promise<AuditLog[]> {
    const conditions = [];
    if (filters?.entityType) conditions.push(eq(auditLog.entityType, filters.entityType));
    if (filters?.entityId) conditions.push(eq(auditLog.entityId, filters.entityId));
    const limit = filters?.limit || 100;
    if (conditions.length > 0) {
      return db.select().from(auditLog).where(and(...conditions)).orderBy(desc(auditLog.createdAt)).limit(limit);
    }
    return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  }

  async createAuditLog(data: InsertAuditLog): Promise<AuditLog> {
    const [result] = await db.insert(auditLog).values(data).returning();
    return result;
  }

  async getLatestSnapshot(beforeDate?: string): Promise<CashBalanceSnapshot | undefined> {
    const conditions = [eq(cashBalanceSnapshots.source, "opening")];
    if (beforeDate) conditions.push(lte(cashBalanceSnapshots.snapshotDate, beforeDate));
    const [result] = await db.select().from(cashBalanceSnapshots)
      .where(and(...conditions))
      .orderBy(desc(cashBalanceSnapshots.snapshotDate))
      .limit(1);
    return result;
  }

  async createSnapshot(data: InsertCashBalanceSnapshot): Promise<CashBalanceSnapshot> {
    const [result] = await db.insert(cashBalanceSnapshots).values(data).returning();
    return result;
  }

  async getSnapshots(): Promise<CashBalanceSnapshot[]> {
    return db.select().from(cashBalanceSnapshots).orderBy(desc(cashBalanceSnapshots.snapshotDate));
  }
}

export const storage = new DatabaseStorage();
