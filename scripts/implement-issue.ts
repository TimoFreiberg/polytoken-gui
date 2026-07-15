#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "TimoFreiberg/pantoken";
export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(SCRIPT_DIR, "seed-prompt.md");

export type IssueReference = { number: number; url: string; input: string };
export type Issue = { title: string; body: string };
export type Screenshot = { sourceUrl: string; localPath?: string; mediaType?: string; status: "downloaded" | "failed"; warning?: string };
export type CommandResult = { code: number; stdout: string; stderr: string; signal?: string };
export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<CommandResult>;
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;
export type DaemonConnection = { sessionId: string; port: number; token: string; baseUrl: string };

const usage = "Usage: implement-issue.ts [--dry-run] <issue-url-or-number>";
export function parseIssueReference(args: string[], repository = REPOSITORY): IssueReference {
  if (args.includes("-h") || args.includes("--help")) throw new Error(usage);
  const dryArgs = args.filter((arg) => arg !== "--dry-run");
  if (dryArgs.length !== 1 || args.filter((arg) => arg === "--dry-run").length > 1) throw new Error(`${usage}\nExactly one issue reference is required.`);
  const input = dryArgs[0]!;
  let numberText = input;
  if (input.startsWith("#")) numberText = input.slice(1);
  else if (input.startsWith("http://") || input.startsWith("https://")) {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error(`Invalid issue URL: ${input}`); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash || url.pathname.split("/").length !== 5 || url.pathname.split("/")[1] !== repository.split("/")[0] || url.pathname.split("/")[2] !== repository.split("/")[1] || url.pathname.split("/")[3] !== "issues") throw new Error(`Issue URL must be https://github.com/${repository}/issues/<number>`);
    numberText = url.pathname.split("/")[4]!;
  }
  if (!/^[1-9][0-9]*$/.test(numberText) || Number(numberText) > 2 ** 31 - 1) throw new Error(`Invalid issue reference: ${input}`);
  const number = Number(numberText);
  return { number, input, url: `https://github.com/${repository}/issues/${number}` };
}

export function extractImageUrls(body: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => { try { const url = new URL(raw.trim().replace(/^<|>$/g, "")); if (["http:", "https:"].includes(url.protocol) && !found.includes(url.href)) found.push(url.href); } catch { /* invalid references are intentionally ignored */ } };
  for (const match of body.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g)) add(match[1] ?? match[2]!);
  for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1]!);
  return found;
}

export function imageExtension(url: string, contentType?: string): string {
  const type = contentType?.split(";", 1)[0]?.toLowerCase();
  const byType: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
  if (type && byType[type]) return byType[type]!;
  try { const ext = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase(); if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext ?? "")) return ext === "jpeg" ? "jpg" : ext!; } catch { /* fall through */ }
  return "bin";
}

export function renderPrompt(template: string, issue: IssueReference & Issue, screenshots: Screenshot[], dryRun = false): string {
  const list = screenshots.filter((s) => s.status === "downloaded").map((s) => `- ${s.localPath} (read with file_read to view this screenshot)`).join("\n") || "(no screenshots in this issue)";
  const sourceList = screenshots.map((s) => `- ${s.sourceUrl}`).join("\n") || "(no image references)";
  return template.replaceAll("{{ISSUE_NUMBER}}", String(issue.number)).replaceAll("{{ISSUE_URL}}", issue.url).replaceAll("{{ISSUE_TITLE}}", issue.title).replaceAll("{{ISSUE_BODY}}", issue.body).replaceAll("{{ISSUE_IMAGES}}", dryRun ? `${sourceList}\n\n(Normal mode will download these under its owned context directory.)` : list);
}

export function parseDaemonOutput(output: string, structured?: { session_id?: string; port?: number }): { sessionId: string; port: number } {
  const sessionId = structured?.session_id ?? output.match(/(?:^|\s)session_id=([^\s]+)/)?.[1];
  const portText = structured?.port ?? output.match(/(?:^|\s)port=([^\s]+)/)?.[1];
  if (!sessionId || !/^[^\s]+$/.test(String(sessionId))) throw new Error(`polytoken did not report a valid session_id (output: ${output.slice(0, 500)})`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("polytoken did not report a valid port");
  return { sessionId: String(sessionId), port };
}

export function plannedCommands(issue: IssueReference, repoRoot: string): string[][] {
  const ws = resolve(repoRoot, "..", `pantoken-issue-${issue.number}`);
  return [["jj", "workspace", "add", ws, "--name", `issue-${issue.number}`], ["bun", "install"], ["polytoken", "new", "--no-attach"], ["zellij", "action", "new-tab", "--block-until-exit", "--cwd", ws, "--", "polytoken", "attach", "<session_id>"]];
}

export const bunCommandRunner: CommandRunner = async (command, args, options = {}) => {
  const proc = Bun.spawn([command, ...args], { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env, stdout: "pipe", stderr: "pipe" });
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};

async function command(runner: CommandRunner, name: string, args: string[], options?: Parameters<CommandRunner>[2]): Promise<CommandResult> { const result = await runner(name, args, options); if (result.code !== 0) throw new Error(`${name} ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`); return result; }
async function claimCommand(runner: CommandRunner, functionName: string, issueNumber: number, extra?: string): Promise<void> {
  await command(runner, "bash", ["-c", `source "$1"; init_claims; ${functionName} "$2" "$3"`, "claims", join(SCRIPT_DIR, "claims.sh"), String(issueNumber), extra ?? ""]);
}
export async function waitForDaemonReady(startupPath: string, timeoutMs = 15_000, read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { const value = JSON.parse(await read(startupPath)) as Record<string, unknown>; if (value.state === "ready") return value; } catch { /* startup file may not exist yet */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`daemon was not ready after ${timeoutMs}ms`);
}

async function daemonRequest(connection: DaemonConnection, path: string, init: RequestInit = {}, http: HttpClient = fetch): Promise<unknown> {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${connection.token}`); if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await http(`${connection.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Daemon ${init.method ?? "GET"} ${path} failed with HTTP ${response.status} (Authorization: Bearer ***)`);
  return response.status === 204 ? undefined : response.json();
}

export async function fetchIssue(issue: IssueReference, runner: CommandRunner = bunCommandRunner): Promise<Issue> {
  const result = await command(runner, "gh", ["issue", "view", String(issue.number), "--repo", REPOSITORY, "--json", "title,body"]);
  let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error("gh returned malformed issue JSON"); }
  if (!value || typeof value !== "object" || typeof (value as any).title !== "string" || typeof (value as any).body !== "string") throw new Error("gh issue data lacks a string title or body");
  return value as Issue;
}

export async function downloadScreenshots(urls: string[], directory: string, http: HttpClient = fetch, maxBytes = 10 * 1024 * 1024): Promise<Screenshot[]> {
  const result: Screenshot[] = [];
  for (const [index, sourceUrl] of urls.entries()) { try { const response = await http(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) }); const type = response.headers.get("content-type") ?? ""; const length = Number(response.headers.get("content-length") ?? 0); if (!response.ok) throw new Error(`HTTP ${response.status}`); if (!type.toLowerCase().startsWith("image/")) throw new Error(`content type ${type || "unknown"} is not an image`); if (length > maxBytes) throw new Error("response exceeds 10 MiB"); const data = new Uint8Array(await response.arrayBuffer()); if (data.byteLength > maxBytes) throw new Error("response exceeds 10 MiB"); const path = join(directory, `screenshot-${index}.${imageExtension(sourceUrl, type)}`); await writeFile(path, data); result.push({ sourceUrl, localPath: path, mediaType: type.split(";", 1)[0], status: "downloaded" }); } catch (error) { result.push({ sourceUrl, status: "failed", warning: error instanceof Error ? error.message : String(error) }); } }
  return result;
}

export type LauncherOptions = { runner?: CommandRunner; http?: HttpClient; env?: Record<string, string>; print?: (text: string) => void };
export async function runLauncher(args: string[], options: LauncherOptions = {}): Promise<void> {
  const runner = options.runner ?? bunCommandRunner; const http = options.http ?? fetch; const print = options.print ?? console.log; const dryRun = args.includes("--dry-run");
  const issue = parseIssueReference(args); const repoRoot = resolve(options.env?.PANTOKEN_REPO_ROOT ?? process.env.PANTOKEN_REPO_ROOT ?? resolve(SCRIPT_DIR, "..")); const data = await fetchIssue(issue, runner); const urls = extractImageUrls(data.body); const template = await readFile(TEMPLATE_PATH, "utf8");
  if (dryRun) { const prompt = renderPrompt(template, { ...issue, ...data }, urls.map((sourceUrl) => ({ sourceUrl, status: "failed" as const })), true); print(`DRY RUN — no filesystem, claims, downloads, or mutating commands\n\nIssue #${issue.number}: ${data.title}\n${issue.url}\n\nPlanned commands:\n${plannedCommands(issue, repoRoot).map((c) => `  ${c.join(" ")}`).join("\n")}\n\nPrompt:\n${prompt}`); return; }
  const context = await mkdtemp(join(repoRoot, ".pantoken-issue-context-")); let claimed = false; let workspace = resolve(repoRoot, "..", `pantoken-issue-${issue.number}`); let daemonPid: string | undefined;
  try { await claimCommand(runner, "claim_issue", issue.number); claimed = true; await mkdir(join(context, "images")); const screenshots = await downloadScreenshots(urls, join(context, "images"), http); await writeFile(join(context, "issue-body.md"), data.body); await writeFile(join(context, "manifest.json"), JSON.stringify(screenshots, null, 2)); await command(runner, "jj", ["workspace", "add", workspace, "--name", `issue-${issue.number}`], { cwd: repoRoot }); await command(runner, "bun", ["install"], { cwd: workspace }); const spawned = await command(runner, "polytoken", ["new", "--no-attach"], { cwd: workspace }); const parsed = parseDaemonOutput(spawned.stdout); const startup = join(process.env.HOME ?? "", ".local/share/polytoken/sessions", parsed.sessionId, "startup.json"); const startupData = await waitForDaemonReady(startup); daemonPid = typeof startupData.pid === "number" ? String(startupData.pid) : undefined; await writeFile(join(workspace, ".autopilot-session-id"), parsed.sessionId); const tokenPath = typeof startupData.credential_file_path === "string" ? startupData.credential_file_path : undefined; const token = tokenPath ? JSON.parse(await readFile(tokenPath, "utf8")).token : startupData.token; if (typeof token !== "string" || !token) throw new Error("daemon startup did not provide a credential"); const connection = { sessionId: parsed.sessionId, port: parsed.port, token, baseUrl: `http://localhost:${parsed.port}` }; await claimCommand(runner, "update_claim_session", issue.number, parsed.sessionId); await daemonRequest(connection, "/facet", { method: "POST", body: JSON.stringify({ facet: "plan" }) }, http); await daemonRequest(connection, "/permission-monitor", { method: "POST", body: JSON.stringify({ mode: "bypass_plus" }) }, http); const handoff = await daemonRequest(connection, "/adventurous-handoff", {}, http) as any; if (!handoff?.enabled) await daemonRequest(connection, "/adventurous-handoff", { method: "POST" }, http); await daemonRequest(connection, "/goal", { method: "POST", body: JSON.stringify({ summary: `Implement ${data.title} (${issue.url})` }) }, http); const prompt = renderPrompt(template, { ...issue, ...data }, screenshots); await daemonRequest(connection, "/prompt", { method: "POST", body: JSON.stringify({ content: prompt }) }, http); await command(runner, "zellij", ["action", "new-tab", "--block-until-exit", "--cwd", workspace, "--name", `#${issue.number}`, "--", "polytoken", "attach", parsed.sessionId]); print(`TUI closed. Workspace retained for integration check: ${workspace}`); } finally { if (claimed) await claimCommand(runner, "release_claim", issue.number).catch(() => undefined); if (!workspace || !existsSync(workspace)) { /* no-op */ } if (daemonPid) await runner("kill", [daemonPid]).catch(() => undefined); await rm(context, { recursive: true, force: true }).catch(() => undefined); }
}

if (import.meta.main) { runLauncher(Bun.argv.slice(2)).catch((error) => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }); }
