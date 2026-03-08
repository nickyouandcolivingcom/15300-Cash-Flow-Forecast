import { Switch, Route } from "wouter";
import { queryClient, getQueryFn } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import CashFlowGrid from "@/pages/cashflow-grid";
import Transactions from "@/pages/transactions";
import Variances from "@/pages/variances";
import CashFlowLines from "@/pages/cashflow-lines";
import ForecastRules from "@/pages/forecast-rules";
import BankAccounts from "@/pages/bank-accounts";
import AuditLogPage from "@/pages/audit-log";
import XeroSettings from "@/pages/xero-settings";
import AuthPage from "@/pages/auth-page";
import { Loader2 } from "lucide-react";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/grid" component={CashFlowGrid} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/variances" component={Variances} />
      <Route path="/lines" component={CashFlowLines} />
      <Route path="/rules" component={ForecastRules} />
      <Route path="/accounts" component={BankAccounts} />
      <Route path="/audit" component={AuditLogPage} />
      <Route path="/xero" component={XeroSettings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center gap-2 p-2 border-b bg-background sticky top-0 z-30">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex-1" />
          </header>
          <main className="flex-1 overflow-auto">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AppContent() {
  const { data: user, isLoading, error } = useQuery<{ id: number; username: string } | null>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
    staleTime: Infinity,
  });

  const { data: setupCheck, isLoading: setupLoading } = useQuery<{ needsSetup: boolean } | null>({
    queryKey: ["/api/auth/setup-check"],
    queryFn: async () => {
      const res = await fetch("/api/auth/setup-check");
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !user && !isLoading,
    retry: false,
  });

  if (isLoading || (!user && setupLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-auth">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage isSetup={setupCheck?.needsSetup ?? false} />;
  }

  return <AuthenticatedApp />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppContent />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
