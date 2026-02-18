#!/usr/bin/env node
/**
 * Dev launcher: kills any stale process on PORT before starting `nest start --watch`.
 * Prevents EADDRINUSE when turbo/pnpm doesn't cleanly propagate kill signals on Windows.
 */

const { execSync, spawn } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3001;

/**
 * Kills every process currently listening on a given port.
 * Works on Windows (netstat + taskkill) and Unix (lsof + kill).
 */
function killPort(port) {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const pids = [
        ...new Set(
          out
            .split('\n')
            .filter((l) => l.includes(`:${port}`) && l.includes('LISTENING'))
            .map((l) => l.trim().split(/\s+/).pop())
            .filter(Boolean),
        ),
      ];
      pids.forEach((pid) => {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`[dev] Killed stale process PID ${pid} on port ${port}`);
        } catch (_) {}
      });
    } else {
      // Unix: lsof returns PIDs listening on the port
      const pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      pids.forEach((pid) => {
        try {
          process.kill(Number(pid), 'SIGKILL');
          console.log(`[dev] Killed stale process PID ${pid} on port ${port}`);
        } catch (_) {}
      });
    }
  } catch (_) {
    // Port was already free — nothing to do
  }
}

/**
 * Kills stale API dev watchers that may survive Ctrl+C on Windows.
 * These zombie watchers can respawn src/main.ts and re-take port 3001.
 */
function killStaleApiWatchers() {
  if (os.platform() !== 'win32') return;
  try {
    const query =
      "name='node.exe' and CommandLine like '%heistDuel\\\\heistDuel\\\\apps\\\\api%' and (" +
      "CommandLine like '%ts-node-dev%src/main.ts%' or " +
      "CommandLine like '%tsx%watch src/main.ts%')";
    execSync(`wmic process where "${query}" call terminate`, { stdio: 'ignore' });
    console.log('[dev] Cleared stale API watcher processes');
  } catch (_) {
    // No stale watchers found (or WMIC unavailable)
  }
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch (_) {}
}

killStaleApiWatchers();
killPort(PORT);

// Start nest in watch mode, inheriting stdio so output appears normally.
// shell: true lets the OS resolve the correct nest binary/shim (nest.cmd on Windows).
const child = spawn('nest', ['start', '--watch'], {
  stdio: 'inherit',
  shell: true,
  // Run from the api workspace root (this script lives in apps/api/scripts/)
  cwd: require('path').resolve(__dirname, '..'),
});

child.on('exit', (code) => process.exit(code ?? 0));

// Forward termination signals so Ctrl+C kills nest cleanly
process.on('SIGTERM', () => killProcessTree(child.pid));
process.on('SIGINT', () => killProcessTree(child.pid));
