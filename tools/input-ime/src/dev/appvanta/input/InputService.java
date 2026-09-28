package dev.appvanta.input;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.util.Base64;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.EditorInfo;
import java.nio.charset.StandardCharsets;

/** Test-device input bridge. No networking, persistence, or model calls. */
public final class InputService extends InputMethodService {
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            setResultCode(0);
            String payload = intent.getStringExtra("text64");
            String expected = intent.getStringExtra("expectedPackage");
            EditorInfo editor = getCurrentInputEditorInfo();
            InputConnection connection = getCurrentInputConnection();
            if (connection == null || editor == null || expected == null || !expected.equals(editor.packageName)) {
                setResultData("no-matching-editor"); return;
            }
            if ("dev.appvanta.input.READY".equals(intent.getAction())) {
                setResultCode(1); setResultData("ready"); return;
            }
            if (payload == null || payload.length() > 32768) { setResultData("invalid-payload"); return; }
            try {
                String text = new String(Base64.decode(payload, Base64.NO_WRAP), StandardCharsets.UTF_8);
                if (connection.commitText(text, 1)) { setResultCode(1); setResultData("committed"); }
                else setResultData("commit-rejected");
            } catch (IllegalArgumentException error) { setResultData("invalid-base64"); }
        }
    };
    @Override public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter("dev.appvanta.input.COMMIT");
        filter.addAction("dev.appvanta.input.READY");
        // Shell has DUMP. Ordinary apps cannot inject text through this receiver.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, "android.permission.DUMP", null, Context.RECEIVER_EXPORTED);
        else registerReceiver(receiver, filter, "android.permission.DUMP", null);
    }
    @Override public void onDestroy() { unregisterReceiver(receiver); super.onDestroy(); }
}
