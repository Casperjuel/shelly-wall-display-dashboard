//! hjemctl — manage the Shelly Wall Displays running the `hjem` dashboards.
//!
//! Every command works over the device's local Gen2 RPC API: no cloud, no
//! Home Assistant, no phone app. Commands that take a target accept a room slug
//! from rooms.yaml, a device id, a raw IP, or `all` to fan out concurrently.

mod discover;
mod mcp;
mod registry;
mod rpc;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use futures::stream::{FuturesUnordered, StreamExt};
use owo_colors::OwoColorize;
use registry::{Panel, Registry};
use rpc::Rpc;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "hjemctl", version, about = "Control Shelly Wall Displays for hjem")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Find every Shelly device on the LAN and remember it
    Discover {
        #[arg(long, default_value = "5")]
        secs: u64,
    },
    /// List known panels
    Ls,
    /// Tie a discovered panel to a room from rooms.yaml
    Assign { device: String, room: String },
    /// Model, firmware, uptime, update availability
    Info { target: String },
    /// Temperature / humidity / lux / relay
    Sensors { target: String },
    /// Live sensor feed, refreshed until ctrl-c
    Watch {
        target: String,
        #[arg(long, default_value = "2")]
        every: u64,
    },
    /// The built-in relay (lampeudtag)
    Relay { target: String, action: String },
    /// Screen brightness: 0-100 or "auto"
    Brightness { target: String, level: String },
    /// Install available firmware
    Update { target: String },
    Reboot { target: String },
    /// Point a panel at an MQTT broker
    Mqtt {
        target: String,
        server: String,
        #[arg(long)]
        user: Option<String>,
        #[arg(long)]
        pass: Option<String>,
    },
    /// Save a panel's full settings to a file
    Backup { target: String },
    /// Stream the device's internal debug log (WebView, network, HA module…)
    Logs {
        target: String,
        /// only show lines containing this substring
        #[arg(long)]
        grep: Option<String>,
    },
    /// Run as an MCP server over stdio, so an agent can drive the panels
    Mcp,
    /// Raw RPC call: hjemctl rpc <target> Ui.GetConfig [k=v ...]
    Rpc {
        target: String,
        method: String,
        #[arg(trailing_var_arg = true)]
        params: Vec<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Discover { secs } => cmd_discover(secs).await,
        Cmd::Ls => cmd_ls().await,
        Cmd::Assign { device, room } => cmd_assign(&device, &room),
        Cmd::Info { target } => cmd_info(&target).await,
        Cmd::Sensors { target } => cmd_sensors(&target).await,
        Cmd::Watch { target, every } => cmd_watch(&target, every).await,
        Cmd::Relay { target, action } => cmd_relay(&target, &action).await,
        Cmd::Brightness { target, level } => cmd_brightness(&target, &level).await,
        Cmd::Update { target } => cmd_update(&target).await,
        Cmd::Reboot { target } => {
            for_each(&target, |p| async move {
                Rpc::new(&p.ip).call("Shelly.Reboot", None).await?;
                println!("  {} rebooting…", p.ip.dimmed());
                Ok(())
            })
            .await
        }
        Cmd::Mqtt { target, server, user, pass } => cmd_mqtt(&target, &server, user, pass).await,
        Cmd::Backup { target } => cmd_backup(&target).await,
        Cmd::Logs { target, grep } => cmd_logs(&target, grep.as_deref()).await,
        Cmd::Mcp => mcp::serve().await,
        Cmd::Rpc { target, method, params } => cmd_rpc(&target, &method, &params).await,
    }
}

/// Resolve a target and run `f` against every matching panel concurrently.
/// Fan-out matters: nine sequential round trips is nine times the latency for
/// no reason, and a panel that's powered down shouldn't block the other eight.
async fn for_each<F, Fut>(target: &str, f: F) -> Result<()>
where
    F: Fn(Panel) -> Fut + Clone,
    Fut: std::future::Future<Output = Result<()>>,
{
    let reg = Registry::load();
    let panels = reg.resolve(target);
    if panels.is_empty() {
        return Err(anyhow!(
            "no panel matches {:?} — try `hjemctl discover`, or pass an IP",
            target
        ));
    }
    let mut tasks = FuturesUnordered::new();
    for p in panels {
        let f = f.clone();
        tasks.push(async move {
            let label = p.room.clone().unwrap_or_else(|| p.ip.clone());
            match f(p).await {
                Ok(()) => None,
                Err(e) => Some(format!("  {} {}", label.red(), e)),
            }
        });
    }
    let mut failures = vec![];
    while let Some(r) = tasks.next().await {
        if let Some(msg) = r {
            failures.push(msg);
        }
    }
    for f in &failures {
        eprintln!("{f}");
    }
    Ok(())
}

async fn cmd_discover(secs: u64) -> Result<()> {
    println!("browsing mDNS for {} …", "_shelly._tcp".dimmed());
    let found = discover::browse(Duration::from_secs(secs)).await?;
    if found.is_empty() {
        println!("{}", "  nothing found — same Wi-Fi network?".yellow());
        return Ok(());
    }
    let mut reg = Registry::load();
    let mut tasks = FuturesUnordered::new();
    for p in found {
        tasks.push(async move {
            let info = Rpc::new(&p.ip).identify().await.ok();
            (p, info)
        });
    }
    while let Some((mut p, info)) = tasks.next().await {
        if let Some(i) = &info {
            p.mac = i.mac.clone();
            p.model = i.model.clone();
            p.ver = i.ver.clone();
        }
        let existing = reg.panels.get(&p.id).and_then(|e| e.room.clone());
        println!(
            "  {:<34} {:<16} {:<20} fw {}{}",
            p.id.bold(),
            p.ip.cyan(),
            p.model,
            p.ver,
            existing.map(|r| format!("   → {}", r.green())).unwrap_or_default()
        );
        reg.upsert(p);
    }
    reg.save()?;
    println!("\nsaved to {}", registry::registry_path().display().to_string().dimmed());
    let unassigned: Vec<_> = reg.panels.values().filter(|p| p.room.is_none()).collect();
    if !unassigned.is_empty() {
        println!(
            "\n{} panel(s) not yet tied to a room. Assign with:\n  hjemctl assign {} <room-slug>",
            unassigned.len(),
            unassigned[0].id
        );
        println!("  rooms: {}", registry::room_slugs().join(", ").dimmed());
    }
    Ok(())
}

async fn cmd_ls() -> Result<()> {
    let reg = Registry::load();
    if reg.panels.is_empty() {
        println!("no panels known — run `hjemctl discover`");
        return Ok(());
    }
    let mut tasks = FuturesUnordered::new();
    for p in reg.panels.values().cloned() {
        tasks.push(async move {
            let up = Rpc::new(&p.ip).identify().await.is_ok();
            (p, up)
        });
    }
    let mut rows = vec![];
    while let Some(r) = tasks.next().await {
        rows.push(r);
    }
    rows.sort_by(|a, b| a.0.room.cmp(&b.0.room));
    for (p, up) in rows {
        println!(
            "  {} {:<20} {:<16} {:<18} fw {}",
            if up { "●".green().to_string() } else { "○".red().to_string() },
            p.room.clone().unwrap_or_else(|| "—".into()).bold(),
            p.ip.cyan(),
            p.model,
            p.ver
        );
    }
    Ok(())
}

fn cmd_assign(device: &str, room: &str) -> Result<()> {
    let slugs = registry::room_slugs();
    if !slugs.is_empty() && !slugs.iter().any(|s| s == room) {
        return Err(anyhow!("unknown room {:?}. rooms.yaml has: {}", room, slugs.join(", ")));
    }
    let mut reg = Registry::load();
    // accept a device id or an IP
    let key = reg
        .panels
        .iter()
        .find(|(k, v)| k.as_str() == device || v.ip == device)
        .map(|(k, _)| k.clone())
        .ok_or_else(|| anyhow!("no known panel {:?} — run `hjemctl discover` first", device))?;
    reg.panels.get_mut(&key).unwrap().room = Some(room.to_string());
    reg.save()?;
    println!("{} → {}", key.bold(), room.green());
    Ok(())
}

async fn cmd_info(target: &str) -> Result<()> {
    for_each(target, |p| async move {
        let r = Rpc::new(&p.ip);
        let info = r.identify().await?;
        println!("{}", p.room.clone().unwrap_or_else(|| p.ip.clone()).bold());
        println!("  id      {}", info.id);
        println!("  model   {}  ({}, gen {})", info.model, info.app, info.gen);
        println!("  fw      {}", info.ver);
        println!("  uptime  {} min", info.uptime / 60);
        println!("  auth    {}", if info.auth_en { "on" } else { "off" });
        match r.call("Shelly.CheckForUpdate", None).await {
            Ok(v) if v.get("stable").is_some() => {
                let to = v["stable"]["version"].as_str().unwrap_or("?");
                println!("  {}", format!("update available: {} → {}", info.ver, to).yellow());
            }
            _ => println!("  {}", "firmware up to date".green()),
        }
        println!();
        Ok(())
    })
    .await
}

async fn cmd_sensors(target: &str) -> Result<()> {
    for_each(target, |p| async move {
        let s = Rpc::new(&p.ip).sensors().await;
        println!(
            "  {:<20} {:>6}  {:>5}  {:>6}  {}",
            p.room.clone().unwrap_or_else(|| p.ip.clone()).bold(),
            s.temp_c.map(|v| format!("{v:.1}°C")).unwrap_or("–".into()).yellow().to_string(),
            s.humidity.map(|v| format!("{v:.0}%")).unwrap_or("–".into()).cyan().to_string(),
            s.lux
                .map(|v| format!("{v:.0}lx"))
                .unwrap_or("–".into()),
            format!(
                "{}  {}",
                s.illumination.as_deref().unwrap_or("").dimmed(),
                match s.relay {
                    Some(true) => "relæ tændt".green().to_string(),
                    Some(false) => "relæ slukket".dimmed().to_string(),
                    None => "—".into(),
                }
            )
        );
        Ok(())
    })
    .await
}

async fn cmd_watch(target: &str, every: u64) -> Result<()> {
    println!("{}\n", "ctrl-c to stop".dimmed());
    loop {
        print!("\x1b[2J\x1b[H");
        println!("{}  {}\n", "hjem".bold(), chrono_now().dimmed());
        cmd_sensors(target).await?;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(every)) => {}
            _ = tokio::signal::ctrl_c() => { println!(); return Ok(()); }
        }
    }
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (h, m, s) = ((now / 3600) % 24, (now / 60) % 60, now % 60);
    format!("{h:02}:{m:02}:{s:02} UTC")
}

async fn cmd_relay(target: &str, action: &str) -> Result<()> {
    let action = action.to_string();
    for_each(target, move |p| {
        let action = action.clone();
        async move {
            let r = Rpc::new(&p.ip);
            match action.as_str() {
                "toggle" => { r.call("Switch.Toggle", Some(json!({"id":0}))).await?; }
                "on" | "off" => {
                    r.call("Switch.Set", Some(json!({"id":0,"on": action=="on"}))).await?;
                }
                _ => return Err(anyhow!("relay takes on|off|toggle")),
            }
            println!("  {} relæ {}", p.room.clone().unwrap_or_else(|| p.ip.clone()), action);
            Ok(())
        }
    })
    .await
}

async fn cmd_brightness(target: &str, level: &str) -> Result<()> {
    let level = level.to_string();
    for_each(target, move |p| {
        let level = level.clone();
        async move {
            let cfg = if level == "auto" {
                json!({"brightness": {"auto": true}})
            } else {
                let n: u8 = level.parse().map_err(|_| anyhow!("brightness takes 0-100 or auto"))?;
                json!({"brightness": {"auto": false, "level": n.min(100)}})
            };
            Rpc::new(&p.ip).call("Ui.SetConfig", Some(json!({"config": cfg}))).await?;
            println!("  {} lysstyrke {}", p.room.clone().unwrap_or_else(|| p.ip.clone()), level);
            Ok(())
        }
    })
    .await
}

async fn cmd_update(target: &str) -> Result<()> {
    for_each(target, |p| async move {
        let r = Rpc::new(&p.ip);
        let label = p.room.clone().unwrap_or_else(|| p.ip.clone());
        let up = r.call("Shelly.CheckForUpdate", None).await?;
        if up.get("stable").is_none() {
            println!("  {} already up to date", label);
            return Ok(());
        }
        let to = up["stable"]["version"].as_str().unwrap_or("?");
        println!("  {} updating → {} {}", label.bold(), to, "(do not cut power)".yellow());
        r.call("Shelly.Update", Some(json!({"stage":"stable"}))).await?;
        Ok(())
    })
    .await
}

async fn cmd_mqtt(target: &str, server: &str, user: Option<String>, pass: Option<String>) -> Result<()> {
    let server = if server.contains(':') { server.to_string() } else { format!("{server}:1883") };
    for_each(target, move |p| {
        let (server, user, pass) = (server.clone(), user.clone(), pass.clone());
        async move {
            let mut cfg = json!({
                "enable": true, "server": server,
                "rpc_ntf": true, "status_ntf": true,
            });
            if let Some(u) = user { cfg["user"] = json!(u); }
            if let Some(pw) = pass { cfg["pass"] = json!(pw); }
            Rpc::new(&p.ip).call("Mqtt.SetConfig", Some(json!({"config": cfg}))).await?;
            println!(
                "  {} → MQTT {}  {}",
                p.room.clone().unwrap_or_else(|| p.ip.clone()),
                cfg["server"].as_str().unwrap_or(""),
                "(reboot to apply)".dimmed()
            );
            Ok(())
        }
    })
    .await
}

/// Tap the device's debug log websocket.
///
/// Shelly streams its internal log over `ws://<ip>/debug/log` once
/// `debug.websocket.enable` is set. This is the only window we have into what
/// the Android side is actually doing — WebView errors, the Home Assistant
/// module's downloads, network failures — none of which surface over RPC.
async fn cmd_logs(target: &str, grep: Option<&str>) -> Result<()> {
    use futures_util::StreamExt;
    let reg = Registry::load();
    let p = reg
        .resolve(target)
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no panel matches {target:?}"))?;

    // Turn the stream on if it isn't already; harmless and idempotent.
    let rpc = Rpc::new(&p.ip);
    let _ = rpc
        .call(
            "Sys.SetConfig",
            Some(json!({"config":{"debug":{"websocket":{"enable":true}}}})),
        )
        .await;

    let url = format!("ws://{}/debug/log", p.ip);
    println!("{} {}\n", "streaming".dimmed(), url.cyan());
    let (stream, _) = tokio_tungstenite::connect_async(&url).await?;
    let (_, mut read) = stream.split();

    loop {
        tokio::select! {
            msg = read.next() => {
                let Some(Ok(msg)) = msg else { break };
                let Ok(text) = msg.into_text() else { continue };
                let text = text.trim();
                if text.is_empty() { continue }
                // Each line is a JSON envelope; the interesting part is `data`.
                let line = serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(String::from))
                    .unwrap_or_else(|| text.to_string());
                if let Some(g) = grep {
                    if !line.to_lowercase().contains(&g.to_lowercase()) { continue }
                }
                // Colour the component tag Shelly prefixes each line with.
                if let Some(end) = line.find("]:") {
                    let (tag, rest) = line.split_at(end + 2);
                    println!("{}{}", tag.cyan(), rest);
                } else {
                    println!("{line}");
                }
            }
            _ = tokio::signal::ctrl_c() => { println!(); break }
        }
    }
    Ok(())
}

async fn cmd_backup(target: &str) -> Result<()> {
    for_each(target, |p| async move {
        let v = Rpc::new(&p.ip).call("Sys.DownloadSettings", None).await?;
        let label = p.room.clone().unwrap_or_else(|| p.id.clone());
        let name = format!("backup-{label}.json");
        std::fs::write(&name, serde_json::to_string_pretty(&v)?)?;
        println!("  {} → {}", label, name.cyan());
        Ok(())
    })
    .await
}

async fn cmd_rpc(target: &str, method: &str, params: &[String]) -> Result<()> {
    let mut obj = serde_json::Map::new();
    for kv in params {
        let (k, v) = kv.split_once('=').ok_or_else(|| anyhow!("params must be k=v, got {kv:?}"))?;
        let parsed: Value = serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.to_string()));
        obj.insert(k.to_string(), parsed);
    }
    let params = if obj.is_empty() { None } else { Some(Value::Object(obj)) };
    let method = method.to_string();
    for_each(target, move |p| {
        let (method, params) = (method.clone(), params.clone());
        async move {
            let v = Rpc::new(&p.ip).call(&method, params).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(())
        }
    })
    .await
}
