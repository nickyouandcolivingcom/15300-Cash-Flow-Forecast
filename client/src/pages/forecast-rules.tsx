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
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/format";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ForecastRule, CashflowLine } from "@shared/schema";

const MONTH_KEYS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"] as const;
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function VolumeEditor({ volumes, onChange }: {
  volumes: Record<string, number>;
  onChange: (v: Record<string, number>) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Monthly Volumes</Label>
      <div className="grid grid-cols-6 gap-2">
        {MONTH_KEYS.map((key, i) => (
          <div key={key} className="space-y-1">
            <Label className="text-[10px] text-muted-foreground uppercase">{MONTH_LABELS[i]}</Label>
            <Input
              type="number"
              min="0"
              step="1"
              className="h-8 text-xs"
              value={volumes[key] ?? 1}
              onChange={(e) => {
                const val = parseInt(e.target.value) || 0;
                onChange({ ...volumes, [key]: val });
              }}
              data-testid={`input-volume-${key}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function EditRuleDialog({ rule, lineName, onClose }: {
  rule: ForecastRule;
  lineName: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [baseAmount, setBaseAmount] = useState(String(Math.abs(parseFloat(rule.baseAmount as string) || 0)));
  const [hasVolumes, setHasVolumes] = useState(!!(rule.monthlyVolumes));
  const [volumes, setVolumes] = useState<Record<string, number>>(
    (rule.monthlyVolumes as Record<string, number>) || MONTH_KEYS.reduce((acc, k) => ({ ...acc, [k]: 1 }), {} as Record<string, number>)
  );
  const [recurrenceType, setRecurrenceType] = useState(rule.recurrenceType || "monthly");
  const [endDate, setEndDate] = useState(rule.endDate ? String(rule.endDate) : "");

  const isOutflow = parseFloat(rule.baseAmount as string) < 0;

  const updateMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(baseAmount) || 0;
      const signedAmt = isOutflow ? -Math.abs(amt) : amt;
      const body: any = {
        baseAmount: signedAmt.toFixed(2),
        recurrenceType,
        monthlyVolumes: hasVolumes ? volumes : null,
      };
      if (endDate) body.endDate = endDate;
      else body.endDate = null;
      await apiRequest("PATCH", `/api/forecast-rules/${rule.id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast-rules"] });
      toast({ title: "Rule updated" });
      onClose();
    },
  });

  const previewAmounts = MONTH_KEYS.map((key) => {
    const amt = parseFloat(baseAmount) || 0;
    const vol = hasVolumes ? (volumes[key] ?? 1) : 1;
    return amt * vol;
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit Rule: {lineName}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-sm">Unit Cost (£)</Label>
            <Input
              type="number"
              step="0.01"
              value={baseAmount}
              onChange={(e) => setBaseAmount(e.target.value)}
              data-testid="input-edit-amount"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Recurrence</Label>
            <Select value={recurrenceType} onValueChange={setRecurrenceType}>
              <SelectTrigger data-testid="select-edit-recurrence"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="quadrimestral">Quadrimestral</SelectItem>
                <SelectItem value="semi_annual">Semi-Annual</SelectItem>
                <SelectItem value="annual">Annual</SelectItem>
                <SelectItem value="one_off">One-off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-sm">End Date (optional)</Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            data-testid="input-edit-end-date"
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={hasVolumes} onCheckedChange={setHasVolumes} data-testid="switch-volumes" />
          <Label className="text-sm">Use monthly volume profile</Label>
        </div>

        {hasVolumes && (
          <VolumeEditor volumes={volumes} onChange={setVolumes} />
        )}

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Forecast Preview (monthly amount)</Label>
          <div className="grid grid-cols-6 gap-1">
            {MONTH_KEYS.map((key, i) => (
              <div key={key} className="text-center">
                <div className="text-[10px] text-muted-foreground">{MONTH_LABELS[i]}</div>
                <div className="text-xs font-mono tabular-nums">
                  {isOutflow ? "-" : ""}£{previewAmounts[i].toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Button
          className="w-full"
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending}
          data-testid="button-save-rule"
        >
          {updateMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </DialogContent>
  );
}

export default function ForecastRules() {
  const { data: rules, isLoading } = useQuery<ForecastRule[]>({ queryKey: ["/api/forecast-rules"] });
  const { data: lines } = useQuery<CashflowLine[]>({ queryKey: ["/api/cashflow-lines"] });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ForecastRule | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");
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

  const getLine = (id: number) => lines?.find(l => l.id === id);
  const getLineName = (id: number) => getLine(id)?.name || `Line ${id}`;
  const getLineCode = (id: number) => getLine(id)?.code || "";
  const getLineCategory = (id: number) => getLine(id)?.category || "";

  const categories = lines
    ? [...new Set(lines.filter(l => l.active).map(l => l.category))]
    : [];

  const activeRules = (rules || []).filter(r => r.active);
  const filteredRules = filterCategory === "all"
    ? activeRules
    : activeRules.filter(r => getLineCategory(r.cashflowLineId) === filterCategory);

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
          <p className="text-sm text-muted-foreground">Manage recurrence rules, unit costs, and volume profiles</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-[160px]" data-testid="select-filter-category">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                            <SelectItem value="quadrimestral">Quadrimestral</SelectItem>
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
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Recurrence</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead>Volumes</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No forecast rules found
                  </TableCell>
                </TableRow>
              ) : (
                filteredRules.map(rule => {
                  const vols = rule.monthlyVolumes as Record<string, number> | null;
                  return (
                    <TableRow key={rule.id} data-testid={`row-rule-${rule.id}`}>
                      <TableCell>
                        <div className="text-sm font-medium">{getLineName(rule.cashflowLineId)}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">{getLineCategory(rule.cashflowLineId)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">{rule.recurrenceType?.replace(/_/g, " ")}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium tabular-nums">
                        {formatCurrency(rule.baseAmount)}
                      </TableCell>
                      <TableCell>
                        {vols ? (
                          <div className="flex gap-0.5">
                            {MONTH_KEYS.map((key, i) => (
                              <span key={key} className={`text-[10px] tabular-nums px-0.5 rounded ${(vols[key] ?? 1) > 1 ? 'bg-amber-100 dark:bg-amber-900 font-semibold' : 'text-muted-foreground'}`}>
                                {vols[key] ?? 1}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
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
                      <TableCell className="text-center">
                        <Switch
                          checked={rule.active ?? true}
                          onCheckedChange={(checked) => toggleMutation.mutate({ id: rule.id, active: checked })}
                          data-testid={`switch-rule-active-${rule.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Dialog open={editingRule?.id === rule.id} onOpenChange={(open) => !open && setEditingRule(null)}>
                            <DialogTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setEditingRule(rule)}
                                data-testid={`button-edit-rule-${rule.id}`}
                              >
                                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            </DialogTrigger>
                            {editingRule?.id === rule.id && (
                              <EditRuleDialog
                                rule={rule}
                                lineName={getLineName(rule.cashflowLineId)}
                                onClose={() => setEditingRule(null)}
                              />
                            )}
                          </Dialog>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(rule.id)}
                            data-testid={`button-delete-rule-${rule.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
