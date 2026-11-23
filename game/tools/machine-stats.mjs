// CPU % and memory % of the machine that runs the model, sampled every `everyMs` — for tools/effect-gen.mjs's status line.
//   local:  this Linux box (/proc/stat, /proc/meminfo, /proc/<pid> of llama-server)
//   remote: the same files read over the user's own SSH (one long-lived `ssh` running a sampling loop; BatchMode, so it
//           never prompts) — the model's HTTP API does not expose them, and nothing new is opened on the server.
// latest() → { cpu, mem, memUsedGb, memTotalGb, servers: [{ port, cpu, rssGb }] } | null (no sample yet / unavailable).
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

// One sample = these lines, then "---": "cpu …" (first line of /proc/stat), "MemTotal: … kB", "MemAvailable: … kB",
// "P <port> <utime+stime ticks> <rss kB>" per llama-server, "T <ticks per second>".
const SAMPLE_SH = 'T=$(getconf CLK_TCK); while :; do head -1 /proc/stat; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; '
  + 'for p in $(pgrep -x llama-server); do port=$(tr "\\0" " " < /proc/$p/cmdline | grep -oE -- "--port [0-9]+" | grep -oE "[0-9]+"); '
  + 'echo "P ${port:-?} $(awk \'{print $14+$15}\' /proc/$p/stat) $(awk \'/VmRSS/{print $2}\' /proc/$p/status)"; done; echo "T $T"; echo ---; sleep "${EVERY:-5}"; done';

export function parseSample(lines) {
  const o = { cpuLine: null, memTotal: 0, memAvail: 0, procs: [], hz: 100 };
  for (const l of lines) {
    if (l.startsWith('cpu ')) o.cpuLine = l.trim().split(/\s+/).slice(1).map(Number);
    else if (l.startsWith('MemTotal:')) o.memTotal = Number(l.split(/\s+/)[1]);
    else if (l.startsWith('MemAvailable:')) o.memAvail = Number(l.split(/\s+/)[1]);
    else if (l.startsWith('P ')) { const [, port, ticks, rss] = l.split(/\s+/); o.procs.push({ port, ticks: Number(ticks), rss: Number(rss) }); }
    else if (l.startsWith('T ')) o.hz = Number(l.split(/\s+/)[1]) || 100;
  }
  return o;
}
// Two consecutive samples → percentages. CPU % over all cores (100 = every core busy); per server: % of one core (400 = 4 cores).
export function diffSamples(a, b, dtMs) {
  if (!a?.cpuLine || !b?.cpuLine) return null;
  const sum = (v) => v.reduce((x, y) => x + y, 0);
  const idle = (v) => (v[3] || 0) + (v[4] || 0);
  const dt = sum(b.cpuLine) - sum(a.cpuLine), di = idle(b.cpuLine) - idle(a.cpuLine);
  const cpu = dt > 0 ? Math.round(100 * (1 - di / dt)) : 0;
  const memUsed = b.memTotal - b.memAvail;
  const servers = b.procs.map(p => {
    const q = a.procs.find(x => x.port === p.port);
    return { port: p.port, cpu: q ? Math.round(100 * ((p.ticks - q.ticks) / b.hz) / (dtMs / 1000)) : null, rssGb: Math.round(p.rss / 1048576 * 10) / 10 };
  });
  return { cpu, mem: b.memTotal ? Math.round(100 * memUsed / b.memTotal) : 0, memUsedGb: Math.round(memUsed / 1048576 * 10) / 10, memTotalGb: Math.round(b.memTotal / 1048576 * 10) / 10, servers };
}

export function startStats({ ssh = '', sshKey = '', everyMs = 5000 } = {}) {
  let prev = null, prevAt = 0, last = null, err = '', child = null, timer = null;
  const take = (lines) => {
    const s = parseSample(lines), now = Date.now();
    if (prev) last = diffSamples(prev, s, now - prevAt) || last;
    prev = s; prevAt = now;
  };
  if (ssh) {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', ...(sshKey ? ['-i', sshKey, '-o', 'IdentitiesOnly=yes'] : []), ssh, `EVERY=${Math.max(1, Math.round(everyMs / 1000))} bash -c '${SAMPLE_SH.replace(/'/g, "'\\''")}'`];
    child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = [], tail = '';
    child.stdout.on('data', (d) => {
      const parts = (tail + d).split('\n'); tail = parts.pop();
      for (const l of parts) { if (l === '---') { take(buf); buf = []; } else buf.push(l); }
    });
    child.stderr.on('data', (d) => { err = String(d).trim().split('\n').pop().slice(0, 120); });
    child.on('exit', (c) => { if (c && !err) err = `ssh exited ${c}`; child = null; });
  } else if (os.platform() === 'linux') {
    const sample = () => {
      try {
        const lines = [fs.readFileSync('/proc/stat', 'utf8').split('\n')[0], ...fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(l => /^(MemTotal|MemAvailable):/.test(l))];
        for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
          try {
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
            if (!cmd.split('\0')[0].endsWith('llama-server')) continue;
            const port = (cmd.split('\0').join(' ').match(/--port (\d+)/) || [])[1] || '?';
            const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
            const rss = (fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1] || 0;
            lines.push(`P ${port} ${Number(st[11]) + Number(st[12])} ${rss}`);
          } catch { /* process gone */ }
        }
        lines.push('T 100');
        take(lines);
      } catch (e) { err = e.message; }
    };
    sample();
    timer = setInterval(sample, everyMs); timer.unref?.();
  } else err = 'machine stats need Linux or --ssh';
  return {
    latest: () => last,
    error: () => err,
    stop: () => { if (timer) clearInterval(timer); if (child) child.kill(); },
  };
}
