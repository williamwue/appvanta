package dev.appvanta.input;

/** Explicit shell-only Java crash fixture; never launched by the input Driver. */
public final class FaultActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        throw new IllegalStateException("AppVanta deliberate Java crash fixture");
    }
}
