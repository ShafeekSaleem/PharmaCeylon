import { redirect } from "next/navigation";

/** The settings sub-nav now owns wayfinding — land on the first, always-open section. */
export default function SettingsIndexPage() {
  redirect("/settings/my-profile");
}
