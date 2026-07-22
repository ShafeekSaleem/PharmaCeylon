import { IconLock } from "@/components/icons";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";
import styles from "./role-access-denied.module.css";

type Props = {
  title?: string;
  description?: string;
  allowedRoles?: RoleName[];
};

export function RoleAccessDenied({
  title = "Insufficient permissions",
  description,
  allowedRoles,
}: Props) {
  const body = description ?? roleDeniedMessage(allowedRoles);

  return (
    <div className={styles.panel} role="status">
      <span className={styles.iconWrap} aria-hidden>
        <IconLock size={18} />
      </span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{body}</p>
    </div>
  );
}
