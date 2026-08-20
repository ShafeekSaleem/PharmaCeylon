import type { KeyboardEvent } from "react";
import type { useRouter } from "next/navigation";
import css from "../dashboard.module.css";

/** Makes a <tr> (or any non-anchor row) behave like a link — click or
 * keyboard-activate to navigate. Pair with the `.rowLink` CSS class. */
export function rowLinkProps(router: ReturnType<typeof useRouter>, href: string) {
  return {
    className: css.rowLink,
    role: "link" as const,
    tabIndex: 0,
    onClick: () => router.push(href),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        router.push(href);
      }
    },
  };
}
