import { z } from "zod";
import { exportPlayerQuerySchema, listPlayerQuerySchema } from "../src/modules/player/player.validation";

describe("export query schemas", () => {
  it("accepts export requests with large pageSize by stripping pagination fields", () => {
    const parsed = exportPlayerQuerySchema.parse({
      pageSize: 10000,
      limit: 10000,
      page: 1,
      cursor: "abc",
      sortOrder: "desc",
      search: "trader",
    });

    expect(parsed).toEqual({
      sortBy: "createdAt",
      sortOrder: "desc",
      search: "trader",
    });
  });

  it("still rejects invalid filter values on export schema", () => {
    expect(() =>
      exportPlayerQuerySchema.parse({
        sortOrder: "invalid",
      }),
    ).toThrow();
  });

  it("list schema still enforces pageSize max for normal list requests", () => {
    expect(() =>
      listPlayerQuerySchema.parse({
        pageSize: 10000,
      }),
    ).toThrow();
  });
});
