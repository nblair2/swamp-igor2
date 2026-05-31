/**
 * Shared, network-free test helpers for the model unit tests. Provides tiny
 * assertion helpers, a JSON-envelope response builder, and a `harness()` that
 * answers the login handshake, logs each captured request (JSON or multipart),
 * and records every `writeResource` call against an in-memory context. Not a
 * test file itself (no `Deno.test`), so `deno test` never runs it directly.
 *
 * @module
 */
import type { FetchLike, IgorGlobalArgs, ReadFileLike } from "./igor.ts";
import type { ModelContext } from "./model.ts";

/** Connection args used across the unit tests. */
export const cfg: IgorGlobalArgs = {
  host: "igor.test",
  port: 8443,
  username: "alice",
  password: "secret",
};

export function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      msg ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Build a JSON envelope `Response` with the given HTTP status. */
export function jsonResponse(
  status: number,
  env: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(env), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A resource write recorded by the fake context. */
export interface Written {
  specName: string;
  instanceName: string;
  data: unknown;
}

/** A captured outbound request (for assertions). */
export interface Captured {
  method: string;
  path: string;
  search: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

/**
 * Build a fake method context plus a request log. The returned `fetch` answers
 * `/login` with an `auth_token` cookie, then defers all other calls to
 * `handler`, recording each as a {@link Captured} entry. `writeResource` pushes
 * to `written`; a stub `readFile` yields fixed bytes for multipart tests.
 */
export function harness(handler: (c: Captured) => Response): {
  context: ModelContext;
  written: Written[];
  calls: Captured[];
} {
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
  const context: ModelContext = {
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
