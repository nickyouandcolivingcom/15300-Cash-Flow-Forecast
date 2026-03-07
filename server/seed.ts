import { storage } from "./storage";
import { db } from "./db";
import { bankAccounts, cashflowLines, forecastRules, actualTransactions, forecastMonths } from "@shared/schema";
import { generateForecasts, getCurrentMonth } from "./forecast-engine";

export async function seedDatabase() {
  const existingAccounts = await storage.getBankAccounts();
  if (existingAccounts.length > 0) {
    console.log("Database already seeded, skipping...");
    return;
  }

  console.log("Seeding database...");

  const account1 = await storage.createBankAccount({
    name: "Operating Account - Barclays",
    xeroAccountId: "acc-001",
    currentBalance: "142850.00",
    active: true,
  });

  const account2 = await storage.createBankAccount({
    name: "Reserve Account - HSBC",
    xeroAccountId: "acc-002",
    currentBalance: "85200.00",
    active: true,
  });

  const currentMonth = getCurrentMonth();
  const [currentYear, currentM] = currentMonth.split("-").map(Number);
  const startDate = `${currentYear}-${String(currentM).padStart(2, "0")}-01`;

  const lines = [
    { code: "REV-001", name: "Client Revenue - Contracts", category: "Revenue", direction: "inflow", lineType: "recurring_fixed", sortOrder: 1, amount: 45000 },
    { code: "REV-002", name: "Client Revenue - Ad Hoc", category: "Revenue", direction: "inflow", lineType: "semi_variable", sortOrder: 2, amount: 12000 },
    { code: "REV-003", name: "Interest Income", category: "Revenue", direction: "inflow", lineType: "recurring_fixed", sortOrder: 3, amount: 350 },

    { code: "PAY-001", name: "Staff Payroll", category: "People Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 10, amount: 28500 },
    { code: "PAY-002", name: "Employer NI & Pension", category: "People Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 11, amount: 5700 },
    { code: "PAY-003", name: "Contractor Payments", category: "People Costs", direction: "outflow", lineType: "semi_variable", sortOrder: 12, amount: 8200 },

    { code: "OCC-001", name: "Office Rent", category: "Occupancy", direction: "outflow", lineType: "recurring_fixed", sortOrder: 20, amount: 4500, upliftType: "percentage", upliftValue: 3 },
    { code: "OCC-002", name: "Utilities", category: "Occupancy", direction: "outflow", lineType: "recurring_fixed", sortOrder: 21, amount: 650 },
    { code: "OCC-003", name: "Building Insurance", category: "Occupancy", direction: "outflow", lineType: "recurring_fixed", sortOrder: 22, amount: 420, recurrence: "quarterly" },

    { code: "OPS-001", name: "Software Subscriptions", category: "Operating Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 30, amount: 3200 },
    { code: "OPS-002", name: "IT Infrastructure", category: "Operating Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 31, amount: 1800 },
    { code: "OPS-003", name: "Professional Indemnity Insurance", category: "Operating Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 32, amount: 2100, recurrence: "annual" },
    { code: "OPS-004", name: "Telephone & Internet", category: "Operating Costs", direction: "outflow", lineType: "recurring_fixed", sortOrder: 33, amount: 480 },

    { code: "CMP-001", name: "Accounting & Audit Fees", category: "Compliance", direction: "outflow", lineType: "recurring_fixed", sortOrder: 40, amount: 1500, recurrence: "quarterly" },
    { code: "CMP-002", name: "Legal Fees", category: "Compliance", direction: "outflow", lineType: "semi_variable", sortOrder: 41, amount: 800 },
    { code: "CMP-003", name: "FCA Regulatory Fees", category: "Compliance", direction: "outflow", lineType: "recurring_fixed", sortOrder: 42, amount: 3500, recurrence: "annual" },

    { code: "TAX-001", name: "Corporation Tax", category: "Tax", direction: "outflow", lineType: "recurring_fixed", sortOrder: 50, amount: 4200, recurrence: "quarterly" },
    { code: "TAX-002", name: "VAT Payments", category: "Tax", direction: "outflow", lineType: "recurring_fixed", sortOrder: 51, amount: 8500, recurrence: "quarterly" },

    { code: "CAP-001", name: "Equipment Purchases", category: "Capital", direction: "outflow", lineType: "one_off", sortOrder: 60, amount: 0 },
    { code: "FIN-001", name: "Loan Repayments", category: "Financing", direction: "outflow", lineType: "recurring_fixed", sortOrder: 70, amount: 2500 },
  ];

  for (const lineData of lines) {
    const line = await storage.createCashflowLine({
      code: lineData.code,
      name: lineData.name,
      category: lineData.category,
      direction: lineData.direction,
      lineType: lineData.lineType,
      sortOrder: lineData.sortOrder,
      bankAccountId: lineData.category === "Revenue" ? account1.id : (lineData.sortOrder > 50 ? account2.id : account1.id),
      active: true,
      isRollup: false,
    });

    if (lineData.amount > 0) {
      await storage.createForecastRule({
        cashflowLineId: line.id,
        recurrenceType: (lineData as any).recurrence || "monthly",
        frequency: 1,
        baseAmount: lineData.amount.toFixed(2),
        startDate: startDate,
        upliftType: (lineData as any).upliftType || "none",
        upliftValue: (lineData as any).upliftValue ? String((lineData as any).upliftValue) : "0",
        upliftFrequency: "annual",
        forecastConfidence: lineData.lineType === "semi_variable" ? "medium" : "high",
        active: true,
      });
    }

    const prevMonth1 = currentM === 1 ? `${currentYear - 1}-12` : `${currentYear}-${String(currentM - 1).padStart(2, "0")}`;
    if (lineData.amount > 0 && lineData.lineType !== "one_off" && ((lineData as any).recurrence || "monthly") === "monthly") {
      const variance = (Math.random() - 0.5) * lineData.amount * 0.08;
      const actualAmt = lineData.amount + variance;
      await storage.createActualTransaction({
        transactionDate: `${prevMonth1}-15`,
        amount: (lineData.direction === "outflow" ? actualAmt : actualAmt).toFixed(2),
        description: `${lineData.name} - ${prevMonth1}`,
        supplierOrCounterparty: lineData.name.split(" ")[0],
        bankAccountId: lineData.category === "Revenue" ? account1.id : account1.id,
        cashflowLineId: line.id,
        mappedConfidence: "high",
        mappingMethod: "manual",
        reconciledFlag: true,
      });
    }
  }

  await generateForecasts();
  console.log("Database seeded successfully!");
}
