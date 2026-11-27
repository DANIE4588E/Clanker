package expo.modules.clankershell

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Output past this is dropped (the stream is still drained so the process never blocks on a full pipe).
private const val MAX_OUTPUT_BYTES = 256 * 1024

private class Capture(stream: InputStream) {
  private val buffer = java.io.ByteArrayOutputStream()
  var truncated = false
    private set
  val reader: Thread = thread(isDaemon = true) {
    val chunk = ByteArray(8192)
    stream.use {
      while (true) {
        val n = it.read(chunk)
        if (n < 0) break
        synchronized(buffer) {
          val room = MAX_OUTPUT_BYTES - buffer.size()
          if (room > 0) buffer.write(chunk, 0, minOf(n, room))
          if (n > room) truncated = true
        }
      }
    }
  }

  fun text(): String = synchronized(buffer) { buffer.toString(Charsets.UTF_8.name()) }
}

// Set in each command's environment so everything it starts can be found again, including
// background jobs that outlive their parent (`cmd &`, `nohup`) and get reparented to init.
private const val RUN_MARKER = "CLANKER_SHELL_RUN"
// Linux signal numbers (the same on arm, arm64, x86 and x86_64).
private const val SIGSTOP = 19

private class Run(val process: Process, val token: String)

/** The parent pid from /proc/<pid>/stat, whose second field (the name) may hold spaces or parens. */
private fun parentOf(pid: Int): Int? {
  val stat = File("/proc/$pid/stat").readText()
  val fields = stat.substring(stat.lastIndexOf(')') + 2).split(' ')
  return fields.getOrNull(1)?.toIntOrNull()
}

/** Whether /proc/<pid>/environ holds `needle` as a whole entry. Only the app's own processes are readable. */
private fun hasEntry(pid: Int, needle: ByteArray): Boolean {
  val env = File("/proc/$pid/environ").readBytes()
  var at = 0
  while (at + needle.size <= env.size) {
    var match = true
    for (i in needle.indices) {
      if (env[at + i] != needle[i]) {
        match = false
        break
      }
    }
    if (match && (at + needle.size == env.size || env[at + needle.size] == 0.toByte())) return true
    val end = (at until env.size).firstOrNull { env[it] == 0.toByte() } ?: return false
    at = end + 1
  }
  return false
}

/**
 * SIGKILLs every process a command started: those carrying its marker and all their descendants
 * (which catches children that cleared their environment). Each pass stops the whole set before
 * killing it so nothing forks in between; a few passes catch anything started mid-scan. The app
 * can signal these because they run as its own uid; no root needed.
 */
private fun killTree(token: String) {
  val me = android.os.Process.myPid()
  val needle = "$RUN_MARKER=$token".toByteArray()
  repeat(3) {
    val pids = File("/proc").list()?.mapNotNull { it.toIntOrNull() } ?: return
    val parents = HashMap<Int, Int>()
    val doomed = HashSet<Int>()
    for (pid in pids) {
      if (pid == me) continue
      val parent = runCatching { parentOf(pid) }.getOrNull() ?: continue
      parents[pid] = parent
      if (runCatching { hasEntry(pid, needle) }.getOrDefault(false)) doomed.add(pid)
    }
    var grew = doomed.isNotEmpty()
    while (grew) {
      grew = false
      for ((pid, parent) in parents) if (parent in doomed && doomed.add(pid)) grew = true
    }
    doomed.remove(me)
    if (doomed.isEmpty()) return
    doomed.forEach { android.os.Process.sendSignal(it, SIGSTOP) }
    doomed.forEach { android.os.Process.sendSignal(it, android.os.Process.SIGNAL_KILL) }
  }
}

class ClankerShellModule : Module() {
  private val running = ConcurrentHashMap<String, Run>()

  override fun definition() = ModuleDefinition {
    Name("ClankerShell")

    /**
     * Runs `command` with /system/bin/sh in `cwd` (a plain filesystem path). Resolves with
     * stdout, stderr, the exit code (-1 when killed) and whether the timeout fired.
     */
    AsyncFunction("exec") Coroutine { id: String, command: String, cwd: String, timeoutMs: Long, env: Map<String, String> ->
      withContext(Dispatchers.IO) {
        val token = UUID.randomUUID().toString()
        val builder = ProcessBuilder("/system/bin/sh", "-c", command).directory(File(cwd))
        builder.environment().putAll(env)
        builder.environment()[RUN_MARKER] = token
        val process = builder.start()
        running[id] = Run(process, token)
        process.outputStream.close()
        val out = Capture(process.inputStream)
        val err = Capture(process.errorStream)
        val finished = try {
          process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
          running.remove(id)
        }
        if (!finished) {
          // Background jobs would otherwise outlive the shell and keep its output pipes open.
          killTree(token)
          process.destroyForcibly()
        }
        out.reader.join(2000)
        err.reader.join(2000)
        mapOf(
          "stdout" to out.text(),
          "stderr" to err.text(),
          "exitCode" to if (finished) process.exitValue() else -1,
          "timedOut" to !finished,
          "truncated" to (out.truncated || err.truncated),
        )
      }
    }

    /** Kills a command started by `exec`; its `exec` call then resolves with exit code -1 or the signal's code. */
    Function("kill") { id: String ->
      val run = running.remove(id) ?: return@Function Unit
      // Scanning /proc takes a moment; keep it off the JS thread.
      thread(isDaemon = true) {
        killTree(run.token)
        run.process.destroyForcibly()
      }
      Unit
    }
  }
}
