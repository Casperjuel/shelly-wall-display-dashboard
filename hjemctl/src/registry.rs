//! Which panel is in which room.
//!
//! Discovery finds devices by mDNS, but mDNS only tells us `id` and IP — not
//! that the one in the hallway is "Soveværelse". The mapping lives in
//! devices.json next to rooms.yaml, and `hjemctl assign` writes it, so every
//! later command can be addressed by room slug instead of by IP.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Panel {
    pub id: String,
    pub ip: String,
    #[serde(default)]
    pub mac: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub ver: String,
    /// room slug from rooms.yaml, if assigned
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub panels: BTreeMap<String, Panel>, // keyed by device id
}

pub fn registry_path() -> PathBuf {
    // repo root, next to rooms.yaml — this file is meant to be committed so the
    // room mapping survives a new laptop.
    let mut p = std::env::current_dir().unwrap_or_default();
    loop {
        if p.join("rooms.yaml").exists() {
            return p.join("devices.json");
        }
        if !p.pop() {
            return PathBuf::from("devices.json");
        }
    }
}

impl Registry {
    pub fn load() -> Self {
        let path = registry_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = registry_path();
        let s = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, s).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    pub fn upsert(&mut self, p: Panel) {
        // Preserve an existing room assignment when re-discovering: discovery
        // knows the IP, only the human knows the room.
        let room = self.panels.get(&p.id).and_then(|e| e.room.clone());
        self.panels.insert(p.id.clone(), Panel { room: room.or(p.room.clone()), ..p });
    }

    /// Resolve a target: room slug, device id, or a literal IP.
    pub fn resolve(&self, target: &str) -> Vec<Panel> {
        if target == "all" {
            return self.panels.values().cloned().collect();
        }
        // literal IP or hostname wins — lets you talk to a panel before it's
        // ever been registered
        if target.chars().next().map_or(false, |c| c.is_ascii_digit()) || target.contains('.') {
            return vec![Panel { id: target.into(), ip: target.into(), ..Default::default() }];
        }
        if let Some(p) = self.panels.values().find(|p| p.room.as_deref() == Some(target)) {
            return vec![p.clone()];
        }
        if let Some(p) = self.panels.get(target) {
            return vec![p.clone()];
        }
        vec![]
    }

    #[allow(dead_code)] // used by the MCP layer
    pub fn label(&self, p: &Panel) -> String {
        p.room.clone().unwrap_or_else(|| p.id.clone())
    }
}

/// Room slugs declared in rooms.yaml, so `assign` can validate against them.
pub fn room_slugs() -> Vec<String> {
    let mut dir = std::env::current_dir().unwrap_or_default();
    let path = loop {
        if dir.join("rooms.yaml").exists() {
            break dir.join("rooms.yaml");
        }
        if !dir.pop() {
            return vec![];
        }
    };
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&text) else { return vec![] };
    v.get("rooms")
        .and_then(|r| r.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|r| r.get("slug").and_then(|s| s.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
