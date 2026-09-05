
    export function current_date() {
        return new Date().toISOString().replaceAll(':', '_');
    }

    export function download(filename, blob) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'prompt' }, id => {
                const error = chrome.runtime.lastError;
                URL.revokeObjectURL(url);
                if (error || !Number.isInteger(id)) {
                    reject(new Error('Download failed or was canceled. Try the export again.'));
                } else {
                    resolve();
                }
            });
        });
    }

    export function str_to_blob(contents) {
        return new Blob([contents], { type: 'application/json' });
    }

    export function operation_start(message) {
        const actions = document.querySelector('#record-actions');
        if (actions.disabled) return false;
        actions.disabled = true;
        actions.setAttribute('aria-busy', 'true');
        const status = document.querySelector('#record-message');
        status.dataset.state = 'busy';
        status.textContent = message;
        return true;
    }

    export function operation_finish(message, failed) {
        const actions = document.querySelector('#record-actions');
        actions.disabled = false;
        actions.setAttribute('aria-busy', 'false');
        const status = document.querySelector('#record-message');
        status.dataset.state = failed ? 'error' : 'success';
        status.textContent = message;
        if (failed) status.focus();
    }
