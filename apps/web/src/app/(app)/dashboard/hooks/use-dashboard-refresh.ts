"use client";

import { useEffect, useState } from "react";

/** Self-fetching charts participate in the dashboard's manual and automatic refresh. */
export function useDashboardRefresh() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    window.addEventListener("dashboard:refresh", refresh);
    return () => window.removeEventListener("dashboard:refresh", refresh);
  }, []);
  return version;
}
