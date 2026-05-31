/**
 * Unit tests for the `@nblair2/igor2/server` model. Network-free.
 *
 * @module
 */
import { model } from "./server.ts";
import {
  assert,
  assertEquals,
  harness,
  jsonResponse,
} from "./_lib/test_util.ts";

Deno.test("auth_reset requires explicit confirm:true", () => {
  const a = model.methods.auth_reset.arguments;
  assert(a.safeParse({ confirm: true }).success);
  assert(!a.safeParse({}).success, "missing confirm");
  assert(!a.safeParse({ confirm: false }).success, "confirm false");
});

Deno.test("auth_reset issues a PUT and records the operation", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.path.endsWith("/authreset")) {
      return jsonResponse(200, {
        status: "success",
        message: "token secret refreshed successfully",
        data: { result: "token secret refreshed successfully" },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.auth_reset.arguments.parse({ confirm: true });
  await model.methods.auth_reset.execute(args, context);

  const put = calls.find((c) => c.path.endsWith("/authreset"))!;
  assertEquals(put.method, "PUT");
  assertEquals(written[0].specName, "operation");
  assertEquals(
    (written[0].data as { operation: string }).operation,
    "auth-reset",
  );
});

Deno.test("config_show reads /config and stores the igor config", async () => {
  const { context, written, calls } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: { igor: { instanceName: "JOTUN", tftp: "/tftp" } },
    })
  );
  await model.methods.config_show.execute({ public: false }, context);
  assertEquals(calls[0].path.endsWith("/config"), true);
  assertEquals(written[0].specName, "config");
  assertEquals(written[0].instanceName, "config-server");
  assertEquals(
    (written[0].data as { instanceName: string }).instanceName,
    "JOTUN",
  );
});

Deno.test("stats reads /stats with query params and stores a snapshot", async () => {
  const { context, written, calls } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: { stats: { resCount: 3 } },
    })
  );
  await model.methods.stats.execute(
    { start: "2026-May-28", duration: 30, verbose: true },
    context,
  );
  const params = new URLSearchParams(calls[0].search);
  assertEquals(params.get("start"), "2026-May-28");
  assertEquals(params.get("duration"), "30");
  assertEquals(params.get("verbose"), "true");
  assertEquals(written[0].instanceName, "stats-latest");
});

Deno.test("show stores a dashboard with derived counts", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: {
        show: {
          cluster: { name: "JOTUN" },
          hosts: [{ name: "kn1" }],
          reservations: [{ name: "r1" }, { name: "r2" }],
        },
      },
    })
  );
  await model.methods.show.execute({}, context);

  assertEquals(written[0].specName, "dashboard");
  assertEquals(written[0].instanceName, "dashboard-JOTUN");
  assertEquals((written[0].data as { hostCount: number }).hostCount, 1);
  assertEquals(
    (written[0].data as { reservationCount: number }).reservationCount,
    2,
  );
});
