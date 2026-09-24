import { apiFetch } from "./auth-client";

/**
 * The header a JSON request must carry.
 *
 * Forgetting `Content-Type` on a POST left the body unparsed at the API, which came back as a
 * validation error on every field of a payload that was correct — "supplierId must be a UUID,
 * items must be an array" for a request that contained both. The client sets it now, so these
 * pin that it does, and that an upload is left alone.
 */
describe("apiFetch headers", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ status: 200, ok: true, text: async () => "{}" });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function headersOf(call: number): Headers {
    return fetchMock.mock.calls[call]![1]!.headers as Headers;
  }

  it("labels a string body as JSON", async () => {
    await apiFetch("/purchasing/purchase-orders", {
      method: "POST",
      body: JSON.stringify({ supplierId: "s-1", items: [] }),
    });
    expect(headersOf(0).get("Content-Type")).toBe("application/json");
  });

  it("leaves a caller's own content type alone", async () => {
    await apiFetch("/things", {
      method: "POST",
      body: "a,b,c",
      headers: { "Content-Type": "text/csv" },
    });
    expect(headersOf(0).get("Content-Type")).toBe("text/csv");
  });

  it("does not set one for an upload, which sets its own with a boundary", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.csv");
    await apiFetch("/uploads/image", { method: "POST", body: form });
    expect(headersOf(0).get("Content-Type")).toBeNull();
  });

  it("does not set one on a GET with no body", async () => {
    await apiFetch("/purchasing/deliveries");
    expect(headersOf(0).get("Content-Type")).toBeNull();
  });
});
