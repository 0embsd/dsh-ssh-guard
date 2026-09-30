import z from "@deepseek-ai/schemastery";
import { closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Client } from "ssh2";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isAbsolute as isAbsolute$1, join as join$1 } from "node:path/posix";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createServer } from "node:net";
import { unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/dsh-home.ts
/**
* DSH_HOME resolution shared by the plugin family's Host halves: the
* environment override wins, the platform home fallback follows. Mirrors
* what dsh-pet and dsh-liangshen each used to implement locally.
*/
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHome$1(path, home = homedir()) {
	const j = home.startsWith("/") ? join$1 : join;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return j(home, path.slice(2));
	return path;
}
/**
* Resolve the DSH home directory.
* @param env - process environment to read DSH_HOME from.
* @param home - platform home directory fallback (test seam).
* @returns the absolute DSH home path.
*/
function resolveDshHome(env = process.env, home = homedir()) {
	const isPosix = home.startsWith("/");
	const j = isPosix ? join$1 : join;
	const isAbs = isPosix ? isAbsolute$1 : isAbsolute;
	const raw = env.DSH_HOME;
	if (raw !== void 0 && raw.trim() !== "") {
		const expanded = expandHome$1(raw.trim(), home);
		return isAbs(expanded) ? expanded : j(process.cwd(), expanded);
	}
	return j(home, ".dsh");
}
/** Resolve the DSH home directory from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
//#region src/ssh-config.ts
/**
* Minimal `~/.ssh/config` reader for the one-shot host import: Host blocks with
* `Include` expansion and explicit skip reasons. Values stay raw strings; the
* store maps them onto a HostPayload.
*
* Deliberate simplifications (documented in the package README):
*   - `Match` blocks are skipped — their options are conditional and must never
*     merge into the Host block above them.
*   - A multi-pattern `Host a b` line only exposes its first pattern.
*   - Include pathnames accept `~`, globs, and several whitespace-separated
*     pathnames, but not environment variables, `%` tokens, or quoting.
*   - Relative Include pathnames resolve against the directory of the config
*     file the import started from (OpenSSH: `~/.ssh` for a user config).
*   - A file that already contributed lines is never read twice, which doubles
*     as the Include cycle guard.
*/
/** Include recursion guard: a cycle or a runaway chain stops here. */
const MAX_INCLUDE_DEPTH = 16;
/** The only line shape ssh_config knows: `Keyword value...` (case-insensitive). */
const LINE_RE = /^([A-Za-z0-9_-]+)\s+(.+)$/;
/** Expand a leading `~` the way OpenSSH does for user configuration files. */
function expandTilde(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
/** Turn one glob segment into a matcher (`*` and `?` only). */
function segmentMatcher(segment) {
	const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}
/**
* Expand a segment list against the filesystem. Wildcards match whole segments
* only; matches are sorted so a glob import stays deterministic.
*/
function globSegments(prefix, segments) {
	const [head, ...rest] = segments;
	if (head === void 0) return [prefix];
	if (!/[*?]/.test(head)) return globSegments(join(prefix, head), rest);
	let names;
	try {
		names = readdirSync(prefix);
	} catch {
		return [];
	}
	const matcher = segmentMatcher(head);
	return names.filter((name) => matcher.test(name)).sort().flatMap((name) => globSegments(join(prefix, name), rest));
}
/** Resolve one Include pathname into the existing regular files it names. */
function resolveInclude(spec, baseDir) {
	const expanded = expandTilde(spec);
	const full = isAbsolute(expanded) ? expanded : join(baseDir, expanded);
	if (!/[*?]/.test(full)) return existsSync(full) ? [full] : [];
	const root = /^([A-Za-z]:[\\/]|[\\/])/.exec(full)?.[1] ?? "";
	const segments = full.slice(root.length).split(/[\\/]+/).filter((part) => part !== "");
	return globSegments(root === "" ? "." : root, segments).filter((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}
/** Read one file into lines, splicing every `Include` in place. */
function readLines(file, baseDir, visited, depth) {
	if (depth > MAX_INCLUDE_DEPTH) return [];
	let key;
	try {
		key = realpathSync(file);
	} catch {
		return [];
	}
	if (visited.has(key)) return [];
	visited.add(key);
	let text;
	try {
		text = readFileSync(key, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const raw of text.split(/\r?\n/)) {
		const match = LINE_RE.exec(raw.trim());
		if (match === null || match[1].toLowerCase() !== "include") {
			out.push(raw);
			continue;
		}
		for (const spec of match[2].trim().split(/\s+/).filter((part) => part !== "")) for (const included of resolveInclude(spec, baseDir)) out.push(...readLines(included, baseDir, visited, depth + 1));
	}
	return out;
}
/**
* Parse one ssh_config file (Include expanded) into Host blocks plus the
* `Match` blocks that were deliberately skipped.
*/
function readSshConfigBlocks(configPath) {
	const blocks = [];
	const skipped = [];
	const lines = readLines(configPath, dirname(configPath), /* @__PURE__ */ new Set(), 0);
	let current;
	for (const raw of lines) {
		const match = LINE_RE.exec(raw.trim());
		if (match === null) continue;
		const key = match[1].toLowerCase();
		const value = match[2].trim();
		if (key === "host") {
			current = {
				pattern: value,
				props: {}
			};
			blocks.push(current);
			continue;
		}
		if (key === "match") {
			skipped.push({
				name: "Match " + value,
				reason: "match"
			});
			current = void 0;
			continue;
		}
		if (current !== void 0) current.props[key] = value;
	}
	return {
		blocks,
		skipped
	};
}
//#endregion
//#region src/store.ts
/**
* Host config store: one JSON file (`$DSH_HOME/dsh-ssh.json`, defaulting
* to `~/.dsh`) holding every
* SSH host entry, written atomically (tmp + rename). Also parses the user's
* standard `~/.ssh/config` for one-shot import. Secrets (passwords,
* passphrases) live in this user-owned file in plaintext — same trust model
* as ssh-skill's annotated ssh-config comments; document it, never log it.
*/
/** File format version. */
const FORMAT_VERSION = 1;
/** Store file location: $DSH_HOME/dsh-ssh.json (defaults to ~/.dsh). */
function storePath() {
	return join(dshHome(), "dsh-ssh.json");
}
/** The user's standard OpenSSH config path. */
function sshConfigPath() {
	return join(homedir(), ".ssh", "config");
}
/** Validate the wire shape of a host payload; returns a message or undefined. */
function validateHostPayload(payload) {
	if (typeof payload !== "object" || payload === null) return "body must be a JSON object";
	const p = payload;
	if (typeof p.host !== "string" || p.host.trim() === "") return "host is required";
	if (typeof p.user !== "string" || p.user.trim() === "") return "user is required";
	const auth = p.auth;
	if (auth !== void 0) {
		if (typeof auth !== "object" || auth === null) return "auth must be an object";
		if (auth.kind !== "key" && auth.kind !== "password" && auth.kind !== "agent") return "auth.kind must be key, password or agent";
		if (auth.kind === "key" && (typeof auth.keyPath !== "string" || auth.keyPath.trim() === "")) return "auth.keyPath is required for key auth";
		if (auth.kind === "password" && auth.password !== void 0 && typeof auth.password !== "string") return "auth.password must be a string when provided";
		if (auth.kind === "agent" && auth.agentPath !== void 0 && typeof auth.agentPath !== "string") return "auth.agentPath must be a string when provided";
	}
	if (p.port !== void 0 && (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) return "port must be an integer in 1..65535";
	if (p.proxyJump !== void 0 && (!Array.isArray(p.proxyJump) || p.proxyJump.some((x) => typeof x !== "string" || x === ""))) return "proxyJump must be an array of alias strings";
	if (p.proxyCommand !== void 0 && typeof p.proxyCommand !== "string") return "proxyCommand must be a string when provided";
	const proxyCommand = typeof p.proxyCommand === "string" ? normalizeProxyCommand(p.proxyCommand) : void 0;
	const proxyJump = Array.isArray(p.proxyJump) ? p.proxyJump : [];
	if (proxyCommand !== void 0 && proxyJump.length > 0) return "proxyCommand and proxyJump cannot be combined — pick one transport per host";
	if (p.tags !== void 0 && (!Array.isArray(p.tags) || p.tags.some((x) => typeof x !== "string"))) return "tags must be an array of strings";
}
/** Alias grammar: letters/digits plus dots, hyphens, underscores (IP/domain aliases included). */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Validate an alias for creation. */
function validateAlias(alias) {
	if (!ALIAS_RE.test(alias)) return "alias must be letters, digits, dots, hyphens or underscores";
}
/**
* The host store. Pure file I/O — no cordis dependency, unit-testable.
*/
var HostStore = class {
	/** The JSON file path. */
	path;
	/** Optional override of the ~/.ssh/config path (tests). */
	sshConfigOverride;
	/**
	* @param path - store file path (defaults to the standard location).
	* @param sshConfigOverride - ssh config path override (tests only).
	*/
	constructor(path, sshConfigOverride) {
		this.path = resolve(path ?? storePath());
		this.sshConfigOverride = sshConfigOverride;
	}
	/** Load all entries (empty store when the file is absent). */
	list() {
		return this.load().hosts;
	}
	/** Find one entry by alias. */
	find(alias) {
		return this.list().find((entry) => entry.alias === alias);
	}
	/** Secret-free projection for the browser and agent surfaces. */
	summarize(entry) {
		let keyReady = true;
		if (entry.auth.kind === "key" && entry.auth.keyPath) keyReady = existsSync(expandHome(entry.auth.keyPath));
		else if (entry.auth.kind === "agent") keyReady = false;
		return {
			alias: entry.alias,
			host: entry.host,
			port: entry.port,
			user: entry.user,
			auth: entry.auth.kind,
			keyReady,
			proxyJump: [...entry.proxyJump],
			...entry.proxyCommand !== void 0 ? { proxyCommand: entry.proxyCommand } : {},
			...entry.description !== void 0 ? { description: entry.description } : {},
			...entry.environment !== void 0 ? { environment: entry.environment } : {},
			tags: [...entry.tags],
			...entry.location !== void 0 ? { location: entry.location } : {},
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt
		};
	}
	/** Create one entry. Throws on alias collision or invalid payload. */
	create(payload) {
		const alias = payload.alias?.trim();
		if (!alias) throw new Error("alias is required");
		const aliasError = validateAlias(alias);
		if (aliasError !== void 0) throw new Error(aliasError);
		const bodyError = validateHostPayload(payload);
		if (bodyError !== void 0) throw new Error(bodyError);
		if (payload.auth === void 0) throw new Error("auth is required");
		const file = this.load();
		if (file.hosts.some((entry) => entry.alias === alias)) throw new Error(`alias '${alias}' already exists`);
		const now = Date.now();
		const entry = {
			alias,
			host: payload.host.trim(),
			port: payload.port ?? 22,
			user: payload.user.trim(),
			auth: {
				kind: payload.auth.kind,
				keyPath: payload.auth.kind === "key" ? expandHome(payload.auth.keyPath?.trim() ?? "") : void 0,
				passphrase: payload.auth.kind === "key" ? payload.auth.passphrase ?? void 0 : void 0,
				password: payload.auth.kind === "password" ? payload.auth.password : void 0,
				agentPath: payload.auth.kind === "agent" ? normalizeAgentPath(payload.auth.agentPath) : void 0
			},
			proxyJump: [...payload.proxyJump ?? []],
			proxyCommand: normalizeProxyCommand(payload.proxyCommand),
			description: payload.description?.trim() || void 0,
			environment: payload.environment?.trim() || void 0,
			tags: [...payload.tags ?? []].map((tag) => tag.trim()).filter((tag) => tag !== ""),
			location: payload.location?.trim() || void 0,
			createdAt: now,
			updatedAt: now
		};
		file.hosts.push(entry);
		this.save(file);
		return entry;
	}
	/** Update the fields present in `patch`; unknown aliases throw. */
	update(alias, patch) {
		const file = this.load();
		const entry = file.hosts.find((candidate) => candidate.alias === alias);
		if (entry === void 0) throw new Error(`alias '${alias}' not found`);
		if (patch.host !== void 0 && (typeof patch.host !== "string" || patch.host.trim() === "")) throw new Error("host is required");
		if (patch.user !== void 0 && (typeof patch.user !== "string" || patch.user.trim() === "")) throw new Error("user is required");
		if (patch.port !== void 0 && (typeof patch.port !== "number" || !Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) throw new Error("port must be an integer in 1..65535");
		if (patch.proxyJump !== void 0 && (!Array.isArray(patch.proxyJump) || patch.proxyJump.some((x) => typeof x !== "string" || x === ""))) throw new Error("proxyJump must be an array of alias strings");
		if (patch.proxyCommand !== void 0 && typeof patch.proxyCommand !== "string") throw new Error("proxyCommand must be a string when provided");
		const mergedProxyCommand = patch.proxyCommand !== void 0 ? normalizeProxyCommand(patch.proxyCommand) : entry.proxyCommand;
		if (mergedProxyCommand !== void 0 && (patch.proxyJump ?? entry.proxyJump).length > 0) throw new Error("proxyCommand and proxyJump cannot be combined — pick one transport per host");
		if (patch.tags !== void 0 && (!Array.isArray(patch.tags) || patch.tags.some((x) => typeof x !== "string"))) throw new Error("tags must be an array of strings");
		if (patch.host !== void 0) entry.host = patch.host.trim();
		if (patch.port !== void 0) entry.port = patch.port;
		if (patch.user !== void 0) entry.user = patch.user.trim();
		if (patch.auth !== void 0) {
			const auth = patch.auth;
			if (auth.kind !== "key" && auth.kind !== "password" && auth.kind !== "agent") throw new Error("auth.kind must be key, password or agent");
			if (auth.kind === "key" && (typeof auth.keyPath !== "string" || auth.keyPath.trim() === "")) throw new Error("auth.keyPath is required for key auth");
			if (auth.kind === "password" && auth.password !== void 0 && typeof auth.password !== "string") throw new Error("auth.password must be a string when provided");
			if (auth.kind === "agent" && auth.agentPath !== void 0 && typeof auth.agentPath !== "string") throw new Error("auth.agentPath must be a string when provided");
			const keyChanged = auth.kind === "key" && auth.keyPath !== void 0 && expandHome(auth.keyPath.trim()) !== entry.auth.keyPath;
			entry.auth = {
				kind: auth.kind,
				keyPath: auth.kind === "key" ? expandHome(auth.keyPath?.trim() ?? "") : void 0,
				passphrase: auth.kind === "key" ? auth.passphrase !== void 0 ? auth.passphrase : keyChanged ? void 0 : entry.auth.passphrase : void 0,
				password: auth.kind === "password" ? auth.password : void 0,
				agentPath: auth.kind === "agent" ? auth.agentPath !== void 0 ? normalizeAgentPath(auth.agentPath) : entry.auth.agentPath : void 0
			};
		}
		if (patch.proxyJump !== void 0) entry.proxyJump = [...patch.proxyJump];
		if (patch.proxyCommand !== void 0) entry.proxyCommand = mergedProxyCommand;
		if (patch.description !== void 0) entry.description = patch.description.trim() || void 0;
		if (patch.environment !== void 0) entry.environment = patch.environment.trim() || void 0;
		if (patch.tags !== void 0) entry.tags = [...patch.tags].map((tag) => tag.trim()).filter((tag) => tag !== "");
		if (patch.location !== void 0) entry.location = patch.location.trim() || void 0;
		entry.updatedAt = Date.now();
		this.save(file);
		return entry;
	}
	/** Remove one entry. */
	delete(alias) {
		const file = this.load();
		const index = file.hosts.findIndex((candidate) => candidate.alias === alias);
		if (index < 0) throw new Error(`alias '${alias}' not found`);
		file.hosts.splice(index, 1);
		this.save(file);
	}
	/**
	* Import hosts from `~/.ssh/config`: Host blocks with a single non-wildcard
	* pattern become entries (a missing HostName falls back to the pattern
	* itself; key auth via IdentityFile; jump hosts via ProxyJump; ProxyCommand
	* kept verbatim). `Include` files are expanded, and `Match` blocks,
	* wildcard patterns, and aliases that already exist are skipped with a
	* reason instead of silently disappearing.
	* @returns import statistics.
	*/
	importFromSshConfig() {
		this.skippedBlocks = [];
		const configPath = this.sshConfigOverride ?? sshConfigPath();
		if (!existsSync(configPath)) return {
			parsed: 0,
			added: 0,
			skipped: 0,
			skippedBlocks: []
		};
		const { blocks, skipped } = readSshConfigBlocks(configPath);
		this.skippedBlocks = [...skipped];
		const skip = (name, reason) => {
			if (name === "") return;
			if (this.skippedBlocks.some((block) => block.name === name)) return;
			this.skippedBlocks.push({
				name,
				reason
			});
		};
		let added = 0;
		for (const block of blocks) {
			const pattern = block.pattern.split(/\s+/)[0];
			if (pattern.includes("*") || pattern.includes("?")) {
				skip(pattern, "wildcard");
				continue;
			}
			if (this.list().some((entry) => entry.alias === pattern)) {
				skip(pattern, "existing");
				continue;
			}
			const payload = {
				alias: pattern,
				host: block.props.hostname !== void 0 && block.props.hostname !== "" ? block.props.hostname : pattern,
				port: block.props.port !== void 0 ? Number.parseInt(block.props.port, 10) : 22,
				user: block.props.user ?? process.env.USER ?? "root",
				auth: {
					kind: block.props.identityfile !== void 0 ? "key" : block.props.identityagent !== void 0 && block.props.identityagent.toLowerCase() !== "none" ? "agent" : "password",
					keyPath: block.props.identityfile,
					password: block.props.password,
					agentPath: block.props.identityagent !== void 0 && block.props.identityagent.toLowerCase() !== "none" ? normalizeAgentPath(block.props.identityagent) : void 0
				},
				proxyJump: block.props.proxyjump !== void 0 ? block.props.proxyjump.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "") : [],
				proxyCommand: block.props.proxycommand,
				description: block.props.description,
				environment: block.props.environment,
				tags: (block.props.tags ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
				location: block.props.location
			};
			try {
				this.create(payload);
				added += 1;
			} catch {
				skip(pattern, "invalid");
			}
		}
		return {
			parsed: blocks.length,
			added,
			skipped: this.skippedBlocks.length,
			skippedBlocks: [...this.skippedBlocks]
		};
	}
	skippedBlocks = [];
	/**
	* Last parsed store keyed by file identity. list/find ride every acquire
	* and GUI refresh; re-reading and re-parsing the whole file each call is
	* wasted work when the file has not changed. Any save invalidates.
	*/
	cache;
	load() {
		let stats;
		try {
			stats = statSync(this.path);
		} catch {
			this.cache = void 0;
			return {
				version: FORMAT_VERSION,
				hosts: []
			};
		}
		if (this.cache !== void 0 && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) return this.cache.file;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.hosts)) throw new Error("store file shape invalid");
			this.cache = {
				mtimeMs: stats.mtimeMs,
				size: stats.size,
				file: parsed
			};
			return parsed;
		} catch {
			this.cache = void 0;
			try {
				renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
			} catch {}
			return {
				version: FORMAT_VERSION,
				hosts: []
			};
		}
	}
	save(file) {
		const dir = dirname(this.path);
		if (!existsSync(dir)) mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		const tmp = this.path + ".tmp";
		writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", {
			encoding: "utf8",
			mode: 384
		});
		renameSync(tmp, this.path);
		this.cache = void 0;
	}
};
/** Normalize an agent endpoint for storage: trim, expand `~`, and resolve the SSH_AUTH_SOCK token. */
function normalizeAgentPath(agentPath) {
	const trimmed = agentPath?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	if (trimmed === "SSH_AUTH_SOCK" || trimmed === "$SSH_AUTH_SOCK") {
		const sock = process.env.SSH_AUTH_SOCK;
		return sock !== void 0 && sock !== "" ? sock : void 0;
	}
	return expandHome(trimmed);
}
/**
* Normalize a ProxyCommand for storage: trim, and treat an empty value or
* OpenSSH's `none` keyword as "no proxy command" (an explicit clear).
*/
function normalizeProxyCommand(raw) {
	const trimmed = raw?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	if (trimmed.toLowerCase() === "none") return void 0;
	return trimmed;
}
/** Expand a leading `~` in a filesystem path. */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
//#endregion
//#region src/engine/proxy-command.ts
/**
* OpenSSH-compatible ProxyCommand transport: run the command with the user's
* shell and expose its stdio as a Duplex that ssh2 accepts as `sock`.
*
* The command comes verbatim from the user's own 0600 store file and runs with
* the DSH host process's privileges — the same trust the `ssh(1)` client gives
* the identical line in `~/.ssh/config`.
*/
/** How long a killed proxy command may linger before SIGKILL (ms). */
const KILL_GRACE_MS = 2e3;
/** Expand the OpenSSH ProxyCommand tokens; unknown %X sequences stay verbatim. */
function expandProxyTokens(command, target) {
	return command.replace(/%[hprn%]/g, (token) => {
		switch (token) {
			case "%h": return target.host;
			case "%p": return String(target.port);
			case "%r": return target.user;
			case "%n": return target.alias;
			default: return "%";
		}
	});
}
/**
* The shell OpenSSH itself would use on this platform: the user's shell with
* `-c` on POSIX, cmd.exe on Windows (where the whole command must stay one
* verbatim argument, exactly as Node's own `shell: true` does it).
*/
function spawnSpec(command) {
	if (process.platform === "win32") return {
		file: process.env.ComSpec ?? "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			"\"" + command + "\""
		],
		windowsVerbatimArguments: true
	};
	return {
		file: process.env.SHELL ?? "/bin/sh",
		args: ["-c", command]
	};
}
/**
* Start one ProxyCommand and bridge its stdio into a Duplex.
*
* Failure modes are reported through the stream: a spawn error, or an exit
* before the SSH handshake finished, destroys it with the exit status and the
* tail of the command's stderr instead of letting ssh2 wait for its own
* `readyTimeout`.
*/
function startProxyCommand(rawCommand, target) {
	const spec = spawnSpec(expandProxyTokens(rawCommand, target));
	const child = spawn(spec.file, spec.args, {
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true,
		...spec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {},
		...process.platform === "win32" ? {} : { detached: true }
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-4096);
	});
	let killed = false;
	const kill = () => {
		if (killed) return;
		killed = true;
		const pid = child.pid;
		const group = process.platform !== "win32" && pid !== void 0;
		try {
			if (group) process.kill(-pid, "SIGTERM");
			else child.kill();
		} catch {}
		setTimeout(() => {
			try {
				if (group) process.kill(-pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}, KILL_GRACE_MS).unref();
	};
	function formatExitError(code, signal, stderrDetail) {
		const status = signal !== null ? "signal " + signal : "code " + String(code ?? "unknown");
		const detail = stderrDetail.trim();
		return /* @__PURE__ */ new Error("ProxyCommand exited (" + status + ")" + (detail === "" ? "" : ": " + detail));
	}
	const stream = new Duplex({
		read() {
			child.stdout?.resume();
		},
		write(chunk, _encoding, callback) {
			const stdin = child.stdin;
			if (stream.destroyed || stdin === null || stdin.destroyed) {
				callback(/* @__PURE__ */ new Error("ProxyCommand stdin is already closed"));
				return;
			}
			stdin.write(chunk, (err) => {
				if (!err) {
					callback();
					return;
				}
				if (child.exitCode !== null && child.exitCode !== 0 || child.signalCode !== null) {
					const exitErr = formatExitError(child.exitCode, child.signalCode, stderr);
					fail(exitErr);
					callback(exitErr);
					return;
				}
				let resolved = false;
				const onExit = (code, signal) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timer);
					const exitErr = code !== null && code !== 0 || signal !== null ? formatExitError(code, signal, stderr) : /* @__PURE__ */ new Error("ProxyCommand transport write failed: " + err.message);
					fail(exitErr);
					callback(exitErr);
				};
				const timer = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					child.removeListener("exit", onExit);
					const transportErr = /* @__PURE__ */ new Error("ProxyCommand transport write failed: " + err.message);
					fail(transportErr);
					callback(transportErr);
				}, 200);
				timer.unref();
				child.once("exit", onExit);
			});
		},
		final(callback) {
			const stdin = child.stdin;
			if (stdin === null || stdin.destroyed) {
				callback();
				return;
			}
			stdin.end((err) => {
				if (err) callback(/* @__PURE__ */ new Error("ProxyCommand transport close failed: " + err.message));
				else callback();
			});
		},
		destroy(error, callback) {
			kill();
			callback(error);
		}
	});
	stream.on("error", () => {});
	let failed = false;
	const fail = (error) => {
		if (failed || stream.destroyed) return;
		failed = true;
		stream.destroy(error);
	};
	let stdoutEnded = false;
	let exited = false;
	const finishIfClean = () => {
		if (exited && stdoutEnded && !failed && !stream.destroyed) stream.push(null);
	};
	child.stdout?.on("data", (chunk) => {
		if (stream.push(chunk) === false) child.stdout?.pause();
	});
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		finishIfClean();
	});
	child.stdout?.on("error", (error) => {
		fail(/* @__PURE__ */ new Error("ProxyCommand stdout error: " + error.message));
	});
	child.stdin?.on("error", (error) => {
		if (child.exitCode !== null && child.exitCode !== 0 || child.signalCode !== null) {
			fail(formatExitError(child.exitCode, child.signalCode, stderr));
			return;
		}
		const timer = setTimeout(() => {
			fail(/* @__PURE__ */ new Error("ProxyCommand transport error: " + error.message));
		}, 200);
		timer.unref();
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code !== null && code !== 0 || signal !== null) fail(formatExitError(code, signal, stderr));
		});
	});
	child.on("error", (error) => {
		fail(/* @__PURE__ */ new Error("ProxyCommand could not start: " + error.message));
	});
	child.on("exit", (code, signal) => {
		exited = true;
		if (code !== null && code !== 0 || signal !== null) {
			fail(formatExitError(code, signal, stderr));
			return;
		}
		finishIfClean();
	});
	return {
		stream,
		child
	};
}
//#endregion
//#region src/engine/connection-pool.ts
/**
* Connection pool: per-alias persistent ssh2 connections with multi-hop jump
* support, the acquire / dispose / sweep lifecycle, and the pooled exec path.
*/
/** Default engine knobs (applied when an option is omitted). */
const DEFAULTS = {
	idleTimeoutMs: 30 * 6e4,
	connectTimeoutMs: 15e3,
	keepaliveIntervalMs: 15e3,
	maxOutputBytes: 2 * 1024 * 1024,
	defaultExecTimeoutMs: 6e4,
	defaultMaxWorkers: 8,
	sftpConcurrency: 8
};
/** Build the ssh2 connect config for one entry (key read from disk). */
function buildConnectConfig(entry, sock, opts) {
	const config = {
		host: entry.host,
		port: entry.port,
		username: entry.user,
		readyTimeout: opts.connectTimeoutMs,
		keepaliveInterval: opts.keepaliveIntervalMs,
		keepaliveCountMax: 3,
		tryKeyboard: true
	};
	if (sock !== void 0) config.sock = sock;
	if (entry.auth.kind === "password") config.password = entry.auth.password;
	else if (entry.auth.kind === "agent") {
		const agentPath = resolveAgentPath(entry.auth.agentPath);
		if (agentPath === void 0) throw new Error("ssh-agent is not available: set SSH_AUTH_SOCK or configure an agent path (use 'pageant' for PuTTY Pageant on Windows)");
		config.agent = agentPath;
	} else {
		const keyPath = entry.auth.keyPath === void 0 ? void 0 : expandHome(entry.auth.keyPath);
		if (keyPath === void 0 || !existsSync(keyPath)) throw new Error("private key not found: " + (entry.auth.keyPath ?? "(unset)"));
		config.privateKey = readFileSync(keyPath, "utf8");
		if (entry.auth.passphrase !== void 0 && entry.auth.passphrase !== "") config.passphrase = entry.auth.passphrase;
	}
	return config;
}
/** Resolve the ssh2 agent path for 'agent' auth. */
function resolveAgentPath(agentPath) {
	const explicit = normalizeAgentPath(agentPath);
	if (explicit !== void 0) return explicit;
	const sock = process.env.SSH_AUTH_SOCK;
	if (sock !== void 0 && sock !== "") return sock;
	if (process.platform === "win32") return "pageant";
}
/** Connect one ssh2 client (resolve on ready, reject on error/close). */
function connectClient(config, onKeyboardInteractive) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			const sock = config.sock;
			if (sock !== void 0 && typeof sock.destroy === "function") try {
				sock.destroy();
			} catch {}
			try {
				client.destroy();
			} catch {}
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		client.once("ready", () => {
			if (settled) return;
			settled = true;
			resolve(client);
		});
		client.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
			if (onKeyboardInteractive !== void 0) {
				onKeyboardInteractive(name, instructions, instructionsLang, prompts.map((p) => ({
					prompt: p.prompt,
					echo: Boolean(p.echo)
				})), finish);
				return;
			}
			if (config.password !== void 0 && prompts.length > 0 && prompts.every((p) => /password/i.test(p.prompt))) {
				finish(prompts.map(() => config.password));
				return;
			}
			fail(/* @__PURE__ */ new Error("Authentication failed (keyboard-interactive): " + (prompts.map((p) => p.prompt.trim()).join(", ") || "unsupported interactive challenge")));
		});
		client.on("error", fail);
		try {
			client.connect(config);
		} catch (error) {
			fail(error);
		}
	});
}
/** Cap captured output at the configured byte budget (marks truncation). */
function appendOutput(target, chunk, maxBytes) {
	if (target.truncated) return;
	if (target.text.length + chunk.length > maxBytes) {
		let cut = chunk.toString("utf8").slice(0, maxBytes - target.text.length);
		if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
		target.text += cut + "…[output truncated]";
		target.truncated = true;
		return;
	}
	target.text += chunk.toString("utf8");
}
/** The ProxyCommand token source for one entry. */
function proxyTargetOf(entry) {
	return {
		host: entry.host,
		port: entry.port,
		user: entry.user,
		alias: entry.alias
	};
}
/**
* Parse an OpenSSH jump hop written as an address: `[user@]host[:port]`
* (an IPv6 literal must be bracketed). Returns undefined when the value is not
* an address at all.
*/
function parseJumpSpec(spec) {
	const trimmed = spec.trim();
	if (trimmed === "") return void 0;
	const at = trimmed.lastIndexOf("@");
	const user = at >= 0 ? trimmed.slice(0, at) : void 0;
	const rest = at >= 0 ? trimmed.slice(at + 1) : trimmed;
	if (rest === "") return void 0;
	let host = rest;
	let portText;
	if (rest.startsWith("[")) {
		const end = rest.indexOf("]");
		if (end < 0) return void 0;
		host = rest.slice(1, end);
		const tail = rest.slice(end + 1);
		if (tail.startsWith(":")) portText = tail.slice(1);
		else if (tail !== "") return void 0;
	} else {
		const colon = rest.indexOf(":");
		if (colon >= 0) {
			host = rest.slice(0, colon);
			portText = rest.slice(colon + 1);
		}
	}
	if (host === "") return void 0;
	let port;
	if (portText !== void 0) {
		port = Number(portText);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return void 0;
	}
	return {
		host,
		...port !== void 0 ? { port } : {},
		...user !== void 0 && user !== "" ? { user } : {}
	};
}
/**
* Resolve one ProxyJump spec: an alias configured in this plugin wins, and any
* other value is read as an OpenSSH address whose credentials come from the
* target entry (an ad-hoc hop has no stored auth of its own).
*/
function resolveHop(engine, entry, spec) {
	const configured = engine.store.find(spec);
	if (configured !== void 0) return configured;
	const parsed = parseJumpSpec(spec);
	if (parsed === void 0) throw new Error("proxyJump '" + spec + "' is neither a configured alias nor a [user@]host[:port] address");
	const now = Date.now();
	return {
		alias: spec,
		host: parsed.host,
		port: parsed.port ?? 22,
		user: parsed.user ?? process.env.USER ?? entry.user,
		auth: entry.auth,
		proxyJump: [],
		tags: [],
		createdAt: now,
		updatedAt: now
	};
}
/**
* Build one full jump chain for an entry: hop clients connected through in
* order, each forwarding a stream to the next destination, ending with the
* target client. Shared by the pool and standalone shell sessions.
*
* A ProxyCommand is the transport that reaches its own host, so the entry's
* own command seeds the chain when there is no jump chain, and the first hop's
* command is used when the hop carries one.
*/
async function connectChain(engine, entry, onKeyboardInteractive) {
	const hops = [];
	const chain = entry.proxyJump;
	if (chain.length > 0 && entry.proxyCommand !== void 0) throw new Error("entry '" + entry.alias + "' declares both proxyCommand and proxyJump — pick one transport per host");
	/** Transports this call started; destroyed on every failure path. */
	const transports = [];
	const startTransport = (owner) => {
		const { stream } = startProxyCommand(owner.proxyCommand, proxyTargetOf(owner));
		transports.push(stream);
		return stream;
	};
	let sock = entry.proxyCommand !== void 0 ? startTransport(entry) : void 0;
	try {
		for (let index = 0; index < chain.length; index += 1) {
			const spec = chain[index];
			const hop = resolveHop(engine, entry, spec);
			if (index > 0 && hop.proxyCommand !== void 0) throw new Error("proxyJump hop '" + spec + "' declares a proxyCommand, which is only supported on the first hop");
			const hopSock = index === 0 && hop.proxyCommand !== void 0 ? startTransport(hop) : sock;
			let hopClient;
			try {
				hopClient = await connectClient(buildConnectConfig(hop, hopSock, engine.opts), onKeyboardInteractive);
			} catch (error) {
				throw new Error("proxyJump hop '" + spec + "' (" + hop.user + "@" + hop.host + ":" + hop.port + "): " + (error instanceof Error ? error.message : String(error)));
			}
			hops.push(hopClient);
			const next = index + 1 < chain.length ? resolveHop(engine, entry, chain[index + 1]) : void 0;
			const nextHost = next !== void 0 ? next.host : entry.host;
			const nextPort = next !== void 0 ? next.port : entry.port;
			sock = await new Promise((resolve, reject) => {
				hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
					if (error !== void 0) reject(/* @__PURE__ */ new Error("proxyJump hop '" + spec + "' could not forward to " + nextHost + ":" + nextPort + ": " + error.message));
					else resolve(stream);
				});
			});
		}
	} catch (error) {
		for (const client of hops) client.end();
		for (const stream of transports) try {
			stream.destroy();
		} catch {}
		throw error;
	}
	let target;
	try {
		target = await connectClient(buildConnectConfig(entry, sock, engine.opts), onKeyboardInteractive);
		return {
			client: target,
			hops
		};
	} catch (error) {
		for (const client of hops) client.end();
		for (const stream of transports) try {
			stream.destroy();
		} catch {}
		if (target !== void 0) try {
			target.destroy();
		} catch {}
		throw error;
	}
}
/** Connect (or reuse) the pooled chain for one alias; pins nothing. */
async function acquire(engine, alias) {
	const pending = engine.acquireQueue.get(alias);
	if (pending !== void 0) return pending;
	const task = doAcquire(engine, alias);
	engine.acquireQueue.set(alias, task);
	try {
		return await task;
	} finally {
		if (engine.acquireQueue.get(alias) === task) engine.acquireQueue.delete(alias);
	}
}
async function doAcquire(engine, alias) {
	const entry = engine.store.find(alias);
	if (entry === void 0) throw new Error("alias '" + alias + "' not found — add it first");
	const { client, hops } = await connectChain(engine, entry);
	const record = {
		client,
		hops,
		idleAt: Date.now(),
		pinned: false,
		broken: false,
		inFlight: 0
	};
	client.on("error", () => {
		record.broken = true;
	});
	client.on("close", () => {
		record.broken = true;
	});
	engine.pool.set(alias, record);
	return record;
}
/**
* Tear down one alias's record. When `record` is given and no longer the
* pooled record for the alias (a concurrent acquire replaced it), nothing
* is torn down — the connection belongs to someone else now.
*/
function disposeRecord(engine, alias, record) {
	const current = engine.pool.get(alias);
	if (record !== void 0 && current !== record) return;
	if (current === void 0) return;
	engine.pool.delete(alias);
	endRecordChain(current);
}
/** End one record's client and hop chain (best-effort, safe to repeat). */
function endRecordChain(record) {
	try {
		record.client.end();
	} catch {}
	for (const hop of record.hops) try {
		hop.end();
	} catch {}
}
/** Close connections idle beyond the threshold (skips pinned and in-flight). */
function sweepPool(engine) {
	const cutoff = Date.now() - engine.opts.idleTimeoutMs;
	for (const [alias, record] of engine.pool) if (!record.pinned && record.inFlight === 0 && record.idleAt < cutoff) disposeRecord(engine, alias, record);
}
/**
* Run `fn` with a live client for `alias`, reconnecting (up to the
* attempt budget) when the connection broke mid-flight.
*/
async function withClient(engine, alias, fn, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let record = engine.pool.get(alias);
		if (record === void 0 || record.broken) {
			if (record !== void 0) disposeRecord(engine, alias, record);
			record = await acquire(engine, alias);
		}
		record.idleAt = Date.now();
		record.inFlight += 1;
		try {
			const result = await fn(record.client);
			record.idleAt = Date.now();
			return result;
		} catch (error) {
			lastError = error;
			if (!record.broken) throw error;
			disposeRecord(engine, alias, record);
		} finally {
			record.inFlight -= 1;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/** Run one command on `alias` (reusing the pooled connection). */
async function execCommand(engine, alias, command, timeoutMs) {
	const started = Date.now();
	const budget = timeoutMs !== void 0 && timeoutMs > 0 ? timeoutMs : engine.opts.defaultExecTimeoutMs;
	return withClient(engine, alias, async (client) => {
		return await new Promise((resolve, reject) => {
			client.exec(command, (error, stream) => {
				if (error !== void 0) {
					reject(error);
					return;
				}
				const stdout = {
					text: "",
					truncated: false
				};
				const stderr = {
					text: "",
					truncated: false
				};
				let timedOut = false;
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({
						success: false,
						exitCode: null,
						timedOut,
						stdout: stdout.text,
						stderr: stderr.text,
						durationMs: Date.now() - started,
						error: timedOut ? "command timed out after " + budget + " ms" : void 0
					});
				};
				const timer = setTimeout(() => {
					timedOut = true;
					try {
						stream.signal("KILL");
					} catch {}
					try {
						stream.close();
					} catch {}
					finish();
				}, budget);
				stream.on("data", (chunk) => appendOutput(stdout, chunk, engine.opts.maxOutputBytes));
				stream.stderr.on("data", (chunk) => appendOutput(stderr, chunk, engine.opts.maxOutputBytes));
				stream.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (typeof code !== "number" && !timedOut) {
						reject(/* @__PURE__ */ new Error("ssh: connection lost mid-flight (channel closed without an exit status)"));
						return;
					}
					resolve({
						success: code === 0,
						exitCode: code,
						timedOut,
						stdout: stdout.text,
						stderr: stderr.text,
						durationMs: Date.now() - started
					});
				});
				stream.on("error", (streamError) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(streamError);
				});
			});
		});
	});
}
//#endregion
//#region src/engine/pty.ts
/**
* PTY shell sessions for the web terminal: a standalone (non-pooled)
* ssh2 connection with a long-lived shell channel, resize, and pausable
* output delivery.
*/
/**
* Open a PTY shell session for the web terminal (standalone connection).
* The shell is a long-lived exclusive stream: it uses its own connection so
* closing it can never tear down a pooled exec/tunnel sharing the alias.
*/
async function openShell(engine, alias, size, onKeyboardInteractive) {
	const entry = engine.store.find(alias);
	if (entry === void 0) throw new Error("alias '" + alias + "' not found — add it first");
	const { client, hops } = await connectChain(engine, entry, onKeyboardInteractive);
	return await new Promise((resolve, reject) => {
		client.shell({
			term: "xterm-256color",
			cols: size.cols,
			rows: size.rows
		}, (error, stream) => {
			if (error !== void 0) {
				try {
					client.end();
				} catch {}
				for (const hop of hops) try {
					hop.end();
				} catch {}
				reject(error);
				return;
			}
			let tornDown = false;
			const teardown = () => {
				if (tornDown) return;
				tornDown = true;
				try {
					client.end();
				} catch {}
				for (const hop of hops) try {
					hop.end();
				} catch {}
			};
			const session = {
				send: (data) => {
					try {
						stream.write(data);
					} catch {}
				},
				resize: (cols, rows) => {
					try {
						stream.setWindow(rows, cols, rows, cols);
					} catch {}
				},
				close: () => {
					try {
						stream.close();
					} catch {}
					teardown();
				},
				pause: () => {
					try {
						stream.pause();
					} catch {}
				},
				resume: () => {
					try {
						stream.resume();
					} catch {}
				}
			};
			stream.on("data", (chunk) => {
				session.onData?.(chunk);
			});
			stream.on("close", (code) => {
				teardown();
				session.onExit?.(code);
			});
			stream.on("error", (streamError) => {
				teardown();
				session.onExit?.(null, streamError instanceof Error ? streamError.message : String(streamError));
			});
			resolve(session);
		});
	});
}
//#endregion
//#region src/engine/sftp.ts
/**
* SFTP transfers: upload (file or recursive tree), single-file download, and
* remote directory listing. Every channel is opened once per operation and
* released exactly once so sshd's MaxSessions cap is never exhausted.
*/
/** Walk a local directory, collecting relative paths of every file. */
function walkLocalDir(root) {
	const files = [];
	const visit = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) visit(full);
			else if (stat.isFile()) files.push(relative(root, full).replaceAll("\\", "/"));
		}
	};
	visit(root);
	return files;
}
/** Upload one local file (or directory tree) to a remote path. */
async function upload(engine, alias, localPath, remotePath, recursive, onProgress) {
	if (!remotePath.startsWith("/")) throw new Error("remotePath must be an absolute path (got '" + remotePath + "')");
	const local = resolve(localPath);
	if (!existsSync(local)) throw new Error("local path not found: '" + localPath + "'");
	return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
		const stat = statSync(local);
		let files;
		if (stat.isDirectory()) {
			if (!recursive) throw new Error("'" + localPath + "' is a directory — enable recursive upload");
			files = walkLocalDir(local);
			await ensureRemoteDir(sftp, remotePath);
		} else {
			files = [""];
			await ensureRemoteDir(sftp, dirname(remotePath));
		}
		let bytes = 0;
		for (const rel of files) {
			const src = rel === "" ? local : join(local, rel);
			const remoteRel = rel.split(/[\\/]/).join("/");
			await fastPut(sftp, src, rel === "" ? remotePath : remotePath.replace(/\/$/, "") + "/" + remoteRel, engine.opts.sftpConcurrency, onProgress);
			bytes += statSync(src).size;
		}
		return {
			bytes,
			files: files.length
		};
	}));
}
/** Download one remote file to a local path. */
async function download(engine, alias, remotePath, localPath, onProgress) {
	return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
		if ((await new Promise((resolve, reject) => {
			sftp.stat(remotePath, (error, stats) => error !== void 0 ? reject(error) : resolve(stats));
		})).isDirectory()) throw new Error("'" + remotePath + "' is a directory — directory download is not supported yet (download individual files)");
		const local = resolve(localPath);
		if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true });
		await fastGet(sftp, remotePath, local, engine.opts.sftpConcurrency, onProgress);
		return { bytes: statSync(local).size };
	}));
}
/** List a remote directory (file browser). */
async function ls(engine, alias, path) {
	return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
		return await new Promise((resolve, reject) => {
			sftp.readdir(path, (error, list) => {
				if (error !== void 0) {
					reject(error);
					return;
				}
				resolve(list.map((item) => ({
					name: item.filename,
					type: item.attrs.isDirectory() ? "dir" : item.attrs.isFile() ? "file" : "other",
					size: item.attrs.size,
					mtimeMs: item.attrs.mtime * 1e3,
					mode: item.attrs.mode
				})));
			});
		});
	}));
}
/**
* Open one SFTP channel, run the operation, and release the channel exactly
* once when the operation settles (success or error). ssh2 keeps each
* subsystem channel open until end(); without this, every transfer leaks a
* channel until sshd's MaxSessions cap makes all later opens fail.
*/
async function withSftp(client, run) {
	const sftp = await sftpChannel(client);
	let ended = false;
	const endOnce = () => {
		if (ended) return;
		ended = true;
		try {
			sftp.end();
		} catch {}
	};
	sftp.once("close", endOnce);
	try {
		return await run(sftp);
	} finally {
		endOnce();
	}
}
function sftpChannel(client) {
	return new Promise((resolve, reject) => {
		client.sftp((error, sftp) => error !== void 0 ? reject(error) : resolve(sftp));
	});
}
/** Create a remote directory chain (stat-then-mkdir per segment). */
function ensureRemoteDir(sftp, remote) {
	return new Promise((resolve, reject) => {
		const segments = remote.replace(/^\/+/, "").split("/").filter((segment) => segment !== "");
		const walk = (index) => {
			if (index >= segments.length) {
				resolve();
				return;
			}
			const current = "/" + segments.slice(0, index + 1).join("/");
			sftp.stat(current, (statError) => {
				if (statError === void 0) {
					walk(index + 1);
					return;
				}
				sftp.mkdir(current, (mkdirError) => {
					if (mkdirError !== void 0) {
						reject(mkdirError);
						return;
					}
					walk(index + 1);
				});
			});
		};
		walk(0);
	});
}
/** One fastPut/fastGet transfer with throttled progress (the two directions share everything but the verb). */
function fastTransfer(sftp, kind, src, dst, concurrency, onProgress) {
	return new Promise((resolve, reject) => {
		const file = kind === "put" ? dst : src;
		const finalSize = () => statSync(kind === "put" ? src : dst).size;
		let last = 0;
		let lastEmit = 0;
		const started = Date.now();
		if (kind === "put") onProgress?.({
			phase: "transferring",
			file,
			transferred: 0,
			total: statSync(src).size,
			percent: 0
		});
		const step = (transferred, _chunk, total) => {
			const now = Date.now();
			if (now - lastEmit < 100 && transferred < total) return;
			lastEmit = now;
			const elapsed = (now - started) / 1e3;
			onProgress?.({
				phase: "transferring",
				file,
				transferred,
				total,
				percent: total > 0 ? Math.round(transferred / total * 1e3) / 10 : 0,
				speedBps: elapsed > 0 ? Math.round((transferred - last) / elapsed) : void 0
			});
			last = transferred;
		};
		const done = (error) => {
			if (error !== void 0) {
				onProgress?.({
					phase: "error",
					file,
					transferred: 0,
					total: 0,
					percent: 0,
					error: String(error)
				});
				reject(error);
			} else {
				onProgress?.({
					phase: "done",
					file,
					transferred: finalSize(),
					total: finalSize(),
					percent: 100
				});
				resolve();
			}
		};
		if (kind === "put") sftp.fastPut(src, dst, {
			concurrency,
			step
		}, done);
		else sftp.fastGet(src, dst, {
			concurrency,
			step
		}, done);
	});
}
function fastPut(sftp, src, dst, concurrency, onProgress) {
	return fastTransfer(sftp, "put", src, dst, concurrency, onProgress);
}
function fastGet(sftp, src, dst, concurrency, onProgress) {
	return fastTransfer(sftp, "get", src, dst, concurrency, onProgress);
}
//#endregion
//#region src/engine/tunnel.ts
/**
* Local port-forward tunnels: one loopback-only listener per tunnel, pinned
* to a pooled connection so an idle sweep never closes it, with per-tunnel
* socket tracking and stop (single / alias-scoped / all).
*/
/** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
async function startTunnel(engine, alias, options) {
	if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535) throw new Error("remotePort must be an integer in 1..65535");
	if (options.localPort !== void 0 && (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535)) throw new Error("localPort must be an integer in 1..65535");
	if (engine.store.find(alias) === void 0) throw new Error("alias '" + alias + "' not found — add it first");
	const remoteHost = options.remoteHost ?? "127.0.0.1";
	const id = "tun-" + engine.nextTunnelId;
	engine.nextTunnelId += 1;
	const info = {
		id,
		alias,
		localPort: 0,
		remoteHost,
		remotePort: options.remotePort,
		state: "connecting",
		startedAt: Date.now()
	};
	const existing = engine.pool.get(alias);
	if (existing !== void 0 && existing.broken) disposeRecord(engine, alias, existing);
	const record = engine.pool.get(alias) ?? await acquire(engine, alias);
	const client = record.client;
	const sockets = /* @__PURE__ */ new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});
		client.forwardOut("127.0.0.1", 0, remoteHost, options.remotePort, (error, stream) => {
			if (error !== void 0) {
				socket.destroy();
				return;
			}
			const destroy = () => {
				try {
					socket.destroy();
				} catch {}
				try {
					stream.close();
				} catch {}
			};
			stream.on("error", destroy);
			socket.on("error", destroy);
			stream.on("close", destroy);
			socket.on("close", destroy);
			stream.pipe(socket).pipe(stream);
		});
	});
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.localPort ?? 0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
	} catch (error) {
		if (!record.pinned && record.inFlight === 0) disposeRecord(engine, alias, record);
		throw error;
	}
	record.pinned = true;
	const address = server.address();
	info.localPort = typeof address === "object" && address !== null ? address.port : 0;
	info.state = "forwarding";
	engine.tunnels.set(id, {
		info,
		server,
		alias,
		record,
		sockets
	});
	return info;
}
/** All active tunnels. */
function listTunnels(engine) {
	return [...engine.tunnels.values()].map((tunnel) => ({ ...tunnel.info }));
}
/** Stop one tunnel (closes the listener, live sockets, and the pinned connection). */
function stopTunnel(engine, id) {
	const tunnel = engine.tunnels.get(id);
	if (tunnel === void 0) return false;
	engine.tunnels.delete(id);
	try {
		tunnel.server.close();
	} catch {}
	for (const socket of tunnel.sockets) try {
		socket.destroy();
	} catch {}
	tunnel.sockets.clear();
	if (![...engine.tunnels.values()].some((candidate) => candidate.record === tunnel.record)) if (engine.pool.get(tunnel.alias) === tunnel.record) disposeRecord(engine, tunnel.alias, tunnel.record);
	else endRecordChain(tunnel.record);
	return true;
}
/** Stop all tunnels (optionally for one alias). */
function stopAllTunnels(engine, alias) {
	let count = 0;
	for (const [id, tunnel] of [...engine.tunnels]) if (alias === void 0 || tunnel.alias === alias) {
		stopTunnel(engine, id);
		count += 1;
	}
	return count;
}
//#endregion
//#region src/engine/cluster.ts
/** Run one command against many hosts concurrently. */
async function cluster(engine, options) {
	const hasAliases = Array.isArray(options.aliases) && options.aliases.some((alias) => typeof alias === "string" && alias.trim() !== "");
	const hasEnvironment = typeof options.environment === "string" && options.environment.trim() !== "";
	const hasTags = Array.isArray(options.tags) && options.tags.some((tag) => typeof tag === "string" && tag.trim() !== "");
	if (!hasAliases && !hasEnvironment && !hasTags) throw new Error("ssh_cluster requires aliases, environment, or tags to limit the target set");
	let targets = engine.store.list();
	if (options.aliases !== void 0 && options.aliases.length > 0) targets = targets.filter((entry) => options.aliases.includes(entry.alias));
	if (options.environment !== void 0 && options.environment !== "") targets = targets.filter((entry) => entry.environment === options.environment);
	if (options.tags !== void 0 && options.tags.length > 0) targets = targets.filter((entry) => options.tags.every((tag) => entry.tags.includes(tag)));
	if (targets.length === 0) return [];
	if (options.maxWorkers !== void 0 && (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1)) throw new Error("maxWorkers must be a positive integer");
	const workers = Math.min(engine.opts.defaultMaxWorkers, options.maxWorkers ?? engine.opts.defaultMaxWorkers, targets.length);
	const results = [];
	const queue = [...targets];
	const run = async () => {
		while (queue.length > 0) {
			const entry = queue.shift();
			try {
				const result = await execCommand(engine, entry.alias, options.command, options.timeoutMs);
				results.push({
					alias: entry.alias,
					ok: result.success,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					stdout: result.stdout,
					stderr: result.stderr,
					durationMs: result.durationMs
				});
			} catch (error) {
				results.push({
					alias: entry.alias,
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	};
	await Promise.all(Array.from({ length: workers }, () => run()));
	return results;
}
//#endregion
//#region src/engine.ts
/**
* The engine. Owns the pool, tunnels, and all operations. One instance per
* plugin apply; dispose() closes every connection.
*/
var SshEngine = class {
	store;
	opts;
	pool = /* @__PURE__ */ new Map();
	acquireQueue = /* @__PURE__ */ new Map();
	tunnels = /* @__PURE__ */ new Map();
	nextTunnelId = 1;
	sweepTimer;
	/**
	* @param store - the host config store.
	* @param options - engine knobs (defaults applied).
	*/
	constructor(store, options) {
		this.store = store;
		this.opts = {
			...DEFAULTS,
			...options
		};
		this.sweepTimer = setInterval(() => sweepPool(this), Math.max(1e4, this.opts.idleTimeoutMs / 4));
		this.sweepTimer.unref?.();
	}
	/** Secret-free host list (filtered by the optional query). */
	list(query) {
		const needle = query?.trim().toLowerCase();
		return this.store.list().filter((entry) => needle === void 0 || needle === "" || entry.alias.toLowerCase().includes(needle) || (entry.description ?? "").toLowerCase().includes(needle) || entry.host.toLowerCase().includes(needle) || entry.tags.some((tag) => tag.toLowerCase().includes(needle))).map((entry) => this.store.summarize(entry));
	}
	/** One host summary by alias. */
	find(alias) {
		const entry = this.store.find(alias);
		return entry === void 0 ? void 0 : this.store.summarize(entry);
	}
	/** Run one command on `alias` (reusing the pooled connection). */
	async exec(alias, command, timeoutMs) {
		return execCommand(this, alias, command, timeoutMs);
	}
	/** Run one command against many hosts concurrently. */
	async cluster(options) {
		return cluster(this, options);
	}
	/** Open a PTY shell session for the web terminal (standalone connection). */
	async openShell(alias, size, onKeyboardInteractive) {
		return openShell(this, alias, size, onKeyboardInteractive);
	}
	/** Upload one local file (or directory tree) to a remote path. */
	async upload(alias, localPath, remotePath, recursive, onProgress) {
		return upload(this, alias, localPath, remotePath, recursive, onProgress);
	}
	/** Download one remote file to a local path. */
	async download(alias, remotePath, localPath, onProgress) {
		return download(this, alias, remotePath, localPath, onProgress);
	}
	/** List a remote directory (file browser). */
	async ls(alias, path) {
		return ls(this, alias, path);
	}
	/** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
	async startTunnel(alias, options) {
		return startTunnel(this, alias, options);
	}
	/** All active tunnels. */
	listTunnels() {
		return listTunnels(this);
	}
	/** Stop one tunnel (closes the listener, live sockets, and the pinned connection). */
	stopTunnel(id) {
		return stopTunnel(this, id);
	}
	/** Stop all tunnels (optionally for one alias). */
	stopAllTunnels(alias) {
		return stopAllTunnels(this, alias);
	}
	/**
	* Drop every live artifact bound to one alias: stop its tunnels and close
	* the pooled connection. Host entries that are deleted or whose connection
	* fields change must never keep serving a stale, previously authenticated
	* connection — the next operation re-connects from the current config.
	*/
	dropAlias(alias) {
		stopAllTunnels(this, alias);
		disposeRecord(this, alias);
	}
	/** Probe connectivity with a cross-platform shell command. */
	async test(alias) {
		const started = Date.now();
		try {
			const result = await this.exec(alias, "echo ok", 1e4);
			return result.success ? {
				ok: true,
				latencyMs: result.durationMs
			} : {
				ok: false,
				latencyMs: result.durationMs,
				error: "remote exit code " + result.exitCode
			};
		} catch (error) {
			return {
				ok: false,
				latencyMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Close every pooled connection and tunnel. */
	dispose() {
		if (this.sweepTimer !== void 0) clearInterval(this.sweepTimer);
		for (const id of [...this.tunnels.keys()]) stopTunnel(this, id);
		for (const alias of [...this.pool.keys()]) disposeRecord(this, alias);
	}
};
//#endregion
//#region src/http.ts
/** Default body cap for readJsonBody: 64 KiB. */
const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;
/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Lenient bounded body reader: parse a request body as JSON, or null on an
* empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
* Overflow destroys the request instead of draining the remainder (no drain
* call, matching the current repo-wide behavior); callers must not keep
* reading the request afterwards. With objectOnly, non-JSON-object payloads
* also yield null.
*/
async function readJsonBody(req, opts = {}) {
	const maxBytes = opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) {
			req.destroy();
			return null;
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		if (opts.objectOnly && !isJsonObject(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/** Whether a value is a JSON object: typeof object, not null, not an array. */
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Write one JSON response. Default headers are the family defaults
* (content-type and referrer-policy); caller headers are appended or
* override them.
*/
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
//#endregion
//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. The socket address is
* authoritative; X-Forwarded-For is never trusted.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/protocol.ts
const SSH_API = {
	hosts: "/api/dsh-ssh/hosts",
	importSshConfig: "/api/dsh-ssh/hosts/import-ssh-config",
	test: "/api/dsh-ssh/test",
	exec: "/api/dsh-ssh/exec",
	cluster: "/api/dsh-ssh/cluster",
	upload: "/api/dsh-ssh/upload",
	download: "/api/dsh-ssh/download",
	ls: "/api/dsh-ssh/ls",
	tunnel: "/api/dsh-ssh/tunnel",
	terminal: "/api/dsh-ssh/terminal"
};
//#endregion
//#region src/routes.ts
/**
* The /api/dsh-ssh route family: host CRUD, exec, cluster, SFTP transfer
* (NDJSON progress stream for uploads, binary stream for downloads), remote
* listing, tunnels, and the WebSocket PTY terminal upgrade. Every route
* carries a loopback-only trust fence (plus browser same-origin markers) —
* these endpoints execute commands on remote servers, so LAN-exposed dsh web
* deployments must not serve them.
*/
/** Cap on declared upload bodies (staged to disk before SFTP). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
/**
* One noServer WebSocket server for terminal upgrades: the browser half uses
* a standards-compliant WebSocket, so the host must speak real RFC 6455
* frames (the webserver hands us the raw upgraded socket).
*/
const terminalWss = new WebSocketServer({ noServer: true });
/** Pause the shell when the socket's send buffer exceeds this… */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024;
/** …and resume once it drains below this. */
const BACKPRESSURE_LOW_WATER = 512 * 1024;
/** URL query helper (first value, decoded). */
function queryParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null ? void 0 : value;
}
/**
* Build every /api/dsh-ssh route (exact paths) plus the terminal upgrade.
* @param deps - store, engine, staging dir.
* @returns routes and the upgrade route.
*/
function makeRoutes(deps) {
	const { store, engine } = deps;
	const staging = deps.stagingDir ?? join(tmpdir(), "dsh-ssh-uploads");
	const maxUploadBytes = deps.maxUploadBytes ?? MAX_UPLOAD_BYTES;
	mkdirSync(staging, {
		recursive: true,
		mode: 448
	});
	/** Guard helper: fence + method check. */
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	return {
		routes: [
			{
				kind: "exact",
				path: SSH_API.hosts,
				handler: async (req, res) => {
					const method = req.method ?? "GET";
					if (!isLoopbackRequest(req)) {
						writeJson(res, 403, { error: "forbidden: loopback-only" });
						return;
					}
					const url = new URL(req.url ?? "/", "http://localhost");
					if (method === "GET") {
						writeJson(res, 200, { hosts: engine.list(queryParam(url, "query")) });
						return;
					}
					if (method === "POST") {
						const body = await readJsonBody(req);
						if (body === null) {
							writeJson(res, 400, { error: "invalid JSON body" });
							return;
						}
						try {
							const entry = store.create(body);
							writeJson(res, 201, { host: store.summarize(entry) });
						} catch (error) {
							writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
						}
						return;
					}
					if (method !== "PATCH" && method !== "DELETE") {
						writeJson(res, 405, { error: `method not allowed: ${method}` });
						return;
					}
					const alias = queryParam(url, "alias");
					if (alias === void 0 || alias === "") {
						writeJson(res, 400, { error: "alias query parameter is required" });
						return;
					}
					if (method === "PATCH") {
						const body = await readJsonBody(req);
						if (body === null) {
							writeJson(res, 400, { error: "invalid JSON body" });
							return;
						}
						try {
							const entry = store.update(alias, body);
							const patch = body;
							if ([
								"host",
								"port",
								"user",
								"auth",
								"proxyJump",
								"proxyCommand"
							].some((key) => patch[key] !== void 0)) engine.dropAlias(alias);
							writeJson(res, 200, { host: store.summarize(entry) });
						} catch (error) {
							writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
						}
						return;
					}
					if (method === "DELETE") {
						try {
							engine.dropAlias(alias);
							store.delete(alias);
							writeJson(res, 200, { ok: true });
						} catch (error) {
							writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
						}
						return;
					}
					writeJson(res, 405, { error: `method not allowed: ${method}` });
				}
			},
			{
				kind: "exact",
				path: SSH_API.importSshConfig,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					try {
						writeJson(res, 200, { result: store.importFromSshConfig() });
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			},
			{
				kind: "exact",
				path: SSH_API.test,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					const alias = typeof body?.alias === "string" ? body.alias : "";
					if (alias === "") {
						writeJson(res, 400, { error: "alias is required" });
						return;
					}
					try {
						writeJson(res, 200, { result: await engine.test(alias) });
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			},
			{
				kind: "exact",
				path: SSH_API.exec,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					const alias = typeof body?.alias === "string" ? body.alias : "";
					const command = typeof body?.command === "string" ? body.command : "";
					if (alias === "" || command === "") {
						writeJson(res, 400, { error: "alias and command are required" });
						return;
					}
					const timeoutMs = typeof body?.timeoutMs === "number" ? body.timeoutMs : void 0;
					try {
						writeJson(res, 200, { result: await engine.exec(alias, command, timeoutMs) });
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			},
			{
				kind: "exact",
				path: SSH_API.cluster,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					const command = typeof body?.command === "string" ? body.command : "";
					if (command === "") {
						writeJson(res, 400, { error: "command is required" });
						return;
					}
					const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((x) => typeof x === "string") : void 0;
					const tags = Array.isArray(body?.tags) ? body.tags.filter((x) => typeof x === "string") : void 0;
					const environment = typeof body?.environment === "string" ? body.environment : void 0;
					const timeoutMs = typeof body?.timeoutMs === "number" ? body.timeoutMs : void 0;
					const maxWorkers = typeof body?.maxWorkers === "number" ? body.maxWorkers : void 0;
					const hasAliases = aliases?.some((alias) => alias.trim() !== "") === true;
					const hasEnvironment = typeof environment === "string" && environment.trim() !== "";
					const hasTags = tags?.some((tag) => tag.trim() !== "") === true;
					if (!hasAliases && !hasEnvironment && !hasTags) {
						writeJson(res, 400, { error: "ssh_cluster requires aliases, environment, or tags to limit the target set" });
						return;
					}
					try {
						writeJson(res, 200, { results: await engine.cluster({
							command,
							aliases,
							environment,
							tags,
							timeoutMs,
							maxWorkers
						}) });
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			},
			{
				kind: "exact",
				path: SSH_API.ls,
				handler: async (req, res) => {
					if (!guard(req, res, "GET")) return;
					const url = new URL(req.url ?? "/", "http://localhost");
					const alias = queryParam(url, "alias");
					const path = queryParam(url, "path") ?? "/";
					if (alias === void 0 || alias === "") {
						writeJson(res, 400, { error: "alias query parameter is required" });
						return;
					}
					try {
						writeJson(res, 200, { entries: await engine.ls(alias, path) });
					} catch (error) {
						writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			},
			{
				kind: "exact",
				path: SSH_API.tunnel,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					const action = typeof body?.action === "string" ? body.action : "";
					if (action === "list") {
						writeJson(res, 200, { tunnels: engine.listTunnels() });
						return;
					}
					if (action === "start") {
						const alias = typeof body?.alias === "string" ? body.alias : "";
						const remotePort = typeof body?.remotePort === "number" ? body.remotePort : void 0;
						if (alias === "" || remotePort === void 0) {
							writeJson(res, 400, { error: "alias and remotePort are required" });
							return;
						}
						try {
							writeJson(res, 200, { tunnel: await engine.startTunnel(alias, {
								remotePort,
								remoteHost: typeof body?.remoteHost === "string" && body.remoteHost !== "" ? body.remoteHost : void 0,
								localPort: typeof body?.localPort === "number" ? body.localPort : void 0
							}) });
						} catch (error) {
							writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
						}
						return;
					}
					if (action === "stop") {
						const id = typeof body?.tunnelId === "string" ? body.tunnelId : "";
						if (id === "") {
							writeJson(res, 400, { error: "tunnelId is required" });
							return;
						}
						writeJson(res, 200, { ok: engine.stopTunnel(id) });
						return;
					}
					if (action === "stop-all") {
						const alias = typeof body?.alias === "string" ? body.alias : void 0;
						writeJson(res, 200, { stopped: engine.stopAllTunnels(alias === "" ? void 0 : alias) });
						return;
					}
					writeJson(res, 400, { error: `unknown action '${action}'` });
				}
			},
			{
				kind: "exact",
				path: SSH_API.upload,
				handler: async (req, res) => {
					if (!guard(req, res, "POST")) return;
					const url = new URL(req.url ?? "/", "http://localhost");
					const alias = queryParam(url, "alias");
					const remotePath = queryParam(url, "remotePath");
					if (alias === void 0 || remotePath === void 0) {
						writeJson(res, 400, { error: "alias and remotePath query parameters are required" });
						return;
					}
					const declared = Number(req.headers["content-length"]);
					if (Number.isFinite(declared) && declared > maxUploadBytes) {
						writeJson(res, 413, { error: "upload body too large" });
						return;
					}
					res.writeHead(200, {
						"content-type": "application/x-ndjson; charset=utf-8",
						"cache-control": "no-cache",
						"referrer-policy": "no-referrer"
					});
					const emit = (line) => {
						try {
							res.write(JSON.stringify(line) + "\n");
						} catch {}
					};
					const tmp = join(staging, `upload-${randomBytes(6).toString("hex")}`);
					const sink = createWriteStream(tmp, { mode: 384 });
					let settled = false;
					const fail = (error) => {
						if (settled) return;
						settled = true;
						emit({
							type: "result",
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						});
						const cleanup = () => {
							unlink(tmp).catch(() => void 0).finally(() => {
								try {
									res.end();
								} catch {}
							});
						};
						if (sink.destroyed) cleanup();
						else {
							sink.once("close", cleanup);
							try {
								sink.destroy();
							} catch {
								cleanup();
							}
						}
					};
					const done = () => {
						if (settled) return;
						settled = true;
						try {
							res.end();
						} catch {}
					};
					sink.on("error", (error) => fail(error));
					req.on("error", (error) => fail(error));
					req.on("aborted", () => fail("upload aborted by the client"));
					res.on("error", () => fail("response stream closed"));
					res.on("close", () => {
						if (!res.writableEnded) fail("connection closed");
					});
					let received = 0;
					let capped = false;
					req.on("data", (chunk) => {
						received += chunk.byteLength;
						if (received > maxUploadBytes && !capped) {
							capped = true;
							fail("upload body too large");
							res.on("finish", () => {
								try {
									req.destroy();
								} catch {}
							});
							req.resume();
						}
					});
					req.pipe(sink);
					sink.on("finish", async () => {
						if (settled) return;
						emit({
							type: "progress",
							progress: {
								phase: "connecting",
								file: remotePath,
								transferred: 0,
								total: 0,
								percent: 0
							}
						});
						try {
							const outcome = await engine.upload(alias, tmp, remotePath, false, (progress) => emit({
								type: "progress",
								progress
							}));
							emit({
								type: "result",
								ok: true,
								transferredBytes: outcome.bytes
							});
						} catch (error) {
							emit({
								type: "result",
								ok: false,
								error: error instanceof Error ? error.message : String(error)
							});
						} finally {
							await unlink(tmp).catch(() => void 0);
							done();
						}
					});
				}
			},
			{
				kind: "exact",
				path: SSH_API.download,
				handler: async (req, res) => {
					if (!guard(req, res, "GET")) return;
					const url = new URL(req.url ?? "/", "http://localhost");
					const alias = queryParam(url, "alias");
					const remotePath = queryParam(url, "remotePath");
					if (alias === void 0 || remotePath === void 0) {
						writeJson(res, 400, { error: "alias and remotePath query parameters are required" });
						return;
					}
					const tmp = join(staging, `download-${randomBytes(6).toString("hex")}`);
					try {
						closeSync(openSync(tmp, "w", 384));
						const outcome = await engine.download(alias, remotePath, tmp);
						res.writeHead(200, {
							"content-type": "application/octet-stream",
							"content-length": String(outcome.bytes),
							"content-disposition": `attachment; filename="${basename(remotePath).replace(/"/g, "")}"`,
							"referrer-policy": "no-referrer"
						});
						await new Promise((resolve, reject) => {
							const source = createReadStream(tmp);
							source.on("error", reject);
							res.on("error", reject);
							source.pipe(res);
							source.on("end", resolve);
						});
					} catch (error) {
						if (!res.headersSent) writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
						else res.destroy();
					} finally {
						await unlink(tmp).catch(() => void 0);
					}
				}
			}
		],
		upgrade: {
			path: SSH_API.terminal,
			handler: (req, socket, head) => {
				if (!isLoopbackRequest(req)) {
					socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
					socket.destroy();
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = queryParam(url, "alias");
				if (alias === void 0) {
					socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
					socket.destroy();
					return;
				}
				const cols = Number.parseInt(queryParam(url, "cols") ?? "80", 10);
				const rows = Number.parseInt(queryParam(url, "rows") ?? "24", 10);
				terminalWss.handleUpgrade(req, socket, head, (ws) => {
					let session;
					let closed = false;
					let paused = false;
					let pendingAuthFinish;
					const resume = () => {
						if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) {
							paused = false;
							session?.resume();
						}
					};
					const sendFrame = (frame) => {
						if (closed || ws.readyState !== WebSocket.OPEN) return;
						ws.send(JSON.stringify(frame), resume);
						if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
							paused = true;
							session?.pause();
						}
					};
					const closeSession = () => {
						if (pendingAuthFinish !== void 0) {
							const fn = pendingAuthFinish;
							pendingAuthFinish = void 0;
							try {
								fn([]);
							} catch {}
						}
						const opened = session;
						session = void 0;
						if (opened !== void 0) opened.close();
					};
					const onKeyboardInteractive = (name, instructions, _lang, prompts, finish) => {
						const entry = store.find(alias);
						if (entry?.auth.kind === "password" && entry.auth.password !== void 0 && prompts.length > 0 && prompts.every((p) => /password/i.test(p.prompt))) {
							const password = entry.auth.password;
							finish(prompts.map(() => password));
							return;
						}
						pendingAuthFinish = finish;
						sendFrame({
							type: "auth_prompt",
							name,
							instructions,
							prompts: prompts.map((p) => ({
								prompt: p.prompt,
								echo: p.echo
							}))
						});
					};
					engine.openShell(alias, {
						cols: Number.isFinite(cols) ? cols : 80,
						rows: Number.isFinite(rows) ? rows : 24
					}, onKeyboardInteractive).then((opened) => {
						if (ws.readyState !== WebSocket.OPEN) {
							opened.close();
							return;
						}
						session = opened;
						sendFrame({
							type: "ready",
							alias
						});
						opened.onData = (data) => sendFrame({
							type: "output",
							data: data.toString("utf8")
						});
						opened.onExit = (code, error) => {
							sendFrame({
								type: "exit",
								code,
								error
							});
							closed = true;
							try {
								ws.close(1e3);
							} catch {}
						};
					}).catch((error) => {
						sendFrame({
							type: "exit",
							code: null,
							error: error instanceof Error ? error.message : String(error)
						});
						closed = true;
						try {
							ws.close(1e3);
						} catch {}
					});
					ws.on("message", (data) => {
						let frame;
						try {
							frame = JSON.parse(String(data));
						} catch {
							return;
						}
						if (frame.type === "input") session?.send(frame.data);
						else if (frame.type === "resize") session?.resize(Math.max(2, frame.cols), Math.max(1, frame.rows));
						else if (frame.type === "auth_response") {
							if (pendingAuthFinish !== void 0) {
								const fn = pendingAuthFinish;
								pendingAuthFinish = void 0;
								fn(frame.responses);
							}
						}
					});
					ws.on("close", () => {
						closed = true;
						closeSession();
					});
					ws.on("error", () => {
						closed = true;
						closeSession();
					});
				});
			}
		}
	};
}
//#endregion
//#region src/tools.ts
/**
* Agent tools: the DSH-native counterpart of ssh-skill's CLI. Every tool
* talks to the same engine the web UI uses, so a host configured in the GUI
* is immediately operable by any agent, and vice versa.
*/
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Project one summary onto the agent-facing row shape. */
function toAgentHostRow(host) {
	const { proxyCommand, ...rest } = host;
	return {
		...rest,
		proxyCommandConfigured: proxyCommand !== void 0
	};
}
/** Host table render shared by list surfaces. */
function renderHosts(hosts) {
	if (hosts.length === 0) return "no hosts configured";
	return [
		"alias | host | port | user | auth | proxy | environment | tags | description",
		"--- | --- | --- | --- | --- | --- | --- | --- | ---",
		...hosts.map((host) => [
			host.alias,
			host.host,
			String(host.port),
			host.user,
			host.auth,
			host.proxyJump.length > 0 ? "jump:" + host.proxyJump.join(",") : host.proxyCommandConfigured ? "proxy-command" : "-",
			host.environment ?? "-",
			host.tags.length > 0 ? host.tags.join(",") : "-",
			host.description ?? ""
		].join(" | "))
	].join("\n");
}
/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result) {
	const parts = [result.timedOut ? "[timed out]" : `[exit code: ${result.exitCode ?? "null"}]`];
	if (result.stdout !== "") parts.push("stdout:\n" + result.stdout);
	if (result.stderr !== "") parts.push("stderr:\n" + result.stderr);
	if (result.error !== void 0) parts.push("error: " + result.error);
	parts.push(`duration: ${result.durationMs} ms`);
	return parts.join("\n");
}
/** Render cluster outcomes compactly. */
function renderCluster(results) {
	if (results.length === 0) return "no hosts matched";
	return results.map((result) => {
		const status = result.ok ? "ok" : result.timedOut === true ? "timed out" : "failed";
		const tail = result.error !== void 0 ? " (" + result.error + ")" : "";
		return `${result.alias}: ${status} [exit code: ${result.exitCode ?? "null"}]${tail}`;
	}).join("\n");
}
/** One tunnel line. */
function renderTunnel(tunnel) {
	return `${tunnel.id} ${tunnel.alias} 127.0.0.1:${tunnel.localPort} -> ${tunnel.remoteHost}:${tunnel.remotePort} [${tunnel.state}]`;
}
/** The host-list tool. */
function sshListTool(engine) {
	return defineTool({
		name: "ssh_list",
		description: "List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias. Triggers: SSH, remote server, server IP/hostname, connect/login, check server/status, deploy, upload/download, jump host, tunnel, port forward.",
		parameters: { query: {
			type: "string",
			description: "Optional fuzzy match against alias, description, host, and tags."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { hosts: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							alias: {
								type: "string",
								required: true
							},
							host: {
								type: "string",
								required: true
							},
							port: {
								type: "integer",
								required: true
							},
							user: {
								type: "string",
								required: true
							},
							auth: {
								type: "string",
								enum: [
									"key",
									"password",
									"agent"
								],
								required: true
							},
							keyReady: {
								type: "boolean",
								required: true
							},
							proxyJump: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							proxyCommandConfigured: {
								type: "boolean",
								required: true
							},
							description: { type: "string" },
							environment: { type: "string" },
							tags: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							location: { type: "string" },
							createdAt: {
								type: "integer",
								required: true
							},
							updatedAt: {
								type: "integer",
								required: true
							}
						}
					}
				} }
			},
			render: (_args, value) => text(renderHosts(value.hosts ?? []))
		},
		async execute(args) {
			return { hosts: engine.list(args.query).map(toAgentHostRow) };
		}
	});
}
/** The command-execution tool. */
function sshExecTool(engine) {
	return defineTool({
		name: "ssh_exec",
		description: "Execute a shell command on a REMOTE SSH host by alias; the command runs on the remote host, never on this machine. For commands on this machine, use the local bash tool. Prefer combining independent read-only queries into one command. Triggers: run command on server, deploy, check server/status, service control, view logs, any remote operation.",
		parameters: {
			alias: {
				type: "string",
				required: true,
				description: "Host alias from ssh_list."
			},
			command: {
				type: "string",
				required: true,
				description: "The shell command to run remotely."
			},
			timeoutMs: {
				type: "integer",
				description: "Timeout in milliseconds (default 60000)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: {
						type: "boolean",
						required: true
					},
					exitCode: {
						oneOf: [{ type: "integer" }, { type: "null" }],
						required: true
					},
					timedOut: {
						type: "boolean",
						required: true
					},
					stdout: {
						type: "string",
						required: true
					},
					stderr: {
						type: "string",
						required: true
					},
					durationMs: {
						type: "integer",
						required: true
					},
					error: { type: "string" }
				}
			},
			render: (_args, value) => text(renderExec(value))
		},
		async execute(args) {
			try {
				return await engine.exec(args.alias, args.command, args.timeoutMs);
			} catch (error) {
				return {
					success: false,
					exitCode: null,
					timedOut: false,
					stdout: "",
					stderr: "",
					durationMs: 0,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	});
}
/** The upload tool. */
function sshUploadTool(engine) {
	return defineTool({
		name: "ssh_upload",
		description: "Transfer a file FROM this machine (the dsh host) TO a remote SSH host. Use this only when the file must be copied to the remote host. Files that stay on this machine are handled with the local file tools (read / write / edit), not ssh_upload. Triggers: upload file to server, deploy artifact, copy config to server.",
		parameters: {
			alias: {
				type: "string",
				required: true,
				description: "Host alias from ssh_list."
			},
			localPath: {
				type: "string",
				required: true,
				description: "Absolute path of the source file on THIS machine (the dsh host) — not a path on the remote host."
			},
			remotePath: {
				type: "string",
				required: true,
				description: "Absolute destination path on the remote SSH host (parent dirs are created)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					transferredBytes: { type: "integer" },
					files: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: (_args, value) => text(value.ok ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes` : `upload failed: ${value.error ?? "unknown error"}`)
		},
		async execute(args) {
			try {
				const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, false);
				return {
					ok: true,
					transferredBytes: outcome.bytes,
					files: outcome.files
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	});
}
/** The download tool. */
function sshDownloadTool(engine) {
	return defineTool({
		name: "ssh_download",
		description: "Copy a remote FILE from a configured SSH host to this machine (the dsh host). Use this only when the source is on the remote host; files already on this machine are read with the local file tools (read / write / edit), not ssh_download. Directory download is not supported — download files individually. Triggers: download file from server, fetch remote log/artifact.",
		parameters: {
			alias: {
				type: "string",
				required: true,
				description: "Host alias from ssh_list."
			},
			remotePath: {
				type: "string",
				required: true,
				description: "Absolute path of the source file on the remote SSH host."
			},
			localPath: {
				type: "string",
				required: true,
				description: "Absolute destination path on THIS machine (the dsh host)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					bytes: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: (_args, value) => text(value.ok ? `downloaded ${value.bytes ?? 0} bytes` : `download failed: ${value.error ?? "unknown error"}`)
		},
		async execute(args) {
			try {
				return {
					ok: true,
					bytes: (await engine.download(args.alias, args.remotePath, args.localPath)).bytes
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	});
}
/** The tunnel tool. */
function sshTunnelTool(engine) {
	return defineTool({
		name: "ssh_tunnel",
		description: "Manage local port-forward tunnels to a configured SSH host. Start a tunnel to reach a remote internal service (database, web UI, API) through 127.0.0.1 on this machine. Triggers: tunnel, port forward, connect database, access internal service.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"start",
					"list",
					"stop",
					"stop-all"
				],
				description: "start / list / stop / stop-all."
			},
			alias: {
				type: "string",
				description: "Host alias (required for start, optional for stop-all)."
			},
			remotePort: {
				type: "integer",
				description: "Port on the remote side (required for start)."
			},
			remoteHost: {
				type: "string",
				description: "Remote host to forward to (default 127.0.0.1 — the server itself)."
			},
			localPort: {
				type: "integer",
				description: "Local listening port (default: auto-assigned)."
			},
			tunnelId: {
				type: "string",
				description: "Tunnel id (required for stop)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					tunnel: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							alias: {
								type: "string",
								required: true
							},
							localPort: {
								type: "integer",
								required: true
							},
							remoteHost: {
								type: "string",
								required: true
							},
							remotePort: {
								type: "integer",
								required: true
							},
							state: {
								type: "string",
								enum: [
									"forwarding",
									"connecting",
									"failed"
								],
								required: true
							},
							error: { type: "string" },
							startedAt: {
								type: "integer",
								required: true
							}
						}
					},
					tunnels: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								alias: {
									type: "string",
									required: true
								},
								localPort: {
									type: "integer",
									required: true
								},
								remoteHost: {
									type: "string",
									required: true
								},
								remotePort: {
									type: "integer",
									required: true
								},
								state: {
									type: "string",
									enum: [
										"forwarding",
										"connecting",
										"failed"
									],
									required: true
								},
								error: { type: "string" },
								startedAt: {
									type: "integer",
									required: true
								}
							}
						}
					},
					stopped: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: (_args, value) => {
				if (value.error !== void 0) return text(`tunnel error: ${value.error}`);
				if (value.tunnel !== void 0) {
					if (value.tunnel.state === "failed") return text(`tunnel failed: ${value.tunnel.error ?? "unknown error"}`);
					return text(`tunnel started: ${renderTunnel(value.tunnel)}`);
				}
				if (value.tunnels !== void 0) return text(value.tunnels.length === 0 ? "no active tunnels" : value.tunnels.map(renderTunnel).join("\n"));
				return text(`stopped ${value.stopped ?? 0} tunnel(s)`);
			}
		},
		async execute(args) {
			if (args.action === "list") return {
				ok: true,
				tunnels: engine.listTunnels()
			};
			if (args.action === "start") {
				if (args.alias === void 0 || args.remotePort === void 0) throw new Error("alias and remotePort are required for start");
				try {
					return {
						ok: true,
						tunnel: await engine.startTunnel(args.alias, {
							remotePort: args.remotePort,
							remoteHost: args.remoteHost,
							localPort: args.localPort
						})
					};
				} catch (error) {
					return {
						ok: false,
						tunnel: {
							id: "",
							alias: args.alias,
							localPort: 0,
							remoteHost: args.remoteHost ?? "127.0.0.1",
							remotePort: args.remotePort,
							state: "failed",
							error: error instanceof Error ? error.message : String(error),
							startedAt: Date.now()
						}
					};
				}
			}
			if (args.action === "stop") {
				if (args.tunnelId === void 0) throw new Error("tunnelId is required for stop");
				return engine.stopTunnel(args.tunnelId) ? {
					ok: true,
					stopped: 1
				} : {
					ok: false,
					stopped: 0,
					error: `tunnel '${args.tunnelId}' not found`
				};
			}
			if (args.action === "stop-all") return {
				ok: true,
				stopped: engine.stopAllTunnels(args.alias)
			};
			throw new Error(`unknown action '${String(args.action)}'`);
		}
	});
}
/** The cluster tool. */
function sshClusterTool(engine) {
	return defineTool({
		name: "ssh_cluster",
		description: "Run one command concurrently across selected SSH hosts; at least one aliases, environment, or tags filter is required. Triggers: run on selected servers, batch operation, production servers, cluster command.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The shell command to run on every matched host."
			},
			aliases: {
				type: "array",
				items: { type: "string" },
				description: "Optional alias filter; at least one of aliases, environment, or tags is required."
			},
			environment: {
				type: "string",
				description: "Optional environment filter; at least one selector is required."
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Optional ALL-tags filter; at least one selector is required."
			},
			timeoutMs: {
				type: "integer",
				description: "Per-host timeout in milliseconds."
			},
			maxWorkers: {
				type: "integer",
				description: "Concurrency cap (default 8)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { results: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							alias: {
								type: "string",
								required: true
							},
							ok: {
								type: "boolean",
								required: true
							},
							exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
							timedOut: { type: "boolean" },
							stdout: { type: "string" },
							stderr: { type: "string" },
							durationMs: { type: "integer" },
							error: { type: "string" }
						}
					}
				} }
			},
			render: (_args, value) => text(renderCluster(value.results ?? []))
		},
		async execute(args) {
			if (!(Array.isArray(args.aliases) && args.aliases.some((alias) => typeof alias === "string" && alias.trim() !== "") || typeof args.environment === "string" && args.environment.trim() !== "" || Array.isArray(args.tags) && args.tags.some((tag) => typeof tag === "string" && tag.trim() !== ""))) throw new Error("ssh_cluster requires aliases, environment, or tags to limit the target set");
			return { results: await engine.cluster(args) };
		}
	});
}
//#endregion
//#region src/mount-once.ts
/**
* Host single-instance guard shared by the plugin family. The family bundle
* (dsh-web-all / dsh-skins) namespaces every child row id (web-ui-*), so
* the loader accepts a standalone install of the same package side by side;
* without this guard the second instance would still re-register the same
* webserver routes, tools, settings namespaces, and system-prompt sections
* and fail the boot. mountOnce makes the second host apply a no-op for the
* lifetime of the first instance (the browser half is already deduped by
* package name in the client module host).
*
* The registry rides a global symbol so two module instances of the same
* package (npm copy vs repository link) still share one verdict. cordis
* `ctx.effect` runs its callback immediately and treats the callback's
* return value as the fiber disposer, so the unmarker is returned, not run.
*/
const MOUNTED = Symbol.for("dsh-web.mounted-plugins");
function mountedSet() {
	const registry = globalThis;
	return registry[MOUNTED] ??= /* @__PURE__ */ new Set();
}
/**
* Wrap a cordis plugin apply so the package runs at most once per process.
* The first mount registers normally and unmarks when its fiber disposes;
* any later mount of the same package name is a no-op.
* @param packageName - npm package identity shared by every install source.
* @param fn - the original plugin apply.
* @returns an apply of the same shape.
*/
function mountOnce(packageName, fn) {
	return ((...args) => {
		const mounted = mountedSet();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		args[0]?.effect?.(() => () => {
			mounted.delete(packageName);
		});
		return fn(...args);
	});
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "ssh";
/** Services required before the SSH surfaces can mount. */
const inject = [
	"webServer",
	"tools",
	"systemPrompt"
];
/**
* Plugin config schema. Under the 0.1.7 settings model this schema IS the
* entry's settings page: the Host derives one form per profile entry from it
* and serves it through the shared configuration forms. Every field is
* `volatile()`, which is what puts it on that page and what lets an edit reach
* a running instance without a remount: the loader commits the new value into
* the field's reference and announces `loader/volatile-update` on this fiber.
*/
const Config = z.object({
	announceToAgent: z.boolean().default(false).volatile(),
	enabled: z.boolean().default(true).volatile(),
	terminalFontFamily: z.string().default("").volatile()
});
/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false;
const DEFAULT_ENABLED = true;
/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField(field, fallback) {
	if (field === void 0) return fallback;
	if (typeof field === "object" && field !== null && typeof field.get === "function") {
		const value = field.get();
		return value === void 0 ? fallback : value;
	}
	return field;
}
/** Raw config the profile declares for this entry, when the loader exposes it. */
function profileConfig(ctx) {
	const config = ctx.fiber.entry?.options?.config;
	if (typeof config !== "object" || config === null || Array.isArray(config)) return void 0;
	return config;
}
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const SSH_GUIDANCE = "本机已安装 dsh-ssh 插件（DSH 远程 SSH 运维）：侧边栏「SSH」入口；在 dsh-web 插件全家桶仓库（packages/dsh-ssh）统一维护。能力：主机配置存 $DSH_HOME/dsh-ssh.json（默认 ~/.dsh）（可从 ~/.ssh/config 导入）；持久连接池复用长连接（空闲 30 分钟自动断开）；ssh_list 列出主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、ssh_tunnel 本地端口转发（访问远程数据库/内网服务）、ssh_cluster 按 aliases/environment/tags 至少一种非空 selector 筛选后集群并发执行；支持密钥/密码/ssh-agent 认证、passphrase 密钥、ProxyJump 跳板机（别名或 [user@]host[:port] 地址）与 OpenSSH 语义的 ProxyCommand（跳过堡垒机客户端场景，只能由用户在 GUI 配置，agent 不可写）；Web 终端走 WebSocket。限制：主机操作由用户在 GUI 中配置后 agent 方可使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出原样返回、可能含敏感信息；断线重连可能重放非幂等命令；传输/执行消耗真实远程资源，先确认再操作。路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / bash），ssh_* 工具只针对远程主机上的路径。用户提到「SSH / 远程服务器 / 服务器操作 / 跳板机 / 隧道 / 部署 / 上传下载」时即指本插件，请据此协作。";
/**
* Mount the SSH engine, routes, tools, and announcement.
* @param ctx - host plugin context carrying webServer/tools/systemPrompt.
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
const apply = mountOnce("@linxin666/dsh-ssh", applyImpl);
function applyImpl(ctx, config) {
	const store = new HostStore();
	const engine = new SshEngine(store);
	ctx.effect(() => () => {
		engine.dispose();
	}, "dsh-ssh: engine");
	const resolve = () => {
		let enabled = readConfigField(config?.enabled, DEFAULT_ENABLED);
		if (enabled === false && profileConfig(ctx)?.enabled === void 0 && store.list().length > 0) enabled = true;
		return {
			announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE),
			enabled
		};
	};
	const { routes, upgrade } = makeRoutes({
		store,
		engine
	});
	let disposeRoutes;
	const tools = [
		sshListTool(engine),
		sshExecTool(engine),
		sshUploadTool(engine),
		sshDownloadTool(engine),
		sshTunnelTool(engine),
		sshClusterTool(engine)
	];
	let disposeTools;
	let disposeSection;
	const sync = () => {
		const value = resolve();
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (!value.enabled) return;
		if (value.announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-ssh",
			order: SECTION_ORDER,
			text: SSH_GUIDANCE
		});
		disposeRoutes = ctx.effect(() => {
			const disposers = routes.map((route) => ctx.webServer.register(route));
			const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade);
			return () => {
				for (const dispose of disposers) dispose();
				upgradeDisposer();
			};
		}, "dsh-ssh: routes");
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-ssh: tools");
	};
	ctx.on("loader/volatile-update", () => {
		sync();
	});
	sync();
}
//#endregion
export { Config, SSH_GUIDANCE, apply, inject, name };
