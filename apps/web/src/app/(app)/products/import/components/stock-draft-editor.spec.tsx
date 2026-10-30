import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { StockDraftEditor, type StockDraftView } from "./stock-draft-editor";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const row = {
  rowNumber: 2,
  productId: "product",
  name: "Panadol",
  categoryName: "Medicines",
  qty: 10,
  costPrice: 7.25,
  sellingPrice: 10,
  batchNo: "B1",
  expiryDate: "2028-01-01T00:00:00.000Z",
};
const view: StockDraftView = {
  importId: "import-a",
  version: 4,
  rows: [row],
  stagedBy: "owner",
  postedAt: null,
};
const api = jest.mocked(apiJson);
beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue(view);
});
const open = () =>
  render(
    <StockDraftEditor
      key="a"
      branchId="branch-a"
      importId="import-a"
      canEditCosts
    />,
  );
function readFile(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

it("saves a version-pinned multipart draft and never calls a stock posting route", async () => {
  open();
  fireEvent.change(await screen.findByLabelText("Quantity row 2"), {
    target: { value: "12" },
  });
  api.mockResolvedValue({ ...view, version: 5, rows: [{ ...row, qty: 12 }] });
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  await screen.findByRole("status");
  const [path, request] = api.mock.calls[1];
  expect(path).toBe("/products/import/import-a/stock/replace");
  expect(request).toMatchObject({
    method: "POST",
    headers: { "x-branch-id": "branch-a" },
  });
  const payload = JSON.parse(
    await readFile((request!.body as FormData).get("file") as File),
  );
  expect(payload).toEqual({ version: 4, rows: [{ ...row, qty: 12 }] });
  expect(
    screen.queryByRole("button", { name: /^Post/ }),
  ).not.toBeInTheDocument();
  expect(api.mock.calls.some(([url]) => url.endsWith("/post"))).toBe(false);
});
it("preserves hidden costs by refusing client replacement rather than filling zero", async () => {
  api.mockResolvedValue({ ...view, rows: [{ ...row, costPrice: null }] });
  render(
    <StockDraftEditor
      branchId="branch-a"
      importId="import-a"
      canEditCosts={false}
    />,
  );
  expect(await screen.findByText("Hidden")).toBeInTheDocument();
  expect(screen.getByLabelText("Quantity row 2")).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save draft changes" }),
  ).not.toBeInTheDocument();
});
it("locks the whole draft after category posting and shows remaining quantities", async () => {
  api.mockResolvedValue({
    ...view,
    postedAt: "2026-10-30T00:00:00Z",
    rows: [
      { ...row, postedBatchId: "posted" },
      { ...row, rowNumber: 3, categoryName: "Retail", qty: 5 },
    ],
  });
  open();
  expect(
    await screen.findByText(/entire draft is now locked/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Quantity row 3")).toBeDisabled();
  expect(screen.getByText(/1 of 2 rows posted/)).toHaveTextContent(
    "5 units waiting",
  );
  fireEvent.change(screen.getByLabelText("Show draft category"), {
    target: { value: JSON.stringify("Retail") },
  });
  expect(screen.queryByLabelText("Quantity row 2")).not.toBeInTheDocument();
});
it("hides previously loaded costs immediately when cost access is removed", async () => {
  const { rerender } = open();
  await screen.findByLabelText("Cost row 2");
  rerender(
    <StockDraftEditor
      key="a"
      branchId="branch-a"
      importId="import-a"
      canEditCosts={false}
    />,
  );
  expect(screen.queryByLabelText("Cost row 2")).not.toBeInTheDocument();
  expect(screen.getByText("Hidden")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save draft changes" }),
  ).not.toBeInTheDocument();
});
it("requires a reload after a version conflict and never reports a stale save as complete", async () => {
  open();
  fireEvent.change(await screen.findByLabelText("Quantity row 2"), {
    target: { value: "12" },
  });
  api.mockRejectedValueOnce(new ApiError("Staged stock changed", 409, {}));
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  expect(
    await screen.findByText(/Another person changed or posted/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save draft changes" }),
  ).toBeDisabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  api.mockResolvedValue({ ...view, version: 5 });
  fireEvent.click(screen.getByRole("button", { name: /Reload draft/ }));
  expect(await screen.findByText(/Version 5/)).toBeInTheDocument();
  expect(screen.getByLabelText("Quantity row 2")).toHaveValue(10);
});
it("ignores old branch reads when the keyed editor switches branch", async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation((_, init) =>
    (init?.headers as Record<string, string>)["x-branch-id"] === "branch-a"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          ...view,
          importId: "import-b",
          rows: [{ ...row, name: "Galle item" }],
        }),
  );
  const { rerender } = open();
  rerender(
    <StockDraftEditor
      key="b"
      branchId="branch-b"
      importId="import-b"
      canEditCosts
    />,
  );
  await screen.findByText("Galle item");
  await act(async () => finish(view));
  expect(screen.queryByText("Panadol")).not.toBeInTheDocument();
  expect(screen.getByText("Galle item")).toBeInTheDocument();
});
it("renders document-sized drafts in pages of 25 rows", async () => {
  api.mockResolvedValue({
    ...view,
    rows: Array.from({ length: 30 }, (_, index) => ({
      ...row,
      rowNumber: index + 1,
      name: `Product ${index + 1}`,
    })),
  });
  open();
  await screen.findByText("Product 1");
  expect(screen.queryByText("Product 26")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
  expect(screen.getByText("Product 26")).toBeInTheDocument();
  expect(screen.queryByText("Product 1")).not.toBeInTheDocument();
});
it("refuses an emptied price box instead of saving it as zero", async () => {
  open();
  const price = await screen.findByLabelText("Selling price row 2");
  fireEvent.change(price, { target: { value: "" } });
  expect(price).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Save draft changes" }));
  expect(await screen.findByText(/Empty boxes are not saved as 0/)).toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(1);
});
