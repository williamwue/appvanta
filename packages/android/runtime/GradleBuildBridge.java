import java.io.File;
import java.io.DataInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import org.gradle.tooling.BuildCancelledException;
import org.gradle.tooling.CancellationTokenSource;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;

public final class GradleBuildBridge {
    private static String utf8(byte[] bytes) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }

    private static String[] request(String[] launch) throws Exception {
        if (launch.length != 2 || !launch[0].equals("--request-base64")) throw new IllegalArgumentException("Encoded request path required");
        Path path = Path.of(utf8(Base64.getDecoder().decode(launch[1])));
        if (Files.size(path) > 4 * 1024 * 1024) throw new IllegalArgumentException("Request exceeds 4 MiB");
        try (DataInputStream input = new DataInputStream(Files.newInputStream(path))) {
            if (input.readInt() != 0x41564731) throw new IllegalArgumentException("Unsupported request version");
            int count = input.readInt();
            if (count < 6 || count > 1285) throw new IllegalArgumentException("Invalid request field count");
            String[] values = new String[count];
            long total = 8;
            for (int i = 0; i < count; i++) {
                int length = input.readInt(); total += 4L + length;
                if (length < 0 || length > 1024 * 1024 || total > 4 * 1024 * 1024) throw new IllegalArgumentException("Invalid request field size");
                byte[] bytes = new byte[length]; input.readFully(bytes); values[i] = utf8(bytes);
                if (values[i].indexOf(0) >= 0) throw new IllegalArgumentException("Invalid request string");
            }
            if (input.read() != -1) throw new IllegalArgumentException("Trailing request bytes");
            return values;
        }
    }

    public static void main(String[] args) throws Exception {
        args = request(args);
        if (args.length < 6) throw new IllegalArgumentException("installation project user-home receipt task-count tasks... arguments...");
        int taskCount = Integer.parseInt(args[4]);
        if (taskCount < 1 || taskCount > 256 || taskCount > args.length - 5 || args.length - 5 - taskCount > 1024) throw new IllegalArgumentException("Invalid task or argument count");
        for (int i = 0; i < 4; i++) if (!Path.of(args[i]).isAbsolute()) throw new IllegalArgumentException("Absolute request paths required");
        String[] tasks = Arrays.copyOfRange(args, 5, 5 + taskCount);
        for (String task : tasks) if (task.isBlank() || task.startsWith("-")) throw new IllegalArgumentException("Invalid task name");
        String[] arguments = Arrays.copyOfRange(args, 5 + taskCount, args.length);
        Path receipt = Path.of(args[3]);
        if (Files.exists(receipt)) throw new IllegalArgumentException("Receipt already exists");
        String invocation = UUID.randomUUID().toString();
        Path daemonRecords = Path.of(args[3] + ".daemons").toAbsolutePath();
        Files.createDirectory(daemonRecords);
        Path initScript = Path.of(args[3] + ".init.gradle").toAbsolutePath();
        String recordsEncoded = Base64.getEncoder().encodeToString(daemonRecords.toString().getBytes(StandardCharsets.UTF_8));
        String homeEncoded = Base64.getEncoder().encodeToString(new File(args[2]).getCanonicalPath().getBytes(StandardCharsets.UTF_8));
        String script = "def records = new File(new String(java.util.Base64.decoder.decode('" + recordsEncoded + "'), 'UTF-8'))\n"
            + "def expectedHome = new File(new String(java.util.Base64.decoder.decode('" + homeEncoded + "'), 'UTF-8')).canonicalFile\n"
            + "if (gradle.gradleUserHomeDir.canonicalFile != expectedHome) throw new GradleException('Managed Gradle user home mismatch')\n"
            + "def process = ProcessHandle.current()\n"
            + "def record = [version: 1, invocation: '" + invocation + "', pid: process.pid(), startEpochMillis: process.info().startInstant().map { it.toEpochMilli() }.orElse(null), userHome: gradle.gradleUserHomeDir.canonicalPath]\n"
            + "def target = new File(records, process.pid().toString() + '.json').toPath()\n"
            + "def bytes = groovy.json.JsonOutput.toJson(record).getBytes('UTF-8')\n"
            + "try {\n"
            + "  def channel = java.nio.channels.FileChannel.open(target, java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)\n"
            + "  try { def buffer = java.nio.ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true) } finally { channel.close() }\n"
            + "} catch (java.nio.file.FileAlreadyExistsException existing) {\n"
            + "  if (new groovy.json.JsonSlurper().parse(target.toFile(), 'UTF-8') != record) throw new GradleException('Managed Gradle daemon identity changed')\n"
            + "}\n";
        Files.writeString(initScript, script, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        String[] managedArguments = Arrays.copyOf(arguments, arguments.length + 2);
        managedArguments[arguments.length] = "--init-script";
        managedArguments[arguments.length + 1] = initScript.toString();
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
            connection.newBuild().forTasks(tasks).withArguments(managedArguments)
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
        String json = "{\"version\":1,\"invocation\":\"" + invocation + "\",\"status\":\"" + status + "\",\"failureClass\":\"" + failure
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
