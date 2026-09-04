#!/usr/bin/env bash
# Build the hjem kiosk APK using the Android SDK build-tools directly.
#
# Deliberately not Gradle: this app has zero dependencies, and aapt2 + javac +
# d8 + apksigner is the whole pipeline. No wrapper download, no AGP version
# matching against whatever JDK happens to be installed.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-33/android.jar"
OUT=build

[ -x "$BT/aapt2" ]   || { echo "aapt2 not found at $BT"; exit 1; }
[ -f "$PLATFORM" ]   || { echo "android.jar not found at $PLATFORM"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes"

echo "== aapt2 compile =="
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"

echo "== aapt2 link =="
"$BT/aapt2" link \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 33 \
  -o "$OUT/base.apk" \
  "$OUT/res.zip"

echo "== javac =="
find src "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# --release and -bootclasspath are mutually exclusive, and --release targets
# the JDK's own API set rather than Android's. Use -source/-target with
# android.jar as the bootclasspath so the code compiles against Android's API 33.
javac -nowarn -Xlint:-options -source 8 -target 8 \
  -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "== d8 =="
"$BT/d8" --min-api 24 --lib "$PLATFORM" --output "$OUT" \
  $(find "$OUT/classes" -name '*.class')

echo "== package =="
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)

echo "== sign =="
KS="$HOME/.android/debug.keystore"
if [ ! -f "$KS" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  echo "  generated a debug keystore"
fi
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/hjem-kiosk.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 24 "$OUT/hjem-kiosk.apk"

echo
echo "  built: $(cd "$OUT" && pwd)/hjem-kiosk.apk  ($(du -h "$OUT/hjem-kiosk.apk" | cut -f1))"
"$BT/apksigner" verify --print-certs "$OUT/hjem-kiosk.apk" | head -2 | sed 's/^/  /'
