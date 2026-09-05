use algorithm::record::{Record, serialize_records};
use salty_bet_bot::{api, read_file, DOCUMENT};
use dominator::{events, html, clone, with_node};
use js_sys::{Error, Promise};
use std::future::Future;
use web_sys::{HtmlInputElement, Blob};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = "
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
")]
extern "C" {
    fn current_date() -> String;
    fn download(filename: &str, blob: &Blob) -> Promise;
    fn str_to_blob(contents: &str) -> Blob;
    fn operation_start(message: &str) -> bool;
    fn operation_finish(message: &str, failed: bool);
}

// One lifecycle for every record operation: always restore controls, including on errors.
// Keep the automation switch outside this group so disabling it is always accessible.
fn run_operation<F>(message: &str, future: F)
where F: Future<Output = Result<String, JsValue>> + 'static {
    if !operation_start(message) { return; }
    spawn_local(async move {
        match future.await {
            Ok(message) => operation_finish(&message, false),
            Err(error) => {
                let message = js_sys::Reflect::get(&error, &JsValue::from_str("message"))
                    .ok().and_then(|value| value.as_string())
                    .or_else(|| error.as_string())
                    .unwrap_or_else(|| "Record operation failed. Try again or reopen the popup.".into());
                operation_finish(&message, true);
            }
        }
    });
}

async fn export_records(personal: bool) -> Result<String, JsValue> {
    let records = if personal { api::records_get_personal().await? } else { api::records_get_all().await? };
    let blob = str_to_blob(&serialize_records(&records));
    let label = if personal { "SaltyBet Personal Records" } else { "SaltyBet Records" };
    JsFuture::from(download(&format!("{} ({}).json", label, current_date()), &blob)).await?;
    Ok(format!("Export download started ({} records).", records.len()))
}

#[wasm_bindgen(start)]
pub fn main_js() {
    console_error_panic_hook::set_once();
    let container = DOCUMENT.with(|document| document.get_element_by_id("record-content").unwrap());
    dominator::append_dom(&container,
        html!("fieldset", {
            .attribute("id", "record-actions")
            .attribute("aria-describedby", "record-help record-message")
            .children(&mut [
                html!("legend", { .text("Match records") }),
                html!("input" => HtmlInputElement, {
                    .attribute("id", "import-input")
                    .attribute("type", "file")
                    .attribute("accept", ".json,application/json")
                    .attribute("aria-label", "Choose records JSON file")
                    .style("display", "none")
                    .with_node!(element => {
                        .event(clone!(element => move |_: events::Change| {
                            let file = element.files().and_then(|files| files.get(0));
                            element.set_value("");
                            if let Some(file) = file {
                                run_operation("Importing records… Keep this popup open.", async move {
                                    let contents = read_file(&file, |_| {}).await?;
                                    let new_records: Vec<Record> = serde_json::from_str(&contents)
                                        .map_err(|_| Error::new("Import failed: choose a valid Salty Bet Bot JSON export."))?;
                                    if new_records.is_empty() {
                                        return Ok("No records found in this export. Nothing was changed.".into());
                                    }
                                    let old_records = api::records_get_all().await?;
                                    let added = api::get_added_records(old_records, new_records);
                                    let count = added.len();
                                    api::records_insert(added).await?;
                                    Ok(format!("Import complete: {} new records added. Duplicates were skipped.", count))
                                });
                            }
                        }))
                    })
                }),
                html!("div", {
                    .class("record-buttons")
                    .children(&mut [
                        html!("button", {
                            .attribute("type", "button")
                            .text("Import")
                            .event(|_: events::Click| {
                                DOCUMENT.with(|document| {
                                    use wasm_bindgen::JsCast;
                                    if let Some(input) = document.get_element_by_id("import-input") {
                                        input.unchecked_into::<HtmlInputElement>().click();
                                    }
                                });
                            })
                        }),
                        html!("button", {
                            .attribute("type", "button")
                            .text("Export personal records")
                            .event(|_: events::Click| run_operation("Preparing personal export… Keep this popup open.", export_records(true)))
                        }),
                        html!("button", {
                            .attribute("type", "button")
                            .text("Export all records")
                            .event(|_: events::Click| run_operation("Preparing full history export… Keep this popup open.", export_records(false)))
                        }),
                    ])
                }),
                html!("p", {
                    .attribute("id", "record-help")
                    .class("help")
                    .text("Imports skip duplicates. The bundled 458,292-match history is always preserved.")
                }),
                html!("button", {
                    .attribute("type", "button")
                    .class("danger")
                    .text("Clear personal records")
                    .event(|_: events::Click| {
                        if web_sys::window().unwrap().confirm_with_message(
                            "Clear imported and newly collected personal records? Export a backup first.\n\nThe bundled 458,292-match history will remain available."
                        ).unwrap_or(false) {
                            run_operation("Clearing personal records…", async {
                                api::records_clear_personal().await?;
                                Ok("Personal records cleared. Bundled history is unchanged.".into())
                            });
                        }
                    })
                }),
            ])
        })
    );
}
