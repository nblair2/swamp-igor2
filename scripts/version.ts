#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=swamp
/**
 * Release-version helper for the `@nblair2/igor2` extension.
 *
 * The published version lives in several places that must agree: the `version`
 * in `manifest.yaml` (what the registry publishes) and the `version` field of
 * the exported `model` in each of the model files under `extensions/models/`.
 * This script is the single source of truth for keeping them in lock-step. It
 * is intentionally kept outside `extensions/` so it never becomes part of the
 * published bundle.
 *
 * Usage:
 *   deno task bump [version]   # write a new CalVer into manifest + every model
 *   deno task version:check    # assert all files agree and are valid CalVer
 *
 * `bump` with no argument asks `swamp extension version` for the next CalVer
 * (works unauthenticated); pass an explicit `YYYY.MM.DD.MICRO` to override.
 *
 * @module
 */
const ROOT = `${import.meta.dirname}/..`;
const MANIFEST = `${ROOT}/manifest.yaml`;
/** Model source files whose `version` literal must match the manifest. */
const MODEL_FILES = [
  "reservations.ts",
  "hosts.ts",
  "boot.ts",
  "identity.ts",
  "server.ts",
].map((f) => `${ROOT}/extensions/models/${f}`);

const CALVER = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

/** True if `v` is a syntactically valid CalVer that names a real calendar date. */
function isValidCalVer(v: string): boolean {
  const m = CALVER.exec(v);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** The `version: "..."` in `manifest.yaml` (top-level key). */
const MANIFEST_VERSION = /^version:\s*"([^"]+)"/m;
/** The `version: "..."` field of the exported model in a model file. */
const MODEL_VERSION = /^\s*version:\s*"([^"]+)"/m;

/** A file's recorded version, paired with a short label for messages. */
interface FileVersion {
  label: string;
  path: string;
  pattern: RegExp;
  version: string | null;
}

/** Read the version recorded in the manifest and every model file. */
async function readVersions(): Promise<FileVersion[]> {
  const entries: FileVersion[] = [
    {
      label: "manifest.yaml",
      path: MANIFEST,
      pattern: MANIFEST_VERSION,
      version: null,
    },
    ...MODEL_FILES.map((path) => ({
      label: path.slice(path.lastIndexOf("/") + 1),
      path,
      pattern: MODEL_VERSION,
      version: null as string | null,
    })),
  ];
  for (const e of entries) {
    const text = await Deno.readTextFile(e.path);
    e.version = e.pattern.exec(text)?.[1] ?? null;
  }
  return entries;
}

/** Ask `swamp extension version` for the next CalVer for this extension. */
async function nextVersionFromSwamp(): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("swamp", {
      args: ["extension", "version", "--manifest", MANIFEST, "--json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    throw new Error(
      "could not run `swamp` to compute the next version — install swamp, or " +
        "pass an explicit version, e.g. `deno task bump 2026.05.30.1`",
    );
  }
  const out = new TextDecoder().decode(output.stdout).trim();
  // swamp prints `{ "error": "..." }` to stdout (not stderr) on failure.
  let parsed: { nextVersion?: unknown; error?: unknown } = {};
  try {
    parsed = JSON.parse(out);
  } catch { /* fall through to the error below */ }
  if (!output.success || typeof parsed.error === "string") {
    const detail = typeof parsed.error === "string"
      ? parsed.error
      : (out || new TextDecoder().decode(output.stderr).trim());
    throw new Error(
      `could not compute the next version via swamp: ${detail}\n` +
        "pass an explicit version instead, e.g. `deno task bump 2026.05.30.1`",
    );
  }
  if (typeof parsed.nextVersion !== "string") {
    throw new Error("`swamp extension version` did not return a nextVersion");
  }
  return parsed.nextVersion;
}

/** Replace the version literal in a file's text, requiring exactly one match. */
function replaceVersion(
  text: string,
  pattern: RegExp,
  version: string,
): string {
  if (!pattern.test(text)) {
    throw new Error("could not locate a version field to update");
  }
  return text.replace(
    pattern,
    (line) => line.replace(/"[^"]+"/, `"${version}"`),
  );
}

/** Write `version` into `manifest.yaml` and every model file. */
async function bump(version: string): Promise<void> {
  if (!isValidCalVer(version)) {
    throw new Error(
      `'${version}' is not a valid CalVer (expected YYYY.MM.DD.MICRO naming a real date)`,
    );
  }
  const entries = await readVersions();
  for (const e of entries) {
    const text = await Deno.readTextFile(e.path);
    await Deno.writeTextFile(e.path, replaceVersion(text, e.pattern, version));
    console.log(`${e.label}: ${e.version} → ${version}`);
  }
}

/** Assert all files agree and hold a valid CalVer; exit non-zero if not. */
async function check(): Promise<void> {
  const entries = await readVersions();
  const problems: string[] = [];
  for (const e of entries) {
    if (!e.version) problems.push(`no version found in ${e.label}`);
    else if (!isValidCalVer(e.version)) {
      problems.push(`${e.label} version '${e.version}' is not valid CalVer`);
    }
  }
  const versions = new Set(
    entries.map((e) => e.version).filter((v): v is string => v !== null),
  );
  if (versions.size > 1) {
    const detail = entries.map((e) => `${e.label}=${e.version}`).join(", ");
    problems.push(
      `version mismatch (${detail}) — run \`deno task bump <version>\` to sync`,
    );
  }
  if (problems.length > 0) {
    console.error("version check failed:");
    for (const p of problems) console.error(`  - ${p}`);
    Deno.exit(1);
  }
  console.log(`version OK: ${[...versions][0]}`);
}

async function main(): Promise<void> {
  const [cmd, arg] = Deno.args;
  switch (cmd) {
    case "bump":
      await bump(arg ?? await nextVersionFromSwamp());
      break;
    case "check":
      await check();
      break;
    default:
      console.error("usage: version.ts <bump [version] | check>");
      Deno.exit(2);
  }
}

await main();
