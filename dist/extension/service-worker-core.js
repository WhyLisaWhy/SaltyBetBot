export const PROTOCOL_VERSION = 1;
export const DATABASE_NAME = "salty-bet-bot-v3";
export const DATABASE_VERSION = 3;
export const PERSONAL_RECORDS_STORE = "personal_records";
export const PERSONAL_RECORDS_INDEX = "date_key";
export const HEALTH_ALARM = "saltybot-health";
export const PERSONAL_RECORDS_BACKUP_ALARM = "saltybot-personal-records-backup";
export const CHAT_STALE_AFTER_MS = 20 * 60 * 1000;
export const PERSONAL_RECORDS_BACKUP_PERIOD_MINUTES = 30;
export const PERSONAL_RECORDS_BACKUP_FILENAME =
  "SaltyBetBot Backups/personal-records-latest.json";
export const SETTINGS_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_BET = 32_000;
export const MIN_MAX_BET = 1;
export const MAX_MAX_BET = 1_000_000;

export const SALTYBET_PATTERNS = [
  "*://saltybet.com/*",
  "*://www.saltybet.com/*",
  "*://mugen.saltybet.com/*",
  "*://live.saltybet.com/*",
];

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  automationEnabled: false,
  maxBet: DEFAULT_MAX_BET,
});

function validMaxBet(value) {
  return Number.isInteger(value) && value >= MIN_MAX_BET && value <= MAX_MAX_BET;
}

function normalizedSettings(stored) {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    automationEnabled: stored.automationEnabled === true,
    maxBet: validMaxBet(stored.maxBet) ? stored.maxBet : DEFAULT_MAX_BET,
  };
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function publicRecord(value) {
  const { key: _key, ...record } = value;
  return record;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordKey(record) {
  let hash = 0x811c9dc5;
  const input = canonicalJson(record);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${record.date}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validRecord(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      Number.isFinite(record.date) &&
      record.left &&
      typeof record.left.name === "string" &&
      record.right &&
      typeof record.right.name === "string",
  );
}

function isSaltyBetUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ["saltybet.com", "www.saltybet.com", "mugen.saltybet.com", "live.saltybet.com"].includes(
        parsed.hostname,
      )
    );
  } catch {
    return false;
  }
}

export function createServiceWorker({
  chromeApi,
  indexedDb,
  keyRange,
  now = () => Date.now(),
}) {
  let databasePromise;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          const store = database.objectStoreNames.contains(PERSONAL_RECORDS_STORE)
            ? request.transaction.objectStore(PERSONAL_RECORDS_STORE)
            : database.createObjectStore(PERSONAL_RECORDS_STORE, { keyPath: "key" });
          if (!store.indexNames.contains(PERSONAL_RECORDS_INDEX)) {
            store.createIndex(PERSONAL_RECORDS_INDEX, ["date", "key"], { unique: true });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Unable to open records database"));
      });
    }
    return databasePromise;
  }

  async function getSettings() {
    const stored = await chromeApi.storage.local.get(DEFAULT_SETTINGS);
    return normalizedSettings(stored);
  }

  async function setSettings(payload = {}) {
    const current = await getSettings();
    const hasAutomationEnabled = Object.prototype.hasOwnProperty.call(payload, "automationEnabled");
    const hasMaxBet = Object.prototype.hasOwnProperty.call(payload, "maxBet");

    if (hasAutomationEnabled && typeof payload.automationEnabled !== "boolean") {
      throw new Error("automationEnabled must be a boolean");
    }
    if (hasMaxBet && !validMaxBet(payload.maxBet)) {
      throw new Error(`maxBet must be an integer between ${MIN_MAX_BET} and ${MAX_MAX_BET}`);
    }

    const settings = normalizedSettings({
      automationEnabled: hasAutomationEnabled ? payload.automationEnabled : current.automationEnabled,
      maxBet: hasMaxBet ? payload.maxBet : current.maxBet,
    });
    await chromeApi.storage.local.set(settings);
    await broadcastControllerStatus();
    return settings;
  }

  async function ensureDefaults() {
    const current = await chromeApi.storage.local.get(DEFAULT_SETTINGS);
    await chromeApi.storage.local.set(normalizedSettings(current));
    await chromeApi.alarms.create(HEALTH_ALARM, { periodInMinutes: 5 });
    await chromeApi.alarms.create(PERSONAL_RECORDS_BACKUP_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: PERSONAL_RECORDS_BACKUP_PERIOD_MINUTES,
      persistAcrossSessions: true,
    });
  }

  async function currentControllerId() {
    const session = await chromeApi.storage.session.get({ controllerTabId: null });
    return Number.isInteger(session.controllerTabId) ? session.controllerTabId : null;
  }

  async function controllerIsValid(tabId) {
    if (!Number.isInteger(tabId)) return false;
    try {
      const tab = await chromeApi.tabs.get(tabId);
      return isSaltyBetUrl(tab.url || "");
    } catch {
      return false;
    }
  }

  async function assignController(tabId, force = false) {
    if (!(await controllerIsValid(tabId))) throw new Error("The selected tab is not a SaltyBet tab");

    const current = await currentControllerId();
    if (!force && current !== null && current !== tabId && (await controllerIsValid(current))) {
      return controllerStatus(tabId);
    }

    await chromeApi.storage.session.set({ controllerTabId: tabId });
    await broadcastControllerStatus();
    return controllerStatus(tabId);
  }

  async function controllerStatus(tabId) {
    const [controllerTabId, settings, health] = await Promise.all([
      currentControllerId(),
      getSettings(),
      chromeApi.storage.session.get({ lastTwitchEventAt: null }),
    ]);
    return {
      isController: tabId === controllerTabId,
      controllerTabId,
      automationEnabled: settings.automationEnabled,
      maxBet: settings.maxBet,
      lastTwitchEventAt: health.lastTwitchEventAt,
    };
  }

  async function sendRuntimeEvent(tabId, payload) {
    try {
      await chromeApi.tabs.sendMessage(tabId, {
        v: PROTOCOL_VERSION,
        type: "runtime.event",
        payload,
      });
    } catch {
      // Content scripts may be navigating or not initialized yet.
    }
  }

  async function saveTwitchSnapshot(tabId, events, timestamp) {
    const key = `twitchSnapshot:${tabId}`;
    const session = await chromeApi.storage.session.get({
      [key]: { events: [], timestamp: null },
    });
    const previous = session[key];
    const previousEvents =
      Array.isArray(previous?.events) &&
      Number.isFinite(previous?.timestamp) &&
      timestamp - previous.timestamp < CHAT_STALE_AFTER_MS
        ? previous.events
        : [];
    await chromeApi.storage.session.set({
      [key]: {
        events: [...previousEvents, ...events].slice(-50),
        timestamp,
      },
    });
  }

  async function replayTwitchSnapshot(tabId) {
    const key = `twitchSnapshot:${tabId}`;
    const session = await chromeApi.storage.session.get({ [key]: null });
    const snapshot = session[key];
    if (
      snapshot &&
      Array.isArray(snapshot.events) &&
      snapshot.events.length > 0 &&
      Number.isFinite(snapshot.timestamp) &&
      now() - snapshot.timestamp < CHAT_STALE_AFTER_MS
    ) {
      await sendRuntimeEvent(tabId, { kind: "twitch_events", events: snapshot.events });
    }
  }

  async function broadcastControllerStatus() {
    const tabs = await chromeApi.tabs.query({ url: SALTYBET_PATTERNS });
    await Promise.all(
      tabs.map(async (tab) => {
        if (!Number.isInteger(tab.id)) return;
        const status = await controllerStatus(tab.id);
        await sendRuntimeEvent(tab.id, { kind: "controller_status", ...status });
      }),
    );
  }

  async function routeTwitchEvents(events, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || !isSaltyBetUrl(sender.tab.url || "")) {
      throw new Error("Twitch events must originate from an embedded SaltyBet chat frame");
    }
    if (!Array.isArray(events)) throw new Error("Twitch event payload must be an array");

    let controllerTabId = await currentControllerId();
    if (!(await controllerIsValid(controllerTabId))) {
      await chromeApi.storage.session.set({ controllerTabId: tabId });
      controllerTabId = tabId;
    }

    const timestamp = now();
    await saveTwitchSnapshot(tabId, events, timestamp);
    if (controllerTabId === tabId) {
      await chromeApi.storage.session.set({ lastTwitchEventAt: timestamp });
    }
    if (events.length > 0) {
      await sendRuntimeEvent(tabId, { kind: "twitch_events", events });
    }

    return {
      forwarded: events.length > 0,
      mayBet: controllerTabId === tabId,
      controllerTabId,
      received: events.length,
    };
  }

  async function recordsPage(payload) {
    const limit = Math.min(Math.max(Number(payload?.limit) || 1000, 1), 5000);
    const afterCursor =
      Number.isFinite(payload?.afterCursor?.date) && typeof payload?.afterCursor?.key === "string"
        ? payload.afterCursor
        : null;
    const database = await openDatabase();
    const transaction = database.transaction(PERSONAL_RECORDS_STORE, "readonly");
    const done = transactionPromise(transaction);
    const store = transaction.objectStore(PERSONAL_RECORDS_STORE);
    const index = store.index(PERSONAL_RECORDS_INDEX);
    const range =
      afterCursor === null
        ? undefined
        : keyRange.lowerBound([afterCursor.date, afterCursor.key], true);
    const request = index.openCursor(range);
    const records = [];
    let nextCursor = null;

    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error("Unable to read records"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) {
          resolve();
          return;
        }
        records.push(publicRecord(cursor.value));
        nextCursor = { date: cursor.value.date, key: cursor.value.key };
        cursor.continue();
      };
    });
    await done;

    return { records, nextCursor: records.length === limit ? nextCursor : null };
  }

  async function insertRecords(payload) {
    const records = payload?.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
      throw new Error("records.insert requires between 1 and 1000 records");
    }
    if (!records.every(validRecord)) throw new Error("One or more records are invalid");

    const database = await openDatabase();
    const transaction = database.transaction(PERSONAL_RECORDS_STORE, "readwrite");
    const done = transactionPromise(transaction);
    const store = transaction.objectStore(PERSONAL_RECORDS_STORE);
    for (const record of [...records].sort((left, right) => left.date - right.date)) {
      const { id: _id, key: _key, ...value } = record;
      store.put({ ...value, key: recordKey(value) });
    }
    await done;
    return { inserted: records.length };
  }

  async function clearPersonalRecords() {
    const database = await openDatabase();
    const transaction = database.transaction(PERSONAL_RECORDS_STORE, "readwrite");
    const done = transactionPromise(transaction);
    transaction.objectStore(PERSONAL_RECORDS_STORE).clear();
    await done;
    return { cleared: true };
  }

  async function personalRecordCount() {
    const database = await openDatabase();
    const transaction = database.transaction(PERSONAL_RECORDS_STORE, "readonly");
    const done = transactionPromise(transaction);
    const count = await requestPromise(transaction.objectStore(PERSONAL_RECORDS_STORE).count());
    await done;
    return count;
  }

  async function getAllPersonalRecords() {
    const records = [];
    let afterCursor = null;

    do {
      const page = await recordsPage({ limit: 5000, afterCursor });
      records.push(...page.records);
      afterCursor = page.nextCursor;
    } while (afterCursor !== null);

    return records;
  }

  async function backupPersonalRecords() {
    const records = await getAllPersonalRecords();
    const timestamp = now();
    const stored = await chromeApi.storage.local.get({ personalRecordsLastGoodBackup: null });
    const previous = stored.personalRecordsLastGoodBackup;

    if (records.length === 0) {
      const result = {
        status: "skipped_empty",
        recordCount: 0,
        generatedAt: timestamp,
      };
      await chromeApi.storage.local.set({ personalRecordsBackup: result });
      return result;
    }

    const firstDate = records[0].date;
    const lastDate = records.at(-1).date;
    if (
      previous &&
      (records.length < previous.recordCount ||
        (Number.isFinite(previous.lastDate) && lastDate < previous.lastDate))
    ) {
      const result = {
        status: "skipped_regression",
        recordCount: records.length,
        firstDate,
        lastDate,
        generatedAt: timestamp,
        previousRecordCount: previous.recordCount,
        previousLastDate: previous.lastDate,
      };
      await chromeApi.storage.local.set({ personalRecordsBackup: result });
      return result;
    }

    const contents = `${JSON.stringify(records, null, 2)}\n`;
    const downloadId = await chromeApi.downloads.download({
      url: `data:application/json;charset=utf-8,${encodeURIComponent(contents)}`,
      filename: PERSONAL_RECORDS_BACKUP_FILENAME,
      conflictAction: "overwrite",
      saveAs: false,
    });
    const result = {
      status: "download_started",
      downloadId,
      recordCount: records.length,
      firstDate,
      lastDate,
      generatedAt: timestamp,
    };
    await chromeApi.storage.local.set({
      personalRecordsBackup: result,
      personalRecordsLastGoodBackup: {
        recordCount: records.length,
        firstDate,
        lastDate,
        generatedAt: timestamp,
      },
    });
    return result;
  }

  async function health() {
    const [settings, controllerTabId, session, personalRecords] = await Promise.all([
      getSettings(),
      currentControllerId(),
      chromeApi.storage.session.get({ lastTwitchEventAt: null, lastRecoveryAt: null }),
      personalRecordCount(),
    ]);
    return { settings, controllerTabId, personalRecords, ...session };
  }

  async function recoverStaleChat() {
    const controllerTabId = await currentControllerId();
    if (!(await controllerIsValid(controllerTabId))) {
      await chromeApi.storage.session.remove(["controllerTabId", "lastTwitchEventAt", "lastRecoveryAt"]);
      return;
    }

    const session = await chromeApi.storage.session.get({
      lastTwitchEventAt: null,
      lastRecoveryAt: null,
    });
    if (!Number.isFinite(session.lastTwitchEventAt)) return;

    const timestamp = now();
    const stale = timestamp - session.lastTwitchEventAt >= CHAT_STALE_AFTER_MS;
    const recentlyRecovered =
      Number.isFinite(session.lastRecoveryAt) && timestamp - session.lastRecoveryAt < CHAT_STALE_AFTER_MS;
    if (stale && !recentlyRecovered) {
      await sendRuntimeEvent(controllerTabId, {
        kind: "health_status",
        status: "chat_stale",
      });
      await chromeApi.storage.session.set({ lastRecoveryAt: timestamp });
      await chromeApi.tabs.reload(controllerTabId);
    }
  }

  async function handleRequest(message, sender = {}) {
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") {
      throw new Error("Unsupported extension protocol message");
    }
    const payload = message.payload || {};

    switch (message.type) {
      case "controller.register": {
        const tabId = sender?.tab?.id;
        if (!Number.isInteger(tabId)) throw new Error("Controller registration requires a tab");
        const status = await assignController(tabId, false);
        await replayTwitchSnapshot(tabId);
        return status;
      }
      case "controller.claim": {
        const status = await assignController(payload.tabId, true);
        await replayTwitchSnapshot(payload.tabId);
        return status;
      }
      case "settings.get":
        return getSettings();
      case "settings.set":
        return setSettings(payload);
      case "twitch.events":
        return routeTwitchEvents(payload.events, sender);
      case "records.page":
        return recordsPage(payload);
      case "records.insert":
        return insertRecords(payload);
      case "records.clear_personal":
        return clearPersonalRecords();
      case "records.count_personal":
        return { count: await personalRecordCount() };
      case "records.backup_personal":
        return backupPersonalRecords();
      case "health.get":
        return health();
      case "log":
        console.log("[SaltyBetBot]", payload.message);
        return { logged: true };
      default:
        throw new Error(`Unknown extension request: ${message.type}`);
    }
  }

  function start() {
    chromeApi.runtime.onInstalled.addListener(() => {
      ensureDefaults().catch(console.error);
    });
    chromeApi.runtime.onStartup.addListener(() => {
      ensureDefaults().catch(console.error);
    });
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleRequest(message, sender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => {
          console.error(error);
          sendResponse({
            ok: false,
            error: { code: "REQUEST_FAILED", message: error.message || String(error) },
          });
        });
      return true;
    });
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      currentControllerId()
        .then(async (controllerTabId) => {
          if (controllerTabId === tabId) {
            await chromeApi.storage.session.remove([
              "controllerTabId",
              "lastTwitchEventAt",
              "lastRecoveryAt",
            ]);
            await broadcastControllerStatus();
          }
          await chromeApi.storage.session.remove(`twitchSnapshot:${tabId}`);
        })
        .catch(console.error);
    });
    chromeApi.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === HEALTH_ALARM) recoverStaleChat().catch(console.error);
      if (alarm.name === PERSONAL_RECORDS_BACKUP_ALARM) {
        backupPersonalRecords().catch(console.error);
      }
    });
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && (changes.automationEnabled || changes.maxBet)) {
        broadcastControllerStatus().catch(console.error);
      }
    });

    const defaultsReady = ensureDefaults();
    defaultsReady.catch(console.error);
    return defaultsReady;
  }

  return {
    assignController,
    backupPersonalRecords,
    broadcastControllerStatus,
    clearPersonalRecords,
    getSettings,
    handleRequest,
    health,
    insertRecords,
    openDatabase,
    personalRecordCount,
    recordsPage,
    recoverStaleChat,
    routeTwitchEvents,
    setSettings,
    start,
  };
}
