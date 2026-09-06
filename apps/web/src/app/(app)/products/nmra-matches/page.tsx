import { redirect } from "next/navigation";

/** The register-match worklist is now the Work Queue's "NMRA match" filter. */
export default function NmraMatchesRedirect() {
  redirect("/products/manage?view=nmra_match");
}
