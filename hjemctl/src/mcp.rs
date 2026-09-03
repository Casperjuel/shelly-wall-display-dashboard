//! MCP server: exposes the panels as tools an agent can call.
//!
//! Run with `hjemctl mcp` and register it as a stdio MCP server. It gives an
//! agent the same reach this CLI has — list panels, read sensors, drive the
//! relay and screen, and issue arbitrary RPC — so the displays can be managed
//! conversationally rather than by memorising subcommands.

use crate::registry::{room_slugs, Registry};
use crate::rpc::Rpc;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ServiceExt,
    transport::stdio,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct Target {
    #[schemars(description = "Room slug from rooms.yaml (e.g. tv_stue), a device id, an IP, or 'all'")]
    target: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct RelayParams {
    #[schemars(description = "Room slug, device id, IP, or 'all'")]
    target: String,
    #[schemars(description = "on, off, or toggle")]
    action: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct BrightnessParams {
    #[schemars(description = "Room slug, device id, IP, or 'all'")]
    target: String,
    #[schemars(description = "0-100, or the string 'auto'")]
    level: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TapParams {
    #[schemars(description = "Room slug, device id, or IP")]
    target: String,
    #[schemars(description = "X coordinate in screen pixels")]
    x: i64,
    #[schemars(description = "Y coordinate in screen pixels")]
    y: i64,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct RpcParams {
    #[schemars(description = "Room slug, device id, or IP")]
    target: String,
    #[schemars(description = "RPC method, e.g. Ui.GetConfig or Shelly.GetStatus")]
    method: String,
    #[schemars(description = "Optional JSON object of params, as a string")]
    params_json: Option<String>,
}

#[derive(Clone)]
pub struct Panels;

impl Panels {
    fn resolve_one(target: &str) -> Result<String, String> {
        let reg = Registry::load();
        let panels = reg.resolve(target);
        panels
            .first()
            .map(|p| p.ip.clone())
            .ok_or_else(|| format!("no panel matches {target:?}; run hjemctl discover"))
    }
}

#[tool_router]
impl Panels {
    #[tool(description = "List every known wall display: room, IP, model, firmware, and whether it is reachable right now.")]
    async fn list_panels(&self) -> String {
        let reg = Registry::load();
        if reg.panels.is_empty() {
            return "No panels registered yet. Run `hjemctl discover`.".into();
        }
        let mut out = vec![];
        for p in reg.panels.values() {
            let up = Rpc::new(&p.ip).identify().await.is_ok();
            out.push(json!({
                "room": p.room, "id": p.id, "ip": p.ip,
                "model": p.model, "firmware": p.ver,
                "online": up,
            }));
        }
        json!({ "panels": out, "known_rooms": room_slugs() }).to_string()
    }

    #[tool(description = "Discover Shelly wall displays on the local network via mDNS and register them.")]
    async fn discover(&self) -> String {
        match crate::discover::browse(std::time::Duration::from_secs(5)).await {
            Ok(found) => {
                let mut reg = Registry::load();
                let mut names = vec![];
                for mut p in found {
                    if let Ok(i) = Rpc::new(&p.ip).identify().await {
                        p.mac = i.mac; p.model = i.model; p.ver = i.ver;
                    }
                    names.push(json!({"id": p.id, "ip": p.ip, "model": p.model}));
                    reg.upsert(p);
                }
                let _ = reg.save();
                json!({"discovered": names}).to_string()
            }
            Err(e) => format!("discovery failed: {e}"),
        }
    }

    #[tool(description = "Read a panel's built-in sensors: temperature (°C), humidity (%), illuminance (lux) and relay state. Pass 'all' to read every panel.")]
    async fn get_sensors(&self, Parameters(Target { target }): Parameters<Target>) -> String {
        let reg = Registry::load();
        let panels = reg.resolve(&target);
        if panels.is_empty() {
            return format!("no panel matches {target:?}");
        }
        let mut out = vec![];
        for p in panels {
            let s = Rpc::new(&p.ip).sensors().await;
            out.push(json!({
                "room": p.room, "ip": p.ip,
                "temperature_c": s.temp_c, "humidity_pct": s.humidity,
                "lux": s.lux, "illumination": s.illumination,
                "relay_on": s.relay,
            }));
        }
        json!({ "readings": out }).to_string()
    }

    #[tool(description = "Turn a panel's built-in relay on or off. This switches a real mains circuit (the lamp outlet), so confirm with the user before calling it.")]
    async fn set_relay(&self, Parameters(RelayParams { target, action }): Parameters<RelayParams>) -> String {
        let reg = Registry::load();
        let panels = reg.resolve(&target);
        if panels.is_empty() { return format!("no panel matches {target:?}"); }
        let mut done = vec![];
        for p in panels {
            let r = Rpc::new(&p.ip);
            let res = match action.as_str() {
                "toggle" => r.call("Switch.Toggle", Some(json!({"id":0}))).await,
                "on" | "off" => r.call("Switch.Set", Some(json!({"id":0,"on":action=="on"}))).await,
                _ => return "action must be on, off or toggle".into(),
            };
            done.push(json!({"room": p.room, "ok": res.is_ok(),
                             "error": res.err().map(|e| e.to_string())}));
        }
        json!({"action": action, "results": done}).to_string()
    }

    #[tool(description = "Set screen brightness (0-100) or 'auto' for the ambient-light sensor.")]
    async fn set_brightness(&self, Parameters(BrightnessParams { target, level }): Parameters<BrightnessParams>) -> String {
        let cfg = if level == "auto" {
            json!({"brightness": {"auto": true}})
        } else {
            match level.parse::<u8>() {
                Ok(n) => json!({"brightness": {"auto": false, "level": n.min(100)}}),
                Err(_) => return "level must be 0-100 or 'auto'".into(),
            }
        };
        let reg = Registry::load();
        let panels = reg.resolve(&target);
        if panels.is_empty() { return format!("no panel matches {target:?}"); }
        let mut done = vec![];
        for p in panels {
            let res = Rpc::new(&p.ip).call("Ui.SetConfig", Some(json!({"config": cfg}))).await;
            done.push(json!({"room": p.room, "ok": res.is_ok()}));
        }
        json!({"brightness": level, "results": done}).to_string()
    }

    #[tool(description = "Simulate a touch on the panel's screen at pixel coordinates. Useful for driving the on-device UI remotely.")]
    async fn tap_screen(&self, Parameters(TapParams { target, x, y }): Parameters<TapParams>) -> String {
        let ip = match Self::resolve_one(&target) { Ok(v) => v, Err(e) => return e };
        match Rpc::new(&ip).call("Ui.Tap", Some(json!({"x": x, "y": y}))).await {
            Ok(v) => json!({"tapped": {"x": x, "y": y}, "result": v}).to_string(),
            Err(e) => format!("tap failed: {e}"),
        }
    }

    #[tool(description = "Read a panel's full device status: every component, config and reading it reports. Use this to inspect what the device currently knows about itself.")]
    async fn get_status(&self, Parameters(Target { target }): Parameters<Target>) -> String {
        let ip = match Self::resolve_one(&target) { Ok(v) => v, Err(e) => return e };
        match Rpc::new(&ip).call("Shelly.GetStatus", None).await {
            Ok(v) => v.to_string(),
            Err(e) => format!("failed: {e}"),
        }
    }

    #[tool(description = "Call any Shelly Gen2 RPC method on a panel. Use Shelly.ListMethods to see what is available. This is the escape hatch for anything the other tools do not cover.")]
    async fn call_rpc(&self, Parameters(RpcParams { target, method, params_json }): Parameters<RpcParams>) -> String {
        let ip = match Self::resolve_one(&target) { Ok(v) => v, Err(e) => return e };
        let params = match params_json.as_deref() {
            None | Some("") => None,
            Some(s) => match serde_json::from_str(s) {
                Ok(v) => Some(v),
                Err(e) => return format!("params_json is not valid JSON: {e}"),
            },
        };
        match Rpc::new(&ip).call(&method, params).await {
            Ok(v) => v.to_string(),
            Err(e) => format!("{method} failed: {e}"),
        }
    }
}

#[tool_handler]
impl rmcp::ServerHandler for Panels {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Controls Shelly Wall Displays running the `hjem` dashboards. \
             Targets are room slugs from rooms.yaml (kokken, tv_stue, sovevaerelse, …), \
             a device id, an IP, or 'all'. Everything runs over the local network — \
             no cloud and no Home Assistant required. \
             set_relay switches a real mains circuit: confirm with the user first."
                .into(),
        );
        info
    }
}

pub async fn serve() -> anyhow::Result<()> {
    let service = Panels.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
