"use client";

import { IconActivity, IconBanknote, IconCreditCard, IconReceipt, IconSmartphone } from "@/components/icons";
import { paymentMixColor } from "@/app/(app)/dashboard/lib/payment-mix-colors";
import css from "../reports.module.css";

const METHOD_LABELS: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank Transfer", mobile_wallet: "Mobile Wallet", credit: "Credit" };

const METHOD_ICONS: Record<string, React.ReactNode> = {
  cash: <IconBanknote size={15} />,
  card: <IconCreditCard size={15} />,
  bank_transfer: <IconActivity size={15} />,
  mobile_wallet: <IconSmartphone size={15} />,
  credit: <IconReceipt size={15} />,
};

export function paymentMethodLabel(method: string): string {
  if (METHOD_LABELS[method]) return METHOD_LABELS[method]!;
  const spaced = method.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type Props = { method: string; withLabel?: boolean };

/** Small color-tinted icon square for a payment method — same tint used for that method everywhere
 * else on the page (donut segment, trend line, status chip), so a method reads as one color/icon
 * pair throughout the report instead of a different glyph per section. */
export function PaymentMethodIcon({ method, withLabel = true }: Props) {
  const color = paymentMixColor(method);
  return (
    <span className={css.paymentMethodCell}>
      <span className={css.paymentMethodIconSq} style={{ background: `color-mix(in srgb, ${color} 16%, var(--pc-card-bg))`, color }}>
        {METHOD_ICONS[method] ?? <IconReceipt size={15} />}
      </span>
      {withLabel ? <span>{paymentMethodLabel(method)}</span> : null}
    </span>
  );
}
