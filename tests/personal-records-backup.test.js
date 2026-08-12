import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { preparePersonalRecordsBackup } from "../scripts/prepare-personal-records-backup.mjs";

const temporaryDirectories = [];

function record(date, left = `Left ${date}`, right = `Right ${date}`) {
  return { left: { name: left }, right: { name: right }, date };
}

async function paths() {
  const root = await mkdtemp(join(tmpdir(), "saltybet-records-backup-"));
  temporaryDirectories.push(root);
  return {
    sourcePath: join(root, "source.json"),
    targetPath: join(root, "community-records", "personal-records-latest.json"),
    metadataPath: join(root, "community-records", "personal-records-metadata.json"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("personal-record backup publisher", () => {
  it("publishes chronological records with reproducible metadata", async () => {
    const files = await paths();
    await writeFile(files.sourcePath, JSON.stringify([record(10), record(20)]));

    const result = await preparePersonalRecordsBackup({
      ...files,
      generatedAt: new Date("2026-08-12T12:00:00Z"),
    });

    expect(result).toEqual(expect.objectContaining({ status: "updated", recordCount: 2 }));
    expect(JSON.parse(await readFile(files.targetPath, "utf8"))).toHaveLength(2);
    expect(JSON.parse(await readFile(files.metadataPath, "utf8"))).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        recordCount: 2,
        firstDate: 10,
        lastDate: 20,
        generatedAt: "2026-08-12T12:00:00.000Z",
      }),
    );

    expect(await preparePersonalRecordsBackup({ ...files })).toEqual(
      expect.objectContaining({ status: "unchanged", recordCount: 2 }),
    );
  });

  it("rejects empty, malformed, out-of-order, and regressed exports", async () => {
    const files = await paths();

    for (const invalid of [[], [{ date: 10 }], [record(20), record(10)]]) {
      await writeFile(files.sourcePath, JSON.stringify(invalid));
      await expect(preparePersonalRecordsBackup({ ...files })).rejects.toThrow();
    }

    await writeFile(files.sourcePath, JSON.stringify([record(10), record(20)]));
    await preparePersonalRecordsBackup({ ...files });
    await writeFile(files.sourcePath, JSON.stringify([record(10)]));
    await expect(preparePersonalRecordsBackup({ ...files })).rejects.toThrow(
      "Refusing record-count regression",
    );
  });
});
