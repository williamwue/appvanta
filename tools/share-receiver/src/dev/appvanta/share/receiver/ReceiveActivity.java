package dev.appvanta.share.receiver;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;

public final class ReceiveActivity extends Activity {
    public void onCreate(Bundle state) {
        super.onCreate(state);
        JSONObject report = new JSONObject();
        try {
            if (Intent.ACTION_SEND_MULTIPLE.equals(getIntent().getAction())) {
                ArrayList<Uri> uris = getIntent().getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (uris == null || uris.size() < 2 || uris.size() > 16) throw new IllegalArgumentException("Invalid URI list");
                JSONArray items = new JSONArray();
                boolean passed = true;
                for (Uri uri : uris) { JSONObject item = receive(uri); items.put(item); passed &= "received".equals(item.getString("status")); }
                report.put("items", items); report.put("status", passed ? "received" : "failed");
                report.put("clipCount", getIntent().getClipData() == null ? 0 : getIntent().getClipData().getItemCount());
            } else report = receive(getIntent().getParcelableExtra(Intent.EXTRA_STREAM));
        } catch (Exception error) { try { report.put("status", "failed"); report.put("error", error.toString()); } catch (Exception ignored) { throw new IllegalStateException(ignored); } }
        try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), "received.json"))) {
            output.write(report.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        } catch (Exception error) { throw new IllegalStateException(error); }
        TextView view = new TextView(this); view.setText(report.toString()); setContentView(view);
    }
    private JSONObject receive(Uri uri) {
        JSONObject report = new JSONObject();
        try {
            report.put("readPermission", checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION));
            report.put("uri", uri.toString()); report.put("mimeType", getIntent().getType()); report.put("flags", getIntent().getFlags());
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); int size = 0;
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                byte[] buffer = new byte[1024]; int read;
                while ((read = input.read(buffer)) != -1) { size += read; if (size > 1048576) throw new IllegalStateException("Too large"); digest.update(buffer, 0, read); }
            }
            StringBuilder sha = new StringBuilder(); for (byte value : digest.digest()) sha.append(String.format("%02x", value & 255));
            report.put("sha256", sha.toString()); report.put("bytes", size); report.put("status", "received");
            try { getContentResolver().openFileDescriptor(uri, "w").close(); report.put("writeDenied", false); }
            catch (SecurityException denied) { report.put("writeDenied", true); }
        } catch (Exception error) { try { report.put("status", "failed"); report.put("error", error.toString()); } catch (Exception ignored) { throw new IllegalStateException(ignored); } }
        return report;
    }
}
