package com.canlitune.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground service that keeps the live engine (and microphone access) alive while another app,
 * e.g. a karaoke video, is on screen. The audio itself runs in the native Oboe engine of this process.
 */
public class AudioService extends Service {
    static final String CHANNEL = "canlitune_live";
    static final String ACTION_STOP = "com.canlitune.app.STOP";
    static volatile Runnable onStopRequested;   // set by MainActivity to update its UI

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            NativeAudio.nRecStop();
            NativeAudio.nStop();
            Runnable r = onStopRequested;
            if (r != null) r.run();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Canlı ses", NotificationManager.IMPORTANCE_LOW));
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, AudioService.class).setAction(ACTION_STOP), immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("CanlıTune açık")
                .setContentText("Mikrofon işleniyor; başka uygulama açıkken de çalışır.")
                .setSmallIcon(R.drawable.ic_fg)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(0, "Durdur", stop).build());
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(1, n);
        } catch (Exception e) {
            android.util.Log.e("CanliTune", "startForeground failed", e);
            stopSelf();
        }
        return START_NOT_STICKY;
    }
}
