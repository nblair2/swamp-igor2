/**
 * Swamp model `@nblair2/igor2/boot` — the igor2 boot stack: distros, profiles,
 * images and kickstarts.
 *
 * Distros, image-register and kickstart-register/edit use `multipart/form-data`
 * (so kernel / initrd / kickstart files can be uploaded from a local path);
 * profiles use JSON. File uploads read the given local path at runtime — if the
 * swamp runtime restricts file reads, prefer the reference-based creation paths
 * (`copyDistro` / `useDistroImage` / `imageRef`, or server-staged images).
 * Methods and resources are inlined into `export const model` so the swamp-club
 * registry can index them.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  buildForm,
  DistroSchema,
  distrosFromData,
  GlobalArgsSchema,
  ImageSchema,
  imagesFromData,
  KickstartSchema,
  kickstartsFromData,
  ProfileSchema,
  profilesFromData,
  type QueryValue,
  type ReadFileLike,
} from "./_lib/igor.ts";
import {
  clientFor,
  type MethodResult,
  type ModelContext,
  writeList,
  writeOne,
} from "./_lib/model.ts";

const DISTRO = "distro";
const PROFILE = "profile";
const IMAGE = "image";
const KICKSTART = "kickstart";

const EmptyArgs = z.object({});

const NameArg = z.object({ name: z.string().min(1).describe("Resource name") });

/** The caller-injected file reader, or the default `Deno.readFile`. */
function reader(context: ModelContext): ReadFileLike | undefined {
  return context._deps?.readFile;
}

// --- distros -----------------------------------------------------------------

const DistroCreateArgs = z.object({
  name: z.string().min(1).describe("Unique distro name"),
  copyDistro: z.string().optional().describe(
    "Create by copying an existing distro (one source required)",
  ),
  useDistroImage: z.string().optional().describe(
    "Create using the image of an existing distro (one source required)",
  ),
  imageRef: z.string().optional().describe(
    "Create from an already-registered image ID (one source required)",
  ),
  kernelFile: z.string().optional().describe(
    "Local path to a kernel file to upload (with initrdFile; one source required)",
  ),
  initrdFile: z.string().optional().describe(
    "Local path to an initrd file to upload (with kernelFile)",
  ),
  description: z.string().optional().describe("Free-text description"),
  kernelArgs: z.string().optional().describe("Default kernel arguments"),
  kickstart: z.string().optional().describe(
    "Kickstart filename (local-boot images only)",
  ),
  public: z.boolean().optional().describe("Make the distro public (admin)"),
  distroGroups: z.array(z.string()).optional().describe(
    "Groups granted access (not allowed if public)",
  ),
  boot: z.array(z.enum(["bios", "uefi"])).optional().describe(
    "Supported boot modes",
  ),
}).refine(
  (a) => {
    const sources = [
      a.copyDistro,
      a.useDistroImage,
      a.imageRef,
      a.kernelFile && a.initrdFile ? "files" : undefined,
    ].filter(Boolean);
    return sources.length === 1;
  },
  {
    message:
      "provide exactly one source: copyDistro, useDistroImage, imageRef, or kernelFile+initrdFile",
  },
);

const DistroEditArgs = z.object({
  name: z.string().min(1).describe("Distro to edit"),
  newName: z.string().optional().describe("Rename the distro"),
  description: z.string().optional().describe("Update description"),
  kernelArgs: z.string().optional().describe("Update default kernel arguments"),
  owner: z.string().optional().describe("Transfer ownership (admin)"),
  addGroup: z.array(z.string()).optional().describe("Groups to grant access"),
  removeGroup: z.array(z.string()).optional().describe(
    "Groups to revoke access",
  ),
  kickstart: z.string().optional().describe("Update kickstart filename"),
  public: z.boolean().optional().describe("Make the distro public (admin)"),
  setDefault: z.boolean().optional().describe(
    "Set as the default distro (admin)",
  ),
  removeDefault: z.boolean().optional().describe("Clear default-distro status"),
});

// --- profiles ----------------------------------------------------------------

const ProfileCreateArgs = z.object({
  name: z.string().min(1).describe("Unique profile name"),
  distro: z.string().min(1).describe("Distro this profile boots"),
  description: z.string().optional().describe("Free-text description"),
  kernelArgs: z.string().optional().describe(
    "Extra kernel arguments appended to the distro's",
  ),
});

const ProfileEditArgs = z.object({
  name: z.string().min(1).describe("Profile to edit"),
  newName: z.string().optional().describe("Rename the profile"),
  description: z.string().optional().describe("Update description"),
  kernelArgs: z.string().optional().describe("Update kernel arguments"),
});

// --- images ------------------------------------------------------------------

const ImageRegisterArgs = z.object({
  kernelFile: z.string().optional().describe(
    "Local path to a kernel file to upload (with initrdFile)",
  ),
  initrdFile: z.string().optional().describe(
    "Local path to an initrd file to upload (with kernelFile)",
  ),
  kstaged: z.string().optional().describe(
    "Server-staged kernel filename (with istaged) instead of uploading",
  ),
  istaged: z.string().optional().describe(
    "Server-staged initrd filename (with kstaged)",
  ),
  breed: z.string().optional().describe(
    "Distro breed (e.g. ubuntu, redhat, generic-linux)",
  ),
  localBoot: z.boolean().optional().describe(
    "Register as a local-install image",
  ),
  boot: z.array(z.enum(["bios", "uefi"])).optional().describe(
    "Supported boot modes",
  ),
}).refine(
  (a) => (!!a.kernelFile && !!a.initrdFile) || (!!a.kstaged && !!a.istaged),
  {
    message:
      "provide kernelFile+initrdFile to upload, or kstaged+istaged to use server-staged files",
  },
);

// --- kickstarts --------------------------------------------------------------

const KickstartRegisterArgs = z.object({
  kickstart: z.string().min(1).describe(
    "Local path to a kickstart file to upload",
  ),
});

const KickstartEditArgs = z.object({
  name: z.string().min(1).describe("Kickstart to edit"),
  kickstart: z.string().optional().describe(
    "Local path to a replacement kickstart file",
  ),
  newName: z.string().optional().describe("Rename the kickstart"),
});

/**
 * The `@nblair2/igor2/boot` model: distros, profiles, images and kickstarts.
 * See the README for the full method reference and the file-upload caveat.
 */
export const model = {
  type: "@nblair2/igor2/boot",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    distro: {
      description: "An igor2 boot distro (kernel/initrd + kickstart + groups)",
      schema: DistroSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    profile: {
      description: "An igor2 boot profile (a distro plus kernel arguments)",
      schema: ProfileSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    image: {
      description: "A registered igor2 distro image (kernel/initrd pair)",
      schema: ImageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    kickstart: {
      description: "A registered igor2 kickstart file",
      schema: KickstartSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    distro_create: {
      description:
        "Create a boot distro by copying a distro, reusing an image, referencing an image ID, or uploading kernel+initrd",
      arguments: DistroCreateArgs,
      execute: async (
        args: z.infer<typeof DistroCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const fields: Record<string, QueryValue> = { name: args.name };
        if (args.copyDistro !== undefined) fields.copyDistro = args.copyDistro;
        if (args.useDistroImage !== undefined) {
          fields.useDistroImage = args.useDistroImage;
        }
        if (args.imageRef !== undefined) fields.imageRef = args.imageRef;
        if (args.description !== undefined) {
          fields.description = args.description;
        }
        if (args.kernelArgs !== undefined) fields.kernelArgs = args.kernelArgs;
        if (args.kickstart !== undefined) fields.kickstart = args.kickstart;
        if (args.public) fields.public = "true";
        if (args.distroGroups !== undefined) {
          fields.distroGroups = args.distroGroups;
        }
        if (args.boot !== undefined) fields.boot = args.boot;
        const files = (args.kernelFile && args.initrdFile)
          ? [
            { field: "kernelFile", path: args.kernelFile },
            { field: "initrdFile", path: args.initrdFile },
          ]
          : [];
        const form = await buildForm(fields, files, reader(context));
        const res = await client.postForm("/distros", form);
        const distro = distrosFromData(res.data)[0] ?? { name: args.name };
        return writeOne(context, "distro", DISTRO, args.name, distro);
      },
    },

    distro_list: {
      description: "List all visible distros, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/distros");
        const handles = await writeList(
          context,
          "distro",
          DISTRO,
          distrosFromData(res.data),
        );
        return { dataHandles: handles };
      },
    },

    distro_show: {
      description: "Fetch a single distro by name and store it",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/distros", {
          query: { name: args.name },
        });
        const distro =
          distrosFromData(res.data).find((d) => d.name === args.name) ??
            distrosFromData(res.data)[0];
        if (!distro) throw new Error(`distro '${args.name}' not found`);
        return writeOne(context, "distro", DISTRO, args.name, distro);
      },
    },

    distro_edit: {
      description: "Edit a distro (rename, groups, kernel args, default, etc.)",
      arguments: DistroEditArgs,
      execute: async (
        args: z.infer<typeof DistroEditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const fields: Record<string, QueryValue> = {};
        if (args.newName !== undefined) fields.name = args.newName;
        if (args.description !== undefined) {
          fields.description = args.description;
        }
        if (args.kernelArgs !== undefined) fields.kernelArgs = args.kernelArgs;
        if (args.owner !== undefined) fields.owner = args.owner;
        if (args.addGroup !== undefined) fields.addGroup = args.addGroup;
        if (args.removeGroup !== undefined) {
          fields.removeGroup = args.removeGroup;
        }
        if (args.kickstart !== undefined) fields.kickstart = args.kickstart;
        if (args.public) fields.public = "true";
        if (args.setDefault) fields.default = "true";
        if (args.removeDefault) fields.default_remove = "true";
        if (Object.keys(fields).length === 0) {
          throw new Error("no changes provided to distro_edit");
        }
        const form = await buildForm(fields, [], reader(context));
        await client.patchForm(
          `/distros/${encodeURIComponent(args.name)}`,
          form,
        );
        const finalName = args.newName ?? args.name;
        const res = await client.get("/distros", {
          query: { name: finalName },
        });
        const distro =
          distrosFromData(res.data).find((d) => d.name === finalName) ??
            { name: finalName };
        return writeOne(context, "distro", DISTRO, finalName, distro);
      },
    },

    distro_delete: {
      description: "Delete a distro",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/distros/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },

    profile_create: {
      description:
        "Create a boot profile (a distro plus extra kernel arguments)",
      arguments: ProfileCreateArgs,
      execute: async (
        args: z.infer<typeof ProfileCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const body: Record<string, unknown> = {
          name: args.name,
          distro: args.distro,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.kernelArgs !== undefined) body.kernelArgs = args.kernelArgs;
        const res = await client.post("/profiles", body);
        const profile = profilesFromData(res.data)[0] ?? { name: args.name };
        return writeOne(context, "profile", PROFILE, args.name, profile);
      },
    },

    profile_list: {
      description: "List all visible profiles, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/profiles");
        const handles = await writeList(
          context,
          "profile",
          PROFILE,
          profilesFromData(res.data),
        );
        return { dataHandles: handles };
      },
    },

    profile_show: {
      description: "Fetch a single profile by name and store it",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/profiles", {
          query: { name: args.name },
        });
        const profile =
          profilesFromData(res.data).find((p) => p.name === args.name) ??
            profilesFromData(res.data)[0];
        if (!profile) throw new Error(`profile '${args.name}' not found`);
        return writeOne(context, "profile", PROFILE, args.name, profile);
      },
    },

    profile_edit: {
      description: "Edit a profile (rename, description, kernel arguments)",
      arguments: ProfileEditArgs,
      execute: async (
        args: z.infer<typeof ProfileEditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const body: Record<string, unknown> = {};
        if (args.newName !== undefined) body.name = args.newName;
        if (args.description !== undefined) body.description = args.description;
        if (args.kernelArgs !== undefined) body.kernelArgs = args.kernelArgs;
        if (Object.keys(body).length === 0) {
          throw new Error("no changes provided to profile_edit");
        }
        await client.patch(`/profiles/${encodeURIComponent(args.name)}`, body);
        const finalName = args.newName ?? args.name;
        const res = await client.get("/profiles", {
          query: { name: finalName },
        });
        const profile =
          profilesFromData(res.data).find((p) => p.name === finalName) ??
            { name: finalName };
        return writeOne(context, "profile", PROFILE, finalName, profile);
      },
    },

    profile_delete: {
      description: "Delete a profile",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/profiles/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },

    image_register: {
      description:
        "Register a distro image by uploading kernel+initrd files or referencing server-staged files",
      arguments: ImageRegisterArgs,
      execute: async (
        args: z.infer<typeof ImageRegisterArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const fields: Record<string, QueryValue> = {};
        if (args.kstaged !== undefined) fields.kstaged = args.kstaged;
        if (args.istaged !== undefined) fields.istaged = args.istaged;
        if (args.breed !== undefined) fields.breed = args.breed;
        if (args.localBoot) fields.localBoot = "true";
        if (args.boot !== undefined) fields.boot = args.boot;
        const files = (args.kernelFile && args.initrdFile)
          ? [
            { field: "kernelFile", path: args.kernelFile },
            { field: "initrdFile", path: args.initrdFile },
          ]
          : [];
        const form = await buildForm(fields, files, reader(context));
        const res = await client.postForm("/images/register", form);
        const image = imagesFromData(res.data)[0];
        const name = (image && typeof image.name === "string")
          ? image.name
          : (image && typeof image.image_id === "string")
          ? image.image_id
          : `image-${Date.now()}`;
        return writeOne(context, "image", IMAGE, name, image ?? { name });
      },
    },

    image_list: {
      description: "List all registered distro images, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/images");
        const images = imagesFromData(res.data).map((img) => ({
          ...img,
          name: typeof img.name === "string"
            ? img.name
            : typeof img.image_id === "string"
            ? img.image_id
            : "unknown",
        }));
        const handles = await writeList(context, "image", IMAGE, images);
        return { dataHandles: handles };
      },
    },

    image_delete: {
      description: "Delete a registered distro image by name/ID",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/images/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },

    kickstart_register: {
      description: "Register (upload) a kickstart file",
      arguments: KickstartRegisterArgs,
      execute: async (
        args: z.infer<typeof KickstartRegisterArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const form = await buildForm({}, [
          { field: "kickstart", path: args.kickstart },
        ], reader(context));
        const res = await client.postForm("/kickstart/register", form);
        // Register returns the registered name only in the message.
        const match = res.message.match(/as:\s*(\S+)/);
        const name = match
          ? match[1]
          : (args.kickstart.split(/[/\\]/).pop() || "kickstart");
        return writeOne(context, "kickstart", KICKSTART, name, {
          name,
          message: res.message,
        });
      },
    },

    kickstart_list: {
      description: "List all kickstart files, storing each one",
      arguments: EmptyArgs,
      execute: async (
        _args: z.infer<typeof EmptyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const res = await client.get("/kickstart");
        const handles = await writeList(
          context,
          "kickstart",
          KICKSTART,
          kickstartsFromData(res.data),
        );
        return { dataHandles: handles };
      },
    },

    kickstart_edit: {
      description: "Replace a kickstart's file and/or rename it",
      arguments: KickstartEditArgs,
      execute: async (
        args: z.infer<typeof KickstartEditArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        const fields: Record<string, QueryValue> = {};
        if (args.newName !== undefined) fields.name = args.newName;
        const files = args.kickstart
          ? [{ field: "kickstart", path: args.kickstart }]
          : [];
        if (Object.keys(fields).length === 0 && files.length === 0) {
          throw new Error("no changes provided to kickstart_edit");
        }
        const form = await buildForm(fields, files, reader(context));
        const res = await client.patchForm(
          `/kickstart/${encodeURIComponent(args.name)}`,
          form,
        );
        const finalName = args.newName ?? args.name;
        return writeOne(context, "kickstart", KICKSTART, finalName, {
          name: finalName,
          message: res.message,
        });
      },
    },

    kickstart_delete: {
      description: "Delete a kickstart file",
      arguments: NameArg,
      execute: async (
        args: z.infer<typeof NameArg>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const client = await clientFor(context);
        await client.del(`/kickstart/${encodeURIComponent(args.name)}`);
        return { dataHandles: [] };
      },
    },
  },
};
