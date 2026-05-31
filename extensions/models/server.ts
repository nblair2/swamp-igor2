/**
 * Swamp model `@nblair2/igor2/server` — clusters and server operations.
 *
 * Clusters + MOTD (`/igor/clusters`), the cluster dashboard (`/igor`), and the
 * server operations sync (`/igor/sync`), stats (`/igor/stats`), config
 * (`/igor/config`) and auth-reset (`/igor/authreset`). Some are admin-only and
 * `auth_reset` is destructive — it invalidates every issued JWT cluster-wide.
 * Methods and resources are inlined into `export const model` so the swamp-club
 * registry can index them.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  ClusterSchema,
  clustersFromData,
  GlobalArgsSchema,
  sanitizeInstanceName,
} from "./_lib/igor.ts";
import {
  clientFor,
  type MethodResult,
  type ModelContext,
  operationSchema,
  writeList,
  writeOne,
  writeOperation,
} from "./_lib/model.ts";

const CLUSTER = "cluster";

const EmptyArgs = z.object({});

const MotdArgs = z.object({
  motd: z.string().describe("Message-of-the-day text ('' to clear)"),
  motdUrgent: z.boolean().describe("Flag the MOTD as urgent"),
});

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

/**
 * The `@nblair2/igor2/server` model: clusters, MOTD, the dashboard, and server
 * operations (sync, stats, config, auth-reset). See the README for the full
 * method reference.
 */
export const model = {
  type: "@nblair2/igor2/server",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
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
    operation: {
      description: "Outcome of a sync, MOTD-set or auth-reset action",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    cluster_list: {
      description: "List clusters, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    cluster_motd_set: {
      description: "Set the cluster message-of-the-day (admin)",
      arguments: MotdArgs,
      execute: async (
        args: z.infer<typeof MotdArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    sync: {
      description: "Run a network sync check (e.g. Arista VLAN reconciliation)",
      arguments: SyncArgs,
      execute: async (
        args: z.infer<typeof SyncArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    stats: {
      description: "Read cluster usage statistics and store the snapshot",
      arguments: StatsArgs,
      execute: async (
        args: z.infer<typeof StatsArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    config_show: {
      description: "Read the igor2 server configuration (or public settings)",
      arguments: ConfigArgs,
      execute: async (
        args: z.infer<typeof ConfigArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get(
          args.public ? "/config/public" : "/config",
        );
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
    },

    auth_reset: {
      description:
        "Reset the server JWT signing secret — DESTRUCTIVE: invalidates every issued token cluster-wide (admin)",
      arguments: AuthResetArgs,
      execute: async (
        _args: z.infer<typeof AuthResetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.put("/authreset");
        return writeOperation(context, "auth-reset", {
          message: res.message,
          result: res.data.result ?? res.data,
        });
      },
    },

    show: {
      description:
        "Read the cluster dashboard (cluster meta, hosts, reservations)",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },
  },
};
