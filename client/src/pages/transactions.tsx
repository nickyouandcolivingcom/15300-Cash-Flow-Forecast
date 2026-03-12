import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrencyDetailed } from "@/lib/format";
import { Plus, Search, CheckCircle, XCircle, Check } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ActualTransaction, BankAccount, CashflowLine } from "@shared/schema";

const CATEGORY_ORDER = ["Rent Revenue", "Recurring", "Tenancies", "Tradesmen", "Transfers", "Other"];

function MappingPicker({
  transactionId,
  currentLineId,
  cashflowLines,
}: {
  transactionId: number;
  currentLineId: number | null;
  cashflowLines: CashflowLine[];
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const mapMutation = useMutation({
    mutationFn: async (lineId: number | null) => {
      const response = await apiRequest("PATCH", `/api/transactions/${transactionId}`, {
        cashflowLineId: lineId,
        mappedConfidence: lineId ? "manual" : "unmatched",
        mappingMethod: lineId ? "manual" : "none",
      });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      setOpen(false);
      toast({ title: "Mapping saved" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to save mapping", variant: "destructive" });
    },
  });

  const currentLine = cashflowLines.find(l => l.id === currentLineId);

  const categories = CATEGORY_ORDER.filter(cat =>
    cashflowLines.some(l => l.category === cat)
  );

  const filteredLines = selectedCategory
    ? cashflowLines.filter(l => l.category === selectedCategory)
    : cashflowLines;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid={`button-map-${transactionId}`}
          className="text-left focus:outline-none"
          disabled={mapMutation.isPending}
        >
          {currentLine ? (
            <Badge variant="secondary" className="text-xs cursor-pointer hover:bg-secondary/70 whitespace-nowrap">
              {currentLine.name}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs cursor-pointer hover:border-amber-400 text-amber-600 whitespace-nowrap">
              Unmapped — click to map
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" side="bottom">
        <div className="p-2 border-b flex gap-1 flex-wrap">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              selectedCategory === null
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/80 text-muted-foreground"
            }`}
          >
            All
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat === selectedCategory ? null : cat)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                selectedCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted hover:bg-muted/80 text-muted-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
        <Command>
          <CommandInput placeholder="Type to search..." className="h-9" />
          <CommandList className="max-h-56">
            <CommandEmpty>No lines found.</CommandEmpty>
            {currentLineId && (
              <CommandGroup>
                <CommandItem
                  value="remove-mapping"
                  onSelect={() => mapMutation.mutate(null)}
                  className="text-muted-foreground text-xs italic"
                >
                  — Remove mapping
                </CommandItem>
              </CommandGroup>
            )}
            {(selectedCategory ? [selectedCategory] : CATEGORY_ORDER).map(cat => {
              const lines = filteredLines.filter(l => l.category === cat);
              if (!lines.length) return null;
              return (
                <CommandGroup key={cat} heading={cat}>
                  {lines.sort((a, b) => a.name.localeCompare(b.name)).map(l => (
                    <CommandItem
                      key={l.id}
                      value={`${l.code} ${l.name} ${l.category}`}
                      onSelect={() => mapMutation.mutate(l.id)}
                      className="text-xs"
                    >
                      <Check
                        className={`mr-1.5 h-3 w-3 shrink-0 ${l.id === currentLineId ? "opacity-100" : "opacity-0"}`}
                      />
                      <span className="text-muted-foreground mr-1">{l.code}</span>
                      {l.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
                  <FormItem><FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" {...field} data-testid="input-transaction-date" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem><FormLabel>Amount</FormLabel>
                    <FormControl><Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-transaction-amount" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem><FormLabel>Description</FormLabel>
                    <FormControl><Input placeholder="Transaction description" {...field} data-testid="input-transaction-description" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="supplierOrCounterparty" render={({ field }) => (
                  <FormItem><FormLabel>Supplier / Counterparty</FormLabel>
                    <FormControl><Input placeholder="Supplier name" {...field} data-testid="input-transaction-supplier" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="bankAccountId" render={({ field }) => (
                  <FormItem><FormLabel>Bank Account</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-bank-account"><SelectValue placeholder="Select account" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {bankAccounts?.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="cashflowLineId" render={({ field }) => (
                  <FormItem><FormLabel>Cash Flow Line (optional)</FormLabel>
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
        <div className="p-4 border-b">
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
        </div>
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
                    <TableCell className="text-sm max-w-[180px] truncate">{t.description}</TableCell>
                    <TableCell className="text-sm max-w-[140px] truncate">{t.supplierOrCounterparty}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{getBankName(t.bankAccountId)}</TableCell>
                    <TableCell className="text-sm">
                      <MappingPicker
                        transactionId={t.id}
                        currentLineId={t.cashflowLineId}
                        cashflowLines={activeLines}
                      />
                    </TableCell>
                    <TableCell className={`text-right text-sm font-medium tabular-nums whitespace-nowrap ${parseFloat(t.amount as string) < 0 ? "text-red-600" : ""}`}>
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
