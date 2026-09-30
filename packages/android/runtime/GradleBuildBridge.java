import java.io.File;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import org.gradle.tooling.BuildCancelledException;
import org.gradle.tooling.CancellationTokenSource;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;

public final class GradleBuildBridge {
    public static void main(String[] args) throws Exception {
        if (args.length < 6) throw new IllegalArgumentException("installation project user-home receipt task-count tasks... arguments...");
        int taskCount = Integer.parseInt(args[4]);
        if (taskCount < 1 || taskCount > args.length - 5) throw new IllegalArgumentException("Invalid task count");
        String[] tasks = Arrays.copyOfRange(args, 5, 5 + taskCount);
        for (String task : tasks) if (task.isBlank() || task.startsWith("-")) throw new IllegalArgumentException("Invalid task name");
        String[] arguments = Arrays.copyOfRange(args, 5 + taskCount, args.length);
        Path receipt = Path.of(args[3]);
        if (Files.exists(receipt)) throw new IllegalArgumentException("Receipt already exists");
        long started = System.nanoTime();
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
            connection.newBuild().forTasks(tasks).withArguments(arguments)
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
        String json = "{\"version\":1,\"status\":\"" + status + "\",\"failureClass\":\"" + failure
            + "\",\"cancellationRequested\":" + cancellation.token().isCancellationRequested()
            + ",\"bridgePid\":" + ProcessHandle.current().pid() + ",\"taskCount\":" + tasks.length
            + ",\"elapsedMs\":" + (System.nanoTime() - started) / 1000000 + "}";
        try (FileChannel file = FileChannel.open(receipt, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer bytes = StandardCharsets.UTF_8.encode(json);
            while (bytes.hasRemaining()) file.write(bytes);
            file.force(true);
        }
    }
}
