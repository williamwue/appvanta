package dev.appvanta.input;

/** Explicit shell-only ANR fixture. Blocks only after a deliberate button click. */
public final class AnrActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        android.widget.Button button = new android.widget.Button(this);
        button.setText("Trigger AppVanta ANR");
        button.setOnClickListener(view -> {
            android.util.Log.i("AppVantaAnrFixture", "Deliberately blocking main thread for 60 seconds");
            android.os.SystemClock.sleep(60000);
        });
        setContentView(button);
    }
}
