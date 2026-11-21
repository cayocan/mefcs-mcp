/**
 * Open a URL in the user's default browser (the MCP server runs on the user's machine).
 * Only https URLs on allow-listed hosts are opened.
 */
import { spawn } from "node:child_process";

const ALLOWED_HOSTS = new Set(["www.tone3000.com", "tone3000.com"]);

export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Returns true when a browser launch was attempted. */
export function openUrl(url: string): boolean {
  if (!isAllowedUrl(url)) return false;
  if (process.env.MEFCS_NO_BROWSER === "1") return false;
  try {
    const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
    const child =
      process.platform === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], opts) // no shell parsing of '&'
        : process.platform === "darwin"
          ? spawn("open", [url], opts)
          : spawn("xdg-open", [url], opts);
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
