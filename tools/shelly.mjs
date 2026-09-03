#!/usr/bin/env node
/**
 * Shelly Wall Display control from the Mac, over the device's local Gen2 RPC
 * API. No cloud, no app, no Home Assistant required — which is why this works
 * today with HA still offline.
 *
 *   node tools/shelly.mjs discover
 *   node tools/shelly.mjs <ip|name> info | status | sensors | ui
 *   node tools/shelly.mjs <ip> relay on|off|toggle
 *   node tools/shelly.mjs <ip> brightness 40 | auto
 *   node tools/shelly.mjs <ip> screensaver on 30 | off
 *   node tools/shelly.mjs <ip> mqtt <broker-host> [user] [pass]
 *   node tools/shelly.mjs <ip> update            # firmware
 *   node tools/shelly.mjs <ip> reboot
 *   node tools/shelly.mjs <ip> rpc <Method> [k=v ...]   # anything else
 *   node tools/shelly.mjs watch <ip>             # live sensor feed
 */
import { execFile } from 'node:child_process';

const [, , target, cmd, ...rest] = process.argv;

const RESET = '\x1b[0m', DIM = '\x1b[2m', B = '\x1b[1m';
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m' };
const die = (m) => { console.error(C.r + m + RESET); process.exit(1); };

async function rpc(ip, method, params) {
  const url = `http://${ip}/rpc`;
  const body = { id: 1, method, ...(params ? { params } : {}) };
  const ctl = AbortSignal.timeout(12000);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctl,
  }).catch((e) => die(`cannot reach ${ip}: ${e.message}`));
  const j = await r.json();
  if (j.error) die(`${method} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Browse mDNS for Wall Displays and resolve each to an IP. */
function discover() {
  return new Promise((resolve) => {
    const found = new Map();
    const p = execFile('dns-sd', ['-B', '_shelly._tcp', 'local']);
    p.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const m = line.match(/_shelly\._tcp\.\s+(\S+)/);
        if (m) found.set(m[1], null);
      }
    });
    setTimeout(async () => {
      p.kill();
      // resolve each name to an address
      for (const name of [...found.keys()]) {
        const ip = await new Promise((ok) => {
          const q = execFile('dns-sd', ['-G', 'v4', `${name}.local`]);
          let addr = null;
          q.stdout.on('data', (d) => {
            const m = String(d).match(/(\d+\.\d+\.\d+\.\d+)/);
            if (m && !addr) { addr = m[1]; q.kill(); ok(addr); }
          });
          setTimeout(() => { q.kill(); ok(addr); }, 3000);
        });
        found.set(name, ip);
      }
      resolve(found);
    }, 4000);
  });
}

function fmt(v) {
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ── commands ───────────────────────────────────────────────────────────────
if (!target || target === 'help' || target === '--help') {
  console.log(`
${B}shelly${RESET} — control Shelly Wall Displays over local RPC

  discover                       find every Wall Display on the LAN
  <ip> info                      model, firmware, uptime
  <ip> status                    everything the device reports
  <ip> sensors                   temperature / humidity / lux / relay
  <ip> ui                        display settings
  <ip> relay on|off|toggle       the built-in relay (lampeudtag)
  <ip> brightness <0-100>|auto   screen brightness
  <ip> screensaver on [sec]|off
  <ip> mqtt <host> [user] [pass] point it at an MQTT broker
  <ip> update                    install available firmware
  <ip> reboot
  <ip> rpc <Method> [k=v ...]    raw RPC call
  watch <ip>                     live sensor feed
`);
  process.exit(0);
}

if (target === 'discover') {
  console.log('browsing mDNS for _shelly._tcp …\n');
  const found = await discover();
  if (!found.size) die('no Shelly devices found — same Wi-Fi network?');
  for (const [name, ip] of found) {
    let info = null;
    if (ip) info = await fetch(`http://${ip}/shelly`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json()).catch(() => null);
    console.log(`${B}${name}${RESET}`);
    console.log(`  ip      ${C.c}${ip ?? '?'}${RESET}`);
    if (info) {
      console.log(`  model   ${info.model}  (${info.app}, gen ${info.gen})`);
      console.log(`  fw      ${info.ver}${info.auth_en ? '  [auth on]' : ''}`);
    }
    console.log();
  }
  process.exit(0);
}

if (target === 'watch') {
  const ip = cmd ?? die('usage: watch <ip>');
  console.log(`watching ${ip} — ctrl-c to stop\n`);
  for (;;) {
    const [t, h, l, s] = await Promise.all([
      rpc(ip, 'Temperature.GetStatus', { id: 0 }).catch(() => null),
      rpc(ip, 'Humidity.GetStatus', { id: 0 }).catch(() => null),
      rpc(ip, 'Illuminance.GetStatus', { id: 0 }).catch(() => null),
      rpc(ip, 'Switch.GetStatus', { id: 0 }).catch(() => null),
    ]);
    const now = new Date().toLocaleTimeString('da-DK');
    process.stdout.write(
      `\r${DIM}${now}${RESET}  ` +
      `${C.y}${t?.tC ?? '–'}°C${RESET}  ` +
      `${C.c}${h?.rh ?? '–'}%${RESET}  ` +
      `${l?.lux ?? '–'} lux ${DIM}${l?.illumination ?? ''}${RESET}  ` +
      `relæ ${s?.output ? C.g + 'TÆNDT' : DIM + 'slukket'}${RESET}   `
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const ip = target;
switch (cmd) {
  case 'info': {
    const d = await rpc(ip, 'Shelly.GetDeviceInfo');
    for (const k of ['id', 'model', 'app', 'gen', 'ver', 'fw_id', 'auth_en']) {
      console.log(`  ${k.padEnd(9)} ${fmt(d[k])}`);
    }
    const up = await rpc(ip, 'Shelly.CheckForUpdate').catch(() => ({}));
    if (up?.stable) console.log(`\n  ${C.y}update available: ${d.ver} → ${up.stable.version}${RESET}`);
    else console.log(`\n  ${C.g}firmware up to date${RESET}`);
    break;
  }
  case 'status':
    console.log(JSON.stringify(await rpc(ip, 'Shelly.GetStatus'), null, 2));
    break;
  case 'sensors': {
    const [t, h, l, s] = await Promise.all([
      rpc(ip, 'Temperature.GetStatus', { id: 0 }),
      rpc(ip, 'Humidity.GetStatus', { id: 0 }),
      rpc(ip, 'Illuminance.GetStatus', { id: 0 }),
      rpc(ip, 'Switch.GetStatus', { id: 0 }),
    ]);
    console.log(`  temperatur     ${C.y}${t.tC} °C${RESET}`);
    console.log(`  luftfugtighed  ${C.c}${h.rh} %${RESET}`);
    console.log(`  lys            ${l.lux} lux  ${DIM}(${l.illumination})${RESET}`);
    console.log(`  relæ           ${s.output ? C.g + 'tændt' : 'slukket'}${RESET}  ${DIM}kilde: ${s.source}${RESET}`);
    break;
  }
  case 'ui':
    console.log(JSON.stringify(await rpc(ip, 'Ui.GetConfig'), null, 2));
    break;
  case 'relay': {
    const a = rest[0];
    if (a === 'toggle') console.log(await rpc(ip, 'Switch.Toggle', { id: 0 }));
    else if (a === 'on' || a === 'off') {
      await rpc(ip, 'Switch.Set', { id: 0, on: a === 'on' });
      console.log(`relæ ${a === 'on' ? 'tændt' : 'slukket'}`);
    } else die('usage: relay on|off|toggle');
    break;
  }
  case 'brightness': {
    const a = rest[0];
    const cfg = a === 'auto'
      ? { auto: true }
      : { auto: false, level: Math.max(0, Math.min(100, parseInt(a, 10))) };
    await rpc(ip, 'Ui.SetConfig', { config: { brightness: cfg } });
    console.log(`lysstyrke: ${a}`);
    break;
  }
  case 'screensaver': {
    const on = rest[0] !== 'off';
    const timeout = parseInt(rest[1] ?? '30', 10);
    await rpc(ip, 'Ui.SetConfig', { config: { screen_saver: { enable: on, timeout } } });
    console.log(`pauseskærm: ${on ? `til efter ${timeout}s` : 'fra'}`);
    break;
  }
  case 'mqtt': {
    const [server, user, pass] = rest;
    if (!server) die('usage: mqtt <broker-host> [user] [pass]');
    await rpc(ip, 'Mqtt.SetConfig', {
      config: {
        enable: true,
        server: server.includes(':') ? server : `${server}:1883`,
        ...(user ? { user } : {}), ...(pass ? { pass } : {}),
        rpc_ntf: true, status_ntf: true,
      },
    });
    console.log(`MQTT → ${server}. Reboot to apply: node tools/shelly.mjs ${ip} reboot`);
    break;
  }
  case 'update': {
    const up = await rpc(ip, 'Shelly.CheckForUpdate');
    if (!up?.stable) { console.log('already up to date'); break; }
    console.log(`updating to ${up.stable.version} … the display will reboot itself.`);
    console.log(`${C.y}Do not cut power until it comes back.${RESET}`);
    await rpc(ip, 'Shelly.Update', { stage: 'stable' });
    console.log('update started.');
    break;
  }
  case 'reboot':
    await rpc(ip, 'Shelly.Reboot');
    console.log('rebooting…');
    break;
  case 'rpc': {
    const method = rest[0] ?? die('usage: rpc <Method> [k=v ...]');
    const params = {};
    for (const kv of rest.slice(1)) {
      const [k, v] = kv.split('=');
      params[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
    }
    console.log(JSON.stringify(await rpc(ip, method, Object.keys(params).length ? params : undefined), null, 2));
    break;
  }
  default:
    die(`unknown command "${cmd}" — run \`node tools/shelly.mjs help\``);
}
