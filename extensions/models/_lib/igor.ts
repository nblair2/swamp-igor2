/**
 * Shared client for the igor2 cluster node-reservation manager REST API.
 *
 * igor2 exposes a JSON REST API rooted at `/igor` over HTTPS (default port
 * 8443). Authentication is a two-step flow: `GET /igor/login` with HTTP Basic
 * credentials returns a JWT (delivered as the `auth_token` cookie) which is then
 * sent as a `Bearer` token on every subsequent request. All responses share a
 * common envelope `{ status, message, serverTime, data }`.
 *
 * Most endpoints take/return JSON, but the boot stack (distros, images,
 * kickstarts) uses `multipart/form-data` for create/register/edit so kernel,
 * initrd and kickstart files can be uploaded. GET endpoints accept query-string
 * filters. This module centralizes connection config, the login handshake, the
 * request envelope handling, query/multipart encoding, and small typed wrappers
 * so the model methods stay thin.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";

/**
 * Connection and credential arguments shared by every method of the model.
 * Reused as the model's `globalArguments` schema.
 */
export const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "igor2 server hostname or IP (e.g. igor.example.com)",
  ),
  port: z.number().int().positive().default(8443).describe(
    "igor2 server HTTPS port (default 8443)",
  ),
  username: z.string().min(1).describe("igor2 username for login"),
  password: z.string().meta({ sensitive: true }).describe(
    "igor2 password for login",
  ),
  caCert: z.string().meta({ sensitive: true }).optional().describe(
    "PEM-encoded CA certificate to trust when the igor2 server uses a " +
      "self-signed or private-CA certificate",
  ),
});

/** Validated connection/credential arguments. */
export type IgorGlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Successful result of a single API call: the HTTP status and envelope data. */
export interface ApiResult {
  /** HTTP status code of the response. */
  status: number;
  /** The `data` object from the igor2 response envelope. */
  data: Record<string, unknown>;
  /** The `message` field from the envelope, if present. */
  message: string;
}

/** Error thrown when igor2 returns a `fail`/`error` envelope or a non-OK HTTP status. */
export class IgorApiError extends Error {
  /** HTTP status code that accompanied the failure (0 for client-side errors). */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IgorApiError";
    this.status = status;
  }
}

/** Minimal fetch signature so tests can inject a stub. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Reads a file's bytes; defaults to `Deno.readFile`, overridable in tests. */
export type ReadFileLike = (path: string) => Promise<Uint8Array>;

/** Optional dependencies, primarily for testing. */
export interface IgorDeps {
  /** Override the global `fetch` (used to stub HTTP in unit tests). */
  fetch?: FetchLike;
  /** Override file reading (used to stub multipart uploads in unit tests). */
  readFile?: ReadFileLike;
}

/** Query-string values: scalars or arrays (arrays repeat the key). */
export type QueryValue = string | number | boolean | string[] | undefined;

/** Per-request options shared by every verb. */
export interface RequestOpts {
  /** Query-string parameters appended to the URL. */
  query?: Record<string, QueryValue>;
  /** HTTP statuses to treat as success (e.g. `[409]` for idempotent create). */
  allowStatuses?: number[];
}

/** A connected, authenticated igor2 client. */
export interface IgorClient {
  /** Issue a GET against `path` (relative to `/igor`). */
  get(path: string, opts?: RequestOpts): Promise<ApiResult>;
  /** Issue a POST with a JSON body. */
  post(
    path: string,
    body: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PATCH with a JSON body. */
  patch(
    path: string,
    body: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PUT (optionally with a JSON body). */
  put(
    path: string,
    body?: Record<string, unknown>,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a DELETE. */
  del(path: string, opts?: RequestOpts): Promise<ApiResult>;
  /** Issue a POST with a `multipart/form-data` body. */
  postForm(
    path: string,
    form: FormData,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
  /** Issue a PATCH with a `multipart/form-data` body. */
  patchForm(
    path: string,
    form: FormData,
    opts?: RequestOpts,
  ): Promise<ApiResult>;
}

/** Build the base URL (`https://host:port/igor`) for a connection. */
export function baseUrl(cfg: Pick<IgorGlobalArgs, "host" | "port">): string {
  return `https://${cfg.host}:${cfg.port}/igor`;
}

/** Append query parameters to a URL, repeating keys for array values. */
function withQuery(url: string, query?: Record<string, QueryValue>): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) u.searchParams.append(key, String(item));
    } else {
      u.searchParams.append(key, String(value));
    }
  }
  return u.toString();
}

/**
 * Remove path-traversal and separator characters so a name is safe to use as a
 * swamp resource instance name (which maps directly to a storage path).
 */
export function sanitizeInstanceName(name: string): string {
  return name.replace(/\.\./g, "").replace(/[/\\]/g, "_");
}

/**
 * Build a `multipart/form-data` body from scalar/array fields plus files read
 * from local paths. Scalars are stringified; arrays repeat the field name;
 * each file path is read into a `File` part named after the path's basename.
 * Throws `IgorApiError` (status 0) if a file path cannot be read so the caller
 * gets a clear message instead of an opaque fetch failure.
 */
export async function buildForm(
  fields: Record<string, QueryValue>,
  files: Array<{ field: string; path: string }> = [],
  readFile: ReadFileLike = Deno.readFile,
): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, String(item));
    } else {
      form.append(key, String(value));
    }
  }
  for (const { field, path } of files) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new IgorApiError(
        `cannot read file '${path}' for field '${field}': ${reason}`,
        0,
      );
    }
    const fileName = path.split(/[/\\]/).pop() || field;
    form.append(field, new File([bytes as BlobPart], fileName));
  }
  return form;
}

/** Extract the `auth_token` JWT from a login response's Set-Cookie headers. */
function tokenFromCookies(res: Response): string | null {
  const cookies = res.headers.getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  for (const cookie of cookies) {
    const match = cookie.match(/auth_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

/** Parse the shared igor2 response envelope, tolerating non-JSON error bodies. */
async function parseEnvelope(
  res: Response,
): Promise<{ status: string; message: string; data: Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    // Non-JSON body (e.g. a proxy error page) — leave body empty.
  }
  return {
    status: typeof body.status === "string" ? body.status : "",
    message: typeof body.message === "string" ? body.message : "",
    data: (body.data && typeof body.data === "object")
      ? body.data as Record<string, unknown>
      : {},
  };
}

/**
 * Log in to igor2 and return an authenticated client.
 *
 * Performs `GET /igor/login` with HTTP Basic auth, captures the `auth_token`
 * JWT, and returns helpers that attach it as a `Bearer` token on every call.
 * When `caCert` is set, a dedicated Deno HTTP client is created so the
 * self-signed/private-CA server certificate is trusted.
 */
export async function connect(
  cfg: IgorGlobalArgs,
  deps: IgorDeps = {},
): Promise<IgorClient> {
  const fetchFn: FetchLike = deps.fetch ?? (globalThis.fetch as FetchLike);
  const root = baseUrl(cfg);

  // Trust a provided CA cert (only meaningful with the real Deno fetch).
  let clientInit: RequestInit = {};
  if (cfg.caCert && !deps.fetch && "createHttpClient" in Deno) {
    const httpClient = (Deno as unknown as {
      createHttpClient: (o: { caCerts: string[] }) => unknown;
    }).createHttpClient({ caCerts: [cfg.caCert] });
    clientInit = { client: httpClient } as RequestInit;
  }

  const basic = "Basic " + btoa(`${cfg.username}:${cfg.password}`);
  const loginRes = await fetchFn(`${root}/login`, {
    method: "GET",
    headers: { "Authorization": basic },
    ...clientInit,
  });
  if (!loginRes.ok) {
    const env = await parseEnvelope(loginRes);
    throw new IgorApiError(
      env.message || `login failed (HTTP ${loginRes.status})`,
      loginRes.status,
    );
  }
  const token = tokenFromCookies(loginRes);
  if (!token) {
    throw new IgorApiError(
      "login succeeded but no auth_token cookie was returned",
      loginRes.status,
    );
  }

  async function send(
    method: string,
    path: string,
    opts: {
      body?: Record<string, unknown>;
      form?: FormData;
      query?: Record<string, QueryValue>;
      allowStatuses?: number[];
    },
  ): Promise<ApiResult> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
    };
    let bodyInit: BodyInit | undefined;
    if (opts.form !== undefined) {
      // Let fetch set the multipart Content-Type (with boundary) itself.
      bodyInit = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }
    const res = await fetchFn(withQuery(`${root}${path}`, opts.query), {
      method,
      headers,
      body: bodyInit,
      ...clientInit,
    });
    const env = await parseEnvelope(res);
    const ok = res.ok && env.status !== "fail" && env.status !== "error";
    if (!ok && !(opts.allowStatuses ?? []).includes(res.status)) {
      throw new IgorApiError(
        env.message || `request to ${path} failed (HTTP ${res.status})`,
        res.status,
      );
    }
    return { status: res.status, data: env.data, message: env.message };
  }

  return {
    get: (path, opts) =>
      send("GET", path, {
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    post: (path, body, opts) =>
      send("POST", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    patch: (path, body, opts) =>
      send("PATCH", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    put: (path, body, opts) =>
      send("PUT", path, {
        body,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    del: (path, opts) =>
      send("DELETE", path, {
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    postForm: (path, form, opts) =>
      send("POST", path, {
        form,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
    patchForm: (path, form, opts) =>
      send("PATCH", path, {
        form,
        query: opts?.query,
        allowStatuses: opts?.allowStatuses,
      }),
  };
}

// --- Typed response shapes (declared loosely; igor2 fields vary by version) ---

/**
 * Array field that tolerates igor2's inconsistent empty encoding: some endpoints
 * return `[]` for an empty list, others return `null` (and a missing key is also
 * possible). All three are normalized to `[]` so downstream consumers always see
 * an array.
 */
const arr = (el: z.ZodTypeAny) =>
  z.array(el).nullish().transform((v) => v ?? []);

/** A reservation as returned under `data.reservation[]`. */
export const ReservationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
  profile: z.string().optional(),
  distro: z.string().optional(),
  vlan: z.union([z.number(), z.string()]).optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  origEnd: z.number().optional(),
  extendCount: z.number().optional(),
  hosts: arr(z.string()),
  hostRange: z.string().optional(),
  // igor returns these as range-notation strings (e.g. "kn[1-3,5]"), not arrays.
  hostsUp: z.string().optional(),
  hostsOn: z.string().optional(),
  hostsPing: z.string().optional(),
  hostsOff: z.string().optional(),
  hostsPowerNA: z.string().optional(),
  installed: z.boolean().optional(),
  installError: z.string().optional(),
  remainHours: z.number().optional(),
}).passthrough();

/** A host as returned under `data.hosts[]`. */
export const HostSchema = z.object({
  name: z.string(),
  hostName: z.string().optional(),
  sequenceID: z.number().optional(),
  eth: z.string().optional(),
  ip: z.string().optional(),
  mac: z.string().optional(),
  bootMode: z.string().optional(),
  state: z.string().optional(),
  powered: z.string().optional(),
  cluster: z.string().optional(),
  hostPolicy: z.string().optional(),
  accessGroups: arr(z.string()),
  restricted: z.boolean().optional(),
  reservations: arr(z.string()),
}).passthrough();

/** A boot distro as returned under `data.distro[]` / `data.distros[]`. */
export const DistroSchema = z.object({
  name: z.string(),
  isDefault: z.boolean().optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  groups: arr(z.string()),
  image_type: z.string().optional(),
  kernel: z.string().optional(),
  initrd: z.string().optional(),
  kernelArgs: z.string().optional(),
  kickstart: z.string().optional(),
  isPublic: z.boolean().optional(),
}).passthrough();

/** A boot profile as returned under `data.profile[]` / `data.profiles[]`. */
export const ProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  distro: z.string().optional(),
  kernelArgs: z.string().optional(),
}).passthrough();

/** A distro image as returned under `data.image` / `data.distroImages[]`. */
export const ImageSchema = z.object({
  name: z.string(),
  image_id: z.string().optional(),
  image_type: z.string().optional(),
  kernel: z.string().optional(),
  initrd: z.string().optional(),
  distros: arr(z.string()),
  breed: z.string().optional(),
  local: z.string().optional(),
  boot: arr(z.string()),
}).passthrough();

/** A kickstart file as returned under `data.kickstarts[]`. */
export const KickstartSchema = z.object({
  name: z.string(),
  fileName: z.string().optional(),
  owner: z.string().optional(),
}).passthrough();

/** A user as returned under `data.users[]`. */
export const UserSchema = z.object({
  name: z.string(),
  fullName: z.string().optional(),
  email: z.string().optional(),
  groups: arr(z.string()),
  joinDate: z.union([z.number(), z.string()]).optional(),
}).passthrough();

/** A group as returned under `data.owner[]` / `data.member[]`. */
export const GroupSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  owners: arr(z.string()),
  members: arr(z.string()),
  distros: arr(z.string()),
  hostPolicies: arr(z.string()),
  reservations: arr(z.string()),
}).passthrough();

/** A cluster as returned under `data.clusters[]`. */
export const ClusterSchema = z.object({
  name: z.string(),
  prefix: z.string().optional(),
  displayHeight: z.number().optional(),
  displayWidth: z.number().optional(),
  motd: z.string().optional(),
  motdUrgent: z.boolean().optional(),
}).passthrough();

/** A host policy as returned under `data.hostPolicy[]` / `data.hostPolicies[]`. */
export const HostPolicySchema = z.object({
  name: z.string(),
  hosts: z.string().optional(),
  maxResTime: z.string().optional(),
  accessGroups: arr(z.string()),
  scheduleBlock: arr(z.record(z.string(), z.unknown())),
}).passthrough();

/** Return the first array found among `keys` in an envelope's data object. */
function arrayFrom(
  data: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown>[] {
  for (const key of keys) {
    const arr = data[key];
    if (Array.isArray(arr)) return arr as Record<string, unknown>[];
  }
  return [];
}

/** Coerce a single-object-or-array value into an array of objects. */
function objectsFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

/** Extract the reservation array from a list/create response envelope. */
export function reservationsFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return arrayFrom(data, "reservation", "reservations");
}

/** Extract the host array from a hosts response envelope. */
export function hostsFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return arrayFrom(data, "hosts", "host");
}

/** Extract distros (create returns `distro`, list returns `distros`). */
export function distrosFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return objectsFrom(data.distro).concat(arrayFrom(data, "distros"));
}

/** Extract profiles (create returns `profile`, list returns `profiles`). */
export function profilesFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return objectsFrom(data.profile).concat(arrayFrom(data, "profiles"));
}

/** Extract images (register returns `image`, list returns `distroImages`). */
export function imagesFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return objectsFrom(data.image).concat(
    arrayFrom(data, "distroImages", "images"),
  );
}

/** Extract kickstarts from a `data.kickstarts[]` envelope. */
export function kickstartsFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return arrayFrom(data, "kickstarts", "kickstart");
}

/** Extract users from a `data.users[]` envelope. */
export function usersFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return arrayFrom(data, "users", "user");
}

/**
 * Extract groups, merging the `owner` and `member` arrays igor2 returns and
 * de-duplicating by name (a group can appear in both lists).
 */
export function groupsFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const all = [
    ...arrayFrom(data, "groups"),
    ...arrayFrom(data, "owner"),
    ...arrayFrom(data, "member"),
  ];
  const byName = new Map<string, Record<string, unknown>>();
  for (const g of all) {
    const name = typeof g.name === "string" ? g.name : JSON.stringify(g);
    if (!byName.has(name)) byName.set(name, g);
  }
  return [...byName.values()];
}

/** Extract clusters from a `data.clusters[]` envelope. */
export function clustersFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return arrayFrom(data, "clusters", "cluster");
}

/** Extract host policies (create returns `hostPolicy`, list `hostPolicies`). */
export function hostPoliciesFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  return objectsFrom(data.hostPolicy).concat(
    arrayFrom(data, "hostPolicies", "hostpolicies"),
  );
}
