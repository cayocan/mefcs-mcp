/**
 * Thin client for mefcs_ks_bridge.exe, the Kernel Streaming MIDI helper that ships with M-EFCS.
 *
 * IPC (text over stdio):
 *   bridge list                      -> "device <id> <in> <out>" lines, then "done"
 *   bridge open-raw <id> <in> <out>  -> "ready"
 *   stdin  "send <seq> <hex>\n"      -> stdout "sent <seq>"
 *   device traffic                   -> stdout "data <hex>" (SysEx may be split across lines)
 *   stdin  "quit\n"                  -> exits
 *
 * Only one process can own the device, so M-EFCS must be closed while this runs.
 */
import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { toHex, fromHex } from "./framing.js";

export interface BridgeDevice {
  id: string;
  input: string;
  output: string;
}

export function listDevices(bridgePath: string, timeoutMs = 10000): Promise<BridgeDevice[]> {
  return new Promise((resolve, reject) => {
    execFile(bridgePath, ["list"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const devices: BridgeDevice[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^device\s+(\S+)\s+(\S+)\s+(\S+)/);
        if (m) devices.push({ id: m[1], input: m[2], output: m[3] });
      }
      resolve(devices);
    });
  });
}

export class BridgeSession extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private lineBuf = "";
  private sysexBuf = "";
  private seq = 0;
  private pendingSent = new Map<number, () => void>();

  constructor(private readonly bridgePath: string) {
    super();
  }

  open(dev: BridgeDevice, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.bridgePath, ["open-raw", dev.id, dev.input, dev.output], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error("Bridge did not report 'ready' in time")), timeoutMs);
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("exit", (code) => {
        this.emit("closed", code);
        this.proc = undefined;
      });
      proc.stderr.on("data", (d: Buffer) => this.emit("stderr", d.toString()));
      proc.stdout.on("data", (d: Buffer) => {
        this.lineBuf += d.toString("ascii");
        let idx: number;
        while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
          const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
          this.lineBuf = this.lineBuf.slice(idx + 1);
          if (line === "ready") {
            clearTimeout(timer);
            resolve();
          } else this.handleLine(line);
        }
      });
    });
  }

  private handleLine(line: string) {
    if (line.startsWith("sent ")) {
      const n = Number(line.slice(5).trim());
      const done = this.pendingSent.get(n);
      if (done) {
        this.pendingSent.delete(n);
        done();
      }
      return;
    }
    if (line.startsWith("data ")) {
      this.sysexBuf += line.slice(5).trim().toLowerCase();
      // Emit every complete SysEx message (ends with F7 on a byte boundary).
      for (;;) {
        let end = -1;
        for (let i = 0; i + 1 < this.sysexBuf.length; i += 2) {
          if (this.sysexBuf.slice(i, i + 2) === "f7") {
            end = i + 2;
            break;
          }
        }
        if (end < 0) break;
        const hex = this.sysexBuf.slice(0, end);
        this.sysexBuf = this.sysexBuf.slice(end);
        this.emit("sysex", fromHex(hex));
      }
      return;
    }
    if (line.trim()) this.emit("info", line);
  }

  /** Send one SysEx message; resolves when the bridge confirms it was submitted. */
  send(msg: Uint8Array, timeoutMs = 5000): Promise<void> {
    if (!this.proc) return Promise.reject(new Error("Bridge session is not open"));
    const n = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSent.delete(n);
        reject(new Error(`Bridge did not confirm send ${n}`));
      }, timeoutMs);
      this.pendingSent.set(n, () => {
        clearTimeout(timer);
        resolve();
      });
      this.proc!.stdin.write(`send ${n} ${toHex(msg)}\n`);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const p = this.proc;
      const timer = setTimeout(() => {
        p.kill();
        resolve();
      }, 2000);
      p.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      p.stdin.write("quit\n");
      p.stdin.end();
    });
  }

  get isOpen() {
    return !!this.proc;
  }
}
