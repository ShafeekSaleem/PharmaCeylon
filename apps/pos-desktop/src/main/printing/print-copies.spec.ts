import { describe, expect, it } from "@jest/globals";
import { printCopies } from "./print-copies";

describe("printing several copies", () => {
  it("prints each copy in order", async () => {
    const sent: string[] = [];
    await expect(
      printCopies(["supplier", "branch"], async (copy) => {
        sent.push(copy);
        return { ok: true, error: null };
      }),
    ).resolves.toEqual({ ok: true, error: null, printed: ["supplier", "branch"] });
    expect(sent).toEqual(["supplier", "branch"]);
  });

  it("stops at the first failure and says which copies did print", async () => {
    const sent: string[] = [];
    await expect(
      printCopies(["supplier", "branch"], async (copy) => {
        sent.push(copy);
        return copy === "branch" ? { ok: false, error: "Out of paper." } : { ok: true, error: null };
      }),
    ).resolves.toEqual({ ok: false, error: "Out of paper.", printed: ["supplier"] });
    await expect(
      printCopies(["supplier", "branch"], async () => ({ ok: false, error: "Offline." })),
    ).resolves.toEqual({ ok: false, error: "Offline.", printed: [] });
  });
});
