#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  panelctl — provision Shelly Wall Displays with the hjem kiosk.
#
#  Everything a panel needs, in one re-runnable command. Nothing here is
#  destructive and every step is idempotent, because the thing you actually do
#  with a wall panel is run this again: after a firmware update, after a factory
#  reset, after adb drops on reboot.
#
#    ./tools/panelctl.sh status                 what every panel is running
#    ./tools/panelctl.sh provision sovevaerelse one room
#    ./tools/panelctl.sh provision all          every room in panels.yaml
#    ./tools/panelctl.sh url kokken             re-point one panel's dashboard
#    ./tools/panelctl.sh restart tv_stue        relaunch the kiosk
#    ./tools/panelctl.sh logcat kontor          watch the app's log
#
#  Panels are listed in panels.yaml (gitignored — it holds your IPs); copy
#  panels.example.yaml to start. Secrets come from .env, never from this file.
#
#  ── ADB is not persistent ──────────────────────────────────────────────────
#  Network adb on these panels does not survive a reboot. Before provisioning,
#  on the panel: Settings -> About Device, then tap the firmware version and
#  hardware revision lines in this order:  F H F F H F H H
#  That is Shelly's own hidden developer mode, and it is what opens port 5555.
#  Android's "developer options" (tapping Build number) is a different setting
#  and does NOT open the port.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PANELS="${PANELS_FILE:-$ROOT/panels.yaml}"
APK="${APK:-$ROOT/android/build/hjem-kiosk.apk}"
PKG=dk.hjem.kiosk
ACT="$PKG/.KioskActivity"

# adb lives in different places on macOS and on the NUC.
ADB="${ADB:-$(command -v adb || echo "$HOME/Library/Android/sdk/platform-tools/adb")}"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
die()    { c_err "$*"; exit 1; }

[ -x "$ADB" ] || die "adb not found. Set ADB=/path/to/adb, or: sudo apt install adb"

# ── configuration ───────────────────────────────────────────────────────────
# panels.yaml is deliberately a flat "slug: ip" map so it can be read without a
# YAML parser — this script has to run on a NUC with nothing installed.
if [ ! -f "$PANELS" ]; then
  die "no $PANELS — copy panels.example.yaml to panels.yaml and fill in your IPs"
fi

# HA_URL comes from .env so the dashboard address is configured in exactly one
# place, and never committed.
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env"; set +a
fi
HA="${HA_PANEL_URL:-${HA_URL:-}}"
[ -n "$HA" ] || die "HA_URL not set. Put it in .env (see .env.example)"

rooms()   { grep -E '^[a-z_]+:' "$PANELS" | cut -d: -f1; }
ip_of()   { grep -E "^$1:" "$PANELS" | head -1 | cut -d: -f2- | tr -d ' "'; }

dash_url() { echo "${HA%/}/local/hjem/index.html?room=$1"; }

# ── adb helpers ─────────────────────────────────────────────────────────────
connect() {
  local ip="$1"
  "$ADB" disconnect "$ip:5555" >/dev/null 2>&1 || true
  "$ADB" connect "$ip:5555" 2>&1 | grep -qE 'connected' || return 1
  sleep 1
  return 0
}

sh_() { "$ADB" -s "$1:5555" shell "${@:2}" 2>&1; }

# ── commands ────────────────────────────────────────────────────────────────
cmd_status() {
  printf '%-18s %-16s %-9s %-8s %s\n' ROOM IP ADB KIOSK URL
  for r in $(rooms); do
    local ip; ip="$(ip_of "$r")"
    local adb_state=- kiosk=- url=-
    if nc -z -G 2 "$ip" 5555 >/dev/null 2>&1; then
      adb_state=open
      if connect "$ip"; then
        # `|| true` throughout: under `set -e` a grep that matches nothing
        # fails the whole assignment and aborts the loop before anything is
        # printed — which is exactly how this reported "no panels" while
        # happily talking to one.
        if sh_ "$ip" "pm list packages | grep -q $PKG" >/dev/null 2>&1; then
          kiosk="$( { sh_ "$ip" "dumpsys package $PKG | grep -m1 versionName" || true; } \
                    | tr -d ' \r' | cut -d= -f2 | head -1)"
          kiosk="${kiosk:-yes}"
        else
          kiosk=absent
        fi
        url="$( { sh_ "$ip" "run-as $PKG cat /data/data/$PKG/shared_prefs/hjem.xml 2>/dev/null" || true; } \
                | grep -o 'room=[a-z_]*' | head -1 || true)"
        url="${url:-?}"
      fi
    elif ping -c1 -W1000 "$ip" >/dev/null 2>&1; then
      adb_state=closed
    else
      adb_state=offline
    fi
    printf '%-18s %-16s %-9s %-8s %s\n' "$r" "$ip" "$adb_state" "$kiosk" "$url"
  done
}

cmd_provision() {
  local r="$1" ip; ip="$(ip_of "$r")"
  [ -n "$ip" ] || die "room '$r' not in $PANELS"
  [ -f "$APK" ] || die "no APK at $APK — run android/build.sh first"

  echo "── $r ($ip)"
  connect "$ip" || { c_warn "   adb refused. Do the F H F F H F H H tap sequence on the panel first."; return 1; }

  echo "   installing kiosk"
  "$ADB" -s "$ip:5555" install -r -g "$APK" 2>&1 | grep -qi success \
    && c_ok "   installed" || { c_err "   install failed"; return 1; }

  # Neither of these can be granted by the app itself on API 23+.
  echo "   granting permissions"
  sh_ "$ip" "appops set $PKG SYSTEM_ALERT_WINDOW allow" >/dev/null   # floating Hjem button
  sh_ "$ip" "appops set $PKG WRITE_SETTINGS allow"      >/dev/null   # screen brightness

  # The stock Shelly overlay is the panel's only Back button, and it sits on top
  # of the dashboard. Ours replaces it: shown only when the kiosk loses focus.
  echo "   hiding the Shelly overlay"
  sh_ "$ip" "appops set cloud.shelly.stargate SYSTEM_ALERT_WINDOW deny" >/dev/null

  echo "   setting dashboard url"
  sh_ "$ip" "am start -n $ACT -e url '$(dash_url "$r")'" >/dev/null

  # HOME is what makes it survive a power cut without anything launching it.
  echo "   setting as launcher"
  sh_ "$ip" "cmd package set-home-activity $ACT" >/dev/null 2>&1 || \
    c_warn "   could not set HOME automatically — do it on the panel: Settings > Apps > Default apps > Home"

  c_ok "   done → $(dash_url "$r")"
}

cmd_url() {
  local r="$1" ip; ip="$(ip_of "$r")"
  connect "$ip" || die "adb refused for $r ($ip)"
  sh_ "$ip" "am start -n $ACT -e url '$(dash_url "$r")'" >/dev/null
  c_ok "$r → $(dash_url "$r")"
}

cmd_restart() {
  local r="$1" ip; ip="$(ip_of "$r")"
  connect "$ip" || die "adb refused for $r ($ip)"
  sh_ "$ip" "am force-stop $PKG; am start -n $ACT" >/dev/null
  c_ok "$r restarted"
}

cmd_logcat() {
  local r="$1" ip; ip="$(ip_of "$r")"
  connect "$ip" || die "adb refused for $r ($ip)"
  "$ADB" -s "$ip:5555" logcat -s chromium:* "$PKG":*
}

cmd_shot() {
  local r="$1" ip out; ip="$(ip_of "$r")"
  out="${2:-$r.png}"
  connect "$ip" || die "adb refused for $r ($ip)"
  "$ADB" -s "$ip:5555" exec-out screencap -p > "$out"
  c_ok "$out ($(wc -c < "$out" | tr -d ' ') bytes)"
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

case "${1:-}" in
  status)    cmd_status ;;
  provision)
    [ $# -ge 2 ] || usage
    if [ "$2" = all ]; then
      fail=0
      for r in $(rooms); do cmd_provision "$r" || fail=$((fail+1)); done
      [ "$fail" -eq 0 ] && c_ok "all panels provisioned" || c_warn "$fail panel(s) skipped"
    else
      cmd_provision "$2"
    fi ;;
  url)       [ $# -ge 2 ] || usage; cmd_url "$2" ;;
  restart)   [ $# -ge 2 ] || usage; cmd_restart "$2" ;;
  logcat)    [ $# -ge 2 ] || usage; cmd_logcat "$2" ;;
  shot)      [ $# -ge 2 ] || usage; cmd_shot "$2" "${3:-}" ;;
  *)         usage ;;
esac
