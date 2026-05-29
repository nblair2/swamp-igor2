/**
 * Unit tests for the igor2 `_lib` client. Uses a stubbed `fetch` so no network
 * or live server is required.
 *
 * @module
 */
import {
  baseUrl,
  buildForm,
  connect,
  distrosFromData,
  type FetchLike,
  GroupSchema,
  groupsFromData,
  IgorApiError,
  type IgorGlobalArgs,
  imagesFromData,
  ReservationSchema,
  reservationsFromData,
  sanitizeInstanceName,
} from "./igor.ts";

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

Deno.test("baseUrl builds the /igor root URL", () => {
  assertEquals(baseUrl(cfg), "https://igor.test:8443/igor");
});

Deno.test("sanitizeInstanceName strips traversal and separators", () => {
  assertEquals(sanitizeInstanceName("../a/b\\c"), "_a_b_c");
});

Deno.test("reservationsFromData handles both keys and non-arrays", () => {
  assertEquals(
    reservationsFromData({ reservation: [{ name: "x" }] }).length,
    1,
  );
  assertEquals(
    reservationsFromData({ reservations: [{ name: "y" }] }).length,
    1,
  );
  assertEquals(reservationsFromData({}).length, 0);
});

Deno.test("connect logs in with Basic and attaches Bearer afterward", async () => {
  const calls: Array<{ path: string; auth: string | null }> = [];
  const fetchStub: FetchLike = (input, init) => {
    const u = new URL(input);
    calls.push({
      path: u.pathname,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(
          200,
          { status: "success", data: {} },
          "auth_token=TOK; HttpOnly",
        ),
      );
    }
    return Promise.resolve(
      jsonResponse(200, { status: "success", data: { reservation: [] } }),
    );
  };

  const client = await connect(cfg, { fetch: fetchStub });
  await client.get("/reservations");

  assertEquals(calls[0].auth, "Basic " + btoa("alice:secret"));
  assertEquals(calls[1].auth, "Bearer TOK");
});

Deno.test("connect throws when login fails", async () => {
  const fetchStub: FetchLike = () =>
    Promise.resolve(
      jsonResponse(401, { status: "fail", message: "bad creds", data: {} }),
    );
  let threw = false;
  try {
    await connect(cfg, { fetch: fetchStub });
  } catch (e) {
    threw = true;
    assert(e instanceof IgorApiError, "expected IgorApiError");
    assertEquals((e as IgorApiError).status, 401);
  }
  assert(threw, "expected login to throw");
});

Deno.test("request throws IgorApiError on a fail envelope", async () => {
  const fetchStub: FetchLike = (input) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(200, { status: "success", data: {} }, "auth_token=T"),
      );
    }
    return Promise.resolve(
      jsonResponse(404, { status: "fail", message: "not found", data: {} }),
    );
  };
  const client = await connect(cfg, { fetch: fetchStub });
  let threw = false;
  try {
    await client.get("/reservations");
  } catch (e) {
    threw = true;
    assert(e instanceof IgorApiError);
    assertEquals((e as IgorApiError).status, 404);
    assertEquals((e as IgorApiError).message, "not found");
  }
  assert(threw, "expected request to throw");
});

Deno.test("allowStatuses suppresses the throw and returns data", async () => {
  const fetchStub: FetchLike = (input) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(200, { status: "success", data: {} }, "auth_token=T"),
      );
    }
    return Promise.resolve(
      jsonResponse(409, { status: "fail", message: "exists", data: {} }),
    );
  };
  const client = await connect(cfg, { fetch: fetchStub });
  const res = await client.post("/reservations", { name: "x" }, {
    allowStatuses: [409],
  });
  assertEquals(res.status, 409);
});

Deno.test("get appends query params, repeating keys for arrays", async () => {
  let requested = "";
  const fetchStub: FetchLike = (input) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(200, { status: "success", data: {} }, "auth_token=T"),
      );
    }
    requested = u.search;
    return Promise.resolve(
      jsonResponse(200, { status: "success", data: { distros: [] } }),
    );
  };
  const client = await connect(cfg, { fetch: fetchStub });
  await client.get("/distros", {
    query: { name: "d1", boot: ["bios", "uefi"], skip: undefined },
  });
  const params = new URLSearchParams(requested);
  assertEquals(params.get("name"), "d1");
  assertEquals(params.getAll("boot"), ["bios", "uefi"]);
  assertEquals(params.has("skip"), false);
});

Deno.test("put sends a PUT and unwraps the envelope data", async () => {
  let method = "";
  const fetchStub: FetchLike = (input, init) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/login")) {
      return Promise.resolve(
        jsonResponse(200, { status: "success", data: {} }, "auth_token=T"),
      );
    }
    method = init?.method ?? "";
    return Promise.resolve(
      jsonResponse(200, { status: "success", data: { result: "ok" } }),
    );
  };
  const client = await connect(cfg, { fetch: fetchStub });
  const res = await client.put("/authreset");
  assertEquals(method, "PUT");
  assertEquals(res.data.result, "ok");
});

Deno.test("buildForm encodes scalars, arrays, and uploaded files", async () => {
  const form = await buildForm(
    { name: "d1", boot: ["bios", "uefi"], skip: undefined },
    [{ field: "kernelFile", path: "/tmp/vmlinuz" }],
    (_p: string) => Promise.resolve(new Uint8Array([1, 2, 3])),
  );
  assertEquals(form.get("name"), "d1");
  assertEquals(form.getAll("boot"), ["bios", "uefi"]);
  assertEquals(form.has("skip"), false);
  const file = form.get("kernelFile");
  assert(file instanceof File, "kernelFile should be a File");
  assertEquals((file as File).name, "vmlinuz");
});

Deno.test("buildForm throws a clear error when a file path is unreadable", async () => {
  let threw = false;
  try {
    await buildForm(
      {},
      [{ field: "kernelFile", path: "/no/such" }],
      () => Promise.reject(new Error("ENOENT")),
    );
  } catch (e) {
    threw = true;
    assert(e instanceof IgorApiError);
    assert((e as IgorApiError).message.includes("/no/such"));
  }
  assert(threw, "expected buildForm to throw");
});

Deno.test("groupsFromData merges owner and member, de-duping by name", () => {
  const merged = groupsFromData({
    owner: [{ name: "g1" }, { name: "g2" }],
    member: [{ name: "g2" }, { name: "g3" }],
  });
  assertEquals(merged.map((g) => g.name), ["g1", "g2", "g3"]);
});

Deno.test("distros/images extractors handle singular and plural keys", () => {
  assertEquals(distrosFromData({ distro: { name: "d" } }).length, 1);
  assertEquals(
    distrosFromData({ distros: [{ name: "a" }, { name: "b" }] }).length,
    2,
  );
  assertEquals(imagesFromData({ image: { name: "i" } }).length, 1);
  assertEquals(imagesFromData({ distroImages: [{ name: "x" }] }).length, 1);
});

Deno.test("schemas normalize null/absent array fields to []", () => {
  // igor returns null (not []) for empty arrays on several endpoints.
  const g = GroupSchema.parse({
    name: "g1",
    members: null,
    distros: null,
    owners: ["alice"],
    // hostPolicies, reservations absent entirely
  });
  assertEquals(g.members, []);
  assertEquals(g.distros, []);
  assertEquals(g.owners, ["alice"]);
  assertEquals(g.hostPolicies, []);
  assertEquals(g.reservations, []);
});

Deno.test("ReservationSchema: hostsUp/On/Off are range strings; hosts is an array", () => {
  const r = ReservationSchema.parse({
    name: "r1",
    hosts: null,
    hostRange: "kn[1-3]",
    hostsUp: "kn[1-2]",
    hostsOff: "kn[3]",
    hostsPowerNA: "",
    origEnd: 1000,
    extendCount: 1,
  });
  assertEquals(r.hosts, []);
  assertEquals(r.hostsUp, "kn[1-2]");
  assertEquals(r.hostsOff, "kn[3]");
  assertEquals(r.extendCount, 1);
});
