import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatMonth } from "@/lib/format";
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

interface DashboardData {
  currentCashPosition: number;
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
            <CardTitle className="text-sm font-medium text-muted-foreground">Current Cash Position</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-cash-position">{formatCurrency(data.currentCashPosition)}</div>
            <p className="text-xs text-muted-foreground mt-1">Across {data.bankAccounts.length} accounts</p>
          </CardContent>
        </Card>

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
            <CardTitle className="text-base font-medium">Bank Accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.bankAccounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between gap-2" data-testid={`card-bank-account-${account.id}`}>
                <p className="text-sm font-medium">{account.name}</p>
                <p className="text-lg font-semibold tabular-nums text-right">{formatCurrency(account.currentBalance)}</p>
              </div>
            ))}
            <div className="border-t pt-3 mt-3">
              <div className="flex items-center justify-between gap-1">
                <p className="text-sm font-medium">Total</p>
                <p className="text-lg font-bold tabular-nums text-right">{formatCurrency(data.currentCashPosition)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Monthly Cash Flows</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-72" data-testid="chart-monthly-flows">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <Tooltip
                  formatter={(value: number, name: string) => [formatCurrency(value), name === "inflow" ? "Inflows" : name === "outflow" ? "Outflows" : "Net"]}
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "12px" }}
                />
                <Bar dataKey="inflow" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} name="inflow" />
                <Bar dataKey="outflow" fill="hsl(var(--chart-5))" radius={[2, 2, 0, 0]} name="outflow" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
