package app.connectwell.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

/**
 * The app's own notification channels, for calls. Messages use the channel
 * Chrome names (see DelegationService).
 *
 * Created whenever the app starts. Android fixes a channel's sound and
 * importance at its first creation and leaves them to the person after that;
 * calling this again only refreshes the names, so they follow the phone's
 * language.
 */
final class Channels {
    static final String CALLS = "calls";
    static final String CALL_STATUS = "call_status";

    private Channels() { }

    static void create(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);

        NotificationChannel calls = new NotificationChannel(
                CALLS, context.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(context.getString(R.string.channel_calls_description));
        // The phone's own ringtone, played as a ringtone: it follows the ringer
        // volume and the ring/silent switch, like a phone call.
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 1000, 1000 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(calls);

        NotificationChannel status = new NotificationChannel(
                CALL_STATUS, context.getString(R.string.channel_call_status), NotificationManager.IMPORTANCE_DEFAULT);
        status.setDescription(context.getString(R.string.channel_call_status_description));
        // The ringing already made the noise; how the call ended is just a note.
        status.setSound(null, null);
        status.enableVibration(false);
        manager.createNotificationChannel(status);
    }
}
