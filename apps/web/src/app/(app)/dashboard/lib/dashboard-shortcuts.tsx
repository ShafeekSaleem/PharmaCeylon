import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconRefresh,
  IconShoppingCart,
  IconTruck,
} from "@/components/icons";
import { OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import type { QuickAction } from "../components/quick-actions-bar";
import type { DashboardRole } from "./dashboard-role";

export const OWNER_DASHBOARD_SHORTCUTS: QuickAction[] = [
  {
    href: "/purchasing?action=create-po",
    label: "Create PO",
    icon: <IconClipboardList size={17} />,
    roles: PURCHASING_ROLES,
    tone: "primary",
  },
  {
    href: "/purchasing?status=pending_approval",
    label: "Approve POs",
    icon: <IconTruck size={17} />,
    roles: PURCHASING_ROLES,
    tone: "warning",
  },
  {
    href: "/inventory?view=low",
    label: "Low stock queue",
    icon: <IconAlertTriangle size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "warning",
  },
  {
    href: "/inventory/batches?nearExpiryDays=30",
    label: "Near expiry",
    icon: <IconCalendar size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "danger",
  },
  {
    href: "/inventory?openAdjustment=1",
    label: "Adjust stock",
    icon: <IconBox size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "info",
  },
  {
    href: "/inventory/movements",
    label: "Stock movements",
    icon: <IconActivity size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "success",
  },
  {
    href: "/transfers?status=requested",
    label: "Transfer approvals",
    icon: <IconTruck size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "info",
  },
  {
    href: "/returns?status=pending_approval",
    label: "Return approvals",
    icon: <IconArchive size={17} />,
    roles: OPERATIONS_ROLES,
    tone: "danger",
  },
];

export const MANAGER_DASHBOARD_SHORTCUTS: QuickAction[] = [
  {
    href: "/purchasing?status=pending_approval",
    label: "Approve POs",
    icon: <IconClipboardList size={18} />,
    roles: PURCHASING_ROLES,
    tone: "warning",
  },
  {
    href: "/transfers?status=requested",
    label: "Transfer approvals",
    icon: <IconTruck size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "info",
  },
  {
    href: "/returns?status=pending_approval",
    label: "Return approvals",
    icon: <IconRefresh size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "danger",
  },
  {
    href: "/purchasing?action=create-po",
    label: "Create PO",
    icon: <IconShoppingCart size={18} />,
    roles: PURCHASING_ROLES,
    tone: "primary",
  },
  {
    href: "/inventory?view=low",
    label: "Low stock queue",
    icon: <IconAlertTriangle size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "warning",
  },
  {
    href: "/inventory/batches?nearExpiryDays=30",
    label: "Near expiry",
    icon: <IconCalendar size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "danger",
  },
  {
    href: "/inventory?openAdjustment=1",
    label: "Adjust stock",
    icon: <IconPackage size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "success",
  },
  {
    href: "/transfers?action=create",
    label: "Request transfer",
    icon: <IconBox size={18} />,
    roles: OPERATIONS_ROLES,
    tone: "info",
  },
];

export function shortcutsForRole(role: DashboardRole): QuickAction[] | null {
  if (role === "owner") return OWNER_DASHBOARD_SHORTCUTS;
  if (role === "manager") return MANAGER_DASHBOARD_SHORTCUTS;
  return null;
}