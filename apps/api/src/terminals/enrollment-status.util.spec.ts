import { buildEnrollmentOfflineBackup } from "./enrollment-status.util";

const at = (ms: number) => new Date(ms);
const names = new Map([
  ["u-auth", "Authorizer"],
  ["u-act", "Activator"],
]);

describe("buildEnrollmentOfflineBackup", () => {
  const fullName = (id: string) => names.get(id) ?? null;

  it("returns all nulls when there is no nomination or authorization", () => {
    expect(buildEnrollmentOfflineBackup("e1", null, null, null, fullName)).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });

  it("returns authorization only for an outstanding assignment on this enrollment", () => {
    expect(
      buildEnrollmentOfflineBackup(
        "e1",
        null,
        null,
        { authorizedAt: at(1000), authorizedByUserId: "u-auth" },
        fullName,
      ),
    ).toEqual({
      authorizedAt: 1000,
      authorizedByUserId: "u-auth",
      authorizedByFullName: "Authorizer",
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });

  it("returns activation and linked authorization when this enrollment is nominated", () => {
    expect(
      buildEnrollmentOfflineBackup(
        "e1",
        {
          enrollmentId: "e1",
          authorizationId: "a1",
          activatedAt: at(2000),
          activatedByUserId: "u-act",
        },
        { authorizedAt: at(500), authorizedByUserId: "u-auth" },
        { authorizedAt: at(999), authorizedByUserId: "u-other" },
        fullName,
      ),
    ).toEqual({
      authorizedAt: 500,
      authorizedByUserId: "u-auth",
      authorizedByFullName: "Authorizer",
      activatedAt: 2000,
      activatedByUserId: "u-act",
      activatedByFullName: "Activator",
    });
  });

  it("returns null activation when the branch nomination is for another enrollment", () => {
    expect(
      buildEnrollmentOfflineBackup(
        "e-other",
        {
          enrollmentId: "e1",
          authorizationId: "a1",
          activatedAt: at(2000),
          activatedByUserId: "u-act",
        },
        { authorizedAt: at(500), authorizedByUserId: "u-auth" },
        null,
        fullName,
      ),
    ).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });
});
