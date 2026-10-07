package app.connectwell.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationManagerCompat;

/**
 * Receives the web app's notifications from Chrome (notification delegation)
 * and posts them as this app's own.
 *
 * Messages and everything else go through the library, onto Chrome's channel,
 * which the manifest makes high priority so they pop up like a messenger's.
 * Calls get two channels of their own: one that RINGS — the phone's ringtone,
 * looping, until the call is answered, declined or over — and a quiet one for
 * how the call ended.
 *
 * The web app's service worker (public/sw.js) tags its notifications, and
 * Chrome embeds that tag in the platform tag it passes here as
 * "p#&lt;origin&gt;#1&lt;tag&gt;":
 *   cw-ring-&lt;conversation&gt;   an incoming call, ringing
 *   cw-call-&lt;conversation&gt;   how that call ended (missed, answered elsewhere)
 * The tags are a contract with sw.js; change them together.
 */
public class DelegationService extends com.google.androidbrowserhelper.trusted.DelegationService {

    private static final String RING_TAG = "#1cw-ring-";
    private static final String CALL_TAG = "#1cw-call-";

    /**
     * A ring nobody ends — its "call is over" message lost on a bad network —
     * must not ring forever. Longer than the server's ring time (45 s unless
     * the server sets CALL_RING_SECONDS higher), so it never cuts a call short.
     */
    private static final long RING_LIMIT_MS = 90_000;

    @Override
    public boolean onNotifyNotificationWithChannel(@NonNull String platformTag, int platformId,
            @NonNull Notification notification, @NonNull String channelName) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (platformTag.contains(RING_TAG)) {
                return post(platformTag, platformId, notification, Channels.CALLS, true);
            }
            if (platformTag.contains(CALL_TAG)) {
                return post(platformTag, platformId, notification, Channels.CALL_STATUS, false);
            }
        }
        return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
    }

    @RequiresApi(Build.VERSION_CODES.O)
    @SuppressWarnings("MissingPermission")   // areNotificationsEnabled() is the check
    private boolean post(String tag, int id, Notification original, String channelId, boolean ringing) {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false;
        Channels.create(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(channelId);
        // Switched off by the person in system settings: respected.
        if (channel == null || channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;

        Notification.Builder builder = Notification.Builder.recoverBuilder(this, original)
                .setChannelId(channelId);
        if (ringing) {
            builder.setCategory(Notification.CATEGORY_CALL).setTimeoutAfter(RING_LIMIT_MS);
        }
        Notification shown = builder.build();
        // Repeats the channel's sound (and vibration) until the notification is
        // cancelled — which is what the web app's "call over" message does.
        if (ringing) shown.flags |= Notification.FLAG_INSISTENT;

        // Replaced rather than updated, so a ringtone always stops, or starts
        // over, instead of depending on how an update is treated.
        manager.cancel(tag, id);
        manager.notify(tag, id, shown);
        return true;
    }
}
