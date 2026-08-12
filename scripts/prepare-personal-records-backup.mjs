import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function isoDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid record date: ${value}`);
  return date.toISOString();
}

export function inspectPersonalRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Refusing to publish an empty personal-record database");
  }

  let previousDate = -Infinity;
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      typeof record !== "object" ||
      !Number.isFinite(record.date) ||
      !record.left ||
      typeof record.left.name !== "string" ||
      record.left.name.length === 0 ||
      !record.right ||
      typeof record.right.name !== "string" ||
      record.right.name.length === 0
    ) {
      throw new Error(`Invalid personal record at array index ${index}`);
    }
    if (record.date < previousDate) {
      throw new Error(`Personal records are not chronological at array index ${index}`);
    }
    previousDate = record.date;
  }

  return {
    recordCount: records.length,
    firstDate: records[0].date,
    lastDate: records.at(-1).date,
  };
}

async function readExistingMetadata(metadataPath) {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Unable to read existing backup metadata: ${error.message}`);
  }
}

export async function preparePersonalRecordsBackup({
  sourcePath,
  targetPath,
  metadataPath,
  generatedAt = new Date(),
}) {
  const sourceText = await readFile(sourcePath, "utf8");
  let records;
  try {
    records = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`Personal-record export is not valid JSON: ${error.message}`);
  }

  const summary = inspectPersonalRecords(records);
  const existing = await readExistingMetadata(metadataPath);
  if (existing) {
    if (summary.recordCount < existing.recordCount) {
      throw new Error(
        `Refusing record-count regression from ${existing.recordCount} to ${summary.recordCount}`,
      );
    }
    if (summary.lastDate < existing.lastDate) {
      throw new Error(
        `Refusing latest-date regression from ${existing.lastDate} to ${summary.lastDate}`,
      );
    }
  }

  const normalized = `${JSON.stringify(records, null, 2)}\n`;
  const sha256 = createHash("sha256").update(normalized).digest("hex");
  if (existing?.sha256 === sha256) {
    return { status: "unchanged", sha256, ...summary };
  }

  const metadata = {
    schemaVersion: 1,
    source: "SaltyBetBot personal_records IndexedDB export",
    generatedAt: generatedAt.toISOString(),
    ...summary,
    firstDateIso: isoDate(summary.firstDate),
    lastDateIso: isoDate(summary.lastDate),
    sha256,
  };

  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(dirname(metadataPath), { recursive: true });
  const targetTemporary = `${targetPath}.${process.pid}.tmp`;
  const metadataTemporary = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(targetTemporary, normalized, { mode: 0o644 });
  await writeFile(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  await rename(targetTemporary, targetPath);
  await rename(metadataTemporary, metadataPath);

  return { status: "updated", sha256, ...summary };
}

async function main() {
  const [sourcePath, targetPath, metadataPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath || !metadataPath) {
    throw new Error(
      "Usage: node scripts/prepare-personal-records-backup.mjs SOURCE TARGET METADATA",
    );
  }
  const result = await preparePersonalRecordsBackup({
    sourcePath: resolve(sourcePath),
    targetPath: resolve(targetPath),
    metadataPath: resolve(metadataPath),
  });
  process.stdout.write(
    [result.status, result.recordCount, result.firstDate, result.lastDate, result.sha256].join("\t") +
      "\n",
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
