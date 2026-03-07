import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { History, FileText } from "lucide-react";
import type { AuditLog } from "@shared/schema";

function formatTimestamp(ts: string | Date | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function actionBadge(action: string) {
  if (action.includes("create")) return <Badge className="text-xs bg-emerald-600">Create</Badge>;
  if (action.includes("update")) return <Badge variant="secondary" className="text-xs">Update</Badge>;
  if (action.includes("delete")) return <Badge variant="destructive" className="text-xs">Delete</Badge>;
  if (action.includes("rebase")) return <Badge className="text-xs bg-primary">Rebase</Badge>;
  if (action.includes("treatment")) return <Badge variant="outline" className="text-xs">Treatment</Badge>;
  return <Badge variant="outline" className="text-xs">{action}</Badge>;
}

export default function AuditLogPage() {
  const { data: logs, isLoading } = useQuery<AuditLog[]>({ queryKey: ["/api/audit-log"] });

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">Audit Log</h1>
        <p className="text-sm text-muted-foreground">Complete history of all changes for governance and compliance</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12">
                    <History className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                    <p className="text-muted-foreground">No audit entries yet</p>
                  </TableCell>
                </TableRow>
              ) : (
                (logs || []).map(log => (
                  <TableRow key={log.id} data-testid={`row-audit-${log.id}`}>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(log.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">{log.entityType?.replace(/_/g, " ")}</Badge>
                        {log.entityId && <span className="text-xs text-muted-foreground">#{log.entityId}</span>}
                      </div>
                    </TableCell>
                    <TableCell>{actionBadge(log.action)}</TableCell>
                    <TableCell className="text-sm">{log.userName || "system"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                      {log.newValueJson ? JSON.stringify(log.newValueJson).substring(0, 80) : "-"}
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
