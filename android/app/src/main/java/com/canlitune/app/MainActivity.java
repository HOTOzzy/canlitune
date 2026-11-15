package com.canlitune.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;

/** Hosts the shared CanlıTune UI (assets/index.html) and routes the mic to the native Oboe engine. */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 7, REQ_FILE = 8;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private volatile int outDeviceId = 0;
    private volatile int lastSampleRate = 48000;
    private File recWav;
    private MediaPlayer player;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0d0f14"));
        getWindow().setNavigationBarColor(Color.parseColor("#0d0f14"));
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
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
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Dosya seç"), REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "CanliNative");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE || fileCb == null) return;
        Uri[] r = (res == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
        fileCb.onReceiveValue(r);
        fileCb = null;
    }

    @Override
    protected void onDestroy() {
        NativeAudio.nRecStop();
        NativeAudio.nStop();
        stopKeepAlive();
        AudioService.onStopRequested = null;
        stopPlayer();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC) return;
        boolean ok = false;   // the notification permission is optional; only the microphone decides
        for (int i = 0; i < perms.length && i < results.length; i++)
            if (Manifest.permission.RECORD_AUDIO.equals(perms[i])) ok = results[i] == PackageManager.PERMISSION_GRANTED;
        web.evaluateJavascript("window.__canliPerm && window.__canliPerm(" + ok + ")", null);
    }

    /** Keeps the engine and the microphone running while another app (a karaoke video…) is in front. */
    private void startKeepAlive() {
        try {
            AudioService.onStopRequested = () -> js("window.__canliStopped && window.__canliStopped()");
            Intent i = new Intent(this, AudioService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Exception e) {
            Log.e("CanliTune", "keep-alive service", e);
        }
    }

    private void stopKeepAlive() {
        try { stopService(new Intent(this, AudioService.class)); } catch (Exception ignored) {}
    }

    private void js(final String code) { runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); }); }

    /** Id of the phone's built-in microphone (0 = let the system choose). */
    private int builtInMicId() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS))
            if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) return d.getId();
        return 0;
    }

    /** "bluetooth" | "wired" | "usb" | "hdmi" | "speaker" | "" (not a listening device). */
    private static String kind(int t) {
        if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return "bluetooth";
        if (Build.VERSION.SDK_INT >= 31 && (t == AudioDeviceInfo.TYPE_BLE_HEADSET || t == AudioDeviceInfo.TYPE_BLE_SPEAKER)) return "bluetooth";
        if (t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                || t == AudioDeviceInfo.TYPE_LINE_ANALOG || t == AudioDeviceInfo.TYPE_AUX_LINE) return "wired";
        if (t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_USB_DEVICE || t == AudioDeviceInfo.TYPE_DOCK) return "usb";
        if (t == AudioDeviceInfo.TYPE_HDMI || t == AudioDeviceInfo.TYPE_HDMI_ARC) return "hdmi";
        if (t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return "speaker";
        return "";
    }

    private File recDir() {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        File d = new File(base, "kayitlar");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private File recFile(String name) {
        if (name == null || name.contains("/") || name.contains("..")) return null;
        File f = new File(recDir(), name);
        return f.isFile() ? f : null;
    }

    private void stopPlayer() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
    }

    /** Methods callable from JavaScript as window.CanliNative.* (they run on a WebView binder thread). */
    private final class Bridge {
        @JavascriptInterface
        public String start() {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> requestPermissions(Build.VERSION.SDK_INT >= 33
                        ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                        : new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC));
                return "{\"ok\":false,\"err\":\"perm\"}";
            }
            String r = NativeAudio.nStart(Build.VERSION.SDK_INT, builtInMicId(), outDeviceId);
            if (!r.contains("\"ok\":true") && outDeviceId != 0) {  // chosen device vanished: fall back to the system default
                outDeviceId = 0;
                r = NativeAudio.nStart(Build.VERSION.SDK_INT, builtInMicId(), 0);
            }
            try { lastSampleRate = new JSONObject(r).optInt("sr", 48000); } catch (Exception ignored) {}
            if (r.contains("\"ok\":true")) runOnUiThread(MainActivity.this::startKeepAlive);
            return r;
        }

        @JavascriptInterface
        public void stop() { NativeAudio.nStop(); runOnUiThread(MainActivity.this::stopKeepAlive); }

        /** Output devices the user can listen on: [{id, name, kind}] (id 0 = system default). */
        @JavascriptInterface
        public String outputs() {
            JSONArray a = new JSONArray();
            try {
                AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    String k = kind(d.getType());
                    if (k.isEmpty()) continue;
                    JSONObject o = new JSONObject();
                    o.put("id", d.getId());
                    o.put("kind", k);
                    o.put("name", String.valueOf(d.getProductName()));
                    a.put(o);
                }
            } catch (Exception e) {
                Log.e("CanliTune", "outputs", e);
            }
            return a.toString();
        }

        @JavascriptInterface
        public void setOutput(int id) { outDeviceId = id; }

        @JavascriptInterface
        public int getOutput() { return outDeviceId; }

        /** Kind of device currently used for listening. */
        @JavascriptInterface
        public String route() {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            String r = "speaker";
            int rank = 0;
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                String k = kind(d.getType());
                if (k.isEmpty()) continue;
                if (outDeviceId != 0) {
                    if (d.getId() == outDeviceId) return k;
                    continue;
                }
                // without an explicit choice Android prefers: bluetooth > wired/usb/hdmi > speaker
                int rk = k.equals("bluetooth") ? 3 : k.equals("speaker") ? 1 : 2;
                if (rk > rank) { rank = rk; r = k; }
            }
            return r;
        }

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
            StringBuilder b = new StringBuilder(220).append('[');
            for (int i = 0; i < t.length; i++) {
                if (i > 0) b.append(',');
                b.append(Float.isNaN(t[i]) || Float.isInfinite(t[i]) ? 0f : t[i]);
            }
            return b.append(']').toString();
        }

        // ---- backing track (decoded to PCM by the web layer) ----
        @JavascriptInterface
        public void beatBegin(double frames, double sampleRate) { NativeAudio.nBeatBegin((long) frames, sampleRate); }

        @JavascriptInterface
        public void beatChunk(String base64Int16Stereo) {
            try {
                NativeAudio.nBeatChunk(Base64.decode(base64Int16Stereo, Base64.DEFAULT));
            } catch (Exception e) {
                Log.e("CanliTune", "beat chunk", e);
            }
        }

        @JavascriptInterface
        public void beatCtl(int cmd, double v) { NativeAudio.nBeatCtl(cmd, v); }

        // ---- recordings ----
        @JavascriptInterface
        public boolean recStart() {
            String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());
            recWav = new File(recDir(), "CanliTune_" + stamp + ".wav");
            return NativeAudio.nRecStart(recWav.getAbsolutePath());
        }

        /** Stops, then converts to .m4a in the background; calls window.__canliRecDone(name) when ready. */
        @JavascriptInterface
        public void recStop() {
            final long frames = NativeAudio.nRecStop();
            final File wav = recWav;
            final int sr = lastSampleRate;
            recWav = null;
            if (wav == null) return;
            new Thread(() -> {
                String name = wav.getName();
                if (frames < sr / 4) {
                    wav.delete();
                    name = "";
                } else {
                    File m4a = new File(wav.getParentFile(), name.replace(".wav", ".m4a"));
                    if (M4aEncoder.encode(wav, m4a, sr)) {
                        wav.delete();
                        name = m4a.getName();
                    }
                }
                js("window.__canliRecDone && window.__canliRecDone(" + JSONObject.quote(name) + ")");
            }).start();
        }

        @JavascriptInterface
        public String recList() {
            JSONArray a = new JSONArray();
            try {
                File[] fs = recDir().listFiles();
                if (fs != null) {
                    Arrays.sort(fs, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
                    for (File f : fs) {
                        if (recWav != null && f.equals(recWav)) continue;
                        JSONObject o = new JSONObject();
                        o.put("name", f.getName());
                        o.put("kb", f.length() / 1024);
                        o.put("t", f.lastModified());
                        a.put(o);
                    }
                }
            } catch (Exception e) {
                Log.e("CanliTune", "recList", e);
            }
            return a.toString();
        }

        @JavascriptInterface
        public boolean recDelete(String name) {
            File f = recFile(name);
            return f != null && f.delete();
        }

        @JavascriptInterface
        public boolean recShare(String name) {
            File f = recFile(name);
            if (f == null) return false;
            try {
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(name.endsWith(".m4a") ? "audio/mp4" : "audio/wav");
                i.putExtra(Intent.EXTRA_STREAM, uri);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent ch = Intent.createChooser(i, "Kaydı paylaş");
                ch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(ch));
                return true;
            } catch (Exception e) {
                Log.e("CanliTune", "share", e);
                return false;
            }
        }

        /** Plays a recording through the normal media path; window.__canliPlayDone() fires at the end. */
        @JavascriptInterface
        public boolean recPlay(String name) {
            final File f = recFile(name);
            if (f == null) return false;
            runOnUiThread(() -> {
                stopPlayer();
                try {
                    player = new MediaPlayer();
                    player.setDataSource(f.getAbsolutePath());
                    player.setOnCompletionListener(mp -> { stopPlayer(); js("window.__canliPlayDone && window.__canliPlayDone()"); });
                    player.prepare();
                    player.start();
                } catch (Exception e) {
                    Log.e("CanliTune", "play", e);
                    stopPlayer();
                    js("window.__canliPlayDone && window.__canliPlayDone()");
                }
            });
            return true;
        }

        @JavascriptInterface
        public void recPlayStop() { runOnUiThread(MainActivity.this::stopPlayer); }
    }
}
