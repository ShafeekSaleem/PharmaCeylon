"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type BreadcrumbCrumb = { label: string; href?: string };

type PageChromeContextValue = {
  extraCrumbs: BreadcrumbCrumb[];
  setExtraCrumbs: (crumbs: BreadcrumbCrumb[]) => void;
  /** Replaces the last pathname segment label (e.g. UUID → product name). */
  lastSegmentLabel: string | null;
  setLastSegmentLabel: (label: string | null) => void;
  /** When true, AppShell hides its sidebar/topbar/subheader so the page fills the viewport (POS focus mode). */
  chromeHidden: boolean;
  setChromeHidden: (hidden: boolean) => void;
};

const PageChromeContext = createContext<PageChromeContextValue | null>(null);

export function PageChromeProvider({ children }: { children: React.ReactNode }) {
  const [extraCrumbs, setExtraCrumbsState] = useState<BreadcrumbCrumb[]>([]);
  const [lastSegmentLabel, setLastSegmentLabelState] = useState<string | null>(null);
  const [chromeHidden, setChromeHiddenState] = useState(false);

  const setExtraCrumbs = useCallback((crumbs: BreadcrumbCrumb[]) => {
    setExtraCrumbsState(crumbs);
  }, []);

  const setLastSegmentLabel = useCallback((label: string | null) => {
    setLastSegmentLabelState(label);
  }, []);

  const setChromeHidden = useCallback((hidden: boolean) => {
    setChromeHiddenState(hidden);
  }, []);

  const value = useMemo(
    () => ({
      extraCrumbs,
      setExtraCrumbs,
      lastSegmentLabel,
      setLastSegmentLabel,
      chromeHidden,
      setChromeHidden,
    }),
    [extraCrumbs, lastSegmentLabel, setExtraCrumbs, setLastSegmentLabel, chromeHidden, setChromeHidden],
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
      chromeHidden: false,
      setChromeHidden: (_: boolean) => {},
    };
  }
  return ctx;
}
