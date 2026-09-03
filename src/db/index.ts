import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Default database location; override with FEELGOOD_DB. */
export const DEFAULT_DB_PATH = resolve(here, "../../data/feelgood.db");

/**
 * Open the database and apply the schema.
 *
 * The schema is written with `IF NOT EXISTS` throughout, so running it on every
 * open is the migration story for now — additive only. Once the shape settles
 * and there is data worth protecting, this wants real versioned migrations.
 */
export function openDatabase(path: string = process.env["FEELGOOD_DB"] ?? DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}
