package dev.appvanta.share.helper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import org.json.JSONObject;

public final class UploadProvider extends ContentProvider {
    private static final Object LOCK = new Object();
    private static final HashSet<String> ACTIVE = new HashSet<>();
    private static final String AUTHORITY = "dev.appvanta.share.uploads";
    private static final long LIMIT = 64L * 1024 * 1024;
    private static boolean validName(String name) {
        if (name == null || name.length() < 1 || name.length() > 255) return false;
        for (int i = 0; i < name.length(); i++) { char value = name.charAt(i); if (value == '/' || value == '\\' || value < 32 || value == 127) return false; }
        return true;
    }
    public boolean onCreate() { return true; }
    private void requireOwner() { getContext().enforceCallingOrSelfPermission("android.permission.DUMP", "Upload management requires DUMP"); }
    private String token(Uri uri) {
        if (!"content".equals(uri.getScheme()) || !AUTHORITY.equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null || uri.getPathSegments().size() != 2 || !"files".equals(uri.getPathSegments().get(0))) throw new IllegalArgumentException("Invalid upload URI");
        String value = uri.getPathSegments().get(1);
        if (!value.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("Invalid upload ID");
        return value;
    }
    private File file(String id, String suffix) { return new File(getContext().getFilesDir(), "upload-" + id + suffix); }
    private JSONObject load(String id) throws Exception {
        byte[] bytes = new AtomicFile(file(id, ".json")).readFully();
        if (bytes.length > 8192) throw new IllegalStateException("Invalid upload metadata");
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }
    private void save(String id, JSONObject record) throws Exception {
        AtomicFile target = new AtomicFile(file(id, ".json"));
        FileOutputStream output = target.startWrite();
        try { output.write(record.toString().getBytes(StandardCharsets.UTF_8)); target.finishWrite(output); }
        catch (Exception error) { target.failWrite(output); throw error; }
    }
    public Uri insert(Uri uri, ContentValues values) {
        requireOwner();
        if (!Uri.parse("content://" + AUTHORITY + "/files").equals(uri) || values == null || values.size() != 5) throw new IllegalArgumentException("Expected upload metadata");
        String id = values.getAsString("id"), mime = values.getAsString("mimeType"), name = values.getAsString("displayName"), sha = values.getAsString("sha256");
        Long size = values.getAsLong("size");
        Uri result = Uri.parse("content://" + AUTHORITY + "/files/" + id); token(result);
        if (mime == null || mime.length() > 127 || !mime.matches("[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*") || !validName(name) || sha == null || !sha.matches("[a-f0-9]{64}") || size == null || size < 0 || size > LIMIT) throw new IllegalArgumentException("Invalid upload metadata");
        synchronized (LOCK) {
            try {
                if (!file(id, ".json").createNewFile()) throw new IllegalStateException("Upload ID already exists");
                save(id, new JSONObject().put("id", id).put("state", "prepared").put("mimeType", mime).put("displayName", name).put("size", size).put("sha256", sha));
                return result;
            } catch (Exception error) { throw new IllegalStateException("Cannot prepare upload", error); }
        }
    }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String id = token(uri);
        synchronized (LOCK) {
            try {
                JSONObject record = load(id);
                if ("r".equals(mode)) {
                    if (!"ready".equals(record.getString("state"))) throw new IllegalStateException("Upload is not ready");
                    return ParcelFileDescriptor.open(file(id, ".bin"), ParcelFileDescriptor.MODE_READ_ONLY);
                }
                requireOwner();
                if (!"w".equals(mode) || !"prepared".equals(record.getString("state"))) throw new IllegalStateException("Upload write cannot be repeated");
                if (ACTIVE.size() >= 4) throw new IllegalStateException("Too many active uploads");
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createReliablePipe();
                try { record.put("state", "writing"); save(id, record); }
                catch (Exception error) { pipe[0].close(); pipe[1].close(); throw error; }
                ACTIVE.add(id);
                new Thread(() -> receive(id, record, pipe[0]), "appvanta-upload-" + id).start();
                return pipe[1];
            } catch (Exception error) { throw new FileNotFoundException(error.toString()); }
        }
    }
    private void receive(String id, JSONObject expected, ParcelFileDescriptor pipe) {
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(pipe); FileOutputStream output = new FileOutputStream(file(id, ".part"))) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long size = 0, declared = expected.getLong("size"); byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                size += count;
                if (size > declared || size > LIMIT) throw new IllegalStateException("Upload exceeds declared size");
                output.write(buffer, 0, count); digest.update(buffer, 0, count);
            }
            output.getFD().sync();
            StringBuilder hex = new StringBuilder(); for (byte value : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            if (size != declared || !hex.toString().equals(expected.getString("sha256"))) throw new IllegalStateException("Upload size or SHA-256 mismatch: received=" + size + ", sha256=" + hex);
            synchronized (LOCK) {
                JSONObject current = load(id);
                if (!"writing".equals(current.getString("state"))) throw new IllegalStateException("Upload was removed");
                if (!file(id, ".part").renameTo(file(id, ".bin"))) throw new IllegalStateException("Cannot commit upload bytes");
                current.put("state", "ready"); save(id, current);
            }
        } catch (Exception error) {
            synchronized (LOCK) {
                try {
                    JSONObject current = load(id);
                    if ("writing".equals(current.getString("state"))) { current.put("state", "rejected"); current.put("error", error.toString()); save(id, current); }
                } catch (Exception ignored) { error.addSuppressed(ignored); }
                file(id, ".part").delete();
            }
        } finally { synchronized (LOCK) { ACTIVE.remove(id); } }
    }
    public String getType(Uri uri) {
        synchronized (LOCK) { try { return load(token(uri)).getString("mimeType"); } catch (Exception error) { return null; } }
    }
    public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String order) {
        if (selection != null || arguments != null || order != null) throw new IllegalArgumentException("Query modifiers unsupported");
        synchronized (LOCK) {
            try {
                String[] columns = projection == null ? new String[] { "_display_name", "_size", "state", "sha256", "mimeType" } : projection;
                String id = token(uri);
                if (!file(id, ".json").exists() && !file(id, ".json.bak").exists()) return new MatrixCursor(columns);
                JSONObject record = load(id);
                Object[] row = new Object[columns.length];
                for (int i = 0; i < columns.length; i++) {
                    String key = columns[i];
                    if ("_display_name".equals(key)) row[i] = record.getString("displayName");
                    else if ("_size".equals(key)) row[i] = record.getLong("size");
                    else if ("state".equals(key) || "sha256".equals(key) || "mimeType".equals(key)) row[i] = record.getString(key);
                    else if ("error".equals(key)) row[i] = record.optString("error");
                    else throw new IllegalArgumentException("Unknown column");
                }
                MatrixCursor cursor = new MatrixCursor(columns); cursor.addRow(row);
                return cursor;
            } catch (Exception error) { throw new IllegalStateException("Cannot inspect upload", error); }
        }
    }
    public int delete(Uri uri, String selection, String[] arguments) {
        requireOwner();
        if (selection != null || arguments != null) throw new IllegalArgumentException("Delete modifiers unsupported");
        String id = token(uri);
        synchronized (LOCK) {
            try {
                if (ACTIVE.contains(id)) throw new IllegalStateException("Upload writer is active; close it before deleting");
                JSONObject record = load(id); record.put("state", "deleted"); save(id, record);
                getContext().revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                for (String suffix : new String[] { ".part", ".bin" }) { File target = file(id, suffix); if (target.exists() && !target.delete()) throw new IllegalStateException("Cannot remove upload bytes"); }
                return 1;
            } catch (Exception error) { throw new IllegalStateException("Cannot delete upload", error); }
        }
    }
    public int update(Uri uri, ContentValues values, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
}
