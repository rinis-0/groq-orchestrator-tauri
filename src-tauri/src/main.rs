// Grok Orchestrator — Tauri backend
// Хранит пул API-ключей Groq в памяти, делает round-robin + failover на 429,
// и предоставляет команды для фронтенда: управление ключами, вызов модели,
// сохранение/загрузка состояния приложения на диск.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows_subsystem")]

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ApiKey {
    id: String,
    label: String,
    key: String,
    enabled: bool,
    #[serde(default)]
    cooldown_until: i64,
    #[serde(default)]
    error_count: u32,
}

struct AppState {
    keys: Mutex<Vec<ApiKey>>,
    rr_index: Mutex<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMsg {
    role: String,
    content: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn mask_key(k: &str) -> String {
    if k.len() <= 8 {
        "*".repeat(k.len())
    } else {
        format!("{}...{}", &k[..4], &k[k.len() - 4..])
    }
}

#[derive(Debug, Serialize, Clone)]
struct ApiKeyPublic {
    id: String,
    label: String,
    masked: String,
    enabled: bool,
    cooling_down: bool,
    error_count: u32,
}

#[tauri::command]
fn add_api_key(state: State<AppState>, label: String, key: String) -> ApiKeyPublic {
    let new_key = ApiKey {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        key,
        enabled: true,
        cooldown_until: 0,
        error_count: 0,
    };
    state.keys.lock().unwrap().push(new_key.clone());
    ApiKeyPublic {
        id: new_key.id,
        label: new_key.label,
        masked: mask_key(&new_key.key),
        enabled: new_key.enabled,
        cooling_down: false,
        error_count: 0,
    }
}

#[tauri::command]
fn remove_api_key(state: State<AppState>, id: String) {
    state.keys.lock().unwrap().retain(|k| k.id != id);
}

#[tauri::command]
fn toggle_api_key(state: State<AppState>, id: String, enabled: bool) {
    let mut keys = state.keys.lock().unwrap();
    if let Some(k) = keys.iter_mut().find(|k| k.id == id) {
        k.enabled = enabled;
    }
}

#[tauri::command]
fn list_api_keys(state: State<AppState>) -> Vec<ApiKeyPublic> {
    let now = now_ms();
    state
        .keys
        .lock()
        .unwrap()
        .iter()
        .map(|k| ApiKeyPublic {
            id: k.id.clone(),
            label: k.label.clone(),
            masked: mask_key(&k.key),
            enabled: k.enabled,
            cooling_down: k.cooldown_until > now,
            error_count: k.error_count,
        })
        .collect()
}

// Используется при загрузке сохранённого состояния: восстанавливает ключи
// с уже известными реальными значениями (а не заново вводить их руками).
#[tauri::command]
fn restore_api_key(state: State<AppState>, label: String, key: String) -> ApiKeyPublic {
    add_api_key(state, label, key)
}

async fn call_groq(
    key: &str,
    model: &str,
    messages: &[ChatMsg],
    temperature: f32,
) -> Result<String, (u16, String)> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": temperature
    });
    let resp = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| (0u16, e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| (0u16, e.to_string()))?;
    if !status.is_success() {
        return Err((status.as_u16(), text));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| (0u16, format!("Некорректный JSON: {e}")))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(content)
}

#[tauri::command]
async fn groq_chat(
    state: State<'_, AppState>,
    model: String,
    messages: Vec<ChatMsg>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let temp = temperature.unwrap_or(0.7);
    let attempts = {
        let keys = state.keys.lock().unwrap();
        keys.len().max(1)
    };

    let mut last_err = "Нет добавленных API-ключей Groq. Добавьте хотя бы один ключ.".to_string();

    for _ in 0..attempts {
        let key_opt: Option<ApiKey> = {
            let keys = state.keys.lock().unwrap();
            let mut idx = state.rr_index.lock().unwrap();
            let n = keys.len();
            if n == 0 {
                None
            } else {
                let now = now_ms();
                let mut chosen: Option<usize> = None;
                for i in 0..n {
                    let pos = (*idx + i) % n;
                    let k = &keys[pos];
                    if k.enabled && k.cooldown_until <= now {
                        chosen = Some(pos);
                        break;
                    }
                }
                chosen.map(|pos| {
                    *idx = (pos + 1) % n;
                    keys[pos].clone()
                })
            }
        };

        let key = match key_opt {
            Some(k) => k,
            None => {
                last_err = "Все ключи сейчас недоступны (rate limit) или отключены. Подождите или добавьте ещё ключ.".to_string();
                break;
            }
        };

        match call_groq(&key.key, &model, &messages, temp).await {
            Ok(content) => return Ok(content),
            Err((status, msg)) => {
                let mut keys = state.keys.lock().unwrap();
                if let Some(k) = keys.iter_mut().find(|k| k.id == key.id) {
                    k.error_count += 1;
                    if status == 429 {
                        k.cooldown_until = now_ms() + 60_000;
                    }
                }
                drop(keys);
                last_err = if status == 429 {
                    format!("Ключ «{}»: превышен rate limit, пробуем следующий ключ...", key.label)
                } else {
                    format!("Ошибка Groq (ключ «{}», код {}): {}", key.label, status, msg)
                };
                continue;
            }
        }
    }

    Err(last_err)
}

#[tauri::command]
fn save_data(app_handle: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("data.json"), json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_data(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = dir.join("data.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            keys: Mutex::new(Vec::new()),
            rr_index: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            add_api_key,
            remove_api_key,
            toggle_api_key,
            list_api_keys,
            restore_api_key,
            groq_chat,
            save_data,
            load_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
