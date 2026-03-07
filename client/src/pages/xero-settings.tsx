import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle, XCircle, RefreshCw, ExternalLink, Download, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface XeroStatus {
  connected: boolean;
  tenantName?: string;
  redirectUri: string;
  error?: string;
}

interface AuthUrl {
  url: string;
  redirectUri: string;
}

export default function XeroSettings() {
  const { data: status, isLoading } = useQuery<XeroStatus>({ queryKey: ["/api/xero/status"] });
  const { data: authUrlData } = useQuery<AuthUrl>({ queryKey: ["/api/xero/auth-url"] });
  const [monthsBack, setMonthsBack] = useState("3");
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("xero_connected") === "true") {
      toast({
        title: "Connected to Xero",
        description: `Organisation: ${params.get("tenant") || "Connected"}`,
      });
      window.history.replaceState({}, "", "/xero");
      queryClient.invalidateQueries({ queryKey: ["/api/xero/status"] });
    }
    if (params.get("xero_error")) {
      toast({
        title: "Xero connection failed",
        description: params.get("xero_error") || "Unknown error",
        variant: "destructive",
      });
      window.history.replaceState({}, "", "/xero");
    }
  }, []);

  const importAccountsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/xero/import-accounts");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Bank accounts imported", description: `${data.imported} accounts synced from Xero` });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const importTransactionsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/xero/import-transactions", { monthsBack: parseInt(monthsBack) });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({
        title: "Transactions imported",
        description: `${data.imported} transactions imported, ${data.mapped} auto-mapped to cash flow lines`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/xero/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/xero/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/xero/auth-url"] });
      toast({ title: "Disconnected from Xero" });
    },
    onError: (err: Error) => {
      toast({ title: "Disconnect failed", description: err.message, variant: "destructive" });
    },
  });

  const fullSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/xero/full-sync", { monthsBack: parseInt(monthsBack) });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow-grid"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/xero/status"] });
      toast({
        title: "Full sync complete",
        description: `${data.accounts.imported} accounts, ${data.transactions.imported} transactions imported`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const isSyncing = importAccountsMutation.isPending || importTransactionsMutation.isPending || fullSyncMutation.isPending;

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Xero Integration</h1>
        <p className="text-sm text-muted-foreground">Connect to Xero to import bank accounts and transactions</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-1">
          <CardTitle className="text-base font-medium">Connection Status</CardTitle>
          {status?.connected ? (
            <Badge className="text-xs bg-emerald-600">Connected</Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-amber-600">Not Connected</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.connected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-emerald-500" />
                  <div>
                    <p className="text-sm font-medium">Connected to: {status.tenantName}</p>
                    <p className="text-xs text-muted-foreground">OAuth tokens are stored securely and refresh automatically</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="button-disconnect-xero"
                >
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Not connected to any Xero organisation</p>
              </div>
              <div className="rounded-md bg-muted/50 p-4 space-y-2">
                <p className="text-sm font-medium">Before connecting:</p>
                <p className="text-xs text-muted-foreground">
                  Make sure your Xero app's redirect URI is set to:
                </p>
                <code className="text-xs bg-muted px-2 py-1 rounded block break-all" data-testid="text-redirect-uri">
                  {status?.redirectUri || "Loading..."}
                </code>
                <p className="text-xs text-muted-foreground">
                  You can update this at developer.xero.com in your app's settings.
                </p>
              </div>
              {authUrlData?.url && (
                <Button asChild data-testid="button-connect-xero">
                  <a href={authUrlData.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-1.5" />
                    Connect to Xero
                  </a>
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {status?.connected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">Import Data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Import period:</span>
                  <Select value={monthsBack} onValueChange={setMonthsBack}>
                    <SelectTrigger className="w-[140px]" data-testid="select-months-back">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Last 1 month</SelectItem>
                      <SelectItem value="3">Last 3 months</SelectItem>
                      <SelectItem value="6">Last 6 months</SelectItem>
                      <SelectItem value="12">Last 12 months</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Button
                  variant="outline"
                  onClick={() => importAccountsMutation.mutate()}
                  disabled={isSyncing}
                  data-testid="button-import-accounts"
                >
                  {importAccountsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-1.5" />
                  )}
                  Import Bank Accounts
                </Button>

                <Button
                  variant="outline"
                  onClick={() => importTransactionsMutation.mutate()}
                  disabled={isSyncing}
                  data-testid="button-import-transactions"
                >
                  {importTransactionsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-1.5" />
                  )}
                  Import Transactions
                </Button>

                <Button
                  onClick={() => fullSyncMutation.mutate()}
                  disabled={isSyncing}
                  data-testid="button-full-sync"
                >
                  {fullSyncMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1.5" />
                  )}
                  Full Sync
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Full Sync imports bank accounts, transactions, updates balances, and regenerates all forecasts.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">How it works</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 text-sm">
                <div className="flex gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">1</div>
                  <p><span className="font-medium">Import Bank Accounts</span> - Pulls your bank accounts from Xero and updates balances</p>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">2</div>
                  <p><span className="font-medium">Import Transactions</span> - Imports bank transactions and auto-maps them to cash flow lines by supplier name and keywords</p>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">3</div>
                  <p><span className="font-medium">Review Mappings</span> - Check the Transactions page to review and correct any unmapped or incorrectly mapped items</p>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">4</div>
                  <p><span className="font-medium">Detect Variances</span> - Run variance detection to compare actuals against forecasts and classify differences</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
