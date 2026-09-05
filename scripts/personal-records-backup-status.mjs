import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BACKUP_STATUS_SCHEMA_VERSION = 1;
export const BACKUP_FAILURE_THRESHOLD = 2;
export const BACKUP_STALE_AFTER_MS = 45 * 60 * 1000;

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid backup status timestamp: ${value}`);
  return date.toISOString();
}

function emptyStatus() {
  return {
    schemaVersion: BACKUP_STATUS_SCHEMA_VERSION,
    consecutiveFailures: 0,
    failureStartedAt: null,
    lastFailureAt: null,
    lastError: null,
    lastSuccessAt: null,
    recordCount: null,
    lastDateIso: null,
    sha256: null,
  };
}

async function writeStatus(statusPath, status) {
  await mkdir(dirname(statusPath), { recursive: true });
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statusPath);
}

export async function readBackupStatus(statusPath) {
  try {
    const parsed = JSON.parse(await readFile(statusPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Backup status is not an object");
    }
    return { ...emptyStatus(), ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Unable to read backup status: ${error.message}`);
  }
}

async function defaultRunGit(args) {
  return execFileAsync("git", args, { maxBuffer: 2 * 1024 * 1024 });
}

export async function readGitHubMasterStatus({ backupRepo, runGit = defaultRunGit }) {
  if (typeof backupRepo !== "string" || !backupRepo) {
    throw new Error("GitHub master status requires a backup repository path");
  }

  await runGit([
    "-C",
    backupRepo,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    "origin",
    "master",
  ]);
  const { stdout } = await runGit([
    "-C",
    backupRepo,
    "show",
    "origin/master:community-records/personal-records-metadata.json",
  ]);
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`GitHub master metadata is not valid JSON: ${error.message}`);
  }
  if (
    !metadata ||
    !Number.isInteger(metadata.recordCount) ||
    typeof metadata.lastDateIso !== "string" ||
    typeof metadata.sha256 !== "string"
  ) {
    throw new Error("GitHub master metadata is missing required backup fields");
  }
  return {
    recordCount: metadata.recordCount,
    lastDateIso: metadata.lastDateIso,
    sha256: metadata.sha256,
  };
}

export async function recordBackupSuccess({
  statusPath,
  recordCount,
  lastDateIso,
  sha256,
  at = new Date(),
}) {
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new Error("Backup success requires a positive record count");
  }
  if (typeof lastDateIso !== "string" || !lastDateIso) {
    throw new Error("Backup success requires a latest-record ISO date");
  }
  if (typeof sha256 !== "string" || !sha256) {
    throw new Error("Backup success requires a SHA-256 value");
  }

  const current = (await readBackupStatus(statusPath)) || emptyStatus();
  const next = {
    ...current,
    schemaVersion: BACKUP_STATUS_SCHEMA_VERSION,
    consecutiveFailures: 0,
    failureStartedAt: null,
    lastSuccessAt: timestamp(at),
    recordCount,
    lastDateIso,
    sha256,
  };
  await writeStatus(statusPath, next);
  return next;
}

export async function recordBackupFailure({ statusPath, message, at = new Date() }) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Backup failure requires a message");
  }

  const current = (await readBackupStatus(statusPath)) || emptyStatus();
  const failureAt = timestamp(at);
  const consecutiveFailures =
    Number.isInteger(current.consecutiveFailures) && current.consecutiveFailures > 0
      ? current.consecutiveFailures + 1
      : 1;
  const next = {
    ...current,
    schemaVersion: BACKUP_STATUS_SCHEMA_VERSION,
    consecutiveFailures,
    failureStartedAt:
      consecutiveFailures === 1 ? failureAt : current.failureStartedAt || failureAt,
    lastFailureAt: failureAt,
    lastError: message.trim(),
  };
  await writeStatus(statusPath, next);
  return next;
}

export function githubMasterIsCurrent(status, masterStatus) {
  const hasHashes = typeof status?.sha256 === "string" && typeof masterStatus?.sha256 === "string";
  return hasHashes
    ? masterStatus.sha256 === status.sha256
    : masterStatus.recordCount >= status?.recordCount &&
      masterStatus.lastDateIso >= status?.lastDateIso;
}

export function evaluateBackupStatus(
  status,
  now = new Date(),
  {
    failureThreshold = BACKUP_FAILURE_THRESHOLD,
    staleAfterMs = BACKUP_STALE_AFTER_MS,
    masterStatus = null,
    masterError = null,
    masterLagStartedAt = null,
    masterUnavailableStartedAt = null,
  } = {},
) {
  const currentTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(currentTime.getTime())) throw new Error(`Invalid watchdog time: ${now}`);

  const failures = Number.isInteger(status?.consecutiveFailures) ? status.consecutiveFailures : 0;
  if (failures >= failureThreshold) {
    const key = `failure:${status.failureStartedAt || status.lastFailureAt || "unknown"}`;
    return {
      alert: true,
      reason: "consecutive_failures",
      key,
      message: `SaltyBetBot backup has failed ${failures} consecutive times. Last error: ${
        status.lastError || "unknown"
      }`,
    };
  }

  if (!status?.lastSuccessAt) {
    return {
      alert: false,
      reason: "not_ready",
      message: "No successful SaltyBetBot backup has been recorded yet",
    };
  }

  const lastSuccessAt = new Date(status.lastSuccessAt);
  if (!Number.isFinite(lastSuccessAt.getTime())) {
    return {
      alert: true,
      reason: "invalid_status",
      key: "invalid:lastSuccessAt",
      message: "SaltyBetBot backup status contains an invalid last-success timestamp",
    };
  }

  const ageMs = Math.max(0, currentTime.getTime() - lastSuccessAt.getTime());
  const unavailableAgeMs = masterUnavailableStartedAt
    ? Math.max(0, currentTime.getTime() - new Date(masterUnavailableStartedAt).getTime())
    : ageMs;
  const lagAgeMs = masterLagStartedAt
    ? Math.max(0, currentTime.getTime() - new Date(masterLagStartedAt).getTime())
    : ageMs;
  if (masterError && unavailableAgeMs > staleAfterMs) {
    return {
      alert: true,
      reason: "github_unavailable",
      key: `github-unavailable:${masterUnavailableStartedAt || status.lastSuccessAt}`,
      message: `GitHub master could not be checked for ${Math.round(
        unavailableAgeMs / 60000,
      )} minutes: ${masterError}`,
    };
  }

  if (masterStatus) {
    if (!githubMasterIsCurrent(status, masterStatus) && lagAgeMs > staleAfterMs) {
      return {
        alert: true,
        reason: "github_stale",
        key: `github:${masterLagStartedAt || status.sha256 || status.lastDateIso || status.recordCount}`,
        message: `GitHub master is still at ${masterStatus.recordCount} records while the VM has published ${status.recordCount}; it has lagged for ${Math.round(
          lagAgeMs / 60000,
        )} minutes`,
      };
    }
  }

  if (ageMs > staleAfterMs) {
    return {
      alert: true,
      reason: "stale_success",
      key: `stale:${status.lastSuccessAt}`,
      message: `SaltyBetBot backup has not succeeded for ${Math.round(ageMs / 60000)} minutes`,
    };
  }

  return {
    alert: false,
    reason: "healthy",
    ageMs,
    message: "SaltyBetBot backup is healthy",
  };
}

async function main() {
  const [command, statusPath, ...args] = process.argv.slice(2);
  if (!command || !statusPath) {
    throw new Error("Usage: node personal-records-backup-status.mjs success|failure STATUS_PATH ...");
  }

  if (command === "success") {
    await recordBackupSuccess({
      statusPath: resolve(statusPath),
      recordCount: Number(args[0]),
      lastDateIso: args[1],
      sha256: args[2],
    });
    return;
  }
  if (command === "failure") {
    await recordBackupFailure({
      statusPath: resolve(statusPath),
      message: args.join(" "),
    });
    return;
  }
  throw new Error(`Unknown backup status command: ${command}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
