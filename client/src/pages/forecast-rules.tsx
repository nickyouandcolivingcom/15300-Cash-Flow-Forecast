import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/format";
import { Plus, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ForecastRule, CashflowLine } from "@shared/schema";

export default function ForecastRules() {
  const { data: rules, isLoading } = useQuery<ForecastRule[]>({ queryKey: ["/api/forecast-rules"] });
  const { data: lines } = useQuery<CashflowLine[]>({ queryKey: ["/api/cashflow-lines"] });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      cashflowLineId: "",
      recurrenceType: "monthly",
      baseAmount: "",
      startDate: new Date().toISOString().split("T")[0],
      upliftType: "none",
      upliftValue: "0",
      upliftFrequency: "annual",
      forecastConfidence: "high",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/forecast-rules", {
        ...data,
        cashflowLineId: parseInt(data.cashflowLineId),
        frequency: 1,
        active: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast-rules"] });
      toast({ title: "Forecast rule created" });
      setDialogOpen(false);
      form.reset();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      await apiRequest("PATCH", `/api/forecast-rules/${id}`, { active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast-rules"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/forecast-rules/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast-rules"] });
      toast({ title: "Rule deleted" });
    },
  });

  const getLineName = (id: number) => lines?.find(l => l.id === id)?.name || `Line ${id}`;
  const getLineCode = (id: number) => lines?.find(l => l.id === id)?.code || "";

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Forecast Rules</h1>
          <p className="text-sm text-muted-foreground">Manage recurrence rules, uplifts, and forecast schedules</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-rule">
              <Plus className="h-4 w-4 mr-1.5" />
              Add Rule
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Forecast Rule</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                <FormField control={form.control} name="cashflowLineId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cash Flow Line</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-rule-line"><SelectValue placeholder="Select line" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {lines?.filter(l => l.active).map(l => (
                          <SelectItem key={l.id} value={String(l.id)}>{l.code} - {l.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="baseAmount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Base Amount</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-rule-amount" /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="recurrenceType" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Recurrence</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-recurrence"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="monthly">Monthly</SelectItem>
                          <SelectItem value="quarterly">Quarterly</SelectItem>
                          <SelectItem value="semi_annual">Semi-Annual</SelectItem>
                          <SelectItem value="annual">Annual</SelectItem>
                          <SelectItem value="one_off">One-off</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date</FormLabel>
                    <FormControl><Input type="date" {...field} data-testid="input-rule-start" /></FormControl>
                  </FormItem>
                )} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="upliftType" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Uplift Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-uplift-type"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="percentage">Percentage</SelectItem>
                          <SelectItem value="fixed">Fixed Amount</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="upliftValue" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Uplift Value</FormLabel>
                      <FormControl><Input type="number" step="0.01" {...field} data-testid="input-uplift-value" /></FormControl>
                    </FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="forecastConfidence" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confidence</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-confidence"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-rule">
                  {createMutation.isPending ? "Creating..." : "Create Rule"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Recurrence</TableHead>
                <TableHead className="text-right">Base Amount</TableHead>
                <TableHead>Uplift</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Start</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rules || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No forecast rules defined
                  </TableCell>
                </TableRow>
              ) : (
                (rules || []).map(rule => (
                  <TableRow key={rule.id} data-testid={`row-rule-${rule.id}`}>
                    <TableCell>
                      <div className="text-sm font-medium">{getLineName(rule.cashflowLineId)}</div>
                      <div className="text-xs text-muted-foreground">{getLineCode(rule.cashflowLineId)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{rule.recurrenceType?.replace(/_/g, " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {formatCurrency(rule.baseAmount)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {rule.upliftType === "none" ? (
                        <span className="text-muted-foreground">-</span>
                      ) : (
                        <span>{rule.upliftType === "percentage" ? `${rule.upliftValue}%` : formatCurrency(rule.upliftValue)} / {rule.upliftFrequency}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={rule.forecastConfidence === "high" ? "default" : rule.forecastConfidence === "medium" ? "secondary" : "outline"}
                        className="text-xs"
                      >
                        {rule.forecastConfidence}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{rule.startDate}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={rule.active ?? true}
                        onCheckedChange={(checked) => toggleMutation.mutate({ id: rule.id, active: checked })}
                        data-testid={`switch-rule-active-${rule.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(rule.id)}
                        data-testid={`button-delete-rule-${rule.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
