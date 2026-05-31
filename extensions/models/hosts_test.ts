/**
 * Unit tests for the `@nblair2/igor2/hosts` model. Network-free.
 *
 * @module
 */
import { model } from "./hosts.ts";
import {
  assert,
  assertEquals,
  harness,
  jsonResponse,
} from "./_lib/test_util.ts";

Deno.test("host_power requires exactly one target", () => {
  const args = model.methods.host_power.arguments;
  assert(args.safeParse({ cmd: "on", hosts: "kn1" }).success);
  assert(args.safeParse({ cmd: "cycle", reservation: "r1" }).success);
  assert(!args.safeParse({ cmd: "on" }).success, "no target");
  assert(
    !args.safeParse({ cmd: "on", hosts: "kn1", reservation: "r1" }).success,
    "two targets",
  );
});

Deno.test("host_power sends cmd + target and stores a powerResult", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.path.endsWith("/hosts-ctrl/power")) {
      return jsonResponse(200, { status: "success", data: { kn1: "on" } });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.host_power.arguments.parse({
    cmd: "cycle",
    hosts: "kn[1-3]",
  });
  await model.methods.host_power.execute(args, context);

  const patch = calls.find((c) => c.path.endsWith("/hosts-ctrl/power"))!;
  assertEquals(patch.json?.cmd, "cycle");
  assertEquals(patch.json?.hosts, "kn[1-3]");
  assertEquals(written[0].specName, "powerResult");
  assertEquals((written[0].data as { command: string }).command, "cycle");
});

Deno.test("host_block sends hosts+block and records the operation", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.path.endsWith("/hosts-ctrl/block")) {
      return jsonResponse(200, {
        status: "success",
        message: "hosts blocked",
        data: { hosts: ["kn1", "kn2"] },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.host_block.arguments.parse({
    hosts: "kn[1-2]",
    block: true,
  });
  await model.methods.host_block.execute(args, context);

  const patch = calls.find((c) => c.path.endsWith("/hosts-ctrl/block"))!;
  assertEquals(patch.json?.hosts, "kn[1-2]");
  assertEquals(patch.json?.block, true);
  assertEquals(written[0].specName, "operation");
  assertEquals((written[0].data as { operation: string }).operation, "block");
});

Deno.test("host_status fetches one host by query and stores it", async () => {
  const { context, written, calls } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: { hosts: [{ name: "kn1", powered: "true" }] },
    })
  );
  const args = model.methods.host_status.arguments.parse({ name: "kn1" });
  await model.methods.host_status.execute(args, context);

  assertEquals(new URLSearchParams(calls[0].search).get("name"), "kn1");
  assertEquals(written[0].specName, "host");
  assertEquals(written[0].instanceName, "host-kn1");
});
