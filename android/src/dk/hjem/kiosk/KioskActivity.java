package dk.hjem.kiosk;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.media.AudioManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

/**
 * Fullscreen kiosk for the hjem dashboards.
 *
 * Declared as HOME in the manifest, so Android starts it at boot and returns to
 * it when anything else exits. That is the whole reason this exists: a normal
 * app sits dormant after a reboot and something has to launch it, which is
 * exactly how the panel ended up showing the stock UI with no way back in.
 *
 * The panel's own hardware — relay, temperature, humidity, illuminance, screen
 * brightness — is not touched here. Shelly's firmware already exposes all of it
 * over local RPC on port 80, so the dashboard talks to it directly and this app
 * only has to render a web page.
 */
public class KioskActivity extends Activity {

    private static final String PREFS = "hjem";
    private static final String KEY_URL = "url";
    // Only used if the app is launched with no url ever configured. Normal
    // provisioning passes one in (`panelctl provision <room>`), and the escape
    // hatch can set it by hand. Deliberately generic: this repo is public.
    private static final String DEFAULT_URL =
            "http://homeassistant.local:8123/local/hjem/index.html";

    /** Long-press this many ms in the top-left corner to reach the escape hatch. */
    private static final long ESCAPE_HOLD_MS = 2000;
    /** Corner size in px on a 720x720 panel — small enough not to be hit by accident. */
    private static final int CORNER_PX = 90;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable pendingEscape;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The dashboard is built for this exact 720x720 panel; let it lay itself out.
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // Home Assistant serves /local/ with `Cache-Control: public,
        // max-age=2678400` — 31 days. With LOAD_DEFAULT the panel would keep
        // showing a month-old build no matter what the deploy pipeline pushed,
        // which makes remote updates useless. The payload is ~100 KB over LAN,
        // so always revalidating costs nothing worth measuring.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setBackgroundColor(Color.BLACK);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return false; // keep everything inside this WebView
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                // Home Assistant may not be up yet at boot — the panel and the
                // server often power on together. Retry rather than sit on an
                // error page that needs a human to dismiss.
                if (req != null && req.isForMainFrame()) {
                    handler.postDelayed(new Runnable() {
                        @Override public void run() { v.loadUrl(url()); }
                    }, 5000);
                }
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Invisible corner target for the escape hatch.
        View corner = new View(this);
        corner.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                if (e.getAction() == MotionEvent.ACTION_DOWN) {
                    pendingEscape = new Runnable() {
                        @Override public void run() { showEscapeHatch(); }
                    };
                    handler.postDelayed(pendingEscape, ESCAPE_HOLD_MS);
                } else if (e.getAction() == MotionEvent.ACTION_UP
                        || e.getAction() == MotionEvent.ACTION_CANCEL) {
                    if (pendingEscape != null) handler.removeCallbacks(pendingEscape);
                }
                return true;
            }
        });
        root.addView(corner, new FrameLayout.LayoutParams(CORNER_PX, CORNER_PX));

        // Device-level things the web app cannot reach on its own. Everything
        // else — lights, heat, music — goes through Home Assistant, so this
        // stays deliberately small.
        web.addJavascriptInterface(new Bridge(), "hjem");

        // Provisioning sets the room without rebuilding the APK:
        //   am start -n dk.hjem.kiosk/.KioskActivity -e url "http://.../?room=kokken"
        // One APK for nine panels; the room is configuration, not code.
        applyIntent(getIntent());

        setContentView(root);
        web.loadUrl(url());
    }

    /** Exposed to the page as `window.hjem`. */
    public class Bridge {

        /** Screen brightness, 0-255. Needs WRITE_SETTINGS (granted over adb). */
        @JavascriptInterface
        public boolean setBrightness(int level) {
            if (level < 1) level = 1;
            if (level > 255) level = 255;
            try {
                Settings.System.putInt(getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS_MODE,
                        Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
                Settings.System.putInt(getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS, level);
                return true;
            } catch (Throwable t) {
                return false; // permission not granted
            }
        }

        @JavascriptInterface
        public int getBrightness() {
            try {
                return Settings.System.getInt(getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS);
            } catch (Throwable t) {
                return -1;
            }
        }

        /** Media volume as a percentage. */
        @JavascriptInterface
        public boolean setVolume(int percent) {
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int v = Math.round(max * Math.max(0, Math.min(100, percent)) / 100f);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }

        @JavascriptInterface
        public int getVolume() {
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                return max == 0 ? 0 : Math.round(
                        am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max);
            } catch (Throwable t) {
                return -1;
            }
        }

        @JavascriptInterface
        public void openSettings() { openSettingsSafely(); }

        @JavascriptInterface
        public void openWifi() {
            safeStart(new Intent(Settings.ACTION_WIFI_SETTINGS));
            scheduleReturn();
        }

        @JavascriptInterface
        public void openSound() {
            safeStart(new Intent(Settings.ACTION_SOUND_SETTINGS));
            scheduleReturn();
        }

        @JavascriptInterface
        public void openApps() {
            safeStart(new Intent(Settings.ACTION_APPLICATION_SETTINGS));
            scheduleReturn();
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                @Override public void run() { web.reload(); }
            });
        }

        /** So a wrong URL can always be corrected from the page itself. */
        @JavascriptInterface
        public void setUrl(final String u) {
            if (u == null || u.trim().isEmpty()) return;
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_URL, u.trim()).apply();
            runOnUiThread(new Runnable() {
                @Override public void run() { web.loadUrl(url()); }
            });
        }
    }

    /**
     * Open Android's settings, then come back on our own.
     *
     * This panel has no navigation bar, and the Shelly overlay that used to
     * supply the only Back button is disabled — so anything launched here is a
     * dead end reachable only over adb. Scheduling our own return means the
     * escape hatch cannot itself become a trap. Long enough to join a Wi-Fi
     * network; short enough that a mis-tap fixes itself.
     */
    private void scheduleReturn() {
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                Intent back = new Intent(KioskActivity.this, KioskActivity.class);
                back.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                safeStart(back);
            }
        }, 180000);
    }

    private void openSettingsSafely() {
        safeStart(new Intent(Settings.ACTION_SETTINGS));
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                Intent back = new Intent(KioskActivity.this, KioskActivity.class);
                back.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                safeStart(back);
            }
        }, 180000); // 3 minutes
    }

    private void safeStart(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable ignored) {
        }
    }

    /** Accept a url (and optional accent) handed in by an intent, and persist it. */
    private void applyIntent(Intent i) {
        if (i == null) return;
        String u = i.getStringExtra("url");
        if (u != null && !u.trim().isEmpty()) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_URL, u.trim()).apply();
        }
    }

    /** Relaunched with a new url while already running (singleTask). */
    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        String before = url();
        applyIntent(i);
        if (!before.equals(url())) web.loadUrl(url());
    }

    private String url() {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getString(KEY_URL, DEFAULT_URL);
    }

    /**
     * Without this, setting the app as HOME would be a one-way door: no status
     * bar, no back, no way to reach Android settings if the URL is wrong.
     */
    private void showEscapeHatch() {
        final EditText input = new EditText(this);
        input.setText(url());
        new AlertDialog.Builder(this)
                .setTitle("Hjem kiosk")
                .setView(input)
                .setPositiveButton("Gem", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .edit().putString(KEY_URL, input.getText().toString().trim()).apply();
                        web.loadUrl(url());
                    }
                })
                .setNeutralButton("Genindlæs", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) { web.reload(); }
                })
                .setNegativeButton("Android", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        openSettingsSafely();
                    }
                })
                .show();
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) immersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        // Dashboard is in front — nothing to escape from, so take the button away.
        try { stopService(new Intent(this, OverlayService.class)); } catch (Throwable ignored) {}
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Something else is in front. Put up the way back.
        try { startService(new Intent(this, OverlayService.class)); } catch (Throwable ignored) {}
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /** As HOME, back must not exit — there is nothing behind us. */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
    }
}
