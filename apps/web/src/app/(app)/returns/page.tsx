"use client";

import { Suspense } from "react";
import { ReturnsContent } from "./returns-content";

export default function ReturnsPage() {
  return (
    <Suspense fallback={null}>
      <ReturnsContent />
    </Suspense>
  );
}
