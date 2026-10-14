'use strict';

const cp = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const COMMAND_TIMEOUT_MS = 10000;
const MAX_ANCESTORS = 64;
/** Process and connection tables are reused this long; a lookup burst from one agent pays once. */
const SNAPSHOT_TTL_MS = 2000;

function run(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/**
 * One value, recomputed by `load` at most once per TTL; concurrent callers share the load in flight.
 * `get(true)` reloads at once, for a lookup that misses in a snapshot taken before its process started.
 */
function cached(load, ttlMs) {
  let value;
  let loadedAt = -Infinity;
  let inFlight;
  return (refresh = false) => {
    if (!refresh && Date.now() - loadedAt < ttlMs) {
      return Promise.resolve(value);
    }
    inFlight ??= load()
      .then((loaded) => {
        value = loaded;
        loadedAt = Date.now();
        return loaded;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** The entry of `key` in a cached table, reloading the table once when a snapshot does not have it. */
async function lookup(table, key) {
  return (await table()).get(key) ?? (await table(true)).get(key);
}

function parseTable(output) {
  return new Map(
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid]) => Number.isInteger(pid))
      .map(([pid, ppid, started]) => [pid, { ppid, started }]),
  );
}

/** Seconds of a `ps` etime value, `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(etime = '0') {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  return Number(days) * 86400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

async function linuxProcessTable() {
  const table = new Map();
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
    // The command name in parentheses may contain spaces; the fields after it are fixed.
    const fields = stat?.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields) {
      table.set(Number(name), { ppid: Number(fields[1]), started: Number(fields[19]) });
    }
  }
  return table;
}

/**
 * Parent and start time of every process, keyed by pid: `{ ppid, started }`, where `started` orders a
 * child after its parent, so a parent pid reused by a newer process is not taken for the parent.
 * @returns {Promise<Map<number, { ppid: number, started: number }>>}
 */
const processTable = cached(async () => {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }';
    return parseTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  if (process.platform === 'linux') {
    return linuxProcessTable();
  }
  // macOS: elapsed seconds; a larger value means an earlier start.
  const output = await run('ps', ['-axo', 'pid=,ppid=,etime=']);
  return new Map(
    output
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .map(([pid, ppid, etime]) => [Number(pid), { ppid: Number(ppid), started: -elapsedSeconds(etime) }]),
  );
}, SNAPSHOT_TTL_MS);

/** `pid` and its ancestors, nearest first, stopping where a recorded parent started after its child. */
async function ancestorsOf(pid) {
  const table = (await processTable()).has(pid) ? await processTable() : await processTable(true);
  const chain = [pid];
  let current = pid;
  while (chain.length < MAX_ANCESTORS) {
    const entry = table.get(current);
    const parent = entry && table.get(entry.ppid);
    if (!entry || !entry.ppid || !parent || parent.started > entry.started) {
      break;
    }
    chain.push(entry.ppid);
    current = entry.ppid;
  }
  return chain;
}

/** Established local TCP connections as `Map<"clientPort>serverPort", pid>`, from the platform's tools. */
const connectionTable = cached(async () => {
  const table = new Map();
  if (process.platform === 'win32') {
    for (const line of (await run('netstat.exe', ['-ano', '-p', 'TCP'])).split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/.exec(line);
      if (match) {
        table.set(`${match[1]}>${match[2]}`, Number(match[3]));
      }
    }
    return table;
  }
  if (process.platform === 'linux') {
    return linuxConnectionTable();
  }
  let pid;
  for (const line of (await run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']).catch(() => '')).split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n')) {
      const match = /:(\d+)->[^:]+:(\d+)$/.exec(line);
      if (match) {
        table.set(`${match[1]}>${match[2]}`, pid);
      }
    }
  }
  return table;
}, SNAPSHOT_TTL_MS);

/** Linux: socket inodes from /proc/net/tcp, then the processes of this user holding them. */
async function linuxConnectionTable() {
  const inodes = new Map();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').slice(1)) {
      const [, local, remote, , , , , , , inode] = line.trim().split(/\s+/);
      if (local && remote && inode && inode !== '0') {
        inodes.set(`socket:[${inode}]`, `${parseInt(local.split(':')[1], 16)}>${parseInt(remote.split(':')[1], 16)}`);
      }
    }
  }
  const table = new Map();
  const uid = process.getuid?.();
  const names = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  await Promise.all(
    names.map(async (name) => {
      const owner = await fs.stat(`/proc/${name}`).catch(() => undefined);
      if (!owner || (uid !== undefined && owner.uid !== uid)) {
        return;
      }
      const descriptors = await fs.readdir(`/proc/${name}/fd`).catch(() => []);
      const targets = await Promise.all(descriptors.map((descriptor) => fs.readlink(path.join('/proc', name, 'fd', descriptor)).catch(() => '')));
      for (const target of targets) {
        const key = inodes.get(target);
        if (key) {
          table.set(key, Number(name));
        }
      }
    }),
  );
  return table;
}

/** Pid of the process whose local TCP port `clientPort` is connected to `serverPort` on this machine, or undefined. */
function ownerOfConnection(clientPort, serverPort) {
  return lookup(connectionTable, `${clientPort}>${serverPort}`);
}

module.exports = { ancestorsOf, ownerOfConnection, elapsedSeconds };
