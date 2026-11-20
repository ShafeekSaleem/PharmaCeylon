import type { ReactNode } from "react";

type Props = {
  text: string;
  children?: ReactNode;
  className?: string;
};

/** Full value on hover via the app-wide FloatingTooltip host (`data-tooltip`). */
export function EllipsisTip({ text, children, className }: Props) {
  if (!text.trim()) return <>{children ?? text}</>;
  return (
    <span className={className} data-tooltip={text}>
      {children ?? text}
    </span>
  );
}