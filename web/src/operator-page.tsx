import type { OperatorTenant } from "./model";
import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Building2 } from "lucide-react";
import { Badge, EmptyState, PageHead } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function OperatorPage(props: {
  tenants: OperatorTenant[];
  loading: boolean;
  onRefresh(): void;
  onSelectTenant(tenantId: string): void;
}): ReactNode {
  const t = useTranslate();

  return (
    <div className="page-stack">
      <PageHead
        title={t("operator.title")}
        description={t("operator.subtitle")}
        refreshLabel={t("common.refresh")}
        loading={props.loading}
        onRefresh={props.onRefresh}
      />
      <Card className="table-panel">
        {props.tenants.length === 0 ? (
          <EmptyState
            title={t("operator.emptyTitle")}
            description={t("operator.emptyDescription")}
            icon={<Building2 />}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("operator.name")}</TableHead>
                <TableHead>{t("operator.tenantId")}</TableHead>
                <TableHead>{t("operator.status")}</TableHead>
                <TableHead>{t("operator.created")}</TableHead>
                <TableHead className="table-actions">{t("operator.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.tenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell>{tenant.displayName}</TableCell>
                  <TableCell>
                    <code>{tenant.id}</code>
                  </TableCell>
                  <TableCell>
                    <Badge tone={tenant.disabledAt ? "warning" : "success"}>
                      {tenant.disabledAt ? t("operator.disabled") : t("common.active")}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(tenant.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="table-actions">
                    <Button
                      className="cc-button"
                      variant="outline"
                      size="sm"
                      disabled={Boolean(tenant.disabledAt) || props.loading}
                      onClick={() => props.onSelectTenant(tenant.id)}
                    >
                      {t("operator.manage")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
