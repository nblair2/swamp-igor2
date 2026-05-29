/**
 * Identity, cluster and server-operation methods for the `@nblair2/igor2` model.
 *
 * Users (`/igor/users`), groups (`/igor/groups`), privilege elevation
 * (`/igor/elevate`), clusters + MOTD (`/igor/clusters`), and the server
 * operations sync (`/igor/sync`), stats (`/igor/stats`), config (`/igor/config`),
 * auth-reset (`/igor/authreset`) and the cluster dashboard (`/igor`).
 *
 * Many of these are admin-only and some are destructive: `auth_reset`
 * invalidates every issued JWT cluster-wide; user/group deletes remove records.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  ClusterSchema,
  clustersFromData,
  GroupSchema,
  groupsFromData,
  sanitizeInstanceName,
  UserSchema,
  usersFromData,
} from "../_lib/igor.ts";
import {
  clientFor,
  defineMethod,
  type MethodDef,
  type MethodResult,
  operationResource,
  type ResourceSpec,
  writeList,
  writeOne,
  writeOperation,
} from "../_lib/model.ts";

const USER = "user";
const GROUP = "group";
const CLUSTER = "cluster";

const NameArg = z.object({ name: z.string().min(1).describe("Resource name") });

// --- users -------------------------------------------------------------------

const UserCreateArgs = z.object({
  name: z.string().min(1).describe("Username"),
  email: z.string().min(1).describe("Email address"),
});

const UserEditArgs = z.object({
  name: z.string().min(1).describe("User to edit"),
  email: z.string().optional().describe("New email address"),
  fullName: z.string().optional().describe("New full name"),
  password: z.string().meta({ sensitive: true }).optional().describe(
    "New password (requires oldPassword)",
  ),
  oldPassword: z.string().meta({ sensitive: true }).optional().describe(
    "Current password (required when changing password)",
  ),
  reset: z.boolean().optional().describe(
    "Force a password reset (cannot combine with other edits)",
  ),
}).refine((a) => {
  const meta = a.email !== undefined || a.fullName !== undefined;
  const pw = a.password !== undefined;
  const reset = a.reset === true;
  const modes = [meta, pw, reset].filter(Boolean).length;
  if (modes !== 1) return false;
  if (pw && a.oldPassword === undefined) return false;
  return true;
}, {
  message:
    "use exactly one of: email/fullName, password (+oldPassword), or reset:true",
});

// --- groups ------------------------------------------------------------------

const GroupCreateArgs = z.object({
  name: z.string().min(1).describe("Group name"),
  isLDAP: z.boolean().optional().describe(
    "Back the group with LDAP (no members/owners/description allowed)",
  ),
  members: z.array(z.string()).optional().describe("Member usernames"),
  owners: z.array(z.string()).optional().describe("Owner usernames"),
  description: z.string().optional().describe("Free-text description"),
}).refine(
  (a) =>
    !a.isLDAP ||
    (a.members === undefined && a.owners === undefined &&
      a.description === undefined),
  { message: "LDAP groups cannot set members, owners, or description" },
);

const GroupEditArgs = z.object({
  name: z.string().min(1).describe("Group to edit"),
  newName: z.string().optional().describe("Rename the group"),
  description: z.string().optional().describe("Update description"),
  addOwners: z.array(z.string()).optional().describe("Owners to add"),
  rmvOwners: z.array(z.string()).optional().describe("Owners to remove"),
  add: z.array(z.string()).optional().describe("Members to add"),
  remove: z.array(z.string()).optional().describe("Members to remove"),
}).refine((a) => {
  const meta = a.newName !== undefined || a.description !== undefined;
  const owners = a.addOwners !== undefined || a.rmvOwners !== undefined;
  const members = a.add !== undefined || a.remove !== undefined;
  return [meta, owners, members].filter(Boolean).length === 1;
}, {
  message:
    "edit exactly one facet: metadata (newName/description), owners, or members",
});

// --- clusters ----------------------------------------------------------------

const MotdArgs = z.object({
  motd: z.string().describe("Message-of-the-day text ('' to clear)"),
  motdUrgent: z.boolean().describe("Flag the MOTD as urgent"),
});

// --- server operations -------------------------------------------------------

const SyncArgs = z.object({
  cmd: z.string().default("arista").describe(
    "Sync command (currently only 'arista')",
  ),
  force: z.boolean().optional().describe("Apply corrections on mismatch"),
  quiet: z.boolean().optional().describe("Suppress detailed output"),
  scope: z.string().optional().describe(
    "Limit to a host range or reservation names",
  ),
});

const StatsArgs = z.object({
  start: z.string().optional().describe(
    "End of the range as 'YYYY-Mon-DD' (e.g. 2026-May-28)",
  ),
  duration: z.number().int().optional().describe(
    "Days back from start (default 7; 0 = since epoch)",
  ),
  verbose: z.boolean().optional().describe("Include per-reservation entries"),
});

const ConfigArgs = z.object({
  public: z.boolean().optional().describe(
    "Read only the public settings (no admin required)",
  ),
});

const AuthResetArgs = z.object({
  confirm: z.literal(true).describe(
    "Must be true — this invalidates ALL issued JWT tokens cluster-wide",
  ),
});

/** Resource specs owned by this group. */
export const resources: Record<string, ResourceSpec> = {
  user: {
    description: "An igor2 user account",
    schema: UserSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  group: {
    description: "An igor2 group (owners, members, shared distros/policies)",
    schema: GroupSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  cluster: {
    description: "An igor2 cluster definition and its MOTD",
    schema: ClusterSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  dashboard: {
    description:
      "Cluster dashboard snapshot (cluster meta, hosts, reservations)",
    schema: z.object({
      cluster: z.record(z.string(), z.unknown()).optional(),
      hostCount: z.number().optional(),
      reservationCount: z.number().optional(),
    }).passthrough(),
    lifetime: "7d",
    garbageCollection: 10,
  },
  stats: {
    description: "An igor2 cluster usage-statistics snapshot",
    schema: z.record(z.string(), z.unknown()),
    lifetime: "7d",
    garbageCollection: 10,
  },
  config: {
    description: "The igor2 server configuration snapshot",
    schema: z.record(z.string(), z.unknown()),
    lifetime: "7d",
    garbageCollection: 10,
  },
  operation: operationResource,
};

/** Methods contributed by this group. */
export const methods: Record<string, MethodDef> = {
  // --- users ---
  user_create: defineMethod({
    description: "Create a user account (admin)",
    arguments: UserCreateArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.post("/users", { name: args.name, email: args.email });
      const res = await client.get("/users", { query: { name: args.name } });
      const user = usersFromData(res.data).find((u) => u.name === args.name) ??
        { name: args.name, email: args.email };
      return writeOne(context, "user", USER, args.name, user);
    },
  }),

  user_list: defineMethod({
    description: "List users, storing each one",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/users");
      const handles = await writeList(
        context,
        "user",
        USER,
        usersFromData(res.data),
      );
      return { dataHandles: handles };
    },
  }),

  user_show: defineMethod({
    description: "Fetch a single user by name and store it",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/users", { query: { name: args.name } });
      const user = usersFromData(res.data).find((u) => u.name === args.name) ??
        usersFromData(res.data)[0];
      if (!user) throw new Error(`user '${args.name}' not found`);
      return writeOne(context, "user", USER, args.name, user);
    },
  }),

  user_edit: defineMethod({
    description:
      "Edit a user: email/fullName, change password, or force a reset",
    arguments: UserEditArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = {};
      if (args.reset === true) {
        body.reset = true;
      } else if (args.password !== undefined) {
        body.password = args.password;
        body.oldPassword = args.oldPassword;
      } else {
        if (args.email !== undefined) body.email = args.email;
        if (args.fullName !== undefined) body.fullName = args.fullName;
      }
      await client.patch(`/users/${encodeURIComponent(args.name)}`, body);
      const res = await client.get("/users", { query: { name: args.name } });
      const user = usersFromData(res.data).find((u) => u.name === args.name) ??
        { name: args.name };
      return writeOne(context, "user", USER, args.name, user);
    },
  }),

  user_delete: defineMethod({
    description: "Delete a user account (admin)",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/users/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  }),

  // --- groups ---
  group_create: defineMethod({
    description: "Create a group (optionally LDAP-backed)",
    arguments: GroupCreateArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = { name: args.name };
      if (args.isLDAP !== undefined) body.isLDAP = args.isLDAP;
      if (args.members !== undefined) body.members = args.members;
      if (args.owners !== undefined) body.owners = args.owners;
      if (args.description !== undefined) body.description = args.description;
      await client.post("/groups", body);
      const res = await client.get("/groups", {
        query: { name: args.name, showMembers: true },
      });
      const group = groupsFromData(res.data).find((g) =>
        g.name === args.name
      ) ??
        { name: args.name };
      return writeOne(context, "group", GROUP, args.name, group);
    },
  }),

  group_list: defineMethod({
    description: "List groups (owned and member), storing each one",
    arguments: z.object({
      showMembers: z.boolean().optional().describe("Include member lists"),
    }),
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/groups", {
        query: { showMembers: args.showMembers },
      });
      const handles = await writeList(
        context,
        "group",
        GROUP,
        groupsFromData(res.data),
      );
      return { dataHandles: handles };
    },
  }),

  group_show: defineMethod({
    description: "Fetch a single group by name and store it",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/groups", {
        query: { name: args.name, showMembers: true },
      });
      const group = groupsFromData(res.data).find((g) =>
        g.name === args.name
      ) ??
        groupsFromData(res.data)[0];
      if (!group) throw new Error(`group '${args.name}' not found`);
      return writeOne(context, "group", GROUP, args.name, group);
    },
  }),

  group_edit: defineMethod({
    description: "Edit a group: metadata, owners, or members (one facet)",
    arguments: GroupEditArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const body: Record<string, unknown> = {};
      if (args.newName !== undefined) body.name = args.newName;
      if (args.description !== undefined) body.description = args.description;
      if (args.addOwners !== undefined) body.addOwners = args.addOwners;
      if (args.rmvOwners !== undefined) body.rmvOwners = args.rmvOwners;
      if (args.add !== undefined) body.add = args.add;
      if (args.remove !== undefined) body.remove = args.remove;
      await client.patch(`/groups/${encodeURIComponent(args.name)}`, body);
      const finalName = args.newName ?? args.name;
      const res = await client.get("/groups", {
        query: { name: finalName, showMembers: true },
      });
      const group = groupsFromData(res.data).find((g) =>
        g.name === finalName
      ) ?? { name: finalName };
      return writeOne(context, "group", GROUP, finalName, group);
    },
  }),

  group_delete: defineMethod({
    description: "Delete a group (admin)",
    arguments: NameArg,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      await client.del(`/groups/${encodeURIComponent(args.name)}`);
      return { dataHandles: [] };
    },
  }),

  // --- clusters ---
  cluster_list: defineMethod({
    description: "List clusters, storing each one",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/clusters");
      const handles = await writeList(
        context,
        "cluster",
        CLUSTER,
        clustersFromData(res.data),
      );
      return { dataHandles: handles };
    },
  }),

  cluster_motd_set: defineMethod({
    description: "Set the cluster message-of-the-day (admin)",
    arguments: MotdArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.patch("/clusters/motd", {
        motd: args.motd,
        motdUrgent: args.motdUrgent,
      });
      return writeOperation(context, "cluster-motd", {
        message: res.message,
        result: res.data,
      });
    },
  }),

  // --- elevate ---
  elevate: defineMethod({
    description: "Activate admin privilege elevation for your session",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.patch("/elevate", {});
      return writeOperation(context, "elevate", { message: res.message });
    },
  }),

  elevate_status: defineMethod({
    description: "Check remaining time on your admin elevation",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/elevate");
      return writeOperation(context, "elevate-status", {
        message: res.message,
      });
    },
  }),

  elevate_cancel: defineMethod({
    description: "Cancel your admin privilege elevation",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.del("/elevate");
      return writeOperation(context, "elevate-cancel", {
        message: res.message,
      });
    },
  }),

  // --- server operations ---
  sync: defineMethod({
    description: "Run a network sync check (e.g. Arista VLAN reconciliation)",
    arguments: SyncArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/sync", {
        query: {
          cmd: args.cmd,
          force: args.force,
          quiet: args.quiet,
          scope: args.scope,
        },
      });
      return writeOperation(context, `sync-${args.cmd}`, {
        target: args.scope,
        message: res.message,
        result: res.data.sync ?? res.data,
      });
    },
  }),

  stats: defineMethod({
    description: "Read cluster usage statistics and store the snapshot",
    arguments: StatsArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/stats", {
        query: {
          start: args.start,
          duration: args.duration,
          verbose: args.verbose,
        },
      });
      const stats = (res.data.stats && typeof res.data.stats === "object")
        ? res.data.stats as Record<string, unknown>
        : res.data;
      return writeOne(context, "stats", "stats", "latest", stats);
    },
  }),

  config_show: defineMethod({
    description: "Read the igor2 server configuration (or public settings)",
    arguments: ConfigArgs,
    execute: async (args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get(args.public ? "/config/public" : "/config");
      const config = (res.data.igor && typeof res.data.igor === "object")
        ? res.data.igor as Record<string, unknown>
        : res.data;
      return writeOne(
        context,
        "config",
        "config",
        args.public ? "public" : "server",
        config,
      );
    },
  }),

  auth_reset: defineMethod({
    description:
      "Reset the server JWT signing secret. DESTRUCTIVE: invalidates every " +
      "issued token cluster-wide, forcing all users to log in again (admin).",
    arguments: AuthResetArgs,
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.put("/authreset");
      return writeOperation(context, "auth-reset", {
        message: res.message,
        result: res.data.result ?? res.data,
      });
    },
  }),

  // --- dashboard ---
  show: defineMethod({
    description:
      "Read the cluster dashboard (cluster meta, hosts, reservations)",
    arguments: z.object({}),
    execute: async (_args, context): Promise<MethodResult> => {
      const client = await clientFor(context);
      const res = await client.get("/");
      const show = (res.data.show && typeof res.data.show === "object")
        ? res.data.show as Record<string, unknown>
        : res.data;
      const cluster = (show.cluster && typeof show.cluster === "object")
        ? show.cluster as Record<string, unknown>
        : undefined;
      const hosts = Array.isArray(show.hosts) ? show.hosts : [];
      const reservations = Array.isArray(show.reservations)
        ? show.reservations
        : [];
      const clusterName = cluster && typeof cluster.name === "string"
        ? cluster.name
        : "cluster";
      const handle = await context.writeResource(
        "dashboard",
        `dashboard-${sanitizeInstanceName(clusterName)}`,
        {
          ...show,
          cluster,
          hostCount: hosts.length,
          reservationCount: reservations.length,
        },
      );
      return { dataHandles: [handle] };
    },
  }),
};
