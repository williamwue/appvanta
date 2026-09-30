package dev.appvanta.share.helper;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import java.util.ArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ShareActivity extends Activity {
    private String operation, mime, destination;
    private int count;
    private JSONObject receipt;
    private final ArrayList<Uri> uris = new ArrayList<>();
    public void onCreate(Bundle saved) { super.onCreate(saved); accept(getIntent()); }
    public void onNewIntent(Intent intent) { super.onNewIntent(intent); accept(intent); }
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 1) finish();
    }
    private void accept(Intent incoming) {
        String requested = incoming.getStringExtra("operation");
        try {
            Receipts.file(this, requested);
            String mode = incoming.getStringExtra("mode");
            if ("prepare".equals(mode)) prepare(incoming, requested);
            else {
                if (!requested.equals(operation) || receipt == null) throw new IllegalStateException("No active preparation; inspect receipt before retry");
                String state = receipt.getString("state");
                if ("cancel".equals(mode) && ("prepared".equals(state) || "rejected".equals(state))) { receipt.remove("error"); record("cancelled"); finish(); }
                else if ("dispatch".equals(mode) && "prepared".equals(state)) dispatch();
                else throw new IllegalArgumentException("Invalid mode");
            }
        } catch (Exception error) {
            if (requested != null && requested.equals(operation) && receipt != null) {
                try {
                    if ("prepared".equals(receipt.getString("state"))) { receipt.put("error", error.toString()); record("rejected"); }
                } catch (Exception ignored) { error.addSuppressed(ignored); }
            }
            show("failed: " + error);
        }
    }
    private void prepare(Intent incoming, String requested) throws Exception {
        int index = incoming.getIntExtra("index", -1);
        int expected = incoming.getIntExtra("count", -1);
        String type = incoming.getStringExtra("mimeType");
        String target = incoming.getStringExtra("targetPackage");
        Uri uri = incoming.getData();
        if (expected < 2 || expected > 16 || index < 0 || index >= expected) throw new IllegalArgumentException("Invalid attachment index/count");
        if (type == null || type.length() > 127 || !type.matches("[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*")) throw new IllegalArgumentException("Explicit MIME required");
        if (target != null && (!target.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+") || target.equals(getPackageName()))) throw new IllegalArgumentException("Invalid destination");
        if (uri == null || uri.toString().length() > 4096 || !uri.toString().matches("content://[A-Za-z0-9_.-]+/[^#\\s\\x00-\\x1f\\x7f]*")) throw new IllegalArgumentException("Content URI required");
        if ("dev.appvanta.share.uploads".equals(uri.getAuthority())) {
            try (android.os.ParcelFileDescriptor descriptor = getContentResolver().openFileDescriptor(uri, "r")) {
                if (descriptor == null) throw new IllegalStateException("Managed upload is not readable");
            }
        } else if (checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new SecurityException("Read grant required");
        if (operation == null) {
            if (index != 0) throw new IllegalStateException("Preparation must start at zero");
            JSONObject initial = new JSONObject().put("version", 1).put("operation", requested).put("state", "prepared").put("count", expected).put("mimeType", type).put("uris", new JSONArray());
            if (target != null) initial.put("packageName", target);
            Receipts.create(this, requested, initial);
            operation = requested; receipt = initial; count = expected; mime = type; destination = target;
        }
        if (!requested.equals(operation) || !"prepared".equals(receipt.getString("state")) || index != uris.size() || count != expected || !mime.equals(type) || !java.util.Objects.equals(destination, target) || uris.contains(uri)) throw new IllegalStateException("Mismatched or duplicate preparation");
        uris.add(uri); receipt.getJSONArray("uris").put(uri.toString()); record("prepared");
        show("Prepared " + operation + " " + uris.size());
    }
    private void dispatch() throws Exception {
        if (uris.size() != count) throw new IllegalStateException("Preparation incomplete");
        Intent send = new Intent(Intent.ACTION_SEND_MULTIPLE).setType(mime);
        if (destination != null) send.setPackage(destination);
        send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(uris));
        ClipData clip = ClipData.newRawUri("AppVanta attachments", uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        send.setClipData(clip); send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        record("dispatching");
        if (destination == null) startActivityForResult(send, 1);
        else startActivity(send);
        record("dispatched");
        if (destination != null) finish();
    }
    private void record(String state) throws Exception { receipt.put("state", state); Receipts.save(this, operation, receipt); }
    private void show(String message) { TextView view = new TextView(this); view.setText(message); setContentView(view); }
}
