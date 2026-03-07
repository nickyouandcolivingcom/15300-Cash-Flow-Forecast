import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

function CellValue({ value, status, hasOverride, hasVariance, isNegative }: {
  value: number;
  status: string;
  hasOverride: boolean;
  hasVariance: boolean;
  isNegative?: boolean;
}) {
  let className = "text-right text-sm tabular-nums whitespace-nowrap px-3 py-2 ";

  if (status === "actual") {
    className += "font-semibold bg-primary/5 ";
  } else if (hasOverride) {
    className += "bg-amber-50 dark:bg-amber-950/20 ";
  } else if (hasVariance) {
    className += "bg-orange-50 dark:bg-orange-950/20 ";
  }

  if (isNegative || value < 0) {
    className += "text-red-600 dark:text-red-400 ";
  }

  return (
    <td className={className}>
      {formatCurrency(value)}
    </td>
  );
}

function TotalRow({ label, values, months, bold, highlight, showSign }: {
  label: string;
  values: Record<string, number>;
  months: string[];
  bold?: boolean;
  highlight?: "positive" | "neutral";
  showSign?: boolean;
}) {
  return (
    <tr className={`${bold ? "font-bold" : "font-semibold"} ${highlight === "positive" ? "bg-primary/5" : "bg-muted/30"} border-t`}>
      <td className={`sticky left-0 z-10 px-4 py-2 text-sm ${bold ? "bg-primary/5" : "bg-muted/30"}`}>
        {label}
      </td>
      {months.map(month => (
        <td key={month} className={`text-right text-sm tabular-nums whitespace-nowrap px-3 py-2 ${(values[month] || 0) < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
          {formatCurrency(values[month] || 0)}
        </td>
      ))}
    </tr>
  );
}

export default function CashFlowGrid() {
  const { data, isLoading } = useQuery<GridData>({ queryKey: ["/api/cashflow-grid"] });
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
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
  const outflowCategories = data.categories.filter(cat =>
    data.grid.some(g => g.line.category === cat && g.line.direction === "outflow")
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Cash Flow Grid</h1>
          <p className="text-sm text-muted-foreground">Rolling 13-month view - actual current month + 12 future months</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-xs">
              <div className="w-2 h-2 rounded-full bg-primary/40 mr-1" />
              Actual
            </Badge>
            <Badge variant="outline" className="text-xs">
              <div className="w-2 h-2 rounded-full bg-amber-400 mr-1" />
              Override
            </Badge>
            <Badge variant="outline" className="text-xs">
              <div className="w-2 h-2 rounded-full bg-orange-400 mr-1" />
              Variance
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
                    {data.months.map((month, idx) => (
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
                        <td colSpan={data.months.length + 1} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
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
                          />
                        );
                      })}
                      <TotalRow label="Total Cash Inflows" values={data.inflowTotals} months={data.months} bold />
                    </>
                  )}

                  {outflowCategories.length > 0 && (
                    <>
                      <tr className="bg-red-50/50 dark:bg-red-950/10">
                        <td colSpan={data.months.length + 1} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
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
    </div>
  );
}

function CategorySection({ category, lines, months, currentMonth, categoryTotals, isExpanded, onToggle }: {
  category: string;
  lines: GridLine[];
  months: string[];
  currentMonth: string;
  categoryTotals: Record<string, number>;
  isExpanded: boolean;
  onToggle: () => void;
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
        {months.map(month => (
          <td key={month} className={`text-right text-sm font-medium tabular-nums whitespace-nowrap px-3 py-2 ${
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
              {row.line.lineType === "one_off" && <Badge variant="outline" className="text-[10px]">One-off</Badge>}
            </div>
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
              />
            );
          })}
        </tr>
      ))}
    </>
  );
}
