"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type BreadcrumbCrumb = { label: string; href?: string };

type PageChromeContextValue = {
  extraCrumbs: BreadcrumbCrumb[];
  setExtraCrumbs: (crumbs: BreadcrumbCrumb[]) => void;
  /** Replaces the last pathname segment label (e.g. UUID → product name). */
  lastSegmentLabel: string | null;
  setLastSegmentLabel: (label: string | null) => void;
};

const PageChromeContext = createContext<PageChromeContextValue | null>(null);

export function PageChromeProvider({ children }: { children: React.ReactNode }) {
  const [extraCrumbs, setExtraCrumbsState] = useState<BreadcrumbCrumb[]>([]);
  const [lastSegmentLabel, setLastSegmentLabelState] = useState<string | null>(null);

  const setExtraCrumbs = useCallback((crumbs: BreadcrumbCrumb[]) => {
    setExtraCrumbsState(crumbs);
  }, []);

  const setLastSegmentLabel = useCallback((label: string | null) => {
    setLastSegmentLabelState(label);
  }, []);

  const value = useMemo(
    () => ({
      extraCrumbs,
      setExtraCrumbs,
      lastSegmentLabel,
      setLastSegmentLabel,
    }),
    [extraCrumbs, lastSegmentLabel, setExtraCrumbs, setLastSegmentLabel],
  );

  return (
    <PageChromeContext.Provider value={value}>{children}</PageChromeContext.Provider>
  );
}

export function usePageChrome() {
  const ctx = useContext(PageChromeContext);
  if (!ctx) {
    return {
      extraCrumbs: [] as BreadcrumbCrumb[],
      setExtraCrumbs: (_: BreadcrumbCrumb[]) => {},
      lastSegmentLabel: null as string | null,
      setLastSegmentLabel: (_: string | null) => {},
    };
  }
  return ctx;
}
