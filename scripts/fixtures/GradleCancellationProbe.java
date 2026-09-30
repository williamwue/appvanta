import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import org.gradle.tooling.BuildCancelledException;
import org.gradle.tooling.CancellationTokenSource;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;

public final class GradleCancellationProbe {
    public static void main(String[] args) throws Exception {
        if (args.length != 5) throw new IllegalArgumentException("installation project user-home receipt task");
        CancellationTokenSource cancellation = GradleConnector.newCancellationTokenSource();
        Thread owner = new Thread(() -> {
            try { while (System.in.read() != -1) { } }
            catch (java.io.IOException error) { }
            cancellation.cancel();
        }, "owner-pipe");
        owner.setDaemon(true);
        owner.start();
        String status = "passed";
        String failure = "";
        try (ProjectConnection connection = GradleConnector.newConnector()
                .useInstallation(new File(args[0]))
                .forProjectDirectory(new File(args[1]))
                .useGradleUserHomeDir(new File(args[2])).connect()) {
            connection.newBuild().forTasks(args[4])
                .withArguments("--offline", "--console=plain", "--max-workers=1")
                .withCancellationToken(cancellation.token())
                .setStandardOutput(System.out).setStandardError(System.err).run();
        } catch (BuildCancelledException error) {
            status = "cancelled";
            failure = error.getClass().getName();
        } catch (Exception error) {
            status = "failed";
            failure = error.getClass().getName();
            error.printStackTrace(System.err);
        }
        Files.writeString(Path.of(args[3]), "{\"status\":\"" + status + "\",\"failureClass\":\"" + failure
            + "\",\"cancellationRequested\":" + cancellation.token().isCancellationRequested() + "}");
    }
}
