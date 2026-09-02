#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  evaluateBackupStatus,
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

async function defaultNotify(message) {
  await execFileAsync("/usr/bin/logger", ["-t", "saltybet-records-backup", message]).catch(() => {});
  await execFileAsync("/usr/bin/notify-send", ["-u", "critical", "SaltyBetBot backup alert", message]).catch(
    () => {},
  );
}

export async function runBackupWatchdog({
  statusPath,
  alertPath,
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
  const evaluation = evaluateBackupStatus(await readBackupStatus(statusPath), now, {
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
