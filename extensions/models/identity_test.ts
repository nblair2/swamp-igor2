/**
 * Unit tests for the `@nblair2/igor2/identity` model. Network-free.
 *
 * @module
 */
import { model } from "./identity.ts";
import {
  assert,
  assertEquals,
  harness,
  jsonResponse,
} from "./_lib/test_util.ts";

Deno.test("user_edit enforces one mode and password needs oldPassword", () => {
  const a = model.methods.user_edit.arguments;
  assert(a.safeParse({ name: "u", email: "e@x" }).success);
  assert(a.safeParse({ name: "u", reset: true }).success);
  assert(a.safeParse({ name: "u", password: "p", oldPassword: "o" }).success);
  assert(!a.safeParse({ name: "u", password: "p" }).success, "missing old pw");
  assert(
    !a.safeParse({ name: "u", email: "e", reset: true }).success,
    "two modes",
  );
});

Deno.test("group_create forbids member/owner/description on LDAP groups", () => {
  const a = model.methods.group_create.arguments;
  assert(a.safeParse({ name: "g", isLDAP: true }).success);
  assert(a.safeParse({ name: "g", members: ["u"] }).success);
  assert(
    !a.safeParse({ name: "g", isLDAP: true, members: ["u"] }).success,
    "LDAP + members",
  );
});

Deno.test("group_edit allows exactly one facet", () => {
  const a = model.methods.group_edit.arguments;
  assert(a.safeParse({ name: "g", newName: "h" }).success);
  assert(a.safeParse({ name: "g", add: ["u"] }).success);
  assert(a.safeParse({ name: "g", addOwners: ["o"] }).success);
  assert(
    !a.safeParse({ name: "g", add: ["u"], addOwners: ["o"] }).success,
    "members + owners",
  );
});

Deno.test("group_list merges owner and member arrays into instances", async () => {
  const { context, written } = harness(() =>
    jsonResponse(200, {
      status: "success",
      data: {
        owner: [{ name: "g1" }],
        member: [{ name: "g1" }, { name: "g2" }],
      },
    })
  );
  await model.methods.group_list.execute({}, context);
  assertEquals(written.map((w) => w.instanceName), ["group-g1", "group-g2"]);
});

Deno.test("user_create posts then re-reads and stores the user", async () => {
  const { context, written, calls } = harness((c) => {
    if (c.method === "GET") {
      return jsonResponse(200, {
        status: "success",
        data: { users: [{ name: "bob", email: "bob@x" }] },
      });
    }
    return jsonResponse(200, { status: "success", data: {} });
  });
  const args = model.methods.user_create.arguments.parse({
    name: "bob",
    email: "bob@x",
  });
  await model.methods.user_create.execute(args, context);

  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.json?.name, "bob");
  assertEquals(post.json?.email, "bob@x");
  assertEquals(written[0].instanceName, "user-bob");
});
