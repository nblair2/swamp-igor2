/**
 * Swamp model `@nblair2/igor2/identity` — accounts, groups and privilege
 * elevation.
 *
 * Users (`/igor/users`), groups (`/igor/groups`) and admin privilege elevation
 * (`/igor/elevate`). Many of these are admin-only and some are destructive
 * (user/group deletes remove records). Methods and resources are inlined into
 * `export const model` so the swamp-club registry can index them.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  GlobalArgsSchema,
  GroupSchema,
  groupsFromData,
  UserSchema,
  usersFromData,
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

const USER = "user";
const GROUP = "group";

const EmptyArgs = z.object({});

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

const GroupListArgs = z.object({
  showMembers: z.boolean().optional().describe("Include member lists"),
});

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

/**
 * The `@nblair2/igor2/identity` model: users, groups and privilege elevation.
 * See the README for the full method reference.
 */
export const model = {
  type: "@nblair2/igor2/identity",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
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
    operation: {
      description:
        "Outcome of an elevate / elevate-status / elevate-cancel action",
      schema: operationSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    user_create: {
      description: "Create a user account (admin)",
      arguments: UserCreateArgs,
      execute: async (
        args: z.infer<typeof UserCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.post("/users", { name: args.name, email: args.email });
        const res = await client.get("/users", { query: { name: args.name } });
        const user =
          usersFromData(res.data).find((u) => u.name === args.name) ??
            { name: args.name, email: args.email };
        return writeOne(context, "user", USER, args.name, user);
      },
    },

    user_list: {
      description: "List users, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    user_show: {
      description: "Fetch a single user by name and store it",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/users", { query: { name: args.name } });
        const user =
          usersFromData(res.data).find((u) => u.name === args.name) ??
            usersFromData(res.data)[0];
        if (!user) throw new Error(`user '${args.name}' not found`);
        return writeOne(context, "user", USER, args.name, user);
      },
    },

    user_edit: {
      description:
        "Edit a user: email/fullName, change password, or force a reset",
      arguments: UserEditArgs,
      execute: async (
        args: z.infer<typeof UserEditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
        const user =
          usersFromData(res.data).find((u) => u.name === args.name) ??
            { name: args.name };
        return writeOne(context, "user", USER, args.name, user);
      },
    },

    user_delete: {
      description: "Delete a user account (admin)",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/users/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },

    group_create: {
      description: "Create a group (optionally LDAP-backed)",
      arguments: GroupCreateArgs,
      execute: async (
        args: z.infer<typeof GroupCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
        const group =
          groupsFromData(res.data).find((g) => g.name === args.name) ??
            { name: args.name };
        return writeOne(context, "group", GROUP, args.name, group);
      },
    },

    group_list: {
      description: "List groups (owned and member), storing each one",
      arguments: GroupListArgs,
      execute: async (
        args: z.infer<typeof GroupListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
    },

    group_show: {
      description: "Fetch a single group by name and store it",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/groups", {
          query: { name: args.name, showMembers: true },
        });
        const group =
          groupsFromData(res.data).find((g) => g.name === args.name) ??
            groupsFromData(res.data)[0];
        if (!group) throw new Error(`group '${args.name}' not found`);
        return writeOne(context, "group", GROUP, args.name, group);
      },
    },

    group_edit: {
      description: "Edit a group: metadata, owners, or members (one facet)",
      arguments: GroupEditArgs,
      execute: async (
        args: z.infer<typeof GroupEditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
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
        const group =
          groupsFromData(res.data).find((g) => g.name === finalName) ??
            { name: finalName };
        return writeOne(context, "group", GROUP, finalName, group);
      },
    },

    group_delete: {
      description: "Delete a group (admin)",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/groups/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },

    elevate: {
      description: "Activate admin privilege elevation for your session",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.patch("/elevate", {});
        return writeOperation(context, "elevate", { message: res.message });
      },
    },

    elevate_status: {
      description: "Check remaining time on your admin elevation",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/elevate");
        return writeOperation(context, "elevate-status", {
          message: res.message,
        });
      },
    },

    elevate_cancel: {
      description: "Cancel your admin privilege elevation",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.del("/elevate");
        return writeOperation(context, "elevate-cancel", {
          message: res.message,
        });
      },
    },
  },
};
