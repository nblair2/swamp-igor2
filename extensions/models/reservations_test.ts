/**
 * Unit tests for the `@nblair2/igor2/reservations` model. Network-free: the
 * shared `harness` stubs `fetch` and the write context.
 *
 * @module
 */
import { model } from "./reservations.ts";
import {
  assert,
  assertEquals,
  harness,
  jsonResponse,
} from "./_lib/test_util.ts";

Deno.test("reservation_create requires one of nodeList/nodeCount and profile/distro", () => {
  const args = model.methods.reservation_create.arguments;
  assert(args.safeParse({ name: "r", nodeList: "kn1", profile: "p" }).success);
  assert(args.safeParse({ name: "r", nodeCount: 2, distro: "d" }).success);
  assert(!args.safeParse({ name: "r", profile: "p" }).success, "no nodes");
  assert(
    !args.safeParse({ name: "r", nodeList: "kn1", nodeCount: 2, profile: "p" })
      .success,
    "both node specs",
  );
  assert(
    !args.safeParse({ name: "r", nodeList: "kn1", profile: "p", distro: "d" })
      .success,
    "both boot specs",
  );
});

Deno.test("reservation_create posts the right body and stores the result", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST" && c.path.endsWith("/reservations")) {
      return jsonResponse(200, {
        status: "success",
        data: { reservation: [{ name: "r1", owner: "alice", hosts: ["kn1"] }] },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.reservation_create.arguments.parse({
    name: "r1",
    nodeList: "kn[1-2]",
    profile: "ubuntu",
    duration: "3d",
  });
  await model.methods.reservation_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.json?.name, "r1");
  assertEquals(post.json?.nodeList, "kn[1-2]");
  assertEquals(post.json?.profile, "ubuntu");
  assertEquals(post.json?.duration, "3d");
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "reservation");
  assertEquals(written[0].instanceName, "reservation-r1");
});

Deno.test("reservation_create is idempotent on HTTP 409", async () => {
  const { context, written } = harness((c) => {
    if (c.method === "POST") {
      return jsonResponse(409, {
        status: "fail",
        message: "reservation already exists",
        data: {},
      });
    }
    return jsonResponse(200, {
      status: "success",
      data: { reservation: [{ name: "r1", owner: "alice" }] },
    });
  });
  const args = model.methods.reservation_create.arguments.parse({
    name: "r1",
    nodeCount: 2,
    distro: "centos7",
  });
  await model.methods.reservation_create.execute(args, context);

  assertEquals(written.length, 1);
  assertEquals((written[0].data as { name: string }).name, "r1");
});

Deno.test("reservation_list stores each reservation under a unique instance", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: { reservation: [{ name: "a" }, { name: "b" }] },
    })
  );
  await model.methods.reservation_list.execute({}, context);

  assertEquals(written.length, 2);
  assertEquals(
    written.map((w) => w.instanceName),
    ["reservation-a", "reservation-b"],
  );
});
