package com.canlitune.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.Iterator;

/** Hosts the shared CanlıTune UI (assets/index.html) and routes the mic to the native Oboe engine. */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 7;
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0d0f14"));
        getWindow().setNavigationBarColor(Color.parseColor("#0d0f14"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0f14"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i("CanliTuneJS", m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "CanliNative");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onDestroy() {
        NativeAudio.nStop();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        web.evaluateJavascript("window.__canliPerm && window.__canliPerm(" + ok + ")", null);
    }

    /** Methods callable from JavaScript as window.CanliNative.* (they run on a WebView binder thread). */
    private final class Bridge {
        @JavascriptInterface
        public String start() {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC));
                return "{\"ok\":false,\"err\":\"perm\"}";
            }
            return NativeAudio.nStart(Build.VERSION.SDK_INT);
        }

        @JavascriptInterface
        public void stop() { NativeAudio.nStop(); }

        @JavascriptInterface
        public void setParams(String json) {
            try {
                JSONObject o = new JSONObject(json);
                String[] keys = new String[o.length()];
                double[] vals = new double[o.length()];
                int i = 0;
                for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                    String k = it.next();
                    keys[i] = k;
                    vals[i] = o.optDouble(k, 0);
                    i++;
                }
                NativeAudio.nSetParams(keys, vals);
            } catch (Exception e) {
                Log.e("CanliTune", "bad params", e);
            }
        }

        @JavascriptInterface
        public void measure() { NativeAudio.nMeasure(); }

        @JavascriptInterface
        public String telemetry() {
            float[] t = NativeAudio.nTelemetry();
            StringBuilder b = new StringBuilder(160).append('[');
            for (int i = 0; i < t.length; i++) { if (i > 0) b.append(','); b.append(Float.isFinite(t[i]) ? t[i] : 0f); }
            return b.append(']').toString();
        }
    }
}
