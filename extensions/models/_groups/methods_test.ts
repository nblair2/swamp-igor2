/**
 * Unit tests for the expanded `@nblair2/igor2` methods (boot stack + admin).
 * Uses a stubbed `fetch` and `readFile` injected via `context._deps`, plus a
 * fake write context — no live igor2 server or real files required.
 *
 * @module
 */
import { model } from "../igor.ts";
import type { FetchLike, IgorGlobalArgs, ReadFileLike } from "../_lib/igor.ts";

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

function jsonResponse(status: number, env: Record<string, unknown>): Response {
  return new Response(JSON.stringify(env), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Written {
  specName: string;
  instanceName: string;
  data: unknown;
}

/** Captured request for assertions. */
interface Captured {
  method: string;
  path: string;
  search: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

/** Build a fake context plus a request log, answering login then `handler`. */
function harness(handler: (c: Captured) => Response) {
  const written: Written[] = [];
  const calls: Captured[] = [];
  const fetchStub: FetchLike = (input, init) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: {} }), {
          status: 200,
          headers: new Headers([
            ["content-type", "application/json"],
            ["set-cookie", "auth_token=T; HttpOnly"],
          ]),
        }),
      );
    }
    const c: Captured = {
      method: init?.method ?? "GET",
      path: u.pathname,
      search: u.search,
    };
    if (init?.body instanceof FormData) c.form = init.body;
    else if (typeof init?.body === "string") c.json = JSON.parse(init.body);
    calls.push(c);
    return Promise.resolve(handler(c));
  };
  const readFile: ReadFileLike = (_p) =>
    Promise.resolve(new Uint8Array([0, 1, 2]));
  const context = {
    globalArgs: cfg,
    _deps: { fetch: fetchStub, readFile },
    writeResource: (specName: string, instanceName: string, data: unknown) => {
      written.push({ specName, instanceName, data });
      return Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
      });
    },
    readResource: () => Promise.resolve(null as Record<string, unknown> | null),
  };
  return { context, written, calls };
}

// --- argument validation ---

Deno.test("distro_create requires exactly one source", () => {
  const args = model.methods.distro_create.arguments;
  assert(args.safeParse({ name: "d", copyDistro: "base" }).success);
  assert(
    args.safeParse({ name: "d", kernelFile: "/k", initrdFile: "/i" }).success,
  );
  assert(!args.safeParse({ name: "d" }).success, "no source");
  assert(
    !args.safeParse({ name: "d", copyDistro: "base", imageRef: "x" }).success,
    "two sources",
  );
  assert(
    !args.safeParse({ name: "d", kernelFile: "/k" }).success,
    "lone kernel file is not a complete source",
  );
});

Deno.test("user_edit enforces one mode and password needs oldPassword", () => {
  const a = model.methods.user_edit.arguments;
  assert(a.safeParse({ name: "u", email: "e@x" }).success);
  assert(a.safeParse({ name: "u", reset: true }).success);
  assert(a.safeParse({ name: "u", password: "p", oldPassword: "o" }).success);
  assert(!a.safeParse({ name: "u", password: "p" }).success, "missing old pw");
  assert(
    !a.safeParse({ name: "u", email: "e", reset: true }).success,
    "two modes",
  );
});

Deno.test("group_create forbids member/owner/description on LDAP groups", () => {
  const a = model.methods.group_create.arguments;
  assert(a.safeParse({ name: "g", isLDAP: true }).success);
  assert(a.safeParse({ name: "g", members: ["u"] }).success);
  assert(
    !a.safeParse({ name: "g", isLDAP: true, members: ["u"] }).success,
    "LDAP + members",
  );
});

Deno.test("group_edit allows exactly one facet", () => {
  const a = model.methods.group_edit.arguments;
  assert(a.safeParse({ name: "g", newName: "h" }).success);
  assert(a.safeParse({ name: "g", add: ["u"] }).success);
  assert(a.safeParse({ name: "g", addOwners: ["o"] }).success);
  assert(
    !a.safeParse({ name: "g", add: ["u"], addOwners: ["o"] }).success,
    "members + owners",
  );
});

Deno.test("auth_reset requires explicit confirm:true", () => {
  const a = model.methods.auth_reset.arguments;
  assert(a.safeParse({ confirm: true }).success);
  assert(!a.safeParse({}).success, "missing confirm");
  assert(!a.safeParse({ confirm: false }).success, "confirm false");
});

// --- method behavior ---

Deno.test("distro_create posts multipart with fields + files", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST" && c.path.endsWith("/distros")) {
      return jsonResponse(200, {
        status: "success",
        data: { distro: { name: "d1", owner: "alice" } },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.distro_create.arguments.parse({
    name: "d1",
    kernelFile: "/tmp/vmlinuz",
    initrdFile: "/tmp/initrd.img",
    boot: ["bios", "uefi"],
    public: true,
  });
  await model.methods.distro_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assert(post.form !== undefined, "should send FormData");
  assertEquals(post.form!.get("name"), "d1");
  assertEquals(post.form!.getAll("boot"), ["bios", "uefi"]);
  assertEquals(post.form!.get("public"), "true");
  assert(post.form!.get("kernelFile") instanceof File, "kernel uploaded");
  assertEquals(written[0].specName, "distro");
  assertEquals(written[0].instanceName, "distro-d1");
});

Deno.test("profile_create posts JSON and stores the profile", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST" && c.path.endsWith("/profiles")) {
      return jsonResponse(200, {
        status: "success",
        data: { profile: { name: "p1", distro: "d1" } },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.profile_create.arguments.parse({
    name: "p1",
    distro: "d1",
    kernelArgs: "quiet",
  });
  await model.methods.profile_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.json?.name, "p1");
  assertEquals(post.json?.distro, "d1");
  assertEquals(post.json?.kernelArgs, "quiet");
  assertEquals(written[0].instanceName, "profile-p1");
});

Deno.test("group_list merges owner and member arrays into instances", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: {
        owner: [{ name: "g1" }],
        member: [{ name: "g1" }, { name: "g2" }],
      },
    })
  );
  await model.methods.group_list.execute({}, context);
  assertEquals(written.map((w) => w.instanceName), ["group-g1", "group-g2"]);
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
  assertEquals((written[0].data as { operation: string }).operation, "block");
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
