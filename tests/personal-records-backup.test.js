import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { preparePersonalRecordsBackup } from "../scripts/prepare-personal-records-backup.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
const publisherScriptPath = fileURLToPath(
  new URL("../scripts/publish-personal-records-backup.sh", import.meta.url),
);

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

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
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

  it("rejects exports that remove old records even when count and latest date advance", async () => {
    const files = await paths();
    await writeFile(files.sourcePath, JSON.stringify([record(10), record(20)]));
    await preparePersonalRecordsBackup({ ...files });

    await writeFile(files.sourcePath, JSON.stringify([record(10), record(30), record(40)]));

    await expect(preparePersonalRecordsBackup({ ...files })).rejects.toThrow(
      "Refusing to remove previously published records",
    );
    expect(JSON.parse(await readFile(files.targetPath, "utf8"))).toHaveLength(2);
  });

  it("rejects records with fields outside the public export schema", async () => {
    const files = await paths();
    const invalidRecords = [
      { ...record(10), privateNote: "do not publish" },
      { ...record(10), left: { name: "Left 10", privateNote: "do not publish" } },
    ];

    for (const invalid of invalidRecords) {
      await writeFile(files.sourcePath, JSON.stringify([invalid]));
      await expect(preparePersonalRecordsBackup({ ...files })).rejects.toThrow(
        "Invalid personal record",
      );
    }
  });

  it("syncs a checkout even when the automation branch is incorrectly tracking master", async () => {
    const root = await mkdtemp(join(tmpdir(), "saltybet-records-publisher-git-"));
    temporaryDirectories.push(root);
    const bareRepo = join(root, "remote.git");
    const seedRepo = join(root, "seed");
    const backupRepo = join(root, "publisher");
    const exportPath = join(root, "export.json");
    const snapshotDir = join(root, "snapshots");
    const sourceRecords = [record(10)];

    await git(root, "init", "--bare", bareRepo);
    await git(root, "init", "--initial-branch=master", seedRepo);
    await git(seedRepo, "config", "user.name", "Test Publisher");
    await git(seedRepo, "config", "user.email", "test-publisher@example.invalid");
    await writeFile(exportPath, JSON.stringify(sourceRecords));
    await preparePersonalRecordsBackup({
      sourcePath: exportPath,
      targetPath: join(seedRepo, "community-records", "personal-records-latest.json"),
      metadataPath: join(seedRepo, "community-records", "personal-records-metadata.json"),
    });
    await git(seedRepo, "add", "community-records");
    await git(seedRepo, "commit", "-m", "seed backup");
    await git(seedRepo, "remote", "add", "origin", bareRepo);
    await git(seedRepo, "push", "origin", "master");
    await git(seedRepo, "branch", "automation/personal-records-backup");
    await git(seedRepo, "push", "origin", "automation/personal-records-backup");

    await git(root, "clone", bareRepo, backupRepo);
    await git(backupRepo, "switch", "-c", "automation/personal-records-backup", "origin/master");
    await git(backupRepo, "config", "branch.automation/personal-records-backup.remote", "origin");
    await git(
      backupRepo,
      "config",
      "branch.automation/personal-records-backup.merge",
      "refs/heads/master",
    );

    const result = await execFileAsync("bash", [
      publisherScriptPath,
    ], {
      env: {
        ...process.env,
        SALTYBET_BACKUP_REPO: backupRepo,
        SALTYBET_RECORDS_EXPORT: exportPath,
        SALTYBET_LOCAL_SNAPSHOTS: snapshotDir,
        SALTYBET_BACKUP_STATE_DIR: join(root, "state"),
      },
    });

    expect(result.stdout).toContain("Personal-record backup is already current");
    expect((await git(backupRepo, "status", "--porcelain")).stdout).toBe("");
    expect(
      (await git(backupRepo, "config", "--get", "branch.automation/personal-records-backup.merge"))
        .stdout.trim(),
    ).toBe("refs/heads/automation/personal-records-backup");
  });
});
