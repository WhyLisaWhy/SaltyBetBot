import { createServiceWorker } from "./service-worker-core.js";

createServiceWorker({
  chromeApi: chrome,
  indexedDb: indexedDB,
  keyRange: IDBKeyRange,
}).start();
