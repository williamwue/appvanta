import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;

public final class BuildProcessIdentity {
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("pid expected-start-epoch-millis encoded-output-path");
        long pid = Long.parseLong(args[0]);
        long expected = Long.parseLong(args[1]);
        if (pid < 1 || expected < 1) throw new IllegalArgumentException("Positive process identity required");
        String state = "unknown";
        Long observed = null;
        try {
            var process = ProcessHandle.of(pid);
            if (process.isEmpty() || !process.get().isAlive()) state = "absent";
            else {
                var start = process.get().info().startInstant();
                if (start.isPresent()) {
                    observed = start.get().toEpochMilli();
                    state = observed == expected ? "matching" : "different";
                }
                if (!process.get().isAlive()) state = "absent";
            }
        } catch (SecurityException error) { state = "unknown"; }
        String json = "{\"version\":1,\"pid\":" + pid + ",\"expectedStartEpochMillis\":" + expected
            + ",\"observedStartEpochMillis\":" + observed + ",\"state\":\"" + state + "\"}";
        Path output = Path.of(new String(Base64.getDecoder().decode(args[2]), StandardCharsets.UTF_8));
        Files.writeString(output, json, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    }
}
