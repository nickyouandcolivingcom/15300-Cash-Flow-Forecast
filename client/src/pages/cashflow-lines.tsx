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
import { Plus, ArrowUpRight, ArrowDownRight, Pencil } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CashflowLine } from "@shared/schema";

export default function CashFlowLines() {
  const { data: lines, isLoading } = useQuery<CashflowLine[]>({ queryKey: ["/api/cashflow-lines"] });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      code: "",
      name: "",
      category: "",
      subcategory: "",
      supplierName: "",
      lineType: "recurring_fixed",
      direction: "outflow",
      sortOrder: "0",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/cashflow-lines", {
        ...data,
        sortOrder: parseInt(data.sortOrder) || 0,
        active: true,
        isRollup: false,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow-lines"] });
      toast({ title: "Cash flow line created" });
      setDialogOpen(false);
      form.reset();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      await apiRequest("PATCH", `/api/cashflow-lines/${id}`, { active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow-lines"] });
    },
  });

  const categories = [...new Set((lines || []).map(l => l.category))];

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
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Cash Flow Lines</h1>
          <p className="text-sm text-muted-foreground">Define and manage cash flow categories and line items</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-line">
              <Plus className="h-4 w-4 mr-1.5" />
              Add Line
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Cash Flow Line</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="code" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Code</FormLabel>
                      <FormControl><Input placeholder="REV-001" {...field} data-testid="input-line-code" /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="sortOrder" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sort Order</FormLabel>
                      <FormControl><Input type="number" {...field} data-testid="input-line-sort" /></FormControl>
                    </FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl><Input placeholder="Line name" {...field} data-testid="input-line-name" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl><Input placeholder="e.g. Revenue, People Costs" {...field} data-testid="input-line-category" /></FormControl>
                  </FormItem>
                )} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="direction" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Direction</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-direction"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="inflow">Inflow</SelectItem>
                          <SelectItem value="outflow">Outflow</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="lineType" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-line-type"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="recurring_fixed">Recurring Fixed</SelectItem>
                          <SelectItem value="recurring_uplift">Recurring w/ Uplift</SelectItem>
                          <SelectItem value="semi_variable">Semi Variable</SelectItem>
                          <SelectItem value="timing_variable">Timing Variable</SelectItem>
                          <SelectItem value="one_off">One-off</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                </div>
                <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-line">
                  {createMutation.isPending ? "Creating..." : "Create Line"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {categories.map(cat => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium flex items-center gap-2">
              {cat}
              <Badge variant="secondary" className="text-xs">{(lines || []).filter(l => l.category === cat).length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="w-16">Order</TableHead>
                  <TableHead className="w-20 text-center">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lines || []).filter(l => l.category === cat).map(line => (
                  <TableRow key={line.id} data-testid={`row-line-${line.id}`}>
                    <TableCell className="text-xs font-mono text-muted-foreground">{line.code}</TableCell>
                    <TableCell className="text-sm font-medium">{line.name}</TableCell>
                    <TableCell>
                      {line.direction === "inflow" ? (
                        <div className="flex items-center gap-1 text-emerald-600 text-sm">
                          <ArrowUpRight className="h-3.5 w-3.5" /> Inflow
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-red-600 text-sm">
                          <ArrowDownRight className="h-3.5 w-3.5" /> Outflow
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{line.lineType?.replace(/_/g, " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{line.sortOrder}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={line.active ?? true}
                        onCheckedChange={(checked) => toggleMutation.mutate({ id: line.id, active: checked })}
                        data-testid={`switch-active-${line.id}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
