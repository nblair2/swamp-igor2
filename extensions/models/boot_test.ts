/**
 * Unit tests for the `@nblair2/igor2/boot` model. Network-free; multipart
 * uploads use the harness's stubbed `readFile`.
 *
 * @module
 */
import { model } from "./boot.ts";
import {
  assert,
  assertEquals,
  harness,
  jsonResponse,
} from "./_lib/test_util.ts";

Deno.test("distro_create requires exactly one source", () => {
  const args = model.methods.distro_create.arguments;
  assert(args.safeParse({ name: "d", copyDistro: "base" }).success);
  assert(
    args.safeParse({ name: "d", kernelFile: "/k", initrdFile: "/i" }).success,
  );
  assert(!args.safeParse({ name: "d" }).success, "no source");
  assert(
    !args.safeParse({ name: "d", copyDistro: "base", imageRef: "x" }).success,
    "two sources",
  );
  assert(
    !args.safeParse({ name: "d", kernelFile: "/k" }).success,
    "lone kernel file is not a complete source",
  );
});

Deno.test("distro_create posts multipart with fields + files", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST" && c.path.endsWith("/distros")) {
      return jsonResponse(200, {
        status: "success",
        data: { distro: { name: "d1", owner: "alice" } },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.distro_create.arguments.parse({
    name: "d1",
    kernelFile: "/tmp/vmlinuz",
    initrdFile: "/tmp/initrd.img",
    boot: ["bios", "uefi"],
    public: true,
  });
  await model.methods.distro_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assert(post.form !== undefined, "should send FormData");
  assertEquals(post.form!.get("name"), "d1");
  assertEquals(post.form!.getAll("boot"), ["bios", "uefi"]);
  assertEquals(post.form!.get("public"), "true");
  assert(post.form!.get("kernelFile") instanceof File, "kernel uploaded");
  assertEquals(written[0].specName, "distro");
  assertEquals(written[0].instanceName, "distro-d1");
});

Deno.test("profile_create posts JSON and stores the profile", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "POST" && c.path.endsWith("/profiles")) {
      return jsonResponse(200, {
        status: "success",
        data: { profile: { name: "p1", distro: "d1" } },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.profile_create.arguments.parse({
    name: "p1",
    distro: "d1",
    kernelArgs: "quiet",
  });
  await model.methods.profile_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.json?.name, "p1");
  assertEquals(post.json?.distro, "d1");
  assertEquals(post.json?.kernelArgs, "quiet");
  assertEquals(written[0].instanceName, "profile-p1");
});
