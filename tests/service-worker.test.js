import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  CHAT_STALE_AFTER_MS,
  PERSONAL_RECORDS_BACKUP_FILENAME,
  createServiceWorker,
} from "../extension/service-worker-core.js";

function eventTarget() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function storageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(defaults = {}) {
      return { ...defaults, ...values };
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function chromeMock() {
  const tabs = new Map([
    [1, { id: 1, url: "https://www.saltybet.com/" }],
    [2, { id: 2, url: "https://www.saltybet.com/" }],
    [3, { id: 3, url: "https://example.com/" }],
  ]);
  const sent = [];
  const reloaded = [];
  const downloads = [];
  const chromeApi = {
    runtime: { onInstalled: eventTarget(), onStartup: eventTarget(), onMessage: eventTarget() },
    alarms: {
      created: [],
      onAlarm: eventTarget(),
      async create(name, options) {
        this.created.push({ name, options });
      },
      async get(name) {
        return this.created.find((alarm) => alarm.name === name);
      },
    },
    downloads: {
      async download(options) {
        downloads.push(options);
        return 99;
      },
    },
    storage: {
      local: storageArea(),
      session: storageArea(),
      onChanged: eventTarget(),
    },
    tabs: {
      onRemoved: eventTarget(),
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error("No such tab");
        return tabs.get(tabId);
      },
      async query() {
        return [...tabs.values()].filter((tab) => tab.url.includes("saltybet.com"));
      },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
      },
      async reload(tabId) {
        reloaded.push(tabId);
      },
    },
  };
  return { chromeApi, downloads, reloaded, sent, tabs };
}

function record(date, left = `Left ${date}`, right = `Right ${date}`) {
  return {
    left: { name: left },
    right: { name: right },
    winner: "Left",
    tier: "A",
    mode: "Matchmaking",
    bet: "None",
    duration: 1000,
    date,
    sum: 100,
  };
}

describe("Manifest V3 service worker core", () => {
  let worker;
  let mock;
  let indexedDb;

  beforeEach(() => {
    mock = chromeMock();
    indexedDb = new IDBFactory();
    worker = createServiceWorker({
      chromeApi: mock.chromeApi,
      indexedDb,
      keyRange: IDBKeyRange,
      now: () => 10_000_000,
    });
  });

  it("defaults to observe-only and persists explicit settings", async () => {
    expect(await worker.getSettings()).toEqual({ schemaVersion: 1, automationEnabled: false });
    expect(await worker.setSettings({ automationEnabled: true })).toEqual({
      schemaVersion: 1,
      automationEnabled: true,
    });
    expect(await worker.getSettings()).toEqual({ schemaVersion: 1, automationEnabled: true });
  });

  it("stores personal records in deterministic chronological pages without exact duplicates", async () => {
    await worker.insertRecords({ records: [record(30), record(10), record(20), record(20)] });

    const first = await worker.recordsPage({ limit: 2 });
    expect(first.records.map(({ date }) => date)).toEqual([10, 20]);
    expect(first.nextCursor).toEqual(expect.objectContaining({ date: 20 }));

    const second = await worker.recordsPage({ limit: 2, afterCursor: first.nextCursor });
    expect(second.records.map(({ date }) => date)).toEqual([30]);
    expect(second.nextCursor).toBeNull();
    expect(await worker.personalRecordCount()).toBe(3);

    await worker.clearPersonalRecords();
    expect(await worker.personalRecordCount()).toBe(0);
  });

  it("preserves settings, controller state, and personal records across worker restarts", async () => {
    await worker.setSettings({ automationEnabled: true });
    await worker.assignController(1);
    await worker.insertRecords({ records: [record(10)] });

    const restarted = createServiceWorker({
      chromeApi: mock.chromeApi,
      indexedDb,
      keyRange: IDBKeyRange,
      now: () => 10_000_000,
    });

    expect(await restarted.getSettings()).toEqual({ schemaVersion: 1, automationEnabled: true });
    const status = await restarted.handleRequest(
      { v: 1, type: "controller.register", payload: {} },
      { tab: mock.tabs.get(1) },
    );
    expect(status.isController).toBe(true);
    expect(await restarted.personalRecordCount()).toBe(1);
  });

  it("exports a validated, overwrite-in-place personal-record backup", async () => {
    await worker.insertRecords({ records: [record(30), record(10)] });

    const result = await worker.backupPersonalRecords();

    expect(result).toEqual({
      status: "download_started",
      downloadId: 99,
      recordCount: 2,
      firstDate: 10,
      lastDate: 30,
      generatedAt: 10_000_000,
    });
    expect(mock.downloads).toHaveLength(1);
    expect(mock.downloads[0]).toEqual(
      expect.objectContaining({
        filename: PERSONAL_RECORDS_BACKUP_FILENAME,
        conflictAction: "overwrite",
        saveAs: false,
      }),
    );
    const json = decodeURIComponent(mock.downloads[0].url.split(",", 2)[1]);
    expect(JSON.parse(json).map(({ date }) => date)).toEqual([10, 30]);
  });

  it("never overwrites the last good backup with an empty database", async () => {
    expect(await worker.backupPersonalRecords()).toEqual({
      status: "skipped_empty",
      recordCount: 0,
      generatedAt: 10_000_000,
    });
    expect(mock.downloads).toHaveLength(0);
  });

  it("routes each tab's Twitch events while granting betting control to only one tab", async () => {
    expect((await worker.assignController(1)).isController).toBe(true);
    expect((await worker.assignController(2)).isController).toBe(false);

    const standby = await worker.routeTwitchEvents([{ Winner: { name: "A" } }], {
      tab: mock.tabs.get(2),
    });
    expect(standby.forwarded).toBe(true);
    expect(standby.mayBet).toBe(false);
    expect(mock.sent.at(-1)).toEqual(expect.objectContaining({ tabId: 2 }));

    const forwarded = await worker.routeTwitchEvents([{ Winner: { name: "A" } }], {
      tab: mock.tabs.get(1),
    });
    expect(forwarded.forwarded).toBe(true);
    expect(forwarded.mayBet).toBe(true);
    expect(mock.sent.at(-1)).toEqual(expect.objectContaining({ tabId: 1 }));

    expect((await worker.assignController(2, true)).isController).toBe(true);
  });

  it("replays an early Twitch snapshot when the SaltyBet listener registers", async () => {
    await worker.routeTwitchEvents([{ BetsOpen: { left: "Alpha", right: "Beta" } }], {
      tab: mock.tabs.get(1),
    });
    await worker.routeTwitchEvents([{ BetsClosed: { left: "Alpha", right: "Beta" } }], {
      tab: mock.tabs.get(1),
    });
    const sendsBeforeRegistration = mock.sent.length;

    await worker.handleRequest(
      { v: 1, type: "controller.register", payload: {} },
      { tab: mock.tabs.get(1) },
    );

    expect(mock.sent.length).toBeGreaterThan(sendsBeforeRegistration);
    expect(mock.sent.at(-1)?.message.payload.kind).toBe("twitch_events");
    expect(mock.sent.at(-1)?.message.payload.events).toHaveLength(2);
  });

  it("marks stale chat and reloads only the controller tab", async () => {
    await worker.assignController(1);
    await mock.chromeApi.storage.session.set({
      lastTwitchEventAt: 10_000_000 - CHAT_STALE_AFTER_MS,
    });
    await worker.recoverStaleChat();

    expect(mock.reloaded).toEqual([1]);
    expect(mock.sent.at(-1)?.message.payload).toEqual({
      kind: "health_status",
      status: "chat_stale",
    });
  });
});
