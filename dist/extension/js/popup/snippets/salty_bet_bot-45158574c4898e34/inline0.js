
    export function send_message_raw(message) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(null, JSON.parse(message), null, function (x) {
                var error = chrome.runtime.lastError;

                if (error != null) {
                    reject(new Error(error.message));

                } else {
                    resolve(JSON.stringify(x));
                }
            });
        });
    }

    const runtimeEventListeners = new WeakMap();

    export function chrome_runtime_events() {
        return {
            addListener(listener) {
                const wrapped = function (message) {
                    if (message && message.v === 1 && message.type === "runtime.event") {
                        listener(JSON.stringify(message.payload));
                    }
                };
                runtimeEventListeners.set(listener, wrapped);
                chrome.runtime.onMessage.addListener(wrapped);
            },
            removeListener(listener) {
                const wrapped = runtimeEventListeners.get(listener);
                if (wrapped) {
                    chrome.runtime.onMessage.removeListener(wrapped);
                    runtimeEventListeners.delete(listener);
                }
            }
        };
    }

    export async function fetch_extension_text(url) {
        const response = await fetch(chrome.runtime.getURL(url));
        if (!response.ok) {
            throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
        }
        return await response.text();
    }

    export async function fetch_extension_gzip_text(url) {
        const response = await fetch(chrome.runtime.getURL(url));
        if (!response.ok) {
            throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
        }
        if (typeof DecompressionStream !== "function") {
            throw new Error("This Chrome version does not support DecompressionStream");
        }
        return await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
    }

    export function get_extension_url(url) {
        return chrome.runtime.getURL(url);
    }

    // TODO add to js_sys
    export function format_float(f) {
        return f.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 0
        });
    }

    // TODO add to js_sys
    export function decimal(f) {
        return f.toLocaleString("en-US", {
            style: "decimal",
            maximumFractionDigits: 2
        });
    }

    export function set_utc_date(date, days) {
        date.setUTCDate(days);
    }
