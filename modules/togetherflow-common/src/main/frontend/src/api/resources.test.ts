import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { TaskApi } from "./resources";

function setup(handler: (url: string, init: RequestInit) => unknown) {
  const fetchImpl = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const payload = handler(url, init);
    return new Response(JSON.stringify(payload ?? {}), {
      status: (init.method ?? "GET").toUpperCase() === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const api = new TaskApi(
    new ApiClient({ baseUrl: "/process-api", fetchImpl: fetchImpl as unknown as typeof fetch }),
  );
  return { api, fetchImpl };
}

const call = (fetchImpl: ReturnType<typeof vi.fn>, n = 0) =>
  fetchImpl.mock.calls[n] as [string, RequestInit];

describe("TaskApi.saveVariables", () => {
  it("does not PUT the collection — the engine has no such method", async () => {
    const { api, fetchImpl } = setup((url, init) => {
      if ((init.method ?? "GET") === "GET") {
        return [{ name: "initiator", type: "string", value: "mpe", scope: "global" }];
      }
      return { name: "initiator", type: "string", value: "mpe", scope: "global" };
    });

    await api.saveVariables("t1", [
      { name: "initiator", type: "string", value: "mpe", scope: "global" },
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(call(fetchImpl, 0)[0]).toMatch(/\/tasks\/t1\/variables$/);
    expect(call(fetchImpl, 0)[1].method ?? "GET").toBe("GET");
    expect(call(fetchImpl, 1)[0]).toMatch(/\/variables\/initiator$/);
    expect(call(fetchImpl, 1)[1].method).toBe("PUT");
    expect(JSON.parse(call(fetchImpl, 1)[1].body as string)).toEqual({
      name: "initiator",
      type: "string",
      value: "mpe",
      scope: "global",
    });
  });

  it("POSTs names that are not yet on the task, keeping one scope per request", async () => {
    const { api, fetchImpl } = setup((url, init) => {
      if ((init.method ?? "GET") === "GET") return [];
      return JSON.parse(init.body as string);
    });

    await api.saveVariables("t1", [
      { name: "employeeId", type: "string", value: "MPE-1" },
      { name: "employeeName", type: "string", value: "Rahim" },
    ]);

    expect(call(fetchImpl, 1)[0]).toMatch(/\/tasks\/t1\/variables$/);
    expect(call(fetchImpl, 1)[1].method).toBe("POST");
    expect(JSON.parse(call(fetchImpl, 1)[1].body as string)).toEqual([
      { name: "employeeId", type: "string", value: "MPE-1", scope: "local" },
      { name: "employeeName", type: "string", value: "Rahim", scope: "local" },
    ]);
  });

  it("updates existing names and creates new ones in the same save", async () => {
    const { api, fetchImpl } = setup((url, init) => {
      if ((init.method ?? "GET") === "GET") {
        return [{ name: "initiator", type: "string", value: "mpe", scope: "global" }];
      }
      if ((init.method ?? "").toUpperCase() === "PUT") {
        return JSON.parse(init.body as string);
      }
      return JSON.parse(init.body as string);
    });

    await api.saveVariables("t1", [
      { name: "initiator", type: "string", value: "mpe", scope: "global" },
      { name: "employeeId", type: "string", value: "MPE-1" },
    ]);

    const methods = fetchImpl.mock.calls.map(([, init]) => (init as RequestInit).method ?? "GET");
    expect(methods).toEqual(["GET", "PUT", "POST"]);
  });
});
