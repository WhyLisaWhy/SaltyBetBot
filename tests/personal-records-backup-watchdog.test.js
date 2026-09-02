import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateBackupStatus,
  readGitHubMasterStatus,
  recordBackupFailure,
  recordBackupSuccess,
} from "../scripts/personal-records-backup-status.mjs";
import { runBackupWatchdog } from "../scripts/personal-records-backup-watchdog.mjs";

const temporaryDirectories = [];

async function paths() {
  const root = await mkdtemp(join(tmpdir(), "saltybet-backup-watchdog-"));
  temporaryDirectories.push(root);
  return {
    statusPath: join(root, "status.json"),
    alertPath: join(root, "alert.key"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("personal-record backup watchdog", () => {
  it("alerts after two consecutive backup failures", () => {
    expect(
      evaluateBackupStatus(
        {
          consecutiveFailures: 2,
          failureStartedAt: "2026-08-27T12:00:00.000Z",
          lastFailureAt: "2026-08-27T12:15:00.000Z",
          lastSuccessAt: "2026-08-27T11:55:00.000Z",
        },
        new Date("2026-08-27T12:20:00.000Z"),
      ),
    ).toEqual(
      expect.objectContaining({
        alert: true,
        reason: "consecutive_failures",
      }),
    );
  });

  it("alerts when the last successful backup is older than 45 minutes", () => {
    expect(
      evaluateBackupStatus(
        {
          consecutiveFailures: 0,
          lastSuccessAt: "2026-08-27T12:00:00.000Z",
        },
        new Date("2026-08-27T12:46:00.000Z"),
      ),
    ).toEqual(
      expect.objectContaining({
        alert: true,
        reason: "stale_success",
      }),
    );
  });

  it("alerts when GitHub master is older than the successful VM publication", () => {
    expect(
      evaluateBackupStatus(
        {
          consecutiveFailures: 0,
          lastSuccessAt: "2026-08-27T12:00:00.000Z",
          recordCount: 12,
          lastDateIso: "2026-08-27T12:00:00.000Z",
          sha256: "new",
        },
        new Date("2026-08-27T12:46:00.000Z"),
        {
          masterStatus: {
            recordCount: 11,
            lastDateIso: "2026-08-27T11:59:00.000Z",
            sha256: "old",
          },
        },
      ),
    ).toEqual(
      expect.objectContaining({
        alert: true,
        reason: "github_stale",
      }),
    );
  });

  it("keeps a recent backup with one failure below the alert threshold", () => {
    expect(
      evaluateBackupStatus(
        {
          consecutiveFailures: 1,
          lastSuccessAt: "2026-08-27T12:15:00.000Z",
        },
        new Date("2026-08-27T12:46:00.000Z"),
      ).alert,
    ).toBe(false);
  });

  it("tracks a failure streak from its first failed run", async () => {
    const { statusPath } = await paths();
    await recordBackupSuccess({
      statusPath,
      recordCount: 10,
      lastDateIso: "2026-08-27T11:59:00.000Z",
      sha256: "good",
      at: new Date("2026-08-27T12:00:00.000Z"),
    });
    await recordBackupFailure({
      statusPath,
      message: "first failure",
      at: new Date("2026-08-27T12:15:00.000Z"),
    });
    await recordBackupFailure({
      statusPath,
      message: "second failure",
      at: new Date("2026-08-27T12:30:00.000Z"),
    });

    expect(JSON.parse(await readFile(statusPath, "utf8"))).toEqual(
      expect.objectContaining({
        consecutiveFailures: 2,
        failureStartedAt: "2026-08-27T12:15:00.000Z",
        lastError: "second failure",
      }),
    );
  });

  it("notifies only once for the same incident", async () => {
    const { statusPath, alertPath } = await paths();
    await recordBackupFailure({
      statusPath,
      message: "failure",
      at: new Date("2026-08-27T12:00:00.000Z"),
    });
    await recordBackupFailure({
      statusPath,
      message: "failure again",
      at: new Date("2026-08-27T12:15:00.000Z"),
    });

    const notifications = [];
    const first = await runBackupWatchdog({
      statusPath,
      alertPath,
      now: new Date("2026-08-27T12:20:00.000Z"),
      notify: async (message) => notifications.push(message),
    });
    const second = await runBackupWatchdog({
      statusPath,
      alertPath,
      now: new Date("2026-08-27T12:35:00.000Z"),
      notify: async (message) => notifications.push(message),
    });

    expect(first.status).toBe("alerted");
    expect(second.status).toBe("already_alerted");
    expect(notifications).toHaveLength(1);
  });

  it("reads and normalizes GitHub master metadata after fetching it", async () => {
    const calls = [];
    const result = await readGitHubMasterStatus({
      backupRepo: "/tmp/publisher",
      runGit: async (args) => {
        calls.push(args);
        if (args.includes("fetch")) return { stdout: "", stderr: "" };
        return {
          stdout: JSON.stringify({
            recordCount: 12,
            lastDateIso: "2026-08-27T12:00:00.000Z",
            sha256: "new",
          }),
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      recordCount: 12,
      lastDateIso: "2026-08-27T12:00:00.000Z",
      sha256: "new",
    });
    expect(calls).toEqual([
      [
        "-C",
        "/tmp/publisher",
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "origin",
        "master",
      ],
      [
        "-C",
        "/tmp/publisher",
        "show",
        "origin/master:community-records/personal-records-metadata.json",
      ],
    ]);
  });

  it("checks GitHub master before deciding that a backup is healthy", async () => {
    const { statusPath, alertPath } = await paths();
    await recordBackupSuccess({
      statusPath,
      recordCount: 12,
      lastDateIso: "2026-08-27T12:00:00.000Z",
      sha256: "new",
      at: new Date("2026-08-27T12:00:00.000Z"),
    });

    const notifications = [];
    const result = await runBackupWatchdog({
      statusPath,
      alertPath,
      backupRepo: "/tmp/publisher",
      now: new Date("2026-08-27T12:46:00.000Z"),
      readMasterStatus: async () => ({
        recordCount: 11,
        lastDateIso: "2026-08-27T11:59:00.000Z",
        sha256: "old",
      }),
      notify: async (message) => notifications.push(message),
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "alerted",
        reason: "github_stale",
      }),
    );
    expect(notifications).toHaveLength(1);
  });
});
