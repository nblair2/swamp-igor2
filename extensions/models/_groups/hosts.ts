/**
 * Host and host-policy methods for the `@nblair2/igor2` model.
 *
 * Hosts: power control (`/igor/hosts-ctrl/power`), list/inspect (`/igor/hosts`),
 * edit/delete (`/igor/hosts/:name`), block/unblock (`/igor/hosts-ctrl/block`),
 * and apply-policy (`/igor/hosts-ctrl/policy`). Host policies: full CRUD against
 * `/igor/hostpolicy`.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  hostPoliciesFromData,
  HostPolicySchema,
  HostSchema,
  hostsFromData,
} from "../_lib/igor.ts";
import {
  clientFor,
  defineMethod,
  inst,
  type MethodDef,
  type MethodResult,
  operationResource,
  type ResourceSpec,
  writeList,
  writeOne,
  writeOperation,
} from "../_lib/model.ts";

const HOST = "host";
const POLICY = "hostpolicy";

// --- argument schemas ---

const PowerArgs = z.object({
  cmd: z.enum(["on", "off", "cycle", "status"]).describe("Power command"),
  hosts: z.string().optional().describe(
    "Host range, e.g. 'kn[1-5]' (mutually exclusive with reservation)",
  ),
  reservation: z.string().optional().describe(
    "Reservation whose nodes to target (mutually exclusive with hosts)",
  ),
}).refine((a) => !!a.hosts !== !!a.reservation, {
  message: "provide exactly one of hosts or reservation",
});

const HostEditArgs = z.object({
  name: z.string().min(1).describe("Host name to edit, e.g. 'kn1'"),
  ip: z.string().optional().describe("New IP address"),
  hostname: z.string().optional().describe("New hostname"),
  boot: z.enum(["bios", "uefi"]).optional().describe("Boot mode"),
  mac: z.string().optional().describe("New MAC address"),
  eth: z.string().optional().describe("Ethernet interface name"),
  hostPolicy: z.string().optional().describe(
    "Host policy name ('' resets to the default policy)",
  ),
});

const BlockArgs = z.object({
  hosts: z.string().min(1).describe("Host range, e.g. 'kn[1-5]'"),
  block: z.boolean().describe("true to block, false to unblock"),
});

const ApplyPolicyArgs = z.object({
  nodeList: z.string().min(1).describe("Host range, e.g. 'kn[1-5]'"),
  policy: z.string().min(1).describe("Host policy name to apply"),
});

const ScheduleBlock = z.object({}).passthrough();

const PolicyCreateArgs = z.object({
  name: z.string().min(1).describe("Host policy name"),
  maxResTime: z.string().optional().describe(
    "Maximum reservation time as a duration, e.g. '24h' or '7d'",
  ),
  accessGroups: z.array(z.string()).optional().describe(
    "Groups allowed to reserve hosts under this policy",
  ),
  notAvailable: z.array(ScheduleBlock).optional().describe(
    "Cron-based unavailability blocks",
  ),
});

const PolicyEditArgs = z.object({
  name: z.string().min(1).describe("Host policy to edit"),
  newName: z.string().optional().describe("Rename the policy"),
  maxResTime: z.string().optional().describe("New maximum reservation time"),
  accessGroups: z.array(z.string()).optional().describe(
    "Replace access groups",
  ),
  notAvailable: z.array(ScheduleBlock).optional().describe(
    "Replace unavailability blocks",
  ),
});

const NameArg = z.object({ name: z.string().min(1).describe("Resource name") });

/** Resource specs owned by this group. */
export const resources: Record<string, ResourceSpec> = {
  host: {
    description: "An igor2 cluster host and its power/boot state",
    schema: HostSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  hostPolicy: {
    description: "An igor2 host policy (max reservation time, access groups)",
    schema: HostPolicySchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  powerResult: {
    description: "Result of a host power command",
    schema: z.object({
      command: z.string(),
      target: z.string(),
      result: z.unknown(),
      ranAt: z.string(),
    }).passthrough(),
    lifetime: "7d",
    garbageCollection: 10,
  },
  operation: operationResource,
};

/** Methods contributed by this group. */
export const methods: Record<string, MethodDef> = {
  host_power: defineMethod({
    description: "Power on/off/cycle nodes, or query their power status",
    arguments: PowerArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = { cmd: args.cmd };
      if (args.hosts !== undefined) body.hosts = args.hosts;
      if (args.reservation !== undefined) body.resName = args.reservation;
      const res = await client.patch("/hosts-ctrl/power", body);
      const handle = await context.writeResource(
        "powerResult",
        inst("power", `${args.cmd}-${Date.now()}`),
        {
          command: args.cmd,
          target: args.hosts ?? args.reservation ?? "",
          result: res.data,
          ranAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    },
  }),

  host_list: defineMethod({
    description: "List all hosts, storing each one",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/hosts");
      const handles = await writeList(
        context,
        "host",
        HOST,
        hostsFromData(res.data),
      );
      return { dataHandles: handles };
    },
  }),

  host_status: defineMethod({
    description: "Fetch a single host by name and store its state",
    arguments: z.object({
      name: z.string().min(1).describe("Host name, e.g. 'kn1'"),
    }),
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/hosts", { query: { name: args.name } });
      const host = hostsFromData(res.data).find((h) => h.name === args.name) ??
        hostsFromData(res.data)[0];
      if (!host) throw new Error(`host '${args.name}' not found`);
      return writeOne(context, "host", HOST, args.name, host);
    },
  }),

  host_edit: defineMethod({
    description:
      "Edit a host's network/boot attributes or its host policy (admin)",
    arguments: HostEditArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = {};
      if (args.ip !== undefined) body.ip = args.ip;
      if (args.hostname !== undefined) body.hostname = args.hostname;
      if (args.boot !== undefined) body.boot = args.boot;
      if (args.mac !== undefined) body.mac = args.mac;
      if (args.eth !== undefined) body.eth = args.eth;
      if (args.hostPolicy !== undefined) body.hostPolicy = args.hostPolicy;
      if (Object.keys(body).length === 0) {
        throw new Error("no changes provided to host_edit");
      }
      await client.patch(`/hosts/${encodeURIComponent(args.name)}`, body);
      const finalName = args.hostname ?? args.name;
      const res = await client.get("/hosts", { query: { name: finalName } });
      const host = hostsFromData(res.data).find((h) => h.name === finalName) ??
        hostsFromData(res.data)[0] ?? { name: finalName };
      return writeOne(context, "host", HOST, finalName, host);
    },
  }),

  host_delete: defineMethod({
    description: "Delete a host from igor2 (admin)",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/hosts/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  }),

  host_block: defineMethod({
    description: "Block or unblock hosts from being reserved (admin)",
    arguments: BlockArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.patch("/hosts-ctrl/block", {
        hosts: args.hosts,
        block: args.block,
      });
      return writeOperation(context, args.block ? "block" : "unblock", {
        target: args.hosts,
        message: res.message,
        result: res.data,
      });
    },
  }),

  host_apply_policy: defineMethod({
    description: "Apply a host policy to a set of hosts (admin)",
    arguments: ApplyPolicyArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.patch("/hosts-ctrl/policy", {
        nodeList: args.nodeList,
        policy: args.policy,
      });
      return writeOperation(context, "apply-policy", {
        target: `${args.nodeList} -> ${args.policy}`,
        message: res.message,
        result: res.data,
      });
    },
  }),

  hostpolicy_create: defineMethod({
    description: "Create a host policy (admin)",
    arguments: PolicyCreateArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = { name: args.name };
      if (args.maxResTime !== undefined) body.maxResTime = args.maxResTime;
      if (args.accessGroups !== undefined) {
        body.accessGroups = args.accessGroups;
      }
      if (args.notAvailable !== undefined) {
        body.notAvailable = args.notAvailable;
      }
      const res = await client.post("/hostpolicy", body);
      const policy = hostPoliciesFromData(res.data)[0] ?? { name: args.name };
      return writeOne(context, "hostPolicy", POLICY, args.name, policy);
    },
  }),

  hostpolicy_list: defineMethod({
    description: "List all host policies, storing each one",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/hostpolicy");
      const handles = await writeList(
        context,
        "hostPolicy",
        POLICY,
        hostPoliciesFromData(res.data),
      );
      return { dataHandles: handles };
    },
  }),

  hostpolicy_show: defineMethod({
    description: "Fetch a single host policy by name and store it",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/hostpolicy", {
        query: { name: args.name },
      });
      const policy = hostPoliciesFromData(res.data).find((p) =>
        p.name === args.name
      ) ?? hostPoliciesFromData(res.data)[0];
      if (!policy) throw new Error(`host policy '${args.name}' not found`);
      return writeOne(context, "hostPolicy", POLICY, args.name, policy);
    },
  }),

  hostpolicy_edit: defineMethod({
    description: "Edit a host policy (admin)",
    arguments: PolicyEditArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = {};
      if (args.newName !== undefined) body.name = args.newName;
      if (args.maxResTime !== undefined) body.maxResTime = args.maxResTime;
      if (args.accessGroups !== undefined) {
        body.accessGroups = args.accessGroups;
      }
      if (args.notAvailable !== undefined) {
        body.notAvailable = args.notAvailable;
      }
      if (Object.keys(body).length === 0) {
        throw new Error("no changes provided to hostpolicy_edit");
      }
      await client.patch(`/hostpolicy/${encodeURIComponent(args.name)}`, body);
      const finalName = args.newName ?? args.name;
      const res = await client.get("/hostpolicy", {
        query: { name: finalName },
      });
      const policy = hostPoliciesFromData(res.data).find((p) =>
        p.name === finalName
      ) ?? { name: finalName };
      return writeOne(context, "hostPolicy", POLICY, finalName, policy);
    },
  }),

  hostpolicy_delete: defineMethod({
    description: "Delete a host policy (admin)",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/hostpolicy/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  }),
};
