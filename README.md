# @nblair2/igor2

A [swamp](https://swamp.club/) extension for
[igor2](https://github.com/sandia-minimega/igor2), Sandia's cluster node
reservation manager. It gives a swamp agent full control of an igor2 cluster
through its REST API, organized into **five models** along igor's API
boundaries: reservations, hosts, the boot stack, identity, and server
operations.

## Models

The extension package `@nblair2/igor2` ships five model types. Each is
configured independently with the same connection arguments and exposes the
methods for its slice of the API:

| Model type                     | Surface                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `@nblair2/igor2/reservations`  | The reservation lifecycle (create/show/list/edit/delete)            |
| `@nblair2/igor2/hosts`         | Host power, inventory, administration, and host policies            |
| `@nblair2/igor2/boot`          | The boot stack: distros, profiles, images, kickstarts               |
| `@nblair2/igor2/identity`      | Users, groups, and admin privilege elevation                        |
| `@nblair2/igor2/server`        | Clusters/MOTD, sync, stats, config, auth-reset, and the dashboard   |

The igor2 API is rooted at `/igor` over HTTPS (default port 8443);
authentication uses `GET /igor/login` with HTTP Basic credentials to obtain a
JWT, which is sent as a `Bearer` token on every request.

⚠️ = admin / elevated privilege typically required. 💥 = globally destructive.

### `@nblair2/igor2/reservations`

| Method               | igor2 endpoint                    | Description                                            |
| -------------------- | --------------------------------- | ------------------------------------------------------ |
| `reservation_create` | `POST /igor/reservations`         | Create a reservation (idempotent — returns existing on conflict) |
| `reservation_show`   | `GET /igor/reservations`          | Fetch one reservation by name                          |
| `reservation_list`   | `GET /igor/reservations`          | List all visible reservations                          |
| `reservation_edit`   | `PATCH /igor/reservations/:name`  | Extend, add/drop nodes, rename, re-distro, etc.        |
| `reservation_delete` | `DELETE /igor/reservations/:name` | Delete a reservation                                   |

### `@nblair2/igor2/hosts`

| Method                 | igor2 endpoint                  | Description                                            |
| ---------------------- | ------------------------------- | ------------------------------------------------------ |
| `host_power`           | `PATCH /igor/hosts-ctrl/power`  | Power `on` / `off` / `cycle` / `status` nodes          |
| `host_list`            | `GET /igor/hosts`               | List all hosts                                         |
| `host_status`          | `GET /igor/hosts`               | Fetch one host by name                                 |
| `host_edit` ⚠️         | `PATCH /igor/hosts/:name`       | Edit a host's ip/hostname/mac/eth/boot mode/policy     |
| `host_delete` ⚠️       | `DELETE /igor/hosts/:name`      | Remove a host from igor2                               |
| `host_block` ⚠️        | `PATCH /igor/hosts-ctrl/block`  | Block / unblock hosts from being reserved              |
| `host_apply_policy` ⚠️ | `PATCH /igor/hosts-ctrl/policy` | Apply a host policy to a set of hosts                  |
| `hostpolicy_create` ⚠️ | `POST /igor/hostpolicy`         | Create a host policy                                   |
| `hostpolicy_list`      | `GET /igor/hostpolicy`          | List host policies                                     |
| `hostpolicy_show`      | `GET /igor/hostpolicy`          | Fetch one host policy by name                          |
| `hostpolicy_edit` ⚠️   | `PATCH /igor/hostpolicy/:name`  | Edit a host policy                                     |
| `hostpolicy_delete` ⚠️ | `DELETE /igor/hostpolicy/:name` | Delete a host policy                                   |

### `@nblair2/igor2/boot`

| Method               | igor2 endpoint                  | Description                                            |
| -------------------- | ------------------------------- | ------------------------------------------------------ |
| `distro_create`      | `POST /igor/distros`            | Create a distro (copy / reuse image / image ref / upload kernel+initrd) |
| `distro_list`        | `GET /igor/distros`             | List distros                                           |
| `distro_show`        | `GET /igor/distros`             | Fetch one distro by name                               |
| `distro_edit`        | `PATCH /igor/distros/:name`     | Edit a distro (groups, kernel args, default, etc.)     |
| `distro_delete`      | `DELETE /igor/distros/:name`    | Delete a distro                                        |
| `profile_create`     | `POST /igor/profiles`           | Create a boot profile (distro + kernel args)           |
| `profile_list`       | `GET /igor/profiles`            | List profiles                                          |
| `profile_show`       | `GET /igor/profiles`            | Fetch one profile by name                              |
| `profile_edit`       | `PATCH /igor/profiles/:name`    | Edit a profile                                         |
| `profile_delete`     | `DELETE /igor/profiles/:name`   | Delete a profile                                       |
| `image_register`     | `POST /igor/images/register`    | Register an image (upload kernel+initrd or use staged) |
| `image_list`         | `GET /igor/images`              | List registered images                                 |
| `image_delete`       | `DELETE /igor/images/:name`     | Delete a registered image                              |
| `kickstart_register` | `POST /igor/kickstart/register` | Upload and register a kickstart file                   |
| `kickstart_list`     | `GET /igor/kickstart`           | List kickstart files                                   |
| `kickstart_edit`     | `PATCH /igor/kickstart/:name`   | Replace a kickstart's file and/or rename it            |
| `kickstart_delete`   | `DELETE /igor/kickstart/:name`  | Delete a kickstart file                                |

### `@nblair2/igor2/identity`

| Method            | igor2 endpoint              | Description                                            |
| ----------------- | --------------------------- | ------------------------------------------------------ |
| `user_create` ⚠️  | `POST /igor/users`          | Create a user account                                  |
| `user_list`       | `GET /igor/users`           | List users                                             |
| `user_show`       | `GET /igor/users`           | Fetch one user by name                                 |
| `user_edit`       | `PATCH /igor/users/:name`   | Change email/full name, set password, or force reset   |
| `user_delete` ⚠️  | `DELETE /igor/users/:name`  | Delete a user account                                  |
| `group_create`    | `POST /igor/groups`         | Create a group (optionally LDAP-backed)                |
| `group_list`      | `GET /igor/groups`          | List groups (merges owned + member)                    |
| `group_show`      | `GET /igor/groups`          | Fetch one group by name                                |
| `group_edit`      | `PATCH /igor/groups/:name`  | Edit metadata, owners, or members (one facet at a time) |
| `group_delete` ⚠️ | `DELETE /igor/groups/:name` | Delete a group                                         |
| `elevate` ⚠️      | `PATCH /igor/elevate`       | Activate admin privilege elevation for your session    |
| `elevate_status`  | `GET /igor/elevate`         | Check remaining elevation time                         |
| `elevate_cancel`  | `DELETE /igor/elevate`      | Cancel admin elevation                                 |

### `@nblair2/igor2/server`

| Method               | igor2 endpoint              | Description                                            |
| -------------------- | --------------------------- | ------------------------------------------------------ |
| `cluster_list`       | `GET /igor/clusters`        | List clusters                                          |
| `cluster_motd_set` ⚠️ | `PATCH /igor/clusters/motd` | Set the cluster message-of-the-day                    |
| `sync` ⚠️            | `GET /igor/sync`            | Run a network sync check (e.g. Arista VLAN reconcile)  |
| `stats`              | `GET /igor/stats`           | Read cluster usage statistics                          |
| `config_show`        | `GET /igor/config`          | Read the server config (or public settings)            |
| `auth_reset` ⚠️💥    | `PUT /igor/authreset`       | Reset the JWT signing secret — invalidates ALL tokens  |
| `show`               | `GET /igor`                 | Read the cluster dashboard snapshot                    |

## Global arguments

Every model takes the same connection arguments (configured per model instance):

| Arg        | Required | Default | Notes                                                       |
| ---------- | -------- | ------- | ----------------------------------------------------------- |
| `host`     | yes      | —       | igor2 server hostname or IP                                 |
| `port`     | no       | `8443`  | igor2 server HTTPS port                                     |
| `username` | yes      | —       | igor2 username                                              |
| `password` | yes      | —       | igor2 password (stored as a secret / vault reference)       |
| `caCert`   | no       | —       | PEM CA cert to trust a self-signed/private-CA igor2 server  |

> **Self-signed certificates:** Many igor2 deployments use a self-signed
> certificate. Supply its CA chain via `caCert` so Deno (which swamp uses to run
> models) trusts the connection. Disabling TLS verification entirely is not
> supported because Deno can only do so via a process-wide runtime flag.

## Usage

```bash
# Configure model instances (credentials are entered once per model)
swamp model create @nblair2/igor2/reservations igor-res \
  --global-arg host=igor.example.com \
  --global-arg username=alice \
  --global-arg password=*** \
  --json
swamp model create @nblair2/igor2/server igor-srv \
  --global-arg host=igor.example.com --global-arg username=alice \
  --global-arg password=*** --json
# For a self-signed server, also: --global-arg caCert="$(cat ca.pem)"

# Read the dashboard (server model); list distros (boot model); list users
swamp model method run igor-srv show --json
swamp model method run igor-boot distro_list --json
swamp model method run igor-id user_list --json

# Create a reservation: 5 nodes for 3 days with the "ubuntu20" profile
swamp model method run igor-res reservation_create \
  --input name=myres \
  --input nodeList='kn[1-5]' \
  --input profile=ubuntu20 \
  --input duration=3d \
  --json

# Power-cycle the reserved nodes (hosts model), then delete the reservation
swamp model method run igor-hosts host_power --input cmd=cycle --input reservation=myres --json
swamp model method run igor-res reservation_delete --input name=myres --json
```

### Boot-stack examples

```bash
# Create a distro by reusing an existing distro's image
swamp model method run igor-boot distro_create \
  --input name=ubuntu22 --input useDistroImage=ubuntu20 --json

# Or register an image by uploading kernel + initrd, then create a distro from it
swamp model method run igor-boot image_register \
  --input kernelFile=/srv/images/vmlinuz --input initrdFile=/srv/images/initrd.img --json
swamp model method run igor-boot distro_create \
  --input name=custom --input imageRef=<image-id> --json

# Create a boot profile on top of a distro
swamp model method run igor-boot profile_create \
  --input name=ubuntu22-debug --input distro=ubuntu22 --input kernelArgs='console=ttyS0' --json
```

### Argument notes

- **Nodes:** provide exactly one of `nodeList` (e.g. `kn1,kn3` or `kn[1-5]`) or
  `nodeCount` (any N available nodes).
- **Boot target:** provide exactly one of `profile` or `distro`.
- **Duration:** a string like `3d` or `5h30m`, or a Unix-epoch end time. `start`
  is a Unix-epoch timestamp.
- **Power target:** provide exactly one of `hosts` (a host range) or
  `reservation` (a reservation name).
- **`distro_create` source:** exactly one of `copyDistro`, `useDistroImage`,
  `imageRef`, or `kernelFile`+`initrdFile`.
- **`user_edit`:** exactly one of email/`fullName`, `password`+`oldPassword`, or
  `reset:true`. **`group_edit`:** exactly one facet — metadata
  (`newName`/`description`), owners (`addOwners`/`rmvOwners`), or members
  (`add`/`remove`).
- **`auth_reset`** requires `confirm=true` because it logs out every user.

> **File uploads (`distro_create`, `image_register`, `kickstart_register`,
> `kickstart_edit`, `distro_edit`):** the file `--input` values are **local
> paths** read at run time and sent as `multipart/form-data`. If your swamp
> runtime restricts model file reads, prefer the reference-based creation paths
> (`copyDistro` / `useDistroImage` / `imageRef`, or server-staged
> `kstaged`/`istaged` for images), which require no local file access.

## Stored resources

List/show methods write one resource instance per object (`distro-<name>`,
`user-<name>`, …). Read-only snapshots are stored under `stats-latest`,
`config-server`/`config-public`, and `dashboard-<cluster>`. One-shot actions
without a resource of their own (elevate, sync, auth-reset, block, apply-policy,
MOTD) record their outcome as an `operation` resource.

## Development

```bash
deno task fmt            # format extensions/ + scripts/
deno task lint           # lint
deno task check          # type-check
deno task test           # run unit tests (stubbed fetch, no server needed)
deno task version:check  # assert manifest + all model versions agree

swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

Each model lives in its own file under `extensions/models/`
(`reservations.ts`, `hosts.ts`, `boot.ts`, `identity.ts`, `server.ts`) as a
self-contained `export const model` so the swamp registry can statically index
its methods and resources. They share the HTTP client and response schemas in
`extensions/models/_lib/igor.ts` and the model plumbing in
`extensions/models/_lib/model.ts`. Unit tests live beside each model
(`*_test.ts`) and stub `fetch` (and file reads), so they run without a live
igor2 server.

### Cutting a release

Run `deno task bump` (no argument asks the registry for the next CalVer, or pass
an explicit `YYYY.MM.DD.MICRO`). This writes the version into `manifest.yaml` and
all five model files in lock-step. Commit, open a PR, and merge to `main`: the
`release.yml` workflow publishes to the swamp registry when the manifest version
is newer than what's published, then tags `v<version>` and creates a GitHub
Release. Publishing is idempotent, so a merge that didn't bump the version is a
no-op.

## License

AGPL-3.0-only — see [LICENSE.txt](LICENSE.txt). This matches the license
convention used across the swamp extension ecosystem.
