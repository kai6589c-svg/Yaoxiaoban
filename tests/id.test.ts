import { describe, expect, it, vi } from "vitest";
import { createId, createRequestId } from "../miniprogram/core/id";

describe("identifier generation", () => {
  it("creates prefixed, non-equal identifiers at the same timestamp", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const first = createId("med", 1_700_000_000_000);
    const second = createId("med", 1_700_000_000_000);
    expect(first).toMatch(/^med_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/);
    expect(second).not.toBe(first);
    expect(createRequestId()).toMatch(/^req_/);
    vi.restoreAllMocks();
  });
});
