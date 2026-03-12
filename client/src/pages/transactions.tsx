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
import { formatCurrencyDetailed } from "@/lib/format";
import { Plus, Search, CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ActualTransaction, BankAccount, CashflowLine } from "@shared/schema";

function InlineMappingSelect({
  transactionId,
  currentLineId,
  cashflowLines,
  onMapped,
}: {
  transactionId: number;
  currentLineId: number | null;
  cashflowLines: CashflowLine[];
  onMapped: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const mapMutation = useMutation({
    mutationFn: async (lineId: string) => {
      await apiRequest("PATCH", `/api/transactions/${transactionId}`, {
        cashflowLineId: lineId === "unmap" ? null : parseInt(lineId),
        mappedConfidence: lineId === "unmap" ? "unmatched" : "manual",
        mappingMethod: lineId === "unmap" ? "none" : "manual",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      toast({ title: "Transaction mapped" });
      onMapped();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to map transaction", variant: "destructive" });
    },
  });

  const grouped = cashflowLines.reduce((acc, l) => {
    if (!acc[l.category]) acc[l.category] = [];
    acc[l.category].push(l);
    return acc;
  }, {} as Record<string, CashflowLine[]>);

  if (!open && currentLineId) {
    const lineName = cashflowLines.find(l => l.id === currentLineId)?.name;
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-left"
        data-testid={`button-remap-${transactionId}`}
        title="Click to reassign"
      >
        <Badge variant="secondary" className="text-xs cursor-pointer hover:bg-secondary/70">{lineName}</Badge>
      </button>
    );
  }

  if (!open && !currentLineId) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid={`button-map-${transactionId}`}
        className="text-left"
      >
        <Badge variant="outline" className="text-xs text-amber-600 cursor-pointer hover:border-amber-400">
          Unmapped — click to map
        </Badge>
      </button>
    );
  }

  return (
    <Select
      open
      onOpenChange={(o) => { if (!o) setOpen(false); }}
      onValueChange={(val) => {
        setOpen(false);
        mapMutation.mutate(val);
      }}
      value={currentLineId ? String(currentLineId) : undefined}
    >
      <SelectTrigger
        className="h-7 text-xs w-48"
        data-testid={`select-map-line-${transactionId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue placeholder="Select line..." />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {currentLineId && (
          <SelectItem value="unmap" className="text-xs text-muted-foreground">
            — Remove mapping
          </SelectItem>
        )}
        {Object.entries(grouped).sort().map(([cat, lines]) => (
          <div key={cat}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/50 sticky top-0">
              {cat}
            </div>
            {lines.sort((a, b) => a.name.localeCompare(b.name)).map(l => (
              <SelectItem key={l.id} value={String(l.id)} className="text-xs">
                <span className="text-muted-foreground mr-1">{l.code}</span> {l.name}
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Transactions() {
  const { data: transactions, isLoading } = useQuery<ActualTransaction[]>({ queryKey: ["/api/transactions"] });
  const { data: bankAccounts } = useQuery<BankAccount[]>({ queryKey: ["/api/bank-accounts"] });
  const { data: cashflowLines } = useQuery<CashflowLine[]>({ queryKey: ["/api/cashflow-lines"] });
  const [searchTerm, setSearchTerm] = useState("");
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      transactionDate: new Date().toISOString().split("T")[0],
      amount: "",
      description: "",
      supplierOrCounterparty: "",
      bankAccountId: "",
      cashflowLineId: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/transactions", {
        ...data,
        bankAccountId: parseInt(data.bankAccountId),
        cashflowLineId: data.cashflowLineId ? parseInt(data.cashflowLineId) : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      toast({ title: "Transaction created" });
      setDialogOpen(false);
      form.reset();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create transaction", variant: "destructive" });
    },
  });

  const activeLines = (cashflowLines || []).filter(l => l.active);

  const filtered = (transactions || []).filter(t => {
    const matchesSearch = !searchTerm ||
      t.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.supplierOrCounterparty?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = !showUnmappedOnly || !t.cashflowLineId;
    return matchesSearch && matchesFilter;
  });

  const unmappedCount = (transactions || []).filter(t => !t.cashflowLineId).length;

  const getBankName = (id: number) => bankAccounts?.find(a => a.id === id)?.name || "Unknown";

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
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Transactions</h1>
          <p className="text-sm text-muted-foreground">Actual cash movements and bank transactions</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-transaction">
              <Plus className="h-4 w-4 mr-1.5" />
              Add Transaction
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Transaction</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                <FormField control={form.control} name="transactionDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" {...field} data-testid="input-transaction-date" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl><Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-transaction-amount" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl><Input placeholder="Transaction description" {...field} data-testid="input-transaction-description" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="supplierOrCounterparty" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Supplier / Counterparty</FormLabel>
                    <FormControl><Input placeholder="Supplier name" {...field} data-testid="input-transaction-supplier" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="bankAccountId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bank Account</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-bank-account"><SelectValue placeholder="Select account" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {bankAccounts?.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="cashflowLineId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cash Flow Line (optional)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-cashflow-line"><SelectValue placeholder="Map to line" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {activeLines.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.code} - {l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-transaction">
                  {createMutation.isPending ? "Creating..." : "Create Transaction"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search transactions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
              data-testid="input-search-transactions"
            />
            <Button
              variant={showUnmappedOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setShowUnmappedOnly(v => !v)}
              data-testid="button-filter-unmapped"
            >
              Unmapped only
              {unmappedCount > 0 && (
                <Badge variant={showUnmappedOnly ? "secondary" : "destructive"} className="ml-1.5 text-xs">
                  {unmappedCount}
                </Badge>
              )}
            </Button>
            <Badge variant="secondary">{filtered.length} transactions</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Bank Account</TableHead>
                <TableHead>Mapped Line</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-center">Reconciled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    No transactions found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(t => (
                  <TableRow key={t.id} data-testid={`row-transaction-${t.id}`}>
                    <TableCell className="text-sm whitespace-nowrap">{t.transactionDate as string}</TableCell>
                    <TableCell className="text-sm max-w-[200px] truncate">{t.description}</TableCell>
                    <TableCell className="text-sm">{t.supplierOrCounterparty}</TableCell>
                    <TableCell className="text-sm">{getBankName(t.bankAccountId)}</TableCell>
                    <TableCell className="text-sm">
                      <InlineMappingSelect
                        transactionId={t.id}
                        currentLineId={t.cashflowLineId}
                        cashflowLines={activeLines}
                        onMapped={() => {}}
                      />
                    </TableCell>
                    <TableCell className={`text-right text-sm font-medium tabular-nums ${parseFloat(t.amount as string) < 0 ? "text-red-600" : ""}`}>
                      {formatCurrencyDetailed(t.amount)}
                    </TableCell>
                    <TableCell className="text-center">
                      {t.reconciledFlag ? (
                        <CheckCircle className="h-4 w-4 text-emerald-500 mx-auto" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground mx-auto" />
                      )}
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
