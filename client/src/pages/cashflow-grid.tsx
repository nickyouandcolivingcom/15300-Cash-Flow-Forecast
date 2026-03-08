import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatMonth } from "@/lib/format";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface GridLine {
  line: {
    id: number;
    code: string;
    name: string;
    category: string;
    subcategory: string | null;
    direction: string;
    lineType: string;
    isRollup: boolean;
    dueDay: number | null;
  };
  monthData: Record<string, {
    amount: number;
    status: string;
    hasOverride: boolean;
    hasVariance: boolean;
    originalForecast: number;
    actualAmount: number | null;
    varianceAmount: number | null;
    varianceTreatment: string | null;
  }>;
  recurrenceType: string | null;
  ruleId: number | null;
  ruleBaseAmount: number | null;
}

interface GridData {
  months: string[];
  currentMonth: string;
  grid: GridLine[];
  categories: string[];
  categoryTotals: Record<string, Record<string, number>>;
  inflowTotals: Record<string, number>;
  outflowTotals: Record<string, number>;
  netTotals: Record<string, number>;
  openingCash: Record<string, number>;
  closingCash: Record<string, number>;
  totalBalance: number;
  bankAccounts: { id: number; name: string; currentBalance: string }[];
}

interface EditTarget {
  line: GridLine;
  month: string;
  currentAmount: number;
}

function CellValue({ value, status, hasOverride, hasVariance, isNegative, onClick }: {
  value: number;
  status: string;
  hasOverride: boolean;
  hasVariance: boolean;
  isNegative?: boolean;
  onClick?: () => void;
}) {
  let className = "text-right text-xs tabular-nums whitespace-nowrap px-2 py-2 ";

  if (status === "actual") {
    className += "font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100 ";
  } else if (hasOverride) {
    className += "font-semibold bg-amber-100 dark:bg-amber-900/40 ";
  } else if (hasVariance) {
    className += "font-semibold bg-orange-100 dark:bg-orange-900/40 ";
  } else {
    className += "text-muted-foreground ";
  }

  if (status !== "actual" && (isNegative || value < 0)) {
    className += "text-red-600 dark:text-red-400 ";
  }

  if (onClick && status !== "actual") {
    className += "cursor-pointer hover:ring-2 hover:ring-primary/50 hover:ring-inset ";
  }

  return (
    <td className={className} data-testid={`cell-${status}`} onClick={onClick && status !== "actual" ? onClick : undefined}>
      {formatCurrency(value)}
    </td>
  );
}

function TotalRow({ label, values, months, bold, highlight }: {
  label: string;
  values: Record<string, number>;
  months: string[];
  bold?: boolean;
  highlight?: "positive" | "neutral";
  showSign?: boolean;
}) {
  return (
    <tr className={`${bold ? "font-bold" : "font-semibold"} ${highlight === "positive" ? "bg-primary/5" : "bg-muted/30"} border-t`}>
      <td className={`sticky left-0 z-10 px-4 py-2 text-xs ${bold ? "bg-primary/5" : "bg-muted/30"}`}>
        {label}
      </td>
      <td className={`text-center text-xs px-1 py-2 ${bold ? "bg-primary/5" : "bg-muted/30"}`}></td>
      {months.map(month => (
        <td key={month} className={`text-right text-xs tabular-nums whitespace-nowrap px-2 py-2 ${(values[month] || 0) < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
          {formatCurrency(values[month] || 0)}
        </td>
      ))}
    </tr>
  );
}

function EditCellDialog({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const { toast } = useToast();
  const [newAmount, setNewAmount] = useState(Math.abs(target.currentAmount).toFixed(2));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const isOutflow = target.line.line.direction === "outflow";
  const hasRule = target.line.ruleId !== null;
  const currentRuleAmount = target.line.ruleBaseAmount;

  const handleUpdateRule = async () => {
    if (!target.line.ruleId) return;
    setSaving(true);
    try {
      const amount = isOutflow ? -Math.abs(parseFloat(newAmount)) : Math.abs(parseFloat(newAmount));
      await apiRequest("PATCH", `/api/forecast-rules/${target.line.ruleId}`, {
        baseAmount: amount.toFixed(2),
      });
      await apiRequest("POST", "/api/forecast/generate");
      await queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Rule updated", description: `${target.line.line.name} updated to ${formatCurrency(amount)} for all future months.` });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to update rule.", variant: "destructive" });
    }
    setSaving(false);
  };

  const handleOverrideMonth = async () => {
    setSaving(true);
    try {
      const amount = isOutflow ? -Math.abs(parseFloat(newAmount)) : Math.abs(parseFloat(newAmount));
      await apiRequest("POST", "/api/overrides", {
        cashflowLineId: target.line.line.id,
        forecastMonth: target.month,
        overrideAmount: amount.toFixed(2),
        reason: reason || `Manual override for ${formatMonth(target.month)}`,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Month overridden", description: `${target.line.line.name} overridden to ${formatCurrency(amount)} for ${formatMonth(target.month)} only.` });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to create override.", variant: "destructive" });
    }
    setSaving(false);
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="text-edit-dialog-title">{target.line.line.name}</DialogTitle>
          <DialogDescription>
            Edit forecast for {formatMonth(target.month)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current forecast</span>
            <span className="font-mono font-semibold" data-testid="text-current-forecast">{formatCurrency(target.currentAmount)}</span>
          </div>

          {hasRule && currentRuleAmount !== null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Rule amount</span>
              <span className="font-mono" data-testid="text-rule-amount">{formatCurrency(currentRuleAmount)}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="new-amount">New amount ({isOutflow ? "enter as positive, stored as negative" : "positive value"})</Label>
            <div className="flex items-center gap-2">
              {isOutflow && <span className="text-muted-foreground text-sm">-</span>}
              <span className="text-muted-foreground text-sm">£</span>
              <Input
                id="new-amount"
                type="number"
                step="0.01"
                min="0"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className="font-mono"
                data-testid="input-new-amount"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Price increase from April"
              className="h-16"
              data-testid="input-reason"
            />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {hasRule && (
            <Button
              onClick={handleUpdateRule}
              disabled={saving || !newAmount}
              className="w-full"
              data-testid="button-update-rule"
            >
              Update rule — all future months
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleOverrideMonth}
            disabled={saving || !newAmount}
            className="w-full"
            data-testid="button-override-month"
          >
            Override {formatMonth(target.month)} only
          </Button>
          <Button variant="ghost" onClick={onClose} className="w-full" data-testid="button-cancel-edit">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CashFlowGrid() {
  const { data, isLoading } = useQuery<GridData>({ queryKey: ["/api/cashflow-grid"] });
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const { toast } = useToast();

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const expandAll = () => {
    if (data) setExpandedCategories(new Set(data.categories));
  };

  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  const regenerateForecasts = async () => {
    setIsGenerating(true);
    try {
      await apiRequest("POST", "/api/forecast/generate");
      await queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Forecasts regenerated", description: "All forecast months have been recalculated." });
    } catch {
      toast({ title: "Error", description: "Failed to regenerate forecasts.", variant: "destructive" });
    }
    setIsGenerating(false);
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const inflowCategories = data.categories.filter(cat =>
    data.grid.some(g => g.line.category === cat && g.line.direction === "inflow")
  );
  const outflowCategoryOrder = ["Recurring", "Tenancies", "Transfers", "Other"];
  const outflowCategories = outflowCategoryOrder.filter(cat =>
    data.grid.some(g => g.line.category === cat && g.line.direction === "outflow")
  ).concat(
    data.categories.filter(cat =>
      data.grid.some(g => g.line.category === cat && g.line.direction === "outflow") &&
      !outflowCategoryOrder.includes(cat)
    )
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Cash Flow Grid</h1>
          <p className="text-sm text-muted-foreground">Rolling 13-month view — click any forecast cell to edit</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100 border-blue-300 dark:border-blue-700 font-semibold">
              Actual
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground font-normal">
              Forecast
            </Badge>
          </div>
          <Button variant="outline" size="sm" onClick={expandAll} data-testid="button-expand-all">Expand All</Button>
          <Button variant="outline" size="sm" onClick={collapseAll} data-testid="button-collapse-all">Collapse All</Button>
          <Button size="sm" onClick={regenerateForecasts} disabled={isGenerating} data-testid="button-regenerate">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isGenerating ? "animate-spin" : ""}`} />
            Regenerate
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <ScrollArea className="w-full">
            <div className="min-w-[1200px]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="sticky left-0 z-20 bg-muted/50 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3 min-w-[240px]">
                      Cash Flow Line
                    </th>
                    <th className="bg-muted/50 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 py-3 w-[40px]">
                      Due
                    </th>
                    {data.months.map((month) => (
                      <th key={month} className={`text-right text-xs font-medium uppercase tracking-wider px-3 py-3 min-w-[100px] whitespace-nowrap ${
                        month === data.currentMonth ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground"
                      }`}>
                        {formatMonth(month)}
                        {month === data.currentMonth && (
                          <div className="text-[10px] font-normal normal-case tracking-normal">Current</div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <TotalRow label="Opening Cash" values={data.openingCash} months={data.months} bold highlight="positive" />

                  {inflowCategories.length > 0 && (
                    <>
                      <tr className="bg-emerald-50/50 dark:bg-emerald-950/10">
                        <td colSpan={data.months.length + 2} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          Cash Inflows
                        </td>
                      </tr>
                      {inflowCategories.map(cat => {
                        const isExpanded = expandedCategories.has(cat);
                        const catLines = data.grid.filter(g => g.line.category === cat && g.line.direction === "inflow");
                        return (
                          <CategorySection
                            key={cat}
                            category={cat}
                            lines={catLines}
                            months={data.months}
                            currentMonth={data.currentMonth}
                            categoryTotals={data.categoryTotals[cat] || {}}
                            isExpanded={isExpanded}
                            onToggle={() => toggleCategory(cat)}
                            onCellClick={(line, month, amount) => setEditTarget({ line, month, currentAmount: amount })}
                          />
                        );
                      })}
                      <TotalRow label="Total Cash Inflows" values={data.inflowTotals} months={data.months} bold />
                    </>
                  )}

                  {outflowCategories.length > 0 && (
                    <>
                      <tr className="bg-red-50/50 dark:bg-red-950/10">
                        <td colSpan={data.months.length + 2} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
                          Cash Outflows
                        </td>
                      </tr>
                      {outflowCategories.map(cat => {
                        const isExpanded = expandedCategories.has(cat);
                        const catLines = data.grid.filter(g => g.line.category === cat && g.line.direction === "outflow");
                        return (
                          <CategorySection
                            key={cat}
                            category={cat}
                            lines={catLines}
                            months={data.months}
                            currentMonth={data.currentMonth}
                            categoryTotals={data.categoryTotals[cat] || {}}
                            isExpanded={isExpanded}
                            onToggle={() => toggleCategory(cat)}
                            onCellClick={(line, month, amount) => setEditTarget({ line, month, currentAmount: amount })}
                          />
                        );
                      })}
                      <TotalRow label="Total Cash Outflows" values={data.outflowTotals} months={data.months} bold />
                    </>
                  )}

                  <TotalRow label="Net Cash Movement" values={data.netTotals} months={data.months} bold highlight="neutral" showSign />
                  <TotalRow label="Closing Cash" values={data.closingCash} months={data.months} bold highlight="positive" />
                </tbody>
              </table>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </CardContent>
      </Card>

      {editTarget && (
        <EditCellDialog target={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}

function CategorySection({ category, lines, months, currentMonth, categoryTotals, isExpanded, onToggle, onCellClick }: {
  category: string;
  lines: GridLine[];
  months: string[];
  currentMonth: string;
  categoryTotals: Record<string, number>;
  isExpanded: boolean;
  onToggle: () => void;
  onCellClick: (line: GridLine, month: string, amount: number) => void;
}) {
  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={onToggle}
        data-testid={`row-category-${category.toLowerCase().replace(/\s/g, "-")}`}
      >
        <td className="sticky left-0 z-10 bg-background px-4 py-2">
          <div className="flex items-center gap-1.5">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="text-sm font-medium">{category}</span>
            <Badge variant="secondary" className="text-xs ml-1">{lines.length}</Badge>
          </div>
        </td>
        <td className="text-center text-xs px-1 py-2"></td>
        {months.map(month => (
          <td key={month} className={`text-right text-xs font-medium tabular-nums whitespace-nowrap px-2 py-2 ${
            month === currentMonth ? "bg-primary/5" : ""
          }`}>
            {formatCurrency(categoryTotals[month] || 0)}
          </td>
        ))}
      </tr>
      {isExpanded && lines.map(row => (
        <tr key={row.line.id} className="border-b border-dashed" data-testid={`row-line-${row.line.id}`}>
          <td className="sticky left-0 z-10 bg-background pl-10 pr-4 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">{row.line.name}</span>
              {row.recurrenceType === "annual" && <Badge variant="outline" className="text-[10px]">Annual</Badge>}
              {row.recurrenceType === "semi_annual" && <Badge variant="outline" className="text-[10px]">Semi-annual</Badge>}
              {row.recurrenceType === "quarterly" && <Badge variant="outline" className="text-[10px]">Quarterly</Badge>}
              {row.recurrenceType === "quadrimestral" && <Badge variant="outline" className="text-[10px]">Periodic</Badge>}
            </div>
          </td>
          <td className="text-center text-xs text-muted-foreground px-1 py-1.5 tabular-nums">
            {row.line.dueDay ? String(row.line.dueDay).padStart(2, "0") : ""}
          </td>
          {months.map(month => {
            const cell = row.monthData[month];
            if (!cell) return <td key={month} className="text-right text-sm px-3 py-1.5 text-muted-foreground">-</td>;
            return (
              <CellValue
                key={month}
                value={cell.amount}
                status={cell.status}
                hasOverride={cell.hasOverride}
                hasVariance={cell.hasVariance}
                onClick={() => onCellClick(row, month, cell.amount)}
              />
            );
          })}
        </tr>
      ))}
    </>
  );
}
