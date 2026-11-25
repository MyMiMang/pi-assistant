use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Write, process::{Command, Stdio}, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct State(Mutex<BTreeMap<String, Value>>);

fn sidecar(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let binary = std::env::current_exe().map_err(|_| "peer_unavailable")?
        .with_file_name(if cfg!(windows) { "node.exe" } else { "node" });
    let dir = super::app_dir(app);
    let mut cmd = Command::new(binary);
    cmd.arg(dir.join("packages/server/src/desktop-peer-client.mjs"))
        .current_dir(dir).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Some(root) = std::env::var_os("SystemRoot") { cmd.env("SystemRoot", root); }
    }
    let mut p = cmd.spawn().map_err(|_| "peer_unavailable")?;
    let write = (|| -> std::io::Result<()> {
        let mut input = p.stdin.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
        let bytes = serde_json::to_vec(&args).map_err(std::io::Error::other)?;
        input.write_all(&bytes)?;
        input.write_all(b"\n")
    })();
    if write.is_err() { let _ = p.kill(); let _ = p.wait(); return Err("peer_unavailable".into()); }
    let out = p.wait_with_output().map_err(|_| "peer_unavailable")?;
    if !out.status.success() { return Err("peer_unavailable".into()); }
    let data: Value = serde_json::from_slice(&out.stdout).map_err(|_| "peer_unavailable")?;
    if data["error"] == "revoked" { return Err("revoked".into()); }
    data.get("value").cloned().ok_or_else(|| "peer_unavailable".into())
}

fn load() -> Result<BTreeMap<String, Value>, String> {
    match crate::peer_store::load()? {
        Some(raw) => serde_json::from_slice(&raw).map_err(|_| "peer_store_unavailable".into()),
        None => Ok(BTreeMap::new()),
    }
}
fn save(records: &BTreeMap<String, Value>) -> Result<(), String> {
    crate::peer_store::save(&serde_json::to_vec(records).map_err(|_| "peer_store_unavailable")?)
}
fn device(id: &str, peer: &Value, state: &str) -> Value {
    json!({"id":id,"name":peer["name"],"state":state})
}
fn copy_identity(source: &Value) -> Value {
    json!({"origin": source["origin"], "serverId": source["serverId"], "publicKey": source["publicKey"]})
}

fn remember(records: &mut BTreeMap<String, Value>, handle: &str, peer: &Value, result: &Value) -> Result<Value, String> {
    if records.contains_key(handle) { return Err("peer_unavailable".into()); }
    let mut record = copy_identity(peer);
    record["token"] = result["token"].clone();
    record["deviceId"] = result["deviceId"].clone();
    record["name"] = peer["targetName"].clone();
    records.insert(handle.into(), record.clone());
    Ok(record)
}

fn dispatch(app: &tauri::AppHandle, r: Value) -> Result<Value, String> {
    let op = r["op"].as_str().unwrap_or("");
    if op == "available" { return Ok(json!(cfg!(any(target_os = "macos", target_os = "windows")))); }
    if !cfg!(any(target_os = "macos", target_os = "windows")) { return Err("peer_unavailable".into()); }
    let shared = app.state::<State>();
    let mut pending = shared.0.lock().map_err(|_| "peer_unavailable")?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "peer_unavailable")?.as_millis();
    pending.retain(|_, p| p["expires"].as_u64().is_some_and(|t| u128::from(t) > now));
    let id = r["id"].as_str().unwrap_or("");
    match op {
        "preview" => {
            if pending.len() >= 8 { return Err("peer_unavailable".into()); }
            let invite = sidecar(app, json!({"op":"preview","invite":r["invite"]}))?;
            let handle = invite["handle"].as_str().ok_or("peer_unavailable")?.to_owned();
            let mut visible = copy_identity(&invite);
            visible["id"] = json!(&handle);
            visible["targetName"] = invite["targetName"].clone();
            if pending.contains_key(&handle) { return Err("peer_unavailable".into()); }
            pending.insert(handle, invite);
            return Ok(visible);
        }
        "claim" => {
            let peer = pending.get_mut(id).ok_or("invalid_invite")?;
            if peer.get("claimId").is_some() { return Err("invalid_invite".into()); }
            let name = r["name"].as_str().filter(|v| !v.trim().is_empty() && v.chars().count() <= 60).ok_or("invalid_name")?;
            let claim = sidecar(app, json!({"op":"claim","peer":peer,"name":name}))?;
            peer["claimId"] = claim["claimId"].clone(); peer["proof"] = claim["proof"].clone();
            return Ok(json!({"checkCode":claim["checkCode"]}));
        }
        "cancel" => { pending.remove(id); return Ok(Value::Null); }
        "collect" => {
            let mut records = load()?;
            let peer = pending.get(id).ok_or("invalid_invite")?;
            let result = sidecar(app, json!({"op":"collect","peer":peer}))?;
            if result["status"] == "pending" { return Ok(json!({"status":"pending"})); }
            let record = remember(&mut records, id, peer, &result)?;
            save(&records)?;
            let mut activate = record.clone();
            activate["claimId"] = peer["claimId"].clone();
            pending.remove(id);
            // A lost response is ambiguous; never re-collect or resend. The stored handle
            // may be checked or forgotten; only the remote server can confirm activation.
            sidecar(app, json!({"op":"confirm","peer":activate}))?;
            return Ok(json!({"status":"remembered","device":device(id,&record,"online")}));
        }
        _ => {}
    }
    let mut records = load()?;
    if op == "list" { return Ok(json!(records.iter().map(|(k,v)| device(k,v,"offline")).collect::<Vec<_>>())); }
    let handle = if matches!(op, "read" | "send") { r["target"]["peer"].as_str().unwrap_or("") } else { id };
    if op == "forget" { records.remove(handle); save(&records)?; return Ok(Value::Null); }
    let peer = records.get(handle).ok_or("unknown_peer")?;
    if !matches!(op, "status" | "chats" | "read" | "send") { return Err("desktop_operation_unavailable".into()); }
    let result = sidecar(app, json!({"op":op,"peer":peer,"agent":r["target"]["agent"],"conversation":r["target"]["conversation"],"text":r["text"],"clientId":r["clientId"]}));
    if op == "status" { return Ok(match result { Ok(v) => v, Err(e) if e == "revoked" => json!("revoked"), _ => json!("offline") }); }
    result
}

#[tauri::command]
pub async fn desktop_peer(window: tauri::WebviewWindow, request: Value) -> Result<Value, String> {
    let url = window.url().map_err(|_| "peer_unavailable")?;
    if window.label() != "main" || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(super::port()) || url.path() != "/" {
        return Err("peer_unavailable".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, request)).await.map_err(|_| "peer_unavailable")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_remote_device_id_survives_reopen_switch_and_forget() {
        let (b, c) = ("opaque-b", "opaque-c");
        let mut stored = BTreeMap::new();
        let issued = json!({"deviceId":"same-remote-id","token":"test"});
        for (handle, host, server) in [(b, "office.test", "B"), (c, "studio.test", "C")] {
            let peer = json!({"origin":format!("https://{host}"),"serverId":server,"publicKey":server,"targetName":host,"name":"Home Windows"});
            remember(&mut stored, handle, &peer, &issued).unwrap();
        }
        let mut reopened: BTreeMap<String, Value> = serde_json::from_slice(&serde_json::to_vec(&stored).unwrap()).unwrap();
        assert_eq!(device(b, &reopened[b], "online")["name"], "office.test");
        assert_eq!(device(c, &reopened[c], "online")["name"], "studio.test");
        assert_eq!(reopened[b]["serverId"], "B");
        assert_eq!(reopened[c]["serverId"], "C");
        reopened.remove(b);
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[c], stored[c]);
    }

    #[test]
    fn projections_never_include_pairing_material() {
        let peer = json!({"origin":"https://peer.test","serverId":"one","publicKey":"public","name":"B","token":"synthetic","proof":"synthetic","code":"synthetic"});
        assert_eq!(copy_identity(&peer), json!({"origin":"https://peer.test","serverId":"one","publicKey":"public"}));
        assert_eq!(device("opaque", &peer, "offline"), json!({"id":"opaque","name":"B","state":"offline"}));
    }
}
