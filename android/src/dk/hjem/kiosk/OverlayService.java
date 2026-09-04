package dk.hjem.kiosk;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * A floating "Hjem" button, shown only while the dashboard is not in front.
 *
 * This panel has no navigation bar. The stock Shelly app supplied the only way
 * back — a SYSTEM_ALERT_WINDOW overlay with a logo and a back arrow — and we
 * disabled that to get a clean dashboard, which quietly turned every other app
 * into a dead end reachable only over adb.
 *
 * So we provide our own, with the difference that matters: it is shown on
 * onPause and removed on onResume, so it is never on top of the dashboard
 * itself. You only ever see it when you actually need it.
 *
 * Needs SYSTEM_ALERT_WINDOW, which an app cannot grant itself on API 23+:
 *
 *   adb shell appops set dk.hjem.kiosk SYSTEM_ALERT_WINDOW allow
 */
public class OverlayService extends Service {

    private WindowManager wm;
    private View button;

    @Override
    public IBinder onBind(Intent i) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (button != null) return START_STICKY; // already showing
        try {
            show();
        } catch (Throwable t) {
            // Permission not granted, or the window type is refused. Failing
            // silently is right: the overlay is a convenience, and crashing the
            // launcher process to report it would be far worse.
            stopSelf();
        }
        return START_STICKY;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void show() {
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

        TextView b = new TextView(this);
        b.setText("Hjem");
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(14), dp(9), dp(14), dp(9));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#CC1B1B22"));
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), Color.parseColor("#66FFFFFF"));
        b.setBackground(bg);

        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Intent back = new Intent(OverlayService.this, KioskActivity.class);
                back.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                startActivity(back);
                stopSelf();
            }
        });

        // TYPE_PHONE is deprecated but is what works on this panel's Android 7.
        // TYPE_APPLICATION_OVERLAY only exists from API 26.
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                // Not focusable: the app underneath keeps its keyboard and
                // touch handling, and this only intercepts its own taps.
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSLUCENT);
        // Bottom-left: Android's own settings put their content and any Back
        // affordance top-left, so this stays out of the way.
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        lp.x = dp(12);
        lp.y = dp(12);

        wm.addView(b, lp);
        button = b;
    }

    @Override
    public void onDestroy() {
        if (wm != null && button != null) {
            try {
                wm.removeView(button);
            } catch (Throwable ignored) {
            }
        }
        button = null;
        super.onDestroy();
    }
}
