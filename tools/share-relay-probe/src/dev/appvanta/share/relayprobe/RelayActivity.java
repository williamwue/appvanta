package dev.appvanta.share.relayprobe;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import java.util.ArrayList;

public final class RelayActivity extends Activity {
    private String operation;
    private final ArrayList<Uri> uris = new ArrayList<>();
    public void onCreate(Bundle state) { super.onCreate(state); accept(getIntent()); }
    public void onNewIntent(Intent intent) { super.onNewIntent(intent); accept(intent); }
    private void accept(Intent incoming) {
        try {
            String token = incoming.getStringExtra("operation");
            int index = incoming.getIntExtra("index", -1);
            if (token == null || !token.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Invalid operation");
            if (index == 0 && operation == null && uris.isEmpty()) operation = token;
            if (!token.equals(operation) || index != uris.size() || index > 1) throw new IllegalStateException("Missing or mismatched preparation");
            Uri uri = incoming.getData();
            if (uri == null || !"content".equals(uri.getScheme()) || !"dev.appvanta.share.source".equals(uri.getAuthority())) throw new IllegalArgumentException("Fixture URI required");
            if (checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new SecurityException("Read grant required");
            if (uris.contains(uri)) throw new IllegalArgumentException("Duplicate URI");
            uris.add(uri);
            if (index == 0) { show("Prepared " + token); return; }
            Intent send = new Intent(Intent.ACTION_SEND_MULTIPLE);
            send.setType("application/octet-stream");
            send.setPackage("dev.appvanta.share.receiver");
            send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(uris));
            ClipData clip = ClipData.newRawUri("AppVanta probe", uris.get(0));
            clip.addItem(new ClipData.Item(uris.get(1)));
            send.setClipData(clip);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(send);
            finish();
        } catch (Exception error) { uris.clear(); operation = null; show("failed: " + error); }
    }
    private void show(String message) { TextView view = new TextView(this); view.setText(message); setContentView(view); }
}
