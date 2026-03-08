import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  decimal,
  boolean,
  date,
  timestamp,
  jsonb,
  serial,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const bankAccounts = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  xeroAccountId: text("xero_account_id"),
  currentBalance: decimal("current_balance", { precision: 15, scale: 2 }).default("0"),
  active: boolean("active").default(true),
});

export const insertBankAccountSchema = createInsertSchema(bankAccounts).omit({ id: true });
export type InsertBankAccount = z.infer<typeof insertBankAccountSchema>;
export type BankAccount = typeof bankAccounts.$inferSelect;

export const cashflowLines = pgTable("cashflow_lines", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  supplierName: text("supplier_name"),
  bankAccountId: integer("bank_account_id"),
  lineType: text("line_type").notNull().default("recurring_fixed"),
  isRollup: boolean("is_rollup").default(false),
  parentLineId: integer("parent_line_id"),
  direction: text("direction").notNull().default("outflow"),
  dueDay: integer("due_day"),
  active: boolean("active").default(true),
  sortOrder: integer("sort_order").default(0),
});

export const insertCashflowLineSchema = createInsertSchema(cashflowLines).omit({ id: true });
export type InsertCashflowLine = z.infer<typeof insertCashflowLineSchema>;
export type CashflowLine = typeof cashflowLines.$inferSelect;

export const actualTransactions = pgTable("actual_transactions", {
  id: serial("id").primaryKey(),
  xeroTransactionId: text("xero_transaction_id"),
  xeroSourceType: text("xero_source_type"),
  transactionDate: date("transaction_date").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  description: text("description"),
  supplierOrCounterparty: text("supplier_or_counterparty"),
  bankAccountId: integer("bank_account_id").notNull(),
  cashflowLineId: integer("cashflow_line_id"),
  mappedConfidence: text("mapped_confidence").default("manual"),
  mappingMethod: text("mapping_method").default("manual"),
  reconciledFlag: boolean("reconciled_flag").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertActualTransactionSchema = createInsertSchema(actualTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertActualTransaction = z.infer<typeof insertActualTransactionSchema>;
export type ActualTransaction = typeof actualTransactions.$inferSelect;

export const forecastRules = pgTable("forecast_rules", {
  id: serial("id").primaryKey(),
  cashflowLineId: integer("cashflow_line_id").notNull(),
  recurrenceType: text("recurrence_type").notNull().default("monthly"),
  frequency: integer("frequency").default(1),
  baseAmount: decimal("base_amount", { precision: 15, scale: 2 }).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  upliftType: text("uplift_type").default("none"),
  upliftValue: decimal("uplift_value", { precision: 10, scale: 4 }).default("0"),
  upliftFrequency: text("uplift_frequency").default("annual"),
  paymentTimingRule: text("payment_timing_rule"),
  timingFlexibility: text("timing_flexibility").default("fixed"),
  forecastConfidence: text("forecast_confidence").default("high"),
  monthlyVolumes: jsonb("monthly_volumes"),
  active: boolean("active").default(true),
});

export const insertForecastRuleSchema = createInsertSchema(forecastRules).omit({ id: true });
export type InsertForecastRule = z.infer<typeof insertForecastRuleSchema>;
export type ForecastRule = typeof forecastRules.$inferSelect;

export const forecastMonths = pgTable("forecast_months", {
  id: serial("id").primaryKey(),
  cashflowLineId: integer("cashflow_line_id").notNull(),
  forecastMonth: text("forecast_month").notNull(),
  originalForecastAmount: decimal("original_forecast_amount", { precision: 15, scale: 2 }).default("0"),
  currentForecastAmount: decimal("current_forecast_amount", { precision: 15, scale: 2 }).default("0"),
  actualAmount: decimal("actual_amount", { precision: 15, scale: 2 }),
  sourceRuleId: integer("source_rule_id"),
  status: text("status").notNull().default("forecast"),
  lastRebasedAt: timestamp("last_rebased_at"),
});

export const insertForecastMonthSchema = createInsertSchema(forecastMonths).omit({ id: true });
export type InsertForecastMonth = z.infer<typeof insertForecastMonthSchema>;
export type ForecastMonth = typeof forecastMonths.$inferSelect;

export const varianceEvents = pgTable("variance_events", {
  id: serial("id").primaryKey(),
  cashflowLineId: integer("cashflow_line_id").notNull(),
  actualTransactionId: integer("actual_transaction_id"),
  forecastMonthId: integer("forecast_month_id"),
  forecastMonth: text("forecast_month").notNull(),
  forecastAmount: decimal("forecast_amount", { precision: 15, scale: 2 }).default("0"),
  actualAmount: decimal("actual_amount", { precision: 15, scale: 2 }).default("0"),
  varianceAmount: decimal("variance_amount", { precision: 15, scale: 2 }).default("0"),
  varianceType: text("variance_type"),
  suggestedTreatment: text("suggested_treatment"),
  approvedTreatment: text("approved_treatment"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertVarianceEventSchema = createInsertSchema(varianceEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertVarianceEvent = z.infer<typeof insertVarianceEventSchema>;
export type VarianceEvent = typeof varianceEvents.$inferSelect;

export const overrides = pgTable("overrides", {
  id: serial("id").primaryKey(),
  cashflowLineId: integer("cashflow_line_id").notNull(),
  forecastMonth: text("forecast_month").notNull(),
  overrideAmount: decimal("override_amount", { precision: 15, scale: 2 }).notNull(),
  reason: text("reason"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOverrideSchema = createInsertSchema(overrides).omit({
  id: true,
  createdAt: true,
});
export type InsertOverride = z.infer<typeof insertOverrideSchema>;
export type Override = typeof overrides.$inferSelect;

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  action: text("action").notNull(),
  oldValueJson: jsonb("old_value_json"),
  newValueJson: jsonb("new_value_json"),
  userName: text("user_name").default("system"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLog).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLog.$inferSelect;

export const xeroTokens = pgTable("xero_tokens", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tenantName: text("tenant_name"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  scope: text("scope"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertXeroTokenSchema = createInsertSchema(xeroTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertXeroToken = z.infer<typeof insertXeroTokenSchema>;
export type XeroToken = typeof xeroTokens.$inferSelect;
