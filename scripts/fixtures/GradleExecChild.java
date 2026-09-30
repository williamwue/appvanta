import java.nio.file.Files;
import java.nio.file.Path;

public final class GradleExecChild {
    public static void main(String[] args) throws Exception {
        Files.writeString(Path.of(args[0]), "{\"pid\":" + ProcessHandle.current().pid() + ",\"phase\":\"executing\"}");
        Thread.sleep(60000);
    }
}
