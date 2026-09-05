#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  evaluateBackupStatus,
  githubMasterIsCurrent,
  readBackupStatus,
  readGitHubMasterStatus,
} from "./personal-records-backup-status.mjs";

const execFileAsync = promisify(execFile);

async function readAlertKey(alertPath) {
  try {
    return (await readFile(alertPath, "utf8")).trim() || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAlertKey(alertPath, key) {
  await mkdir(dirname(alertPath), { recursive: true });
  const temporaryPath = `${alertPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${key}\n`, { mode: 0o600 });
  await rename(temporaryPath, alertPath);
}

async function trackGitHubIncident(incidentPath, status, masterStatus, masterError, now) {
  const checkedAt = new Date(now).toISOString();
  const validTimestamp = value => typeof value === "string" &&
    Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.parse(checkedAt);
  let previous = null;
  try {
    previous = JSON.parse(await readFile(incidentPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous) ||
      !["masterLagStartedAt", "masterUnavailableStartedAt"].every(key =>
        previous[key] === null || validTimestamp(previous[key]))) {
    previous = null;
  }
  // Bootstrap missing or damaged incident state from the last publication. Subsequent
  // incidents start when observed, and successful publisher retries never
  // reset their age. Keep this state separate from publisher-owned status.json.
  const startedAt = previous === null && validTimestamp(status?.lastSuccessAt)
    ? status.lastSuccessAt
    : checkedAt;
  const current = masterStatus && githubMasterIsCurrent(status, masterStatus);
  const next = {
    masterLagStartedAt: current
      ? null
      : previous?.masterLagStartedAt || (masterStatus ? startedAt : null),
    masterUnavailableStartedAt: masterError
      ? previous?.masterUnavailableStartedAt || startedAt
      : null,
  };
  await mkdir(dirname(incidentPath), { recursive: true });
  const temporaryPath = `${incidentPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, incidentPath);
  return next;
}

async function defaultNotify(message) {
  await execFileAsync("/usr/bin/logger", ["-t", "saltybet-records-backup", message]).catch(() => {});
  await execFileAsync("/usr/bin/notify-send", ["-u", "critical", "SaltyBetBot backup alert", message]).catch(
    () => {},
  );
}

export async function runBackupWatchdog({
  statusPath,
  alertPath,
  incidentPath = `${alertPath}.incident.json`,
  backupRepo = null,
  masterStatus = undefined,
  readMasterStatus = readGitHubMasterStatus,
  now = new Date(),
  notify = defaultNotify,
}) {
  let resolvedMasterStatus = masterStatus;
  let masterError = null;
  if (resolvedMasterStatus === undefined && backupRepo) {
    try {
      resolvedMasterStatus = await readMasterStatus({ backupRepo });
    } catch (error) {
      masterError = error.message || String(error);
      resolvedMasterStatus = null;
    }
  }
  const status = await readBackupStatus(statusPath);
  const incident = resolvedMasterStatus || masterError
    ? await trackGitHubIncident(incidentPath, status, resolvedMasterStatus, masterError, now)
    : {};
  const evaluation = evaluateBackupStatus(status, now, {
    ...incident,
    masterStatus: resolvedMasterStatus,
    masterError,
  });
  if (!evaluation.alert) {
    return { status: evaluation.reason, ...evaluation };
  }

  const previousAlertKey = await readAlertKey(alertPath);
  if (previousAlertKey === evaluation.key) {
    return { status: "already_alerted", ...evaluation };
  }

  await notify(evaluation.message);
  await writeAlertKey(alertPath, evaluation.key);
  return { status: "alerted", ...evaluation };
}

async function main() {
  const stateDirectory = process.env.SALTYBET_BACKUP_STATE_DIR ||
    `${process.env.HOME}/.local/state/saltybet-records-backup`;
  const result = await runBackupWatchdog({
    statusPath: process.env.SALTYBET_BACKUP_STATUS || `${stateDirectory}/status.json`,
    alertPath: process.env.SALTYBET_BACKUP_ALERT || `${stateDirectory}/alert.key`,
    backupRepo: process.env.SALTYBET_BACKUP_REPO ||
      `${process.env.HOME}/.local/share/saltybet-records-publisher`,
  });
  console.log(`${result.status}\t${result.reason}\t${result.message}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
