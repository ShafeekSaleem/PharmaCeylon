import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { TerminalEnrollmentOfflineBackup } from "@pharmaceylon/shared";
import {
  emptyOfflineBackup,
  formatOfflineActivated,
  formatOfflineAuthorized,
  offlineBackupNomination,
  tillDisplayName,
} from "./this-counter-display";

const formatFixed = () => "2 Jan 2020";
const tillId = "00000000-0000-4000-8000-0000000000d1";

describe("tillDisplayName", () => {
  it("uses counterLabel when the server sends a till name", () => {
    expect(tillDisplayName("Counter 2", tillId)).toBe("Counter 2");
  });

  it("falls back to a till id prefix when counterLabel is null", () => {
    expect(tillDisplayName(null, tillId)).toBe("00000000");
  });
});

describe("offlineBackupNomination", () => {
  it("is not nominated when every field is null", () => {
    expect(offlineBackupNomination(emptyOfflineBackup)).toBe("not_nominated");
  });

  it("is authorized-not-activated when only authorization is set", () => {
    const backup: TerminalEnrollmentOfflineBackup = {
      ...emptyOfflineBackup,
      authorizedAt: Date.UTC(2020, 0, 2),
      authorizedByUserId: "00000000-0000-4000-8000-000000000001",
      authorizedByFullName: "Dilini Fernando",
    };
    expect(offlineBackupNomination(backup)).toBe("authorized_not_activated");
  });

  it("is activated when activation is set", () => {
    const backup: TerminalEnrollmentOfflineBackup = {
      authorizedAt: Date.UTC(2020, 0, 1),
      authorizedByUserId: "00000000-0000-4000-8000-000000000002",
      authorizedByFullName: "Owner Name",
      activatedAt: Date.UTC(2020, 0, 2),
      activatedByUserId: "00000000-0000-4000-8000-000000000001",
      activatedByFullName: "Dilini Fernando",
    };
    expect(offlineBackupNomination(backup)).toBe("activated");
  });
});

describe("formatOfflineAuthorized", () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = tz;
  });

  it("includes the authorizer when present", () => {
    const text = formatOfflineAuthorized(
      {
        ...emptyOfflineBackup,
        authorizedAt: Date.UTC(2020, 0, 13),
        authorizedByUserId: "00000000-0000-4000-8000-000000000002",
        authorizedByFullName: "Dilini Fernando",
      },
      formatFixed,
    );
    expect(text).toBe("On the web by Dilini Fernando · 2 Jan 2020");
  });

  it("omits a invented name when authorizedByFullName is null", () => {
    const text = formatOfflineAuthorized(
      {
        ...emptyOfflineBackup,
        authorizedAt: Date.UTC(2020, 0, 13),
        authorizedByUserId: "00000000-0000-4000-8000-000000000002",
        authorizedByFullName: null,
      },
      formatFixed,
    );
    expect(text).toBe("On the web · 2 Jan 2020");
  });

  it("returns null when not authorized", () => {
    expect(formatOfflineAuthorized(emptyOfflineBackup, formatFixed)).toBeNull();
  });
});

describe("formatOfflineActivated", () => {
  it("includes the activator when present", () => {
    const text = formatOfflineActivated(
      {
        ...emptyOfflineBackup,
        activatedAt: Date.UTC(2020, 0, 14),
        activatedByUserId: "00000000-0000-4000-8000-000000000001",
        activatedByFullName: "Dilini Fernando",
      },
      formatFixed,
    );
    expect(text).toBe("Here by Dilini Fernando · 2 Jan 2020");
  });

  it("omits a invented name when activatedByFullName is null", () => {
    const text = formatOfflineActivated(
      {
        ...emptyOfflineBackup,
        activatedAt: Date.UTC(2020, 0, 14),
        activatedByUserId: "00000000-0000-4000-8000-000000000001",
        activatedByFullName: null,
      },
      formatFixed,
    );
    expect(text).toBe("Here · 2 Jan 2020");
  });
});
