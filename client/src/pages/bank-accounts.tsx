import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/format";
import { Plus, Landmark, CheckCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BankAccount } from "@shared/schema";

export default function BankAccounts() {
  const { data: accounts, isLoading } = useQuery<BankAccount[]>({ queryKey: ["/api/bank-accounts"] });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      name: "",
      xeroAccountId: "",
      currentBalance: "0",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      await apiRequest("POST", "/api/bank-accounts", { ...data, active: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      toast({ title: "Bank account created" });
      setDialogOpen(false);
      form.reset();
    },
  });

  const totalBalance = (accounts || []).reduce((sum, a) => sum + (parseFloat(a.currentBalance as string) || 0), 0);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Bank Accounts</h1>
          <p className="text-sm text-muted-foreground">Manage bank accounts and reconciliation</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-account">
              <Plus className="h-4 w-4 mr-1.5" />
              Add Account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Bank Account</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Name</FormLabel>
                    <FormControl><Input placeholder="e.g. Operating Account - Barclays" {...field} data-testid="input-account-name" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="xeroAccountId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Xero Account ID (optional)</FormLabel>
                    <FormControl><Input placeholder="Xero reference" {...field} data-testid="input-xero-id" /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="currentBalance" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Balance</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-balance" /></FormControl>
                  </FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-account">
                  {createMutation.isPending ? "Creating..." : "Create Account"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">Total Cash Position</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold" data-testid="text-total-balance">{formatCurrency(totalBalance)}</div>
          <p className="text-sm text-muted-foreground mt-1">Across {accounts?.length || 0} active accounts</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(accounts || []).map(account => (
          <Card key={account.id} data-testid={`card-account-${account.id}`}>
            <CardHeader className="flex flex-row items-start justify-between gap-1 pb-2">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
                  <Landmark className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base font-medium">{account.name}</CardTitle>
                  {account.xeroAccountId && (
                    <p className="text-xs text-muted-foreground">Xero: {account.xeroAccountId}</p>
                  )}
                </div>
              </div>
              <Badge variant={account.active ? "default" : "secondary"} className="text-xs">
                {account.active ? "Active" : "Inactive"}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">{formatCurrency(account.currentBalance)}</div>
              <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                Reconciled to actual cash
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
