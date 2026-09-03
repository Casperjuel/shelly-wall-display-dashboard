//! Shelly Gen2 JSON-RPC over local HTTP.
//!
//! Everything here talks straight to the device on the LAN — no cloud, no
//! Home Assistant, no app. That is what makes this usable while HA is offline.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct Rpc {
    client: reqwest::Client,
    pub host: String,
}

impl Rpc {
    pub fn new(host: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            // Panels are on the LAN; if one is unplugged we want to find out
            // quickly rather than stall a fan-out across nine devices.
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client");
        Self { client, host: host.into() }
    }

    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let mut body = json!({ "id": 1, "method": method });
        if let Some(p) = params {
            body["params"] = p;
        }
        let url = format!("http://{}/rpc", self.host);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("cannot reach {}", self.host))?;

        let v: Value = resp.json().await.context("bad JSON from device")?;

        // Shelly reports failures two ways: a top-level `error`, and — for some
        // methods — an `error` nested inside `result`. Both must be caught or a
        // failed call silently looks like success.
        if let Some(e) = v.get("error") {
            return Err(anyhow!("{} failed: {}", method, e));
        }
        let result = v.get("result").cloned().unwrap_or(Value::Null);
        if let Some(e) = result.get("error") {
            if result.get("code").is_some() || result.as_object().map_or(false, |o| o.len() <= 2) {
                return Err(anyhow!("{} failed: {}", method, e));
            }
        }
        Ok(result)
    }

    /// `GET /shelly` — the one endpoint that works on every generation, and
    /// works before authentication is configured.
    pub async fn identify(&self) -> Result<DeviceInfo> {
        let url = format!("http://{}/shelly", self.host);
        let v: DeviceInfo = self.client.get(&url).send().await?.json().await?;
        Ok(v)
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    #[serde(default)]
    pub mac: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub gen: u8,
    #[serde(default)]
    pub ver: String,
    #[serde(default)]
    pub auth_en: bool,
    #[serde(default)]
    pub uptime: u64,
}

#[derive(Debug, serde::Deserialize)]
pub struct Sensors {
    pub temp_c: Option<f64>,
    pub humidity: Option<f64>,
    pub lux: Option<f64>,
    pub illumination: Option<String>,
    pub relay: Option<bool>,
}

impl Rpc {
    /// All four readings at once. Issued concurrently because each is its own
    /// RPC round trip and they are independent.
    pub async fn sensors(&self) -> Sensors {
        let (t, h, l, s) = tokio::join!(
            self.call("Temperature.GetStatus", Some(json!({"id": 0}))),
            self.call("Humidity.GetStatus", Some(json!({"id": 0}))),
            self.call("Illuminance.GetStatus", Some(json!({"id": 0}))),
            self.call("Switch.GetStatus", Some(json!({"id": 0}))),
        );
        Sensors {
            temp_c: t.ok().and_then(|v| v.get("tC").and_then(|x| x.as_f64())),
            humidity: h.ok().and_then(|v| v.get("rh").and_then(|x| x.as_f64())),
            lux: l.as_ref().ok().and_then(|v| v.get("lux").and_then(|x| x.as_f64())),
            illumination: l.ok().and_then(|v| {
                v.get("illumination").and_then(|x| x.as_str()).map(String::from)
            }),
            relay: s.ok().and_then(|v| v.get("output").and_then(|x| x.as_bool())),
        }
    }
}
