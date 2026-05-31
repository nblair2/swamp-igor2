/**
 * Shared swamp-model plumbing for the `@nblair2/igor2` extension.
 *
 * The extension ships five models (`@nblair2/igor2/{reservations,hosts,boot,
 * identity,server}`), each a self-contained `export const model` so the
 * swamp-club registry's static content extractor can index its methods and
 * resources. This module holds the types and helpers those models share: the
 * method-execution context, resource-spec typing, a connected-client resolver,
 * and small helpers for building unique instance names and writing resources.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  connect,
  type IgorClient,
  type IgorDeps,
  type IgorGlobalArgs,
  sanitizeInstanceName,
} from "./igor.ts";

/** Handle returned by `context.writeResource` (subset we rely on). */
export interface WriteHandle {
  name: string;
  specName: string;
  kind: string;
}

/** Minimal structural type for the swamp method execution context. */
export interface ModelContext {
  globalArgs: IgorGlobalArgs;
  writeResource(
    specName: string,
    instanceName: string,
    data: unknown,
  ): Promise<WriteHandle>;
  readResource?(
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  /** Test-only hook to inject a pre-built client / file reader (see `_lib`). */
  _deps?: IgorDeps;
}

/** Standard return shape of a model method. */
export interface MethodResult {
  dataHandles: WriteHandle[];
}

/** A resource ("state") spec as stored in a model's `resources` registry. */
export interface ResourceSpec {
  description: string;
  schema: z.ZodTypeAny;
  lifetime: string;
  garbageCollection?: number;
}

/** Resolve a connected client, honoring a test-injected fetch when present. */
export function clientFor(context: ModelContext): Promise<IgorClient> {
  return connect(context.globalArgs, context._deps ?? {});
}

/** Build a unique, path-safe instance name (`<prefix>-<sanitized name>`). */
export function inst(prefix: string, name: string): string {
  return `${prefix}-${sanitizeInstanceName(name)}`;
}

/**
 * Write each object in `items` as its own resource instance, keyed by its
 * `name` field (falling back to `"unknown"`), and return the handles.
 */
export async function writeList(
  context: ModelContext,
  spec: string,
  prefix: string,
  items: Record<string, unknown>[],
): Promise<WriteHandle[]> {
  const handles: WriteHandle[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name : "unknown";
    handles.push(await context.writeResource(spec, inst(prefix, name), item));
  }
  return handles;
}

/** Write a single object as a resource instance and return its handle. */
export async function writeOne(
  context: ModelContext,
  spec: string,
  prefix: string,
  name: string,
  data: unknown,
): Promise<MethodResult> {
  const handle = await context.writeResource(spec, inst(prefix, name), data);
  return { dataHandles: [handle] };
}

/**
 * Schema for the `operation` resource: the outcome of a one-shot igor2 action
 * that has no resource of its own (elevate, sync, auth-reset, block, MOTD,
 * apply-policy, …). Models that record such actions inline an `operation`
 * resource spec referencing this schema and call {@link writeOperation}.
 */
export const operationSchema = z.object({
  operation: z.string(),
  target: z.string().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
  ranAt: z.string(),
}).passthrough();

/** Record the outcome of a one-shot action as an `operation` resource. */
export async function writeOperation(
  context: ModelContext,
  operation: string,
  details: { target?: string; message?: string; result?: unknown },
): Promise<MethodResult> {
  const handle = await context.writeResource(
    "operation",
    inst("op", `${operation}-${Date.now()}`),
    {
      operation,
      target: details.target,
      message: details.message,
      result: details.result,
      ranAt: new Date().toISOString(),
    },
  );
  return { dataHandles: [handle] };
}
