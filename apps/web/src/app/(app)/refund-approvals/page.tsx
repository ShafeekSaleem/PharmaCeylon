import { redirect } from "next/navigation";

/** Compatibility for draft-MR bookmarks/notifications; review now belongs to Sales. */
export default async function RefundApprovalsRedirect({ searchParams }: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  const { request } = await searchParams;
  const params = new URLSearchParams({ view: "pending-approvals" });
  if (typeof request === "string") params.set("request", request);
  redirect(`/sales?${params}`);
}
