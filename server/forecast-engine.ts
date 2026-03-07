import { storage } from "./storage";
import type { ForecastRule, CashflowLine, ForecastMonth, InsertForecastMonth } from "@shared/schema";

function getMonthsBetween(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  const [startYear, startM] = startMonth.split("-").map(Number);
  const [endYear, endM] = endMonth.split("-").map(Number);
  let y = startYear, m = startM;
  while (y < endYear || (y === endYear && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getNext12Months(fromMonth: string): string[] {
  const [year, month] = fromMonth.split("-").map(Number);
  const months: string[] = [];
  let y = year, m = month;
  for (let i = 0; i < 13; i++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function shouldApplyRecurrence(
  rule: ForecastRule,
  month: string,
  startMonth: string
): boolean {
  const [ruleStartYear, ruleStartMonth] = (rule.startDate as string).substring(0, 7).split("-").map(Number);
  const [targetYear, targetMonth] = month.split("-").map(Number);
  const [startY, startM] = startMonth.split("-").map(Number);

  const ruleStartTotal = ruleStartYear * 12 + ruleStartMonth;
  const targetTotal = targetYear * 12 + targetMonth;

  if (targetTotal < ruleStartTotal) return false;

  if (rule.endDate) {
    const endMonth = (rule.endDate as string).substring(0, 7);
    const [endY, endM] = endMonth.split("-").map(Number);
    const endTotal = endY * 12 + endM;
    if (targetTotal > endTotal) return false;
  }

  const monthsDiff = targetTotal - ruleStartTotal;

  switch (rule.recurrenceType) {
    case "monthly":
      return true;
    case "quarterly":
      return monthsDiff % 3 === 0;
    case "semi_annual":
      return monthsDiff % 6 === 0;
    case "annual":
      return monthsDiff % 12 === 0;
    case "one_off":
      return monthsDiff === 0;
    default:
      return true;
  }
}

function calculateUplift(
  rule: ForecastRule,
  month: string
): number {
  const baseAmount = parseFloat(rule.baseAmount as string) || 0;
  if (rule.upliftType === "none" || !rule.upliftValue) return baseAmount;

  const upliftVal = parseFloat(rule.upliftValue as string) || 0;
  const [ruleStartYear] = (rule.startDate as string).substring(0, 7).split("-").map(Number);
  const [targetYear] = month.split("-").map(Number);
  const yearsDiff = targetYear - ruleStartYear;

  if (yearsDiff <= 0) return baseAmount;

  const periods = rule.upliftFrequency === "annual" ? yearsDiff : Math.floor(yearsDiff / 2);

  if (rule.upliftType === "percentage") {
    return baseAmount * Math.pow(1 + upliftVal / 100, periods);
  } else if (rule.upliftType === "fixed") {
    return baseAmount + (upliftVal * periods);
  }

  return baseAmount;
}

export async function generateForecasts(): Promise<void> {
  const currentMonth = getCurrentMonth();
  const forecastPeriod = getNext12Months(currentMonth);
  const lines = await storage.getCashflowLines();
  const allRules = await storage.getForecastRules();
  const allOverrides = await storage.getOverrides();

  for (const line of lines) {
    if (!line.active || line.isRollup) continue;

    const lineRules = allRules.filter(r => r.cashflowLineId === line.id && r.active);
    const lineOverrides = allOverrides.filter(o => o.cashflowLineId === line.id);

    for (const month of forecastPeriod) {
      const override = lineOverrides.find(o => o.forecastMonth === month);
      if (override) {
        await storage.upsertForecastMonth({
          cashflowLineId: line.id,
          forecastMonth: month,
          originalForecastAmount: override.overrideAmount,
          currentForecastAmount: override.overrideAmount,
          sourceRuleId: null,
          status: month === currentMonth ? "actual" : "override",
        });
        continue;
      }

      let totalAmount = 0;
      let appliedRuleId: number | null = null;

      for (const rule of lineRules) {
        if (shouldApplyRecurrence(rule, month, currentMonth)) {
          const amount = calculateUplift(rule, month);
          totalAmount += amount;
          appliedRuleId = rule.id;
        }
      }

      const amountStr = totalAmount.toFixed(2);
      await storage.upsertForecastMonth({
        cashflowLineId: line.id,
        forecastMonth: month,
        originalForecastAmount: amountStr,
        currentForecastAmount: amountStr,
        sourceRuleId: appliedRuleId,
        status: month === currentMonth ? "actual" : "forecast",
      });
    }
  }
}

export async function applyVarianceTreatment(
  varianceId: number,
  treatment: "timing" | "permanent" | "one_off",
  approvedBy: string = "user"
): Promise<void> {
  const variance = (await storage.getVarianceEvents({ cashflowLineId: undefined }))[0];
  const variances = await storage.getVarianceEvents();
  const target = variances.find(v => v.id === varianceId);
  if (!target) return;

  await storage.updateVarianceEvent(varianceId, {
    approvedTreatment: treatment,
    approvedBy,
    approvedAt: new Date(),
  });

  if (treatment === "permanent") {
    const rules = await storage.getForecastRules(target.cashflowLineId);
    const activeRule = rules.find(r => r.active);
    if (activeRule) {
      const newBase = parseFloat(target.actualAmount as string) || 0;
      await storage.updateForecastRule(activeRule.id, {
        baseAmount: newBase.toFixed(2),
      });

      await storage.createAuditLog({
        entityType: "forecast_rule",
        entityId: activeRule.id,
        action: "rebase_permanent",
        oldValueJson: { baseAmount: activeRule.baseAmount },
        newValueJson: { baseAmount: newBase.toFixed(2) },
        userName: approvedBy,
      });
    }

    await generateForecasts();
  }

  await storage.createAuditLog({
    entityType: "variance_event",
    entityId: varianceId,
    action: `treatment_${treatment}`,
    oldValueJson: { suggestedTreatment: target.suggestedTreatment },
    newValueJson: { approvedTreatment: treatment },
    userName: approvedBy,
  });
}

export async function detectVariances(month: string): Promise<void> {
  const lines = await storage.getCashflowLines();
  const forecasts = await storage.getForecastMonths({ startMonth: month, endMonth: month });
  const transactions = await storage.getTransactionsByMonth(month);

  for (const line of lines) {
    if (!line.active || line.isRollup) continue;

    const forecast = forecasts.find(f => f.cashflowLineId === line.id);
    const lineTransactions = transactions.filter(t => t.cashflowLineId === line.id);
    const actualTotal = lineTransactions.reduce((sum, t) => sum + (parseFloat(t.amount as string) || 0), 0);

    if (!forecast && actualTotal === 0) continue;

    const forecastAmount = forecast ? parseFloat(forecast.currentForecastAmount as string) || 0 : 0;
    const varianceAmount = actualTotal - forecastAmount;

    if (Math.abs(varianceAmount) > 0.01) {
      let suggestedTreatment = "one_off";
      const variancePct = forecastAmount !== 0 ? Math.abs(varianceAmount / forecastAmount) : 1;

      if (variancePct <= 0.05) {
        suggestedTreatment = "timing";
      } else if (variancePct > 0.05 && variancePct <= 0.30) {
        suggestedTreatment = "permanent";
      }

      await storage.createVarianceEvent({
        cashflowLineId: line.id,
        forecastMonthId: forecast?.id,
        forecastMonth: month,
        forecastAmount: forecastAmount.toFixed(2),
        actualAmount: actualTotal.toFixed(2),
        varianceAmount: varianceAmount.toFixed(2),
        varianceType: suggestedTreatment,
        suggestedTreatment,
      });
    }

    if (forecast) {
      await storage.updateForecastMonth(forecast.id, {
        actualAmount: actualTotal.toFixed(2),
        status: "actual",
      });
    }
  }
}

export { getCurrentMonth, getNext12Months };
