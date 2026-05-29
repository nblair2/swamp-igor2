/**
 * Unit tests for the @nblair2/igor2 model methods. Uses a stubbed `fetch`
 * (injected via `context._deps`) and a fake write/read context — no live igor2
 * server required.
 *
 * @module
 */
import { model } from "./igor.ts";
import type { FetchLike, IgorGlobalArgs } from "./_lib/igor.ts";

const cfg: IgorGlobalArgs = {
  host: "igor.test",
  port: 8443,
  username: "alice",
  password: "secret",
};

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      msg ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function jsonResponse(
  status: number,
  env: Record<string, unknown>,
  setCookie?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(env), { status, headers });
}

interface Written {
  specName: string;
  instanceName: string;
  data: unknown;
}

/** Build a fake method context backed by an in-memory record of writes. */
function fakeContext(fetchStub: FetchLike) {
  const written: Written[] = [];
  const context = {
    globalArgs: cfg,
    _deps: { fetch: fetchStub },
    writeResource: (specName: string, instanceName: string, data: unknown) => {
      written.push({ specName, instanceName, data });
      return Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
      });
    },
    readResource: (_instanceName: string) =>
      Promise.resolve(null as Record<string, unknown> | null),
  };
  return { context, written };
}

/** Stub that always answers login, then defers other calls to `handler`. */
function withLogin(
  handler: (method: string, path: string, body: unknown) => Response,
): FetchLike {
  return (input, init) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(200, { status: "success", data: {} }, "auth_token=T"),
      );
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return Promise.resolve(handler(init?.method ?? "GET", u.pathname, body));
  };
}

// --- argument-schema validation ---

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

// --- method behavior ---

Deno.test("reservation_create posts the right body and stores the result", async () => {
  let posted: Record<string, unknown> | undefined;
  const stub = withLogin((method, path, body) => {
    if (method === "POST" && path.endsWith("/reservations")) {
      posted = body as Record<string, unknown>;
      return jsonResponse(200, {
        status: "success",
        data: { reservation: [{ name: "r1", owner: "alice", hosts: ["kn1"] }] },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const { context, written } = fakeContext(stub);
  const args = model.methods.reservation_create.arguments.parse({
    name: "r1",
    nodeList: "kn[1-2]",
    profile: "ubuntu",
    duration: "3d",
  });
  await model.methods.reservation_create.execute(args, context);

  assertEquals(posted?.name, "r1");
  assertEquals(posted?.nodeList, "kn[1-2]");
  assertEquals(posted?.profile, "ubuntu");
  assertEquals(posted?.duration, "3d");
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "reservation");
  assertEquals(written[0].instanceName, "reservation-r1");
});

Deno.test("reservation_create is idempotent on HTTP 409", async () => {
  const stub = withLogin((method) => {
    if (method === "POST") {
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
  const { context, written } = fakeContext(stub);
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
  const stub = withLogin(() =>
    jsonResponse(200, {
      status: "success",
      data: { reservation: [{ name: "a" }, { name: "b" }] },
    })
  );
  const { context, written } = fakeContext(stub);
  await model.methods.reservation_list.execute({}, context);

  assertEquals(written.length, 2);
  assertEquals(
    written.map((w) => w.instanceName),
    ["reservation-a", "reservation-b"],
  );
});

Deno.test("host_power sends cmd + target and stores a powerResult", async () => {
  let body: Record<string, unknown> | undefined;
  const stub = withLogin((_method, path, b) => {
    if (path.endsWith("/hosts-ctrl/power")) {
      body = b as Record<string, unknown>;
      return jsonResponse(200, { status: "success", data: { kn1: "on" } });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const { context, written } = fakeContext(stub);
  const args = model.methods.host_power.arguments.parse({
    cmd: "cycle",
    hosts: "kn[1-3]",
  });
  await model.methods.host_power.execute(args, context);

  assertEquals(body?.cmd, "cycle");
  assertEquals(body?.hosts, "kn[1-3]");
  assertEquals(written[0].specName, "powerResult");
  assertEquals((written[0].data as { command: string }).command, "cycle");
});

Deno.test("show stores a dashboard with derived counts", async () => {
  const stub = withLogin(() =>
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
  const { context, written } = fakeContext(stub);
  await model.methods.show.execute({}, context);

  assertEquals(written[0].specName, "dashboard");
  assertEquals(written[0].instanceName, "dashboard-JOTUN");
  assertEquals((written[0].data as { hostCount: number }).hostCount, 1);
  assertEquals(
    (written[0].data as { reservationCount: number }).reservationCount,
    2,
  );
});
