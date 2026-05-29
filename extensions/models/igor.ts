/**
 * Swamp model for the igor2 cluster node-reservation manager.
 *
 * A single model type (`@nblair2/igor2`) exposes the full igor2 API as methods —
 * the reservation lifecycle, host power/inventory and administration, the boot
 * stack (distros, profiles, images, kickstarts), identity (users, groups,
 * elevation), clusters/MOTD, and server operations (sync, stats, config,
 * auth-reset). Connection and credentials are configured once via the model's
 * global arguments. The methods and resources are assembled here from the
 * per-resource modules under `./_groups/`.
 *
 * @module
 */
import { GlobalArgsSchema } from "./_lib/igor.ts";
import type { MethodDef, ResourceSpec } from "./_lib/model.ts";
import {
  methods as reservationMethods,
  resources as reservationResources,
} from "./_groups/reservations.ts";
import {
  methods as hostMethods,
  resources as hostResources,
} from "./_groups/hosts.ts";
import {
  methods as bootMethods,
  resources as bootResources,
} from "./_groups/boot.ts";
import {
  methods as adminMethods,
  resources as adminResources,
} from "./_groups/admin.ts";

/** Every resource spec across the model, keyed by spec name. */
const resources: Record<string, ResourceSpec> = {
  ...reservationResources,
  ...hostResources,
  ...bootResources,
  ...adminResources,
};

/** Every method across the model, keyed by method name. */
const methods: Record<string, MethodDef> = {
  ...reservationMethods,
  ...hostMethods,
  ...bootMethods,
  ...adminMethods,
};

/**
 * The `@nblair2/igor2` model: drives the igor2 node-reservation manager across
 * its full API surface. See the `_groups/` modules for the per-resource method
 * implementations.
 */
export const model = {
  type: "@nblair2/igor2",
  version: "2026.05.28.2",
  globalArguments: GlobalArgsSchema,
  resources,
  methods,
};
