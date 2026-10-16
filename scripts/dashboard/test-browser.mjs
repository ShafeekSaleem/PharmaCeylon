// Real web -> Nest -> PostgreSQL smoke test. Creates a fresh synthetic tenant only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";
import { StockService } from "../../apps/api/dist/src/inventory/stock/stock.service.js";

if (
  process.env.DASHBOARD_BROWSER_TEST_ACK !== "ephemeral-database" ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    "Requires DASHBOARD_BROWSER_TEST_ACK=ephemeral-database and a disposable migrated DATABASE_URL",
  );
}
const repo = resolve(import.meta.dirname, "../..");
const out = resolve(
  process.env.DASHBOARD_SCREENSHOT_DIR ??
    resolve(repo, "test-results/dashboard"),
);
mkdirSync(out, { recursive: true });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = randomUUID().slice(0, 8),
  password = "QA-" + randomUUID();
const roles = ["owner", "manager", "pharmacist", "cashier", "inventory_clerk"];
const users = {};
const children = [];
let browser;
function start(args, cwd, name, extra = {}) {
  const stream = createWriteStream(resolve(out, name + ".log"));
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  children.push(child);
  return child;
}
async function waitFor(url) {
  for (let n = 0; n < 120; n++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Server unavailable: " + url);
}
async function seed() {
  const tenant = await prisma.tenant.create({
    data: {
      code: "dashboard-qa-" + suffix,
      legalName: "Dashboard QA Pharmacy",
      displayName: "Dashboard QA Pharmacy",
      complianceRegion: "LK",
      timezone: "Asia/Colombo",
    },
  });
  const tenantId = tenant.id;
  const branches = [];
  for (const [code, name] of [
    ["MAIN", "Colombo Central"],
    ["KANDY", "Kandy Central"],
  ])
    branches.push(
      await prisma.branch.create({
        data: { tenantId, code, name, timezone: "Asia/Colombo" },
      }),
    );
  const [main, other] = branches;
  const hash = await bcrypt.hash(password, 10);
  for (const role of roles) {
    users[role] = await prisma.appUser.create({
      data: {
        tenantId,
        email: `${role}-${suffix}@example.test`,
        fullName:
          role === "inventory_clerk"
            ? "Demo Stock Clerk"
            : "Demo " + role[0].toUpperCase() + role.slice(1),
        passwordHash: hash,
      },
    });
    await prisma.tenantMembership.create({
      data: { tenantId, userId: users[role].id },
    });
    for (const branch of branches)
      await prisma.userBranchRole.create({
        data: { tenantId, userId: users[role].id, branchId: branch.id, role },
      });
  }
  await prisma.tenantSettings.create({
    data: { tenantId, selfApprovalRoleKeys: ["owner"] },
  });
  const supplier = await prisma.supplier.create({
    data: { tenantId, code: "QA-SUP", name: "Demo Medical Supplies" },
  });
  const products = [];
  for (const [sku, name, qty, days] of [
    ["PARA", "Paracetamol 500 mg", 90, 365],
    ["AMOX", "Amoxicillin 250 mg", 6, 20],
    ["EXP", "Expiry review example", 12, -2],
  ]) {
    const product = await prisma.product.create({
      data: { tenantId, sku, name, rangeStatus: "RANGED", reorderLevel: 10 },
    });
    products.push(product);
    const batch = await prisma.batch.create({
      data: {
        tenantId,
        branchId: main.id,
        productId: product.id,
        batchNo: "QA-" + sku,
        expiryDate: new Date(Date.now() + days * 86400000),
        costPrice: 15,
        sellingPrice: 25,
      },
    });
    await prisma.$transaction((tx) =>
      new StockService().receive(
        tx,
        {
          tenantId,
          branchId: main.id,
          userId: users.inventory_clerk.id,
          referenceType: "dashboard_qa",
          referenceId: tenantId,
        },
        [
          {
            productId: product.id,
            batchId: batch.id,
            qty,
            movementType: "opening_stock",
          },
        ],
      ),
    );
  }
  const today = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Colombo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()) + "T00:00:00Z",
  );
  const orders = [];
  for (let n = 0; n < 14; n++)
    orders.push(
      await prisma.purchaseOrder.create({
        data: {
          tenantId,
          branchId: main.id,
          supplierId: supplier.id,
          poNumber: `PO-QA-${String(n + 1).padStart(4, "0")}`,
          status: "pending_approval",
          createdBy: n === 1 ? users.manager.id : users.inventory_clerk.id,
          expectedOn: new Date(today.getTime() + (n === 0 ? -2 : 3) * 86400000),
          items: {
            create: {
              tenantId,
              productId: products[0].id,
              orderedQty: 40,
              unitCost: 15,
            },
          },
        },
      }),
    );
  await prisma.purchaseOrder.create({
    data: {
      tenantId,
      branchId: main.id,
      supplierId: supplier.id,
      poNumber: "PO-QA-RECEIVING",
      status: "issued",
      createdBy: users.owner.id,
      expectedOn: today,
      items: {
        create: {
          tenantId,
          productId: products[0].id,
          orderedQty: 30,
          unitCost: 15,
        },
      },
    },
  });
  await prisma.purchaseOrder.create({
    data: {
      tenantId,
      branchId: other.id,
      supplierId: supplier.id,
      poNumber: "PO-KANDY-ONLY",
      status: "pending_approval",
      createdBy: users.inventory_clerk.id,
    },
  });
  const count = await prisma.stocktake.create({
    data: {
      tenantId,
      branchId: main.id,
      stocktakeNumber: "ST-QA-0086",
      status: "counting",
      scope: "cycle",
      countedBy: users.inventory_clerk.id,
      reviewerId: users.manager.id,
      title: "Evening shelf count",
      areaLabel: "Aisle B",
    },
  });
  await prisma.stocktakeAssignment.create({
    data: { tenantId, stocktakeId: count.id, userId: users.inventory_clerk.id },
  });
  for (const role of ["cashier", "pharmacist"])
    await prisma.heldSale.create({
      data: {
        tenantId,
        branchId: main.id,
        holdRef: role === "cashier" ? "HOLD-QA-0062" : "HOLD-QA-0063",
        label: "Demo counter hold",
        heldBy: users[role].id,
        itemCount: 2,
        total: 450,
        payload: { items: [], meta: { needsPharmacist: role === "cashier" } },
        createdAt: new Date(Date.now() - 25 * 60000),
      },
    });
  for (const [number, from, to, status] of [
    ["TR-QA-0214", other, main, "in_transit"],
    ["TR-QA-0215", main, other, "approved"],
  ])
    await prisma.transfer.create({
      data: {
        tenantId,
        fromBranchId: from.id,
        toBranchId: to.id,
        transferNumber: number,
        status,
        requestedBy: users.inventory_clerk.id,
        approvedBy: users.manager.id,
        expectedOn: today,
        items: { create: { tenantId, productId: products[0].id, qty: 4 } },
      },
    });
  for (let n = 0; n < 65; n++)
    await prisma.sale.create({
      data: {
        tenantId,
        branchId: main.id,
        invoiceNo: "QA-SALE-" + n,
        subtotal: 250,
        grandTotal: 250,
        soldBy: users.cashier.id,
        soldAt: new Date(),
        payments: {
          create: { tenantId, method: n % 2 ? "cash" : "card", amount: 250 },
        },
      },
    });
  return { tenantId, main, other, orders };
}
async function queueData(page, filter = "all", category = "") {
  const response = await page.request.get(
    `http://localhost:3000/api/v1/dashboard/work?filter=${filter}&page=1${category ? "&category=" + category : ""}`,
    { headers: { "x-branch-id": fixture.main.id } },
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
let fixture;
const results = [];
try {
  fixture = await seed();
  const env = {
    PORT: "3001",
    WEB_ORIGINS: "http://localhost:3000",
    JWT_ACCESS_SECRET: "qa-" + randomUUID(),
    JWT_REFRESH_SECRET: "qa-" + randomUUID(),
    JWT_ONBOARDING_SECRET: "qa-" + randomUUID(),
    EMAIL_DELIVERY_MODE: "console",
    COOKIE_SECURE: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    STRUCTURED_HTTP_LOG: "true",
  };
  start(["dist/src/main.js"], resolve(repo, "apps/api"), "api", env);
  start(
    [
      resolve(repo, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      "3000",
      "--hostname",
      "127.0.0.1",
    ],
    resolve(repo, "apps/web"),
    "web",
    env,
  );
  await waitFor("http://127.0.0.1:3001/api/v1/health");
  await waitFor("http://localhost:3000/login");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.DASHBOARD_CHROMIUM_PATH
      ? {
          executablePath: process.env.DASHBOARD_CHROMIUM_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {}),
  });
  for (const role of roles) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [],
      failures = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 500)
        failures.push({ path: new URL(r.url()).pathname, status: r.status() });
    });
    await page.goto("http://localhost:3000/login");
    await page.getByLabel("Email", { exact: true }).fill(users[role].email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Today’s priorities", exact: true })
      .waitFor({ timeout: 30000 });
    await page
      .getByText("Loading your priorities…", { exact: true })
      .waitFor({ state: "hidden" });
    await page
      .getByText("Loading dashboard metrics…", { exact: true })
      .waitFor({ state: "hidden", timeout: 30000 });
    const queue = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: "Today’s priorities",
          exact: true,
        }),
      })
      .first();
    const data = await queueData(page);
    assert.ok(data.total > 0, role + " needs seeded work");
    for (const [filter, label] of [
      ["mine", "Assigned to me"],
      ["approvals", "Needs my decision"],
      ["overdue", "Overdue"],
      ["all", "All work"],
    ]) {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/dashboard/work?") &&
          new URL(r.url()).searchParams.get("filter") === filter,
      );
      await queue
        .getByRole("button", { name: new RegExp("^" + label) })
        .click();
      const r = await response;
      assert.equal(r.status(), 200);
      const d = await r.json();
      assert.equal(d.total, d.counts[filter], role + " " + filter);
      await page.waitForFunction(
        (count) =>
          document
            .getElementById("daily-work-title")
            ?.closest("section")
            ?.querySelectorAll("article").length === count,
        d.items.length,
      );
    }
    if (data.total > 6) {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/dashboard/work?") &&
          new URL(r.url()).searchParams.get("page") === "2",
      );
      await queue.getByRole("button", { name: "Next", exact: true }).click();
      const second = await (await response).json();
      assert.ok(
        second.items.every((i) => !data.items.some((j) => i.id === j.id)),
      );
      const back = page.waitForResponse(
        (r) =>
          r.url().includes("/dashboard/work?") &&
          new URL(r.url()).searchParams.get("page") === "1",
      );
      await queue
        .getByRole("button", { name: "Previous", exact: true })
        .click();
      await back;
    }
    const category = page.waitForResponse(
      (r) =>
        r.url().includes("/dashboard/work?") &&
        new URL(r.url()).searchParams.get("category") === "counter",
    );
    await page
      .getByRole("combobox", { name: "Work category", exact: true })
      .selectOption("counter");
    const cd = await (await category).json();
    assert.ok(cd.items.every((i) => i.category === "counter"));
    const reset = page.waitForResponse(
      (r) =>
        r.url().includes("/dashboard/work?") &&
        !new URL(r.url()).searchParams.get("category"),
    );
    await page
      .getByRole("combobox", { name: "Work category", exact: true })
      .selectOption("");
    await reset;
    await page.screenshot({
      path: resolve(out, role + "-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      role + " desktop overflow",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    const clipped = await page
      .locator("[data-widget-key]")
      .evaluateAll((cards) =>
        cards.flatMap((card) =>
          [
            ...card.querySelectorAll(
              '[class*="overviewSubcard"], [class*="cashFlowBody"], [class*="panelFooter"]',
            ),
          ]
            .filter(
              (el) =>
                el.scrollHeight > el.clientHeight + 2 ||
                el.scrollWidth > el.clientWidth + 2,
            )
            .map((el) => ({
              widget: card.getAttribute("data-widget-key"),
              element: el.className,
              height: el.clientHeight,
              scrollHeight: el.scrollHeight,
              width: el.clientWidth,
              scrollWidth: el.scrollWidth,
            })),
        ),
      );
    assert.deepEqual(clipped, [], role + " clipped chart/footer content");
    await page.screenshot({
      path: resolve(out, role + "-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      role + " mobile overflow",
    );
    if (role === "pharmacist") {
      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "dark"),
      );
      await page.screenshot({
        path: resolve(out, "pharmacist-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    if (role === "manager") {
      await page.setViewportSize({ width: 1440, height: 1100 });
      const approvals = page.waitForResponse(
        (r) =>
          r.url().includes("/dashboard/work?") &&
          new URL(r.url()).searchParams.get("filter") === "approvals",
      );
      await queue.getByRole("button", { name: /^Needs my decision/ }).click();
      await approvals;
      await queue
        .getByRole("link", { name: "Review order: PO-QA-0001", exact: true })
        .click();
      const dialog = page.getByRole("dialog").filter({
        has: page.getByRole("heading", { name: "PO-QA-0001", exact: true }),
      });
      await dialog.waitFor();
      const approved = page.waitForResponse(
        (r) =>
          r
            .url()
            .endsWith(
              "/purchase-orders/" + fixture.orders[0].id + "/approve",
            ) && r.status() < 300,
      );
      await dialog
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      await approved;
      await page.goto("http://localhost:3000/dashboard");
      await page
        .getByRole("heading", { name: "Today’s priorities", exact: true })
        .waitFor();
      const advanced = await queueData(page, "all", "purchasing");
      assert.equal(
        advanced.items.find((i) => i.id === "po:" + fixture.orders[0].id)
          ?.status,
        "issued",
      );
      const decisions = await queueData(page, "approvals", "purchasing");
      assert.equal(
        decisions.total,
        12,
        "approved order and own blocked order are excluded",
      );
    }
    assert.deepEqual(errors, [], role + " browser errors");
    assert.deepEqual(failures, [], role + " server failures");
    results.push({
      role,
      total: data.total,
      counts: data.counts,
      filters: true,
      pagination: data.total > 6,
      category: true,
      desktopOverflow: false,
      mobileOverflow: false,
      errors,
      failures,
    });
    writeFileSync(
      resolve(out, "results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(role + " browser checks passed");
    await ctx.close();
  }
  console.log("Real dashboard browser smoke test passed for all five roles");
} catch (error) {
  if (browser) {
    for (const ctx of browser.contexts())
      for (const page of ctx.pages()) {
        await page
          .screenshot({ path: resolve(out, "failure.png"), fullPage: true })
          .catch(() => {});
        writeFileSync(
          resolve(out, "failure-body.txt"),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        );
      }
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of children) child.kill("SIGTERM");
  await prisma.$disconnect();
}
