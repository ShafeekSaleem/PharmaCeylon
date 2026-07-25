"use client";

import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconFileText,
  IconPackage,
  IconTag,
  IconX,
} from "@/components/icons";
import css from "../catalog.module.css";
import type { CatalogFacets, CatalogFilters } from "../types";

type ChipTone = "slate" | "emerald" | "amber" | "sky" | "violet" | "teal" | "rose";

type Props = {
  filters: CatalogFilters;
  facets: CatalogFacets | null;
  onChange: (patch: Partial<CatalogFilters>) => void;
};

function toneClass(tone: ChipTone, active: boolean): string {
  const map: Record<ChipTone, string> = {
    slate: css.chipSlate,
    emerald: css.chipEmerald,
    amber: css.chipAmber,
    sky: css.chipSky,
    violet: css.chipViolet,
    teal: css.chipTeal,
    rose: css.chipRose,
  };
  return `${css.chip} ${map[tone]}${active ? ` ${css.chipActive}` : ""}`;
}

export function QuickChips({ filters, facets, onChange }: Props) {
  const forms = facets?.dosageForms ?? [];
  const categories = facets?.categories ?? [];
  const tags = facets?.tags ?? [];
  const stock = facets?.branchStockSummary;

  const tablet = forms.find((f) => /tablet/i.test(f.value));
  const capsule = forms.find((f) => /capsule/i.test(f.value));
  const antibiotics = categories.find((c) => /antibiotic/i.test(c.label));
  const rxTag = tags.find((t) => /rx|prescription|script/i.test(t.label));

  const tabletValue = tablet?.value ?? "Tablet";
  const capsuleValue = capsule?.value ?? "Capsule";

  const setStock = (status: "" | "in" | "low" | "out") => {
    const on = filters.stockStatus === status || (status === "in" && filters.inStock);
    onChange({
      stockStatus: on ? "" : status,
      inStock: !on && status === "in",
    });
  };

  const chips: Array<{
    key: string;
    label: string;
    tone: ChipTone;
    active: boolean;
    icon: ReactNode;
    onToggle: () => void;
  }> = [
    {
      key: "exact",
      label: "Exact match",
      tone: "violet",
      active: filters.exact,
      icon: <IconTag size={14} />,
      onToggle: () => onChange({ exact: !filters.exact }),
    },
    {
      key: "inStock",
      label:
        stock != null ? `In stock · ${stock.inStockProductCount}` : "In stock",
      tone: "emerald",
      active: filters.stockStatus === "in" || filters.inStock,
      icon: <IconCheck size={14} />,
      onToggle: () => setStock("in"),
    },
    {
      key: "lowStock",
      label:
        stock != null
          ? `Low stock · ${stock.lowStockProductCount}`
          : "Low stock",
      tone: "amber",
      active: filters.stockStatus === "low",
      icon: <IconAlertTriangle size={14} />,
      onToggle: () => setStock("low"),
    },
    {
      key: "outStock",
      label:
        stock != null
          ? `Out of stock · ${stock.outOfStockProductCount}`
          : "Out of stock",
      tone: "rose",
      active: filters.stockStatus === "out",
      icon: <IconX size={14} />,
      onToggle: () => setStock("out"),
    },
    {
      key: "controlled",
      label: "Controlled",
      tone: "slate",
      active: filters.controlled,
      icon: <IconAlertTriangle size={14} />,
      onToggle: () => onChange({ controlled: !filters.controlled }),
    },
  ];

  if (rxTag) {
    chips.push({
      key: "rx",
      label: "Prescription",
      tone: "sky",
      active: filters.tagId === rxTag.value,
      icon: <IconFileText size={14} />,
      onToggle: () =>
        onChange({ tagId: filters.tagId === rxTag.value ? "" : rxTag.value }),
    });
  }

  if (antibiotics) {
    chips.push({
      key: "antibiotics",
      label: "Antibiotics",
      tone: "teal",
      active: filters.categoryId === antibiotics.value,
      icon: <IconPackage size={14} />,
      onToggle: () =>
        onChange({
          categoryId: filters.categoryId === antibiotics.value ? "" : antibiotics.value,
        }),
    });
  }

  chips.push(
    {
      key: "tablet",
      label: "Tablets",
      tone: "slate",
      active: filters.dosageForm === tabletValue,
      icon: <IconPackage size={14} />,
      onToggle: () =>
        onChange({
          dosageForm: filters.dosageForm === tabletValue ? "" : tabletValue,
        }),
    },
    {
      key: "capsule",
      label: "Capsules",
      tone: "violet",
      active: filters.dosageForm === capsuleValue,
      icon: <IconPackage size={14} />,
      onToggle: () =>
        onChange({
          dosageForm: filters.dosageForm === capsuleValue ? "" : capsuleValue,
        }),
    },
  );

  return (
    <div className={css.chips} role="group" aria-label="Quick filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className={toneClass(chip.tone, chip.active)}
          aria-pressed={chip.active}
          onClick={chip.onToggle}
        >
          <span className={css.chipIcon}>{chip.icon}</span>
          {chip.label}
        </button>
      ))}
    </div>
  );
}
