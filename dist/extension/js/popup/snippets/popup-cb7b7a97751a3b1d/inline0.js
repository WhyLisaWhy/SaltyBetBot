
    export function open_tab(url) {
        // TODO error handling
        chrome.tabs.create({
            url: chrome.runtime.getURL(url)
        });
    }

    export function current_date() {
        return new Date().toISOString().replace(new RegExp("\\:", "g"), "_");
    }

    export function download(filename, blob) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);

            // TODO error handling
            chrome.downloads.download({
                url: url,
                filename: filename,
                saveAs: true,
                conflictAction: "prompt"
            }, function () {
                URL.revokeObjectURL(url);
                resolve();
            });
        });
    }

    export function str_to_blob(contents) {
        return new Blob([contents], { type: "application/json" });
    }
