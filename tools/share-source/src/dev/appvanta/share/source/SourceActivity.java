package dev.appvanta.share.source;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;

public final class SourceActivity extends Activity {
    public void onCreate(Bundle state) {
        super.onCreate(state);
        handle();
    }
    public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handle(); }
    private void handle() {
        String token = getIntent().getStringExtra("token");
        if (token == null || !token.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Invalid token");
        Uri uri = Uri.parse("content://dev.appvanta.share.source/payload/" + token);
        File file = new File(getFilesDir(), token + ".bin");
        String message;
        if (getIntent().getBooleanExtra("cleanup", false)) {
            revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (file.exists() && !file.delete()) throw new IllegalStateException("Cannot remove fixture");
            message = "Removed " + token;
        } else {
            if (file.exists()) throw new IllegalStateException("Fixture already exists");
            int seed = getIntent().getIntExtra("seed", 0);
            if (seed < 0 || seed > 255) throw new IllegalArgumentException("Invalid seed");
            try (FileOutputStream output = new FileOutputStream(file)) {
                for (int i = 0; i < 4096; i++) output.write((i + seed) & 255);
                output.getFD().sync();
            } catch (Exception error) { throw new IllegalStateException(error); }
            grantUriPermission("com.android.shell", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            message = "Ready " + token;
        }
        TextView view = new TextView(this); view.setText(message); setContentView(view);
    }
}
