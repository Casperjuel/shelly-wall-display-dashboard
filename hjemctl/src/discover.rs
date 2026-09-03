//! mDNS discovery of Shelly devices.
//!
//! Shelly Gen2 announces `_shelly._tcp.local`. The service record carries the
//! address directly, so unlike shelling out to `dns-sd` we get name + IP in one
//! pass and never need a second resolve step.

use crate::registry::Panel;
use anyhow::Result;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::BTreeMap;
use std::time::Duration;

pub async fn browse(timeout: Duration) -> Result<Vec<Panel>> {
    let daemon = ServiceDaemon::new()?;
    let rx = daemon.browse("_shelly._tcp.local.")?;
    let mut found: BTreeMap<String, Panel> = BTreeMap::new();
    let deadline = std::time::Instant::now() + timeout;

    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::task::block_in_place(|| rx.recv_timeout(remaining.min(Duration::from_millis(500)))) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let name = info.get_fullname().split('.').next().unwrap_or("").to_string();
                if let Some(addr) = info.get_addresses().iter().next() {
                    found.insert(
                        name.clone(),
                        Panel { id: name, ip: addr.to_string(), ..Default::default() },
                    );
                }
            }
            Ok(_) => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}
