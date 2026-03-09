import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatMonth } from "@/lib/format";
import { TrendingUp, TrendingDown, AlertTriangle, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface DashboardData {
  currentCashPosition: number;
  lastActualDate: string | null;
  openingBalanceTotal: number;
  freeCashFlow: number;
  totalInflow: number;
  totalOutflow: number;
  pendingVariances: number;
  cashTrend: { month: string; closing: number; inflow: number; outflow: number }[];
  bankAccounts: { id: number; name: string; currentBalance: string }[];
  months: string[];
}

export default function Dashboard() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard"],
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const chartData = data.cashTrend.map(t => ({
    month: formatMonth(t.month),
    closing: Math.round(t.closing),
    inflow: Math.round(t.inflow),
    outflow: Math.round(t.outflow),
    net: Math.round(t.inflow - t.outflow),
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-1">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Rolling 13-month cash flow overview</p>
        </div>
        <Badge variant="outline" data-testid="badge-reconciled">
          Reconciled to Actual Cash
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Free Cash Flow (13m)</CardTitle>
            {data.freeCashFlow >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${data.freeCashFlow >= 0 ? "text-emerald-600" : "text-red-600"}`} data-testid="text-free-cash-flow">
              {formatCurrency(data.freeCashFlow)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Net operating cash generated</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Inflows (13m)</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-inflow">{formatCurrency(data.totalInflow)}</div>
            <p className="text-xs text-muted-foreground mt-1">Revenue & other receipts</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Variances</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-pending-variances">{data.pendingVariances}</div>
            <p className="text-xs text-muted-foreground mt-1">Requires review</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base font-medium">Closing Cash Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72" data-testid="chart-cash-trend">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="cashGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                  <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} className="text-muted-foreground" />
                  <Tooltip
                    formatter={(value: number) => [formatCurrency(value), "Closing Cash"]}
                    contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "12px" }}
                  />
                  <Area type="monotone" dataKey="closing" stroke="hsl(var(--primary))" fill="url(#cashGradient)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Current Cash Position</CardTitle>
            {data.lastActualDate && (
              <p className="text-[10px] text-muted-foreground" data-testid="text-as-of-date">
                As of {new Date(data.lastActualDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Opening balance (1st)</p>
              <p className="text-xs tabular-nums text-right text-muted-foreground">{formatCurrency(data.openingBalanceTotal)}</p>
            </div>
            {data.categoryBridge && (
              <div className="space-y-1 py-1">
                {[
                  { key: "Rent Revenue", label: "Rent Revenue" },
                  { key: "Recurring", label: "Recurring" },
                  { key: "Tenancies", label: "Tenancies" },
                  { key: "Transfers", label: "Transfers" },
                  { key: "Other", label: "Other" },
                ].map(({ key, label }) => {
                  const val = data.categoryBridge[key] || 0;
                  if (val === 0) return null;
                  return (
                    <div key={key} className="flex items-center justify-between gap-2" data-testid={`bridge-${key.toLowerCase().replace(/\s+/g, "-")}`}>
                      <p className="text-[11px] text-muted-foreground pl-2">{label}</p>
                      <p className={`text-[11px] tabular-nums text-right ${val >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                        {val >= 0 ? "+" : ""}{formatCurrency(val)}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="border-t pt-2">
              <div className="flex items-center justify-between gap-1">
                <p className="text-sm font-medium">Position</p>
                <p className="text-lg font-bold tabular-nums text-right" data-testid="text-cash-position">{formatCurrency(data.currentCashPosition)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
