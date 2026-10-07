package app.connectwell.twa;

public class Application extends android.app.Application {
    @Override
    public void onCreate() {
        super.onCreate();
        // Before the first call, so "Calls" can be found and adjusted in the
        // app's notification settings from the start.
        Channels.create(this);
    }
}
