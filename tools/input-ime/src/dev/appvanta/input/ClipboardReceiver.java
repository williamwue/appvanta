package dev.appvanta.input;

import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import java.nio.charset.StandardCharsets;

/** Shell-only clipboard bridge for AppVanta test devices. */
public final class ClipboardReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        setResultCode(0);
        if (!"dev.appvanta.input.SET_CLIPBOARD".equals(intent.getAction())) { setResultData("invalid-action"); return; }
        String payload = intent.getStringExtra("text64");
        if (payload == null || payload.length() > 32768) { setResultData("invalid-payload"); return; }
        try {
            String text = new String(Base64.decode(payload, Base64.NO_WRAP), StandardCharsets.UTF_8);
            ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("AppVanta", text));
            setResultCode(1); setResultData("clipboard-set");
        } catch (IllegalArgumentException error) { setResultData("invalid-base64"); }
    }
}
