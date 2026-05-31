/**
 * Swamp model `@nblair2/igor2/reservations` — the igor2 reservation lifecycle:
 * create / show / list / edit / delete against `/igor/reservations`.
 *
 * Connection and credentials are configured once via the model's global
 * arguments. Methods and resources are inlined into `export const model` so the
 * swamp-club registry's static content extractor can index them.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  GlobalArgsSchema,
  IgorApiError,
  ReservationSchema,
  reservationsFromData,
} from "./_lib/igor.ts";
import {
  clientFor,
  inst,
  type MethodResult,
  type ModelContext,
  writeList,
} from "./_lib/model.ts";

const PREFIX = "reservation";

const CreateArgs = z.object({
  name: z.string().min(1).describe("Unique reservation name"),
  nodeList: z.string().optional().describe(
    "Explicit nodes, e.g. 'kn1,kn3' or 'kn[1-5]' (mutually exclusive with nodeCount)",
  ),
  nodeCount: z.number().int().positive().optional().describe(
    "Number of any available nodes to reserve (mutually exclusive with nodeList)",
  ),
  profile: z.string().optional().describe(
    "Boot profile name (provide profile OR distro)",
  ),
  distro: z.string().optional().describe(
    "Boot distro name (provide profile OR distro)",
  ),
  duration: z.union([z.string(), z.number()]).optional().describe(
    "Length, e.g. '3d' or '5h30m', or a Unix-epoch end time",
  ),
  start: z.number().optional().describe("Start time as a Unix-epoch timestamp"),
  group: z.string().optional().describe("Group to grant access to"),
  vlan: z.string().optional().describe(
    "VLAN id, or the name of a reservation to share a VLAN with",
  ),
  kernelArgs: z.string().optional().describe("Extra kernel arguments"),
  description: z.string().optional().describe("Free-text description"),
  owner: z.string().optional().describe("Owner username (admin only)"),
  noCycle: z.boolean().optional().describe("Skip the power cycle on install"),
}).refine((a) => !!a.nodeList !== !!a.nodeCount, {
  message: "provide exactly one of nodeList or nodeCount",
}).refine((a) => !!a.profile !== !!a.distro, {
  message: "provide exactly one of profile or distro",
});

const NameArg = z.object({
  name: z.string().min(1).describe("Reservation name"),
});

const ListArgs = z.object({});

const EditArgs = z.object({
  name: z.string().min(1).describe("Reservation to edit"),
  extend: z.union([z.string(), z.number()]).optional().describe(
    "Extend by a duration ('3d') or to a Unix-epoch end time",
  ),
  extendMax: z.boolean().optional().describe("Extend to the maximum allowed"),
  drop: z.string().optional().describe("Nodes to remove, e.g. 'kn[1-3]'"),
  addNodeList: z.string().optional().describe("Nodes to add, e.g. 'kn[10-12]'"),
  addNodeCount: z.number().int().positive().optional().describe(
    "Number of additional nodes to add",
  ),
  distro: z.string().optional().describe("Change boot distro"),
  profile: z.string().optional().describe("Change boot profile"),
  newName: z.string().optional().describe("Rename the reservation"),
  owner: z.string().optional().describe("Transfer ownership"),
  group: z.string().optional().describe("Change group ('none' to clear)"),
  kernelArgs: z.string().optional().describe("Update kernel arguments"),
  description: z.string().optional().describe("Update description"),
});

/** Build the create request body from validated arguments. */
function createBody(a: z.infer<typeof CreateArgs>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: a.name };
  if (a.nodeList !== undefined) body.nodeList = a.nodeList;
  if (a.nodeCount !== undefined) body.nodeCount = a.nodeCount;
  if (a.profile !== undefined) body.profile = a.profile;
  if (a.distro !== undefined) body.distro = a.distro;
  if (a.duration !== undefined) body.duration = a.duration;
  if (a.start !== undefined) body.start = a.start;
  if (a.group !== undefined) body.group = a.group;
  if (a.vlan !== undefined) body.vlan = a.vlan;
  if (a.kernelArgs !== undefined) body.kernelArgs = a.kernelArgs;
  if (a.description !== undefined) body.description = a.description;
  if (a.owner !== undefined) body.owner = a.owner;
  if (a.noCycle !== undefined) body.noCycle = a.noCycle;
  return body;
}

/** Build the PATCH request body from validated edit arguments. */
function editBody(a: z.infer<typeof EditArgs>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (a.extend !== undefined) body.extend = a.extend;
  if (a.extendMax !== undefined) body.extendMax = a.extendMax;
  if (a.drop !== undefined) body.drop = a.drop;
  if (a.addNodeList !== undefined) body.addNodeList = a.addNodeList;
  if (a.addNodeCount !== undefined) body.addNodeCount = a.addNodeCount;
  if (a.distro !== undefined) body.distro = a.distro;
  if (a.profile !== undefined) body.profile = a.profile;
  if (a.newName !== undefined) body.name = a.newName;
  if (a.owner !== undefined) body.owner = a.owner;
  if (a.group !== undefined) body.group = a.group;
  if (a.kernelArgs !== undefined) body.kernelArgs = a.kernelArgs;
  if (a.description !== undefined) body.description = a.description;
  return body;
}

/** Find a named reservation in a list response, or `null`. */
function findReservation(
  list: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | null {
  return list.find((r) => r.name === name) ?? null;
}

/**
 * The `@nblair2/igor2/reservations` model: the igor2 node-reservation
 * lifecycle. See the README for the full method reference.
 */
export const model = {
  type: "@nblair2/igor2/reservations",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    reservation: {
      description: "An igor2 node reservation and its current host state",
      schema: ReservationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    reservation_create: {
      description:
        "Create a node reservation; idempotent (returns the existing one on conflict)",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        let reservation: Record<string, unknown> | null;
        try {
          const res = await client.post("/reservations", createBody(args));
          reservation = reservationsFromData(res.data)[0] ??
            { name: args.name };
        } catch (err) {
          // Already exists (HTTP 409): fall back to returning current state.
          if (err instanceof IgorApiError && err.status === 409) {
            const list = await client.get("/reservations");
            reservation = findReservation(
              reservationsFromData(list.data),
              args.name,
            );
            if (!reservation) throw err;
          } else {
            throw err;
          }
        }
        const handle = await context.writeResource(
          "reservation",
          inst(PREFIX, args.name),
          reservation,
        );
        return { dataHandles: [handle] };
      },
    },

    reservation_show: {
      description: "Fetch a single reservation by name and store its state",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/reservations");
        const reservation = findReservation(
          reservationsFromData(res.data),
          args.name,
        );
        if (!reservation) {
          throw new Error(`reservation '${args.name}' not found`);
        }
        const handle = await context.writeResource(
          "reservation",
          inst(PREFIX, args.name),
          reservation,
        );
        return { dataHandles: [handle] };
      },
    },

    reservation_list: {
      description: "List all visible reservations, storing each one",
      arguments: ListArgs,
      execute: async (
        _args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/reservations");
        const handles = await writeList(
          context,
          "reservation",
          PREFIX,
          reservationsFromData(res.data),
        );
        return { dataHandles: handles };
      },
    },

    reservation_edit: {
      description:
        "Modify a reservation (extend, add/drop nodes, rename, re-distro, etc.)",
      arguments: EditArgs,
      execute: async (
        args: z.infer<typeof EditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const body = editBody(args);
        if (Object.keys(body).length === 0) {
          throw new Error("no changes provided to reservation_edit");
        }
        await client.patch(
          `/reservations/${encodeURIComponent(args.name)}`,
          body,
        );
        // Re-read so stored state reflects the edit (and any rename).
        const finalName = args.newName ?? args.name;
        const list = await client.get("/reservations");
        const reservation = findReservation(
          reservationsFromData(list.data),
          finalName,
        ) ?? { name: finalName };
        const handle = await context.writeResource(
          "reservation",
          inst(PREFIX, finalName),
          reservation,
        );
        return { dataHandles: [handle] };
      },
    },

    reservation_delete: {
      description: "Delete a reservation",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/reservations/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },
  },
};
