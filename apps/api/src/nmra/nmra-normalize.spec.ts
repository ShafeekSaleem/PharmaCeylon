import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import {
  isRegNoHeader,
  loadNmraProductsFromBuffer,
  loadNmraProductsFromExcel,
  normalizeHeaderKey,
  parseNmraProductRows,
  selectDemoStockRegistrationNos,
  splitBrandAndProductName,
  type NmraProductRow,
} from "./nmra-normalize";

describe("nmra-normalize shared helpers", () => {
  it("normalizes REG. NO. headers to the same token as REG.NO.", () => {
    expect(normalizeHeaderKey("REG. NO.")).toBe("REGNO");
    expect(normalizeHeaderKey("REG.NO.")).toBe("REGNO");
    expect(normalizeHeaderKey("\uFEFFReg No")).toBe("REGNO");
    expect(isRegNoHeader("REG. NO.")).toBe(true);
    expect(isRegNoHeader("REGISTRATION NO")).toBe(true);
    expect(isRegNoHeader("GENERIC NAME")).toBe(false);
  });

  it("parses barcode column when present", () => {
    const rows = parseNmraProductRows([
      {
        "REG.NO.": "M999001",
        "BRAND NAME": "TESTBRAND 500MG",
        "GENERIC NAME": "PARACETAMOL TABLETS 500 MG",
        DOSAGE: "TABLETS",
        SCHEDULE: "IIA",
        BARCODE: "4791234567890",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.barcode).toBe("4791234567890");
    expect(rows[0]!.brandName).toBe("TESTBRAND");
    expect(rows[0]!.name).toBe("TESTBRAND 500MG");
  });

  it("accepts spaced REG. NO. / REGI. TYPE headers from newer NMRA exports", () => {
    const rows = parseNmraProductRows([
      {
        "GENERIC NAME": "PARACETAMOL TABLETS 500 MG",
        BRAND: "TESTBRAND 500",
        DOSAGE: "TABLETS",
        "REG. NO.": "M999010",
        SCHEDULE: "II B",
        "REGI. TYPE": "Full",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registrationNo).toBe("M999010");
    expect(rows[0]!.regType).toBe("Full");
    expect(rows[0]!.brandName).toBe("TESTBRAND");
  });

  it("detects header row below title rows and picks the REG sheet", () => {
    const aoa = [
      ["Valid Registration List", null, null],
      ["Exported 30.07.2026", null, null],
      ["GENERIC NAME", "BRAND", "REG. NO.", "SCHEDULE"],
      ["IBUPROFEN TABLETS 200 MG", "ALPHA", "M999011", "II A"],
      ["AMOXICILLIN CAPSULES 250 MG", "BETA", "M999012", "II B"],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["noop"]]), "Cover");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Valid registartion");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const rows = loadNmraProductsFromBuffer(buffer, { filename: "fixture.xlsx" });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.registrationNo).sort()).toEqual(["M999011", "M999012"]);
  });

  it("applies barcode map by registration number", () => {
    const rows = parseNmraProductRows(
      [
        {
          "REG.NO.": "M999002",
          "BRAND NAME": "ALPHA",
          "GENERIC NAME": "IBUPROFEN CAPSULES 200 MG",
          DOSAGE: "CAPSULES",
          SCHEDULE: "IIB",
        },
      ],
      { barcodeByRegNo: new Map([["M999002", "8901234567890"]]) },
    );
    expect(rows[0]!.barcode).toBe("8901234567890");
  });

  it("selects diverse demo stock up to target", () => {
    const products: NmraProductRow[] = [];
    const schedules = ["I", "II A", "II B", "II C", "III"] as const;
    const forms = ["Tablet", "Capsule", "Injection", "Syrup"] as const;
    let n = 0;
    for (const schedule of schedules) {
      for (const form of forms) {
        for (let i = 0; i < 15; i++) {
          n += 1;
          products.push({
            id: `id-${n}`,
            sku: `M${String(n).padStart(6, "0")}`,
            name: `PRODUCT ${n}`,
            brandName: `BRAND ${n}`,
            genericName: null,
            manufacturer: null,
            dosageForm: form.toUpperCase(),
            dosageFormGroup: form,
            strength: null,
            unit: "STRIP",
            packSize: null,
            packType: null,
            barcode: null,
            registrationNo: `M${String(n).padStart(6, "0")}`,
            registrationDate: null,
            schedule,
            scheduleGroup: schedule,
            regType: "N",
            dossierNo: null,
            countryOfOrigin: null,
            localAgent: null,
            isControlled: schedule === "II C" || schedule === "III",
            requiresPrescription: schedule !== "I" && schedule !== "II A",
            isUnbranded: false,
            isActive: true,
            reorderLevel: 0,
          });
        }
      }
    }
    const selected = selectDemoStockRegistrationNos(products, 80);
    expect(selected.length).toBe(80);
    expect(new Set(selected).size).toBe(80);
  });

  it("does not over-split VERMOR 1", () => {
    expect(splitBrandAndProductName("VERMOR 1").brandName).toBe("VERMOR 1");
  });

  it("parses bundled NMRA seed Excel with rows > 0", () => {
    const seedPath = path.join(
      __dirname,
      "..",
      "..",
      "prisma",
      "data",
      "nmra-valid-registration.xls",
    );
    if (!fs.existsSync(seedPath)) return;
    const rows = loadNmraProductsFromExcel(seedPath);
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows[0]!.registrationNo).toMatch(/^M\d+/i);
  });

  it("parses user Downloads NMRA export with REG. NO. column when present", () => {
    const userPath = path.join(
      process.env.USERPROFILE ?? process.env.HOME ?? "",
      "Downloads",
      "6a6c1e4cd905f50a9a222fe3_valid registrations-30.07.2026 (1).xls",
    );
    if (!fs.existsSync(userPath)) return;
    const rows = loadNmraProductsFromExcel(userPath);
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows[0]!.registrationNo).toMatch(/^M\d+/i);
  });
});
