package dev.appvanta.input;

/** Shell-only native signal fixture. Never invoked by the input Driver. */
public final class NativeFaultActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        android.os.Process.sendSignal(android.os.Process.myPid(), 6);
    }
}
