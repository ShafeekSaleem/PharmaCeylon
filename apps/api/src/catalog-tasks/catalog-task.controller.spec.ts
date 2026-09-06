import "reflect-metadata";
import { PERMISSION_KEY } from "../security/decorators/require-permission.decorator";
import { CatalogTaskController, parseFilter } from "./catalog-task.controller";
import type { CatalogTaskService } from "./catalog-task.service";

const user = { tenantId: "t1", userId: "u1" } as never;

function makeController() {
  const service = {
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, skip: 0, take: 50 }),
    summary: jest.fn().mockResolvedValue({}),
    refresh: jest.fn().mockResolvedValue({ created: 0, updated: 0, closed: 0 }),
    applySafe: jest.fn().mockResolvedValue({ applied: 0, failed: [] }),
    apply: jest.fn().mockResolvedValue({}),
    dismiss: jest.fn().mockResolvedValue({}),
    markNotApplicable: jest.fn().mockResolvedValue({}),
    reopen: jest.fn().mockResolvedValue({}),
    view: jest.fn().mockResolvedValue({}),
  } as unknown as CatalogTaskService;
  return { controller: new CatalogTaskController(service), service };
}

/**
 * The Work Queue's filters arrive from a bookmarkable URL, so `parseFilter` is the boundary
 * between "whatever is in the address bar" and the service's typed filter. It has to be
 * forgiving in one direction and strict in the other: an unknown value must not 400 a saved
 * link, and must not reach Prisma either.
 */
describe("parseFilter", () => {
  it("splits comma-separated statuses and types", () => {
    const filter = parseFilter({
      status: "OPEN,RESOLVED",
      type: "NMRA_MATCH,MISSING_CATEGORY",
    });
    expect(filter.status).toEqual(["OPEN", "RESOLVED"]);
    expect(filter.type).toEqual(["NMRA_MATCH", "MISSING_CATEGORY"]);
  });

  it("accepts lowercase, because a hand-edited URL is a normal way to arrive", () => {
    expect(parseFilter({ status: "open" }).status).toEqual(["OPEN"]);
  });

  it("drops unknown enum members instead of rejecting the request", () => {
    // A link saved before a task type was renamed should degrade to a broader list, not a 400.
    const filter = parseFilter({ status: "OPEN,BANANA", type: "NOT_A_TYPE" });
    expect(filter.status).toEqual(["OPEN"]);
    expect(filter.type).toBeUndefined();
  });

  it("leaves both undefined when nothing was asked for, so the service applies its default", () => {
    const filter = parseFilter({});
    expect(filter.status).toBeUndefined();
    expect(filter.type).toBeUndefined();
  });

  it("parses paging and ignores values that are not numbers", () => {
    expect(parseFilter({ skip: "50", take: "25" })).toMatchObject({
      skip: 50,
      take: 25,
    });
    expect(parseFilter({ skip: "abc" }).skip).toBeUndefined();
  });

  it("parses dates and discards unparseable ones", () => {
    expect(
      parseFilter({ createdFrom: "2026-09-01" }).createdFrom,
    ).toBeInstanceOf(Date);
    expect(
      parseFilter({ createdFrom: "not-a-date" }).createdFrom,
    ).toBeUndefined();
  });
});

describe("CatalogTaskController", () => {
  it("passes the parsed filter straight through to the service", async () => {
    const { controller, service } = makeController();

    await controller.list(
      user,
      "OPEN",
      "NMRA_MATCH",
      "compliance",
      "amlo",
      "imp-1",
      "NMRA",
      undefined,
      undefined,
      "50",
      "25",
    );

    expect(service.list).toHaveBeenCalledWith("t1", {
      status: ["OPEN"],
      type: ["NMRA_MATCH"],
      view: "compliance",
      q: "amlo",
      importId: "imp-1",
      source: "NMRA",
      createdFrom: undefined,
      createdTo: undefined,
      skip: 50,
      take: 25,
    });
  });

  /**
   * The count on the button and the set actually applied come from the same filter. Sending
   * the filter with the request is what makes "Apply 18 safe changes" apply those eighteen
   * rather than every safe task in the tenant.
   */
  it("carries the caller's filter into apply-safe", async () => {
    const { controller, service } = makeController();

    await controller.applySafe(user, {
      view: "compliance",
      q: "amlo",
      importId: "imp-1",
      expected: 18,
    } as never);

    expect(service.applySafe).toHaveBeenCalledWith(
      "t1",
      "u1",
      expect.objectContaining({
        view: "compliance",
        q: "amlo",
        importId: "imp-1",
      }),
    );
  });

  it("routes each lifecycle action to its own service method", async () => {
    const { controller, service } = makeController();

    await controller.apply(user, "task-1", { categoryId: "cat-1" } as never);
    await controller.dismiss(user, "task-1", { note: "no" } as never);
    await controller.notApplicable(user, "task-1", {
      note: "umbrella",
    } as never);
    await controller.reopen(user, "task-1");

    expect(service.apply).toHaveBeenCalledWith("t1", "u1", "task-1", {
      categoryId: "cat-1",
      referenceProductId: undefined,
    });
    expect(service.dismiss).toHaveBeenCalledWith("t1", "u1", "task-1", "no");
    expect(service.markNotApplicable).toHaveBeenCalledWith(
      "t1",
      "u1",
      "task-1",
      "umbrella",
    );
    expect(service.reopen).toHaveBeenCalledWith("t1", "u1", "task-1");
  });
});

/**
 * Consolidating four screens into one must not change who can do what. Reads take
 * `products.view` and writes `products.manage` — exactly what `/products/organize` and
 * `/products/nmra-matches` required before.
 */
describe("CatalogTaskController — permissions", () => {
  const permissionsOf = (method: string): string[] | undefined =>
    Reflect.getMetadata(
      PERMISSION_KEY,
      (
        CatalogTaskController.prototype as unknown as Record<
          string,
          () => unknown
        >
      )[method],
    );

  it.each(["summary", "list", "view"])(
    "%s requires products.view",
    (method) => {
      expect(permissionsOf(method)).toEqual(["products.view"]);
    },
  );

  it.each([
    "refresh",
    "applySafe",
    "apply",
    "dismiss",
    "notApplicable",
    "reopen",
  ])("%s requires products.manage", (method) => {
    expect(permissionsOf(method)).toEqual(["products.manage"]);
  });
});
