import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** MySQL DDL auto-commits. Recover the observed partial 0004 apply without dropping data or skipping unfinished DDL. */
async function main() {
  const filename = "drizzle/0004_capture_pipeline.sql";
  const migration = readFileSync(filename, "utf8");
  const journal = JSON.parse(
    readFileSync("drizzle/meta/_journal.json", "utf8")
  );
  const entry = journal.entries.find(
    (e: { tag: string }) => e.tag === "0004_capture_pipeline"
  );
  if (!entry) throw Error("Migration journal entry missing");
  const c = await mysql.createConnection(process.env.DATABASE_URL!);
  try {
    const [applied] = await c.execute<mysql.RowDataPacket[]>(
      "SELECT hash FROM __drizzle_migrations WHERE created_at=?",
      [entry.when]
    );
    const hash = createHash("sha256").update(migration).digest("hex");
    if (applied.length) {
      if (applied[0].hash !== hash)
        throw Error("Recorded migration hash differs; stop for investigation.");
      console.log("Capture migration already recorded.");
      return;
    }
    for (const text of migration.split("--> statement-breakpoint")) {
      const statement = text.trim();
      if (!statement) continue;
      const create = /^CREATE TABLE `([^`]+)`/.exec(statement),
        fk = /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)`/.exec(statement),
        index = /^CREATE INDEX `([^`]+)` ON `([^`]+)`/.exec(statement);
      let exists = false;
      if (create) {
        const [rows] = await c.execute<mysql.RowDataPacket[]>(
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
          [create[1]]
        );
        exists = rows.length > 0;
      } else if (fk) {
        const [rows] = await c.execute<mysql.RowDataPacket[]>(
          "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?",
          [fk[1], fk[2]]
        );
        exists = rows.length > 0;
      } else if (index) {
        const [rows] = await c.execute<mysql.RowDataPacket[]>(
          "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?",
          [index[2], index[1]]
        );
        exists = rows.length > 0;
      } else
        throw Error(
          "Unexpected statement; recovery only supports reviewed additive DDL."
        );
      if (!exists) {
        await c.query(statement);
        console.log(
          "Applied missing capture DDL:",
          create?.[1] ?? fk?.[2] ?? index?.[1]
        );
      }
    }
    // Match every declared column in the existing tables before accepting their initial CREATE as completed.
    for (const text of migration.split("--> statement-breakpoint")) {
      const match = /^\s*CREATE TABLE `([^`]+)`/.exec(text);
      if (!match) continue;
      const expected = [...text.matchAll(/^\s*`([^`]+)`\s+/gm)].map(m => m[1]);
      const [columns] = await c.execute<mysql.RowDataPacket[]>(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
        [match[1]]
      );
      for (const name of expected)
        if (!columns.some(r => r.COLUMN_NAME === name))
          throw Error("Migration column missing: " + match[1] + "." + name);
    }
    await c.execute(
      "INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)",
      [hash, entry.when]
    );
    console.log(
      "Capture migration completed and recorded; no business records were written."
    );
  } finally {
    await c.end();
  }
}
main().catch(e => {
  console.error(
    e instanceof Error ? e.message : "Capture migration recovery failed"
  );
  process.exitCode = 1;
});
