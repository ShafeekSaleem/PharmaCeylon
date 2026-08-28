export function getApiBaseUrl(): string {
  const configured = (
    process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
    "/api/v1"
  );
  // A registry image must follow the browser's current host/port. Returning an
  // absolute browser URL also preserves callers that use new URL(base).
  if (configured.startsWith("/") && typeof window !== "undefined") {
    return new URL(configured, window.location.origin).href;
  }
  return configured;
}
