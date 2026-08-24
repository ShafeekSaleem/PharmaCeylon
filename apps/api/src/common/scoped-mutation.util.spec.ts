import { NotFoundException } from "@nestjs/common";
import { assertOneScopedMutation } from "./scoped-mutation.util";

describe("assertOneScopedMutation", () => {
  it("accepts exactly one tenant-scoped mutation", () => {
    expect(() => assertOneScopedMutation({ count: 1 }, "Product")).not.toThrow();
  });

  it("rejects a mutation that matched no row", () => {
    expect(() => assertOneScopedMutation({ count: 0 }, "Product")).toThrow(
      NotFoundException,
    );
  });
});
