use crate::{fetch_extension_gzip_text, fetch_extension_text, find_first_index, find_last_index, send_message, spawn};
use algorithm::record::{Mode, Record, Tier, Winner};
use js_sys::Error;
use serde::de::DeserializeOwned;
use serde_derive::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

pub const BASELINE_RECORD_COUNT: usize = 458_292;

// 50 minutes
pub const MAX_MATCH_TIME_LIMIT: f64 = 1000.0 * 60.0 * 50.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaifuBetsOpen {
    pub left: String,
    pub right: String,
    pub tier: Tier,
    pub mode: Mode,
    pub date: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaifuBetsClosedInfo {
    pub name: String,
    pub win_streak: f64,
    pub bet_amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaifuBetsClosed {
    pub left: WaifuBetsClosedInfo,
    pub right: WaifuBetsClosedInfo,
    pub date: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaifuWinner {
    pub name: String,
    pub side: Winner,
    pub date: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WaifuMessage {
    BetsOpen(WaifuBetsOpen),
    BetsClosed(WaifuBetsClosed),
    Winner(WaifuWinner),
    ModeSwitch { date: f64, is_exhibition: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub automation_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerStatus {
    pub is_controller: bool,
    pub controller_tab_id: Option<u32>,
    pub automation_enabled: bool,
    pub last_twitch_event_at: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeEvent {
    TwitchEvents { events: Vec<WaifuMessage> },
    ControllerStatus {
        #[serde(rename = "isController")]
        is_controller: bool,
        #[serde(rename = "controllerTabId")]
        controller_tab_id: Option<u32>,
        #[serde(rename = "automationEnabled")]
        automation_enabled: bool,
        #[serde(rename = "lastTwitchEventAt")]
        last_twitch_event_at: Option<f64>,
    },
    HealthStatus { status: String },
}

#[derive(Serialize)]
struct RequestEnvelope<'a> {
    v: u8,
    #[serde(rename = "type")]
    type_: &'a str,
    payload: Value,
}

#[derive(Deserialize)]
struct ErrorResponse {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct ResponseEnvelope<A> {
    ok: bool,
    data: Option<A>,
    error: Option<ErrorResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordPage {
    records: Vec<Record>,
    next_cursor: Option<RecordCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordCursor {
    date: f64,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordsManifest {
    total_count: usize,
    chunks: Vec<RecordChunk>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordChunk {
    file: String,
    count: usize,
    first_date: Option<f64>,
    last_date: Option<f64>,
    sha256: String,
}

async fn request<A>(type_: &str, payload: Value) -> Result<A, JsValue>
    where A: DeserializeOwned {

    let envelope = RequestEnvelope { v: 1, type_, payload };
    let response: ResponseEnvelope<A> = send_message(&envelope).await?;
    if response.ok {
        response.data.ok_or_else(|| Error::new("Extension response did not include data").into())
    } else {
        let error = response.error.unwrap_or(ErrorResponse {
            code: "UNKNOWN".to_string(),
            message: "Unknown extension error".to_string(),
        });
        Err(Error::new(&format!("{}: {}", error.code, error.message)).into())
    }
}

async fn fetch_text(path: &str, gzip: bool) -> Result<String, JsValue> {
    let promise = if gzip {
        fetch_extension_gzip_text(path)
    } else {
        fetch_extension_text(path)
    };
    JsFuture::from(promise).await?.as_string()
        .ok_or_else(|| Error::new(&format!("{} did not contain text", path)).into())
}

fn records_are_sorted(records: &[Record]) -> bool {
    records.windows(2).all(|pair| pair[0].date <= pair[1].date)
}

pub async fn records_get_baseline() -> Result<Vec<Record>, JsValue> {
    let manifest: RecordsManifest = serde_json::from_str(
        &fetch_text("records/records-manifest.json", false).await?
    ).map_err(|error| Error::new(&format!("Invalid records manifest: {}", error)))?;

    if manifest.total_count != BASELINE_RECORD_COUNT {
        return Err(Error::new(&format!(
            "Expected {} bundled records, found {}",
            BASELINE_RECORD_COUNT,
            manifest.total_count,
        )).into());
    }

    let mut records = Vec::with_capacity(manifest.total_count);
    for chunk in manifest.chunks {
        let path = format!("records/{}", chunk.file);
        let mut loaded: Vec<Record> = serde_json::from_str(&fetch_text(&path, true).await?)
            .map_err(|error| Error::new(&format!("Invalid {}: {}", path, error)))?;
        if loaded.len() != chunk.count || !records_are_sorted(&loaded) {
            return Err(Error::new(&format!("Bundled record chunk failed validation: {}", path)).into());
        }
        if loaded.first().map(|record| record.date) != chunk.first_date ||
           loaded.last().map(|record| record.date) != chunk.last_date ||
           chunk.sha256.len() != 64 {
            return Err(Error::new(&format!("Bundled record metadata mismatch: {}", path)).into());
        }
        records.append(&mut loaded);
    }

    if records.len() != BASELINE_RECORD_COUNT || !records_are_sorted(&records) {
        return Err(Error::new("Bundled record history is incomplete or out of order").into());
    }
    Ok(records)
}

pub async fn records_get_personal() -> Result<Vec<Record>, JsValue> {
    let mut records = vec![];
    let mut cursor: Option<RecordCursor> = None;
    loop {
        let page: RecordPage = request("records.page", json!({
            "limit": 5000,
            "afterCursor": cursor,
        })).await?;
        records.extend(page.records);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    records.sort_by(Record::sort_date);
    Ok(records)
}

pub async fn records_get_all() -> Result<Vec<Record>, JsValue> {
    let mut records = records_get_baseline().await?;
    records.extend(records_get_personal().await?);
    records.sort_by(Record::sort_date);
    Ok(records)
}

pub async fn records_insert(records: Vec<Record>) -> Result<(), JsValue> {
    for chunk in records.chunks(1000) {
        let _: Value = request("records.insert", json!({ "records": chunk })).await?;
    }
    Ok(())
}

pub async fn records_clear_personal() -> Result<(), JsValue> {
    let _: Value = request("records.clear_personal", json!({})).await?;
    Ok(())
}

pub async fn controller_register() -> Result<ControllerStatus, JsValue> {
    request("controller.register", json!({})).await
}

pub async fn twitch_events_send(events: Vec<WaifuMessage>) -> Result<(), JsValue> {
    let _: Value = request("twitch.events", json!({ "events": events })).await?;
    Ok(())
}

pub fn server_log(message: String) {
    spawn(async move {
        let _: Value = request("log", json!({ "message": message })).await?;
        Ok(())
    })
}

pub fn sorted_record_index(old_records: &[Record], new_record: &Record) -> Result<(), usize> {
    let start_date = new_record.date - MAX_MATCH_TIME_LIMIT;
    let end_date = new_record.date + MAX_MATCH_TIME_LIMIT;
    let index = find_first_index(old_records, |x| x.date.partial_cmp(&start_date).unwrap());

    for old_record in &old_records[index..] {
        if old_record.date <= end_date {
            if old_record.is_duplicate(new_record) {
                return Ok(());
            }
        } else {
            break;
        }
    }

    Err(find_last_index(old_records, |x| Record::sort_date(x, new_record)))
}

pub fn get_added_records(mut old_records: Vec<Record>, new_records: Vec<Record>) -> Vec<Record> {
    assert!(records_are_sorted(&old_records));
    let mut added_records = vec![];
    for new_record in new_records {
        if let Err(index) = sorted_record_index(&old_records, &new_record) {
            old_records.insert(index, new_record.clone());
            added_records.push(new_record);
        }
    }
    added_records
}

/// Returns non-duplicate records and duplicate record keys.
pub fn partition_records(old_records: Vec<(u32, Record)>) -> (Vec<Record>, Vec<u32>) {
    let mut records = vec![];
    let mut deleted = vec![];
    for (id, record) in old_records {
        match sorted_record_index(&records, &record) {
            Ok(_) => deleted.push(id),
            Err(index) => records.insert(index, record),
        }
    }
    (records, deleted)
}
