import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
/** Upload + parse + job start (upsert runs async on Nest). */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

function apiProxyTarget(): string {
  return (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

/**
 * Confirm starts an async upsert job and returns { jobId } quickly.
 * Dedicated handler keeps multipart upload off the short rewrite path if needed.
 */
export async function POST(req: NextRequest) {
  const target = `${apiProxyTarget()}/api/v1/products/nmra-import/confirm`;
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  const csrf = req.headers.get("x-csrf-token");
  const branch = req.headers.get("x-branch-id");
  const contentType = req.headers.get("content-type");
  if (cookie) headers.set("cookie", cookie);
  if (csrf) headers.set("x-csrf-token", csrf);
  if (branch) headers.set("x-branch-id", branch);
  if (contentType) headers.set("content-type", contentType);

  const body = await req.arrayBuffer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await upstream.text();
    const resHeaders = new Headers();
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) resHeaders.set("content-type", upstreamType);
    return new NextResponse(text, { status: upstream.status, headers: resHeaders });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "NMRA confirm timed out while starting the import job. Retry with a smaller file."
        : err instanceof Error
          ? err.message
          : "NMRA confirm proxy failed";
    return NextResponse.json({ message }, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
