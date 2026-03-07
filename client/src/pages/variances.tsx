import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatMonthFull } from "@/lib/format";
import { AlertTriangle, CheckCircle, Clock, ArrowRight, TrendingUp } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { VarianceEvent, CashflowLine } from "@shared/schema";

export default function Variances() {
  const { data: variances, isLoading } = useQuery<VarianceEvent[]>({ queryKey: ["/api/variances"] });
  const { data: lines } = useQuery<CashflowLine[]>({ queryKey: ["/api/cashflow-lines"] });
  const { toast } = useToast();

  const treatMutation = useMutation({
    mutationFn: async ({ id, treatment }: { id: number; treatment: string }) => {
      await apiRequest("POST", `/api/variances/${id}/treat`, { treatment });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/variances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Treatment applied", description: "Variance treatment has been applied and forecasts updated." });
    },
  });

  const detectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/forecast/detect-variances", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/variances"] });
      toast({ title: "Variance detection complete" });
    },
  });

  const getLineName = (id: number) => lines?.find(l => l.id === id)?.name || `Line ${id}`;
  const getLineCode = (id: number) => lines?.find(l => l.id === id)?.code || "";

  const pending = variances?.filter(v => !v.approvedTreatment) || [];
  const resolved = variances?.filter(v => v.approvedTreatment) || [];

  const treatmentBadge = (treatment: string | null) => {
    if (!treatment) return null;
    switch (treatment) {
      case "timing": return <Badge variant="secondary" className="text-xs">Timing</Badge>;
      case "permanent": return <Badge className="text-xs bg-primary">Permanent</Badge>;
      case "one_off": return <Badge variant="outline" className="text-xs">One-off</Badge>;
      default: return <Badge variant="outline" className="text-xs">{treatment}</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Variance Review</h1>
          <p className="text-sm text-muted-foreground">Compare actuals vs forecasts and classify variances</p>
        </div>
        <Button onClick={() => detectMutation.mutate()} disabled={detectMutation.isPending} data-testid="button-detect-variances">
          <AlertTriangle className="h-4 w-4 mr-1.5" />
          {detectMutation.isPending ? "Detecting..." : "Detect Variances"}
        </Button>
      </div>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              Pending Review ({pending.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Forecast</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Suggested</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map(v => {
                  const variance = parseFloat(v.varianceAmount as string) || 0;
                  return (
                    <TableRow key={v.id} data-testid={`row-variance-${v.id}`}>
                      <TableCell>
                        <div className="text-sm font-medium">{getLineName(v.cashflowLineId)}</div>
                        <div className="text-xs text-muted-foreground">{getLineCode(v.cashflowLineId)}</div>
                      </TableCell>
                      <TableCell className="text-sm">{formatMonthFull(v.forecastMonth)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{formatCurrency(v.forecastAmount)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">{formatCurrency(v.actualAmount)}</TableCell>
                      <TableCell className={`text-right text-sm tabular-nums font-medium ${variance < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {variance > 0 ? "+" : ""}{formatCurrency(variance)}
                      </TableCell>
                      <TableCell>{treatmentBadge(v.suggestedTreatment)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => treatMutation.mutate({ id: v.id, treatment: "timing" })} disabled={treatMutation.isPending} data-testid={`button-treat-timing-${v.id}`}>
                            Timing
                          </Button>
                          <Button size="sm" onClick={() => treatMutation.mutate({ id: v.id, treatment: "permanent" })} disabled={treatMutation.isPending} data-testid={`button-treat-permanent-${v.id}`}>
                            Permanent
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => treatMutation.mutate({ id: v.id, treatment: "one_off" })} disabled={treatMutation.isPending} data-testid={`button-treat-oneoff-${v.id}`}>
                            One-off
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {pending.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="h-12 w-12 text-emerald-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium">No pending variances</h3>
            <p className="text-sm text-muted-foreground mt-1">All variances have been reviewed and classified</p>
          </CardContent>
        </Card>
      )}

      {resolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              Resolved ({resolved.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Treatment</TableHead>
                  <TableHead>Approved By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolved.map(v => (
                  <TableRow key={v.id} className="opacity-70" data-testid={`row-resolved-${v.id}`}>
                    <TableCell className="text-sm">{getLineName(v.cashflowLineId)}</TableCell>
                    <TableCell className="text-sm">{formatMonthFull(v.forecastMonth)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{formatCurrency(v.varianceAmount)}</TableCell>
                    <TableCell>{treatmentBadge(v.approvedTreatment)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{v.approvedBy || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
