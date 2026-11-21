import { nearDuplicateOf, normaliseCounterName } from "./counter-names";

describe("near-duplicate counter names (UI1 #205)", () => {
  it.each([
    ["Counter 1", "counter 1"],
    ["Counter 1", "Counter1"],
    ["Front counter", "  Front   Counter "],
    ["Front counter", "front-counter"],
    ["Counter 1", "Counter 1 (2)"],
    ["Dispensary", "Dispensary copy"],
  ])("treats %p and %p as names staff would mix up", (a, b) => {
    expect(normaliseCounterName(a)).toBe(normaliseCounterName(b));
  });

  it.each([
    ["Counter 1", "Counter 2"],
    ["Front counter", "Back counter"],
    ["Till 10", "Till 1"],
  ])("keeps %p and %p apart", (a, b) => {
    expect(normaliseCounterName(a)).not.toBe(normaliseCounterName(b));
  });

  it("names the first counter the new name is close to", () => {
    const others = [{ label: "Back counter" }, { label: "Front counter" }];
    expect(nearDuplicateOf("FRONT COUNTER (2)", others)?.label).toBe("Front counter");
    expect(nearDuplicateOf("Dispensary", others)).toBeNull();
  });

  it("says nothing about a blank or punctuation-only name", () => {
    expect(nearDuplicateOf("  ", [{ label: "" }])).toBeNull();
    expect(nearDuplicateOf("--", [{ label: "?" }])).toBeNull();
  });
});
