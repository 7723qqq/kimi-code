import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;

public class Benchmark {
    static final int ITERATIONS = 100;
    static final int WARMUP = 10;
    static String tmpDir;

    public static void main(String[] args) throws Exception {
        tmpDir = Files.createTempDirectory("kimi-java-bench-").toString();
        setup();

        System.out.printf("Benchmark: %d iterations, %d warmup%n", ITERATIONS, WARMUP);
        System.out.println("=".repeat(80));

        // Read
        System.out.println("\n--- Read ---");
        bench("readFile (small, 3 lines)", () -> readFile("edit_target.ts", 3));
        bench("readFile (large, 1000 lines)", () -> readFile("large.ts", 1000));
        bench("readFile (tail -100)", () -> readTail("large.ts", 100));

        // Write
        System.out.println("\n--- Write ---");
        bench("writeFile (overwrite, 100 bytes)", () -> writeFile("write_target.txt", "x".repeat(100), false));
        bench("writeFile (append, 50 bytes)", () -> writeFile("write_target.txt", "y".repeat(50), true));

        // Edit
        System.out.println("\n--- Edit ---");
        bench("editFile (single replace)", () -> editFile("edit_target.ts", "const x = 1", "const x = 2"));

        // Grep
        System.out.println("\n--- Grep ---");
        bench("grep (content, single file)", () -> grepFile("large.ts", "function", true));
        bench("grep (files_with_matches, dir)", () -> grepDir("glob_test", "file", false));
        bench("grep (count, single file)", () -> grepFile("large.ts", "Line", false));
        bench("grep (case insensitive)", () -> grepFile("large.ts", "function", true));

        // Glob
        System.out.println("\n--- Glob ---");
        bench("glob (*.ts, 50 files)", () -> glob("glob_test", "*.ts"));
        bench("glob (recursive **/*.ts)", () -> globRecursive(tmpDir, "*.ts"));

        // Bash
        System.out.println("\n--- Bash ---");
        bench("bash (echo)", () -> bash("echo hello"));
        bench("bash (pwd)", () -> bash("pwd"));

        // Cleanup
        deleteDir(new File(tmpDir));
        System.out.println("\n" + "=".repeat(80));
        System.out.println("Done.");
    }

    static void setup() throws Exception {
        // Large file
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 1000; i++) {
            sb.append("// Line ").append(i + 1).append(": function compute").append(i).append("() { return ").append(i).append(" * 2; }\n");
        }
        Files.writeString(Path.of(tmpDir, "large.ts"), sb.toString());

        // Edit target
        StringBuilder edit = new StringBuilder();
        for (int i = 0; i < 100; i++) edit.append("const x = 1;\n");
        Files.writeString(Path.of(tmpDir, "edit_target.ts"), edit.toString());

        // Glob test files
        Files.createDirectories(Path.of(tmpDir, "glob_test"));
        for (int i = 0; i < 50; i++) {
            Files.writeString(Path.of(tmpDir, "glob_test", "file_" + i + ".ts"), "// file " + i);
            Files.writeString(Path.of(tmpDir, "glob_test", "file_" + i + ".rs"), "// file " + i);
            Files.writeString(Path.of(tmpDir, "glob_test", "file_" + i + ".py"), "# file " + i);
        }

        Files.writeString(Path.of(tmpDir, "write_target.txt"), "initial");
    }

    // --- Operations ---

    static String readFile(String name, int maxLines) throws Exception {
        List<String> lines = Files.readAllLines(Path.of(tmpDir, name));
        StringBuilder sb = new StringBuilder();
        int count = Math.min(lines.size(), maxLines);
        for (int i = 0; i < count; i++) {
            sb.append(i + 1).append('\t').append(lines.get(i)).append('\n');
        }
        return sb.toString();
    }

    static String readTail(String name, int tailCount) throws Exception {
        List<String> lines = Files.readAllLines(Path.of(tmpDir, name));
        int start = Math.max(0, lines.size() - tailCount);
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < lines.size(); i++) {
            sb.append(i + 1).append('\t').append(lines.get(i)).append('\n');
        }
        return sb.toString();
    }

    static int writeFile(String name, String content, boolean append) throws Exception {
        Path p = Path.of(tmpDir, name);
        if (append) {
            Files.write(p, content.getBytes(), StandardOpenOption.APPEND);
        } else {
            Files.writeString(p, content);
        }
        return content.length();
    }

    static int editFile(String name, String oldStr, String newStr) throws Exception {
        Path p = Path.of(tmpDir, name);
        String content = Files.readString(p);
        int count = countOccurrences(content, oldStr);
        if (count == 1) {
            String newContent = content.replaceFirst(Pattern.quote(oldStr), newStr);
            Files.writeString(p, newContent);
        }
        return count;
    }

    static int grepFile(String name, String pattern, boolean caseInsensitive) throws Exception {
        Path p = Path.of(tmpDir, name);
        Pattern pat = Pattern.compile(pattern, caseInsensitive ? Pattern.CASE_INSENSITIVE : 0);
        int matches = 0;
        for (String line : Files.readAllLines(p)) {
            if (pat.matcher(line).find()) matches++;
        }
        return matches;
    }

    static int grepDir(String dirName, String pattern, boolean content) throws Exception {
        Path dir = Path.of(tmpDir, dirName);
        Pattern pat = Pattern.compile(pattern);
        int files = 0;
        try (var stream = Files.list(dir)) {
            for (Path p : stream.toList()) {
                if (Files.isRegularFile(p)) {
                    String text = Files.readString(p);
                    if (pat.matcher(text).find()) files++;
                }
            }
        }
        return files;
    }

    static List<String> glob(String dirName, String pattern) throws Exception {
        Path dir = Path.of(tmpDir, dirName);
        String globPattern = "glob:" + pattern;
        List<String> result = new ArrayList<>();
        try (var stream = Files.newDirectoryStream(dir, pattern)) {
            for (Path p : stream) {
                result.add(p.getFileName().toString());
            }
        }
        return result;
    }

    static List<String> globRecursive(String dir, String pattern) throws Exception {
        List<String> result = new ArrayList<>();
        try (var stream = Files.walk(Path.of(dir))) {
            for (Path p : stream.toList()) {
                if (Files.isRegularFile(p) && p.toString().endsWith(pattern.replace("*", ""))) {
                    result.add(p.getFileName().toString());
                }
            }
        }
        return result;
    }

    static String bash(String command) throws Exception {
        ProcessBuilder pb = new ProcessBuilder("cmd.exe", "/c", command);
        pb.directory(new File(tmpDir));
        Process p = pb.start();
        String stdout = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        p.waitFor();
        return stdout;
    }

    // --- Helpers ---

    static int countOccurrences(String text, String sub) {
        int count = 0;
        int idx = 0;
        while ((idx = text.indexOf(sub, idx)) != -1) {
            count++;
            idx += sub.length();
        }
        return count;
    }

    static void bench(String name, Callable fn) {
        // Warmup
        for (int i = 0; i < WARMUP; i++) {
            try { fn.call(); } catch (Exception e) { throw new RuntimeException(e); }
        }

        // Benchmark
        long[] times = new long[ITERATIONS];
        for (int i = 0; i < ITERATIONS; i++) {
            long start = System.nanoTime();
            try { fn.call(); } catch (Exception e) { throw new RuntimeException(e); }
            times[i] = System.nanoTime() - start;
        }

        Arrays.sort(times);
        long median = times[times.length / 2];
        long p95 = times[(int)(times.length * 0.95)];
        long min = times[0];

        System.out.printf("  %-40s median=%10s  p95=%10s  min=%10s%n",
            name, formatNs(median), formatNs(p95), formatNs(min));
    }

    static String formatNs(long ns) {
        if (ns < 1000) return ns + "ns";
        if (ns < 1_000_000) return String.format("%.1fμs", ns / 1000.0);
        return String.format("%.2fms", ns / 1_000_000.0);
    }

    static void deleteDir(File dir) {
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isDirectory()) deleteDir(f);
                else f.delete();
            }
        }
        dir.delete();
    }

    interface Callable {
        Object call() throws Exception;
    }
}
