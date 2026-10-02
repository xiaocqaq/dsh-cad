import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/unit.ts
/**
* Unit conversion between metres (what the model speaks) and drawing units
* (what AutoCAD stores).
*
* The Codex-for-CAD evaluation recorded a concrete failure of exactly this
* kind: an offset of "500mm" was measured off the drawing with no scale bar,
* producing a wrong result. Keeping every tool input in metres and converting
* in one audited place removes the whole class of error, and returning both
* representations lets the model verify its own arithmetic against the drawing.
*/
var UnitConverter = class UnitConverter {
	/** Drawing units per metre. */
	unitsPerMeter;
	constructor(unitsPerMeter) {
		if (!Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0) throw new Error(`unitsPerMeter 必须是正数,收到: ${unitsPerMeter}`);
		this.unitsPerMeter = unitsPerMeter;
	}
	/** Engineering metres -> drawing units. */
	toDrawing(meters) {
		return meters * this.unitsPerMeter;
	}
	/** Drawing units -> engineering metres. */
	toMeters(units) {
		return units / this.unitsPerMeter;
	}
	pointToDrawing(p) {
		const out = {
			x: this.toDrawing(p.x),
			y: this.toDrawing(p.y)
		};
		if ("z" in p) return {
			...out,
			z: this.toDrawing(p.z)
		};
		return out;
	}
	pointsToDrawing(points) {
		return points.map((p) => this.pointToDrawing(p));
	}
	/** Round for display without introducing float noise like 1.0000000000000002. */
	static round(value, digits = 6) {
		const f = 10 ** digits;
		return Math.round(value * f) / f;
	}
	/**
	* Attach metre equivalents to an entity summary so the model always sees the
	* engineering value next to the raw drawing value.
	*/
	describeEntity(e) {
		const meters = {};
		if (e.measure?.length !== void 0) meters.length = UnitConverter.round(this.toMeters(e.measure.length));
		if (e.measure?.radius !== void 0) meters.radius = UnitConverter.round(this.toMeters(e.measure.radius));
		if (e.measure?.area !== void 0) meters.area = UnitConverter.round(this.toMeters(e.measure.area));
		return {
			...e,
			meters
		};
	}
};
//#endregion
//#region src/service.ts
/**
* Unit-aware façade over a {@link CadTransport}.
*
* Everything above this class speaks metres; everything below speaks drawing
* units. Keeping the conversion in one place is what stops the model from
* mixing a 500 mm offset into a millimetre drawing and silently producing a
* wrong result.
*/
var CadService = class {
	units;
	transport;
	constructor(transport, unitsPerMeter) {
		this.transport = transport;
		this.units = new UnitConverter(unitsPerMeter);
	}
	get backend() {
		return this.transport.kind;
	}
	async start() {
		await this.transport.start();
	}
	async stop() {
		await this.transport.stop();
	}
	/** Escape hatch for tools that need a raw op (e.g. `cad_run_command`). */
	async raw(request) {
		return this.transport.send(request);
	}
	/**
	* Backend-specific diagnostics for `cad_status`; `{}` when the transport has
	* none to report, so callers never have to branch on the backend kind.
	*/
	describeBackend() {
		return this.transport.describeBackend?.() ?? {};
	}
	/** Convert a tool-level point (metres) into a protocol point (drawing units). */
	p(p) {
		return this.units.pointToDrawing(p);
	}
	/** Attach metre equivalents so the model sees engineering values. */
	describe(entities) {
		return entities.map((e) => this.units.describeEntity(e));
	}
	/** Normalise a backend response into a {@link MutationOutcome}. */
	static outcome(response, summary) {
		if (!response.ok) return {
			ok: false,
			handles: [],
			warnings: [],
			summary,
			error: response.error
		};
		return {
			ok: true,
			handles: response.handles ?? [],
			warnings: response.warnings ?? [],
			summary
		};
	}
};
//#endregion
//#region src/transport/auto.ts
/**
* Prefer the resident AutoLISP dispatcher. COM is used only to load that
* dispatcher, or as a degraded backend when the load does not take.
*
* A missing capability stays a structured error. This class does not invent
* a result, and it does not call SetForegroundWindow.
*/
var AutoTransport = class {
	lisp;
	createCom;
	bootstrapTimeoutMs;
	com = null;
	selected;
	degraded = "";
	bootstrapped = false;
	constructor(options) {
		this.lisp = options.lisp;
		this.createCom = options.createCom;
		this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 8e3;
		this.selected = options.lisp;
	}
	get kind() {
		return this.selected.kind;
	}
	async start() {
		await this.lisp.start();
		if (this.lisp.heartbeatFresh()) {
			this.selected = this.lisp;
			this.degraded = "";
			return;
		}
		try {
			const com = this.createCom();
			await com.start();
			this.com = com;
		} catch (err) {
			this.selected = this.lisp;
			this.degraded = err instanceof Error ? err.message : String(err);
			return;
		}
		this.lisp.setNudge(async () => {
			if (!this.com) return;
			await this.com.send({
				op: "runCommand",
				command: "(dsh:tick-now)"
			});
		});
		if (await this.loadDispatcher()) {
			this.selected = this.lisp;
			this.bootstrapped = true;
			this.degraded = this.lisp.heartbeatFresh() ? "" : "这台 AutoCAD 没有定时器反应器。图元数据走 File IPC，每次请求用一次 (dsh:tick-now) 唤醒，不抢焦点。";
			return;
		}
		this.selected = this.com;
		this.degraded = "已尝试加载 AutoLISP 调度器，但未写出 ready.lsp，继续使用 COM";
	}
	async stop() {
		await this.lisp.stop();
		if (this.com) await this.com.stop();
	}
	async send(request) {
		return this.selected.send(request);
	}
	describeBackend() {
		return {
			...this.com?.describeBackend?.() ?? {},
			...this.lisp.describeBackend(),
			selected: this.selected.kind,
			degraded: this.degraded,
			bootstrapped: this.bootstrapped
		};
	}
	async loadDispatcher() {
		if (!this.com) return false;
		const form = `(progn (setq dsh:ipc-dir "${this.lisp.dir.replace(/\\/g, "/")}/") (load "${this.lisp.scriptPath.replace(/\\/g, "/")}"))`;
		if (!(await this.com.send({
			op: "runCommand",
			command: form
		})).ok) return false;
		return this.lisp.waitForReady(this.bootstrapTimeoutMs);
	}
};
//#endregion
//#region src/transport/com.ts
const BRIDGE_RELATIVE = join("assets", "cad-bridge.ps1");
/**
* Drives a running AutoCAD through its COM API.
*
* AutoCAD registers itself as an automation server, so the plugin can attach to
* the engineer's open session with nothing installed inside AutoCAD and no
* compiled DLL. A long-lived PowerShell child process holds the COM reference
* and answers newline-delimited JSON on stdio; keeping one process alive
* matters because attaching and detaching per call would be slow and would
* churn the document's modified flag.
*/
var ComTransport = class {
	kind = "com";
	child = null;
	ready = null;
	pending = /* @__PURE__ */ new Map();
	seq = 0;
	stopped = false;
	options;
	/** Stamp of the bridge script the live child loaded; null while none runs. */
	loadedStamp = null;
	constructor(options) {
		this.options = options;
	}
	resolveScript() {
		if (this.options.scriptPath) return this.options.scriptPath;
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [join(here, "..", "..", BRIDGE_RELATIVE), join(here, "..", BRIDGE_RELATIVE)];
		for (const candidate of candidates) if (existsSync(candidate)) return candidate;
		return candidates[1];
	}
	stampOf(script) {
		try {
			const s = statSync(script);
			return {
				path: script,
				mtimeMs: s.mtimeMs,
				size: s.size
			};
		} catch {
			return null;
		}
	}
	/**
	* Restart the child when the bridge script on disk has changed.
	*
	* Windows PowerShell reads the whole script into memory at startup and never
	* re-reads it, so a plugin upgrade would otherwise keep executing the old
	* bridge for as long as the process lives. That failure is silent and is
	* indistinguishable from the new code being broken. One `statSync` per
	* request is cheap, and restarting here makes an upgrade take effect without
	* restarting the host.
	*/
	restartIfScriptChanged() {
		const child = this.child;
		const loaded = this.loadedStamp;
		if (!child || !loaded) return;
		if (this.pending.size > 0) return;
		const current = this.stampOf(this.resolveScript());
		if (!current) return;
		if (current.path === loaded.path && current.mtimeMs === loaded.mtimeMs && current.size === loaded.size) return;
		this.loadedStamp = null;
		this.child = null;
		this.ready = null;
		if (child.exitCode === null) child.kill();
	}
	/** Diagnostics surfaced by `cad_status`. */
	describeBackend() {
		return {
			bridgeScript: this.resolveScript(),
			bridgeLoadedAt: this.loadedStamp ? new Date(this.loadedStamp.mtimeMs).toISOString() : null,
			bridgeRunning: this.child !== null && this.child.exitCode === null
		};
	}
	async start() {
		if (this.ready) return this.ready;
		this.stopped = false;
		this.ready = this.spawnBridge();
		return this.ready;
	}
	spawnBridge() {
		return new Promise((resolve, reject) => {
			const ps = this.options.powershell ?? "powershell.exe";
			const script = this.resolveScript();
			this.loadedStamp = this.stampOf(script);
			const args = [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script,
				"-ProgId",
				this.options.progId,
				"-ProgIdFallbacks",
				this.options.progIdFallbacks.join(",")
			];
			const child = spawn(ps, args, { stdio: [
				"pipe",
				"pipe",
				"pipe"
			] });
			this.child = child;
			let settled = false;
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk) => {
				stderr = (stderr + chunk).slice(-4e3);
			});
			createInterface({ input: child.stdout }).on("line", (line) => {
				const text = line.trim();
				if (!text) return;
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					return;
				}
				if (parsed.ready) {
					if (!settled) {
						settled = true;
						resolve();
					}
					return;
				}
				if (parsed.error && !parsed.id) {
					if (!settled) {
						settled = true;
						reject(new Error(parsed.error));
					}
					return;
				}
				if (parsed.id && parsed.response) {
					const p = this.pending.get(parsed.id);
					if (p) {
						clearTimeout(p.timer);
						this.pending.delete(parsed.id);
						p.resolve(parsed.response);
					}
				}
			});
			child.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(/* @__PURE__ */ new Error(`无法启动 PowerShell 桥接进程: ${err.message}`));
				}
			});
			child.on("exit", (code) => {
				const err = /* @__PURE__ */ new Error(`CAD 桥接进程已退出 (code=${code ?? "null"})。${stderr ? `\n${stderr}` : ""}`);
				if (this.child === child) {
					this.child = null;
					this.ready = null;
					this.loadedStamp = null;
					for (const [id, p] of this.pending) {
						clearTimeout(p.timer);
						this.pending.delete(id);
						p.resolve({
							ok: false,
							error: {
								code: "NOT_CONNECTED",
								message: err.message
							}
						});
					}
				}
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}
	async send(request) {
		if (this.stopped) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "桥接已停止"
			}
		};
		try {
			this.restartIfScriptChanged();
			await this.start();
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "BACKEND_UNAVAILABLE",
					message: err instanceof Error ? err.message : String(err)
				}
			};
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "桥接进程不可用"
			}
		};
		this.seq += 1;
		const id = `r${this.seq}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({
					ok: false,
					error: {
						code: "TIMEOUT",
						message: `CAD 操作超过 ${this.options.requestTimeoutMs}ms 未返回`
					}
				});
			}, this.options.requestTimeoutMs);
			this.pending.set(id, {
				resolve,
				timer
			});
			child.stdin.write(`${JSON.stringify({
				id,
				request
			})}\n`);
		});
	}
	async stop() {
		this.stopped = true;
		const child = this.child;
		this.child = null;
		this.ready = null;
		this.loadedStamp = null;
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.resolve({
				ok: false,
				error: {
					code: "NOT_CONNECTED",
					message: "桥接已停止"
				}
			});
		}
		if (!child || child.exitCode !== null) return;
		await new Promise((resolve) => {
			child.once("exit", () => resolve());
			child.stdin?.end();
			setTimeout(() => {
				child.kill();
				resolve();
			}, 2e3).unref?.();
		});
	}
};
//#endregion
//#region src/transport/sexpr.ts
function encodeSexpr(value) {
	if (value === null) return "nil";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("sexpr 不能编码非有限数字");
		return String(value);
	}
	if (typeof value === "string") return `"${escapeString(value)}"`;
	return `(${value.map(encodeSexpr).join(" ")})`;
}
/** Drop `undefined` fields so optional request properties stay absent. */
function toSexpr(value) {
	if (value === null || value === void 0) return null;
	if (typeof value === "string" || typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (Array.isArray(value)) return value.map(toSexpr);
	if (typeof value === "object") return Object.entries(value).filter(([, v]) => v !== void 0).map(([k, v]) => [k, toSexpr(v)]);
	return String(value);
}
/**
* A list of `("key" value)` pairs becomes an object. Any other list, including
* `()`, becomes an array. That is how an empty `warnings` list stays an array
* instead of collapsing into an empty object.
*/
function fromSexpr(value) {
	if (!Array.isArray(value)) return value;
	if (isAlist(value)) {
		const obj = {};
		for (const pair of value) {
			const key = pair[0];
			const child = pair[1];
			if (typeof key !== "string" || child === void 0) continue;
			obj[key] = fromSexpr(child);
		}
		return obj;
	}
	return value.map((item) => fromSexpr(item));
}
function decodeSexpr(text) {
	const parser = new Parser(text);
	const value = parser.parse();
	parser.skip();
	if (!parser.eof()) throw new Error("sexpr 尾部有多余内容");
	return value;
}
function isPair(item) {
	if (!Array.isArray(item) || item.length !== 2) return false;
	return typeof item[0] === "string";
}
function isAlist(value) {
	return value.length > 0 && value.every(isPair);
}
function escapeString(value) {
	let out = "";
	for (const ch of value) {
		const cp = ch.codePointAt(0) ?? 0;
		if (ch === "\\") out += "\\\\";
		else if (ch === "\"") out += "\\\"";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "	") out += "\\t";
		else if (cp < 32 || cp > 126) out += `\\U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
		else out += ch;
	}
	return out;
}
var Parser = class {
	i = 0;
	text;
	constructor(text) {
		this.text = text;
		if (text.charCodeAt(0) === 65279) this.i = 1;
	}
	eof() {
		return this.i >= this.text.length;
	}
	parse() {
		this.skip();
		const c = this.text[this.i];
		if (c === void 0) throw new Error("sexpr 意外结束");
		if (c === "(") return this.parseList();
		if (c === "\"") return this.parseString();
		return this.parseAtom();
	}
	skip() {
		while (this.i < this.text.length) {
			const c = this.text[this.i];
			if (c === ";") {
				while (this.i < this.text.length && this.text[this.i] !== "\n") this.i += 1;
				continue;
			}
			if (c === " " || c === "\n" || c === "\r" || c === "	") {
				this.i += 1;
				continue;
			}
			break;
		}
	}
	parseList() {
		this.i += 1;
		const items = [];
		for (;;) {
			this.skip();
			if (this.i >= this.text.length) throw new Error("sexpr 列表没有闭合");
			if (this.text[this.i] === ")") {
				this.i += 1;
				return items;
			}
			if (this.text[this.i] === ".") throw new Error("sexpr 不支持点对");
			items.push(this.parse());
		}
	}
	parseString() {
		this.i += 1;
		let out = "";
		while (this.i < this.text.length) {
			const c = this.text[this.i];
			if (c === "\"") {
				this.i += 1;
				return out;
			}
			if (c !== "\\") {
				out += c;
				this.i += 1;
				continue;
			}
			const next = this.text[this.i + 1];
			if (next === void 0) throw new Error("sexpr 字符串转义不完整");
			if (next === "U" && this.text[this.i + 2] === "+") {
				const hex = this.text.slice(this.i + 3, this.i + 7);
				if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error("sexpr \\U+ 转义无效");
				out += String.fromCodePoint(Number.parseInt(hex, 16));
				this.i += 7;
				continue;
			}
			out += {
				"\\": "\\",
				"\"": "\"",
				n: "\n",
				r: "\r",
				t: "	"
			}[next] ?? next;
			this.i += 2;
		}
		throw new Error("sexpr 字符串没有闭合");
	}
	parseAtom() {
		const start = this.i;
		while (this.i < this.text.length && !" \n\r	();".includes(this.text[this.i] ?? "")) this.i += 1;
		const tok = this.text.slice(start, this.i);
		if (tok.length === 0) throw new Error("sexpr 缺少原子");
		if (tok === "nil") return null;
		if (tok === "t" || tok === "T") return 1;
		if (/^-?\d+$/.test(tok)) return Number(tok);
		if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(tok) || /^-?\d+[eE][+-]?\d+$/.test(tok)) return Number(tok);
		throw new Error(`sexpr 无法识别: ${tok}`);
	}
};
const ASSET_NAME = "cad-ipc.lsp";
const ERROR_CODES = /* @__PURE__ */ new Set([
	"BACKEND_UNAVAILABLE",
	"NOT_CONNECTED",
	"TIMEOUT",
	"NO_DOCUMENT",
	"NOT_FOUND",
	"INVALID_ARGUMENT",
	"UNSUPPORTED",
	"BACKEND_ERROR"
]);
/**
* File IPC transport.
*
* AutoCAD writes `res-<id>.lsp` after something calls `dsh:tick`. This
* process never calls SetForegroundWindow. This AutoCAD build has no
* `vlr-timer-reactor`, so a fresh heartbeat is not assumed to mean a
* poller is still running. If a nudge is set, each request is followed by
* that nudge. Without a nudge and without a fresh heartbeat, the call
* fails with `BACKEND_UNAVAILABLE` and the APPLOAD path.
*/
var LispIpcTransport = class {
	kind = "lisp-ipc";
	dir;
	scriptPath;
	timeoutMs;
	freshMs;
	started = false;
	tail = Promise.resolve();
	nudge = null;
	constructor(options) {
		this.dir = options.ipcDir && options.ipcDir.length > 0 ? options.ipcDir : defaultIpcDir();
		this.scriptPath = resolveAsset(ASSET_NAME, options.scriptPath);
		this.timeoutMs = options.requestTimeoutMs;
		this.freshMs = options.heartbeatFreshMs ?? 3e3;
	}
	async start() {
		mkdirSync(this.dir, { recursive: true });
		this.started = true;
	}
	async stop() {
		this.started = false;
	}
	async send(request) {
		if (!this.started) await this.start();
		return this.enqueue(() => this.roundTrip(request));
	}
	describeBackend() {
		const hb = this.readHeartbeat();
		return {
			ipcDir: this.dir,
			ipcFresh: hb.fresh,
			ipcAgeMs: hb.ageMs,
			ipcVersion: hb.version,
			dispatcherScript: this.scriptPath,
			ipcActiveX: hb.activeX,
			ipcDocument: hb.document
		};
	}
	heartbeatFresh() {
		return this.readHeartbeat().fresh;
	}
	/** Wake the resident dispatcher after the inbox has been written. */
	setNudge(fn) {
		this.nudge = fn;
	}
	async waitForReady(timeoutMs) {
		const since = Date.now() - 1e3;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.heartbeatFresh() || this.readySince(since)) return true;
			await delay(100);
		}
		return this.heartbeatFresh() || this.readySince(since);
	}
	readySince(since) {
		const path = join(this.dir, "ready.lsp");
		if (!existsSync(path)) return false;
		try {
			return statSync(path).mtimeMs >= since;
		} catch {
			return false;
		}
	}
	async waitForHeartbeat(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.heartbeatFresh()) return true;
			await delay(100);
		}
		return this.heartbeatFresh();
	}
	async roundTrip(request) {
		const hb = this.readHeartbeat();
		if (hb.version && hb.version !== "1") return {
			ok: false,
			error: {
				code: "BACKEND_UNAVAILABLE",
				message: `调度器协议版本是 ${hb.version}，插件需要 1。请重新 APPLOAD: ${this.scriptPath}`
			}
		};
		if (!hb.fresh && !this.nudge) return {
			ok: false,
			error: {
				code: "BACKEND_UNAVAILABLE",
				message: `AutoLISP 调度器未在运行。请在 AutoCAD 中 APPLOAD 一次: ${this.scriptPath}（或让 transport=auto 通过 COM 加载后用 (dsh:tick) 唤醒）。心跳目录: ${this.dir}`
			}
		};
		const id = randomBytes(8).toString("hex");
		const inbox = join(this.dir, `req-${id}.lsp`);
		const responsePath = join(this.dir, `res-${id}.lsp`);
		const cancelPath = join(this.dir, `cancel-${id}.lsp`);
		const body = encodeSexpr(toSexpr({
			id,
			...request
		})) + "\n";
		try {
			await writeAtomic(inbox, body);
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "BACKEND_ERROR",
					message: `无法写入调度请求: ${err instanceof Error ? err.message : String(err)}`
				}
			};
		}
		if (this.nudge) try {
			await this.nudge();
		} catch (err) {
			await removeQuiet(inbox);
			return {
				ok: false,
				error: {
					code: "BACKEND_UNAVAILABLE",
					message: `无法唤醒 AutoLISP 调度器: ${err instanceof Error ? err.message : String(err)}`
				}
			};
		}
		const deadline = Date.now() + this.timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(responsePath)) {
				const text = await readFile(responsePath, "utf8");
				await rm(responsePath, { force: true });
				return verifyMutation(request, parseResponse(text));
			}
			await delay(50);
		}
		await writeFile(cancelPath, encodeSexpr([["id", id]]) + "\n", "utf8");
		await removeQuiet(inbox);
		return {
			ok: false,
			error: {
				code: "TIMEOUT",
				message: `AutoLISP 调度器在 ${this.timeoutMs}ms 内没有响应 ${request.op}`
			}
		};
	}
	readHeartbeat() {
		const path = join(this.dir, "heartbeat.lsp");
		try {
			const st = statSync(path);
			const ageMs = Math.max(0, Math.round(Date.now() - st.mtimeMs));
			let version = "";
			let activeX = false;
			let document = "";
			try {
				const raw = fromSexpr(decodeSexpr(readFileSync(path, "utf8")));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					const rec = raw;
					version = rec.version == null ? "" : String(rec.version);
					activeX = rec.activeX === 1;
					document = rec.document == null ? "" : String(rec.document);
				}
			} catch {}
			return {
				fresh: ageMs < this.freshMs,
				ageMs,
				version,
				activeX,
				document
			};
		} catch {
			return {
				fresh: false,
				ageMs: -1,
				version: "",
				activeX: false,
				document: ""
			};
		}
	}
	enqueue(fn) {
		const run = this.tail.then(fn, fn);
		this.tail = run.then(() => void 0, () => void 0);
		return run;
	}
};
function defaultIpcDir() {
	const base = process.env.LOCALAPPDATA || process.env.TEMP || process.cwd();
	return join(base, "dsh-cad", "ipc");
}
function resolveAsset(name, override) {
	if (override) return override;
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "..", "..", "assets", name), join(here, "..", "assets", name)];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return candidates[1];
}
async function removeQuiet(path) {
	try {
		await rm(path, { force: true });
	} catch {}
}
async function writeAtomic(path, text) {
	const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rm(path, { force: true });
	try {
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}
function parseResponse(text) {
	let value;
	try {
		value = fromSexpr(decodeSexpr(text));
	} catch (err) {
		return {
			ok: false,
			error: {
				code: "BACKEND_ERROR",
				message: `调度器响应无法解析: ${err instanceof Error ? err.message : String(err)}`
			}
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {
		ok: false,
		error: {
			code: "BACKEND_ERROR",
			message: "调度器响应不是对象"
		}
	};
	const rec = value;
	if (rec.ok !== 1) return {
		ok: false,
		error: {
			code: typeof rec.code === "string" && ERROR_CODES.has(rec.code) ? rec.code : "BACKEND_ERROR",
			message: typeof rec.message === "string" ? rec.message : "调度器返回了失败"
		}
	};
	const response = {
		ok: true,
		data: coerceFlags(rec.data ?? {})
	};
	if (Array.isArray(rec.handles)) response.handles = rec.handles.map((h) => String(h));
	if (Array.isArray(rec.warnings)) response.warnings = rec.warnings.map((w) => String(w));
	return response;
}
/** Layer flags cross the file as 0/1. The tool schema wants booleans. */
function coerceFlags(value) {
	if (Array.isArray(value)) return value.map(coerceFlags);
	if (!value || typeof value !== "object") return value;
	const rec = value;
	const out = {};
	for (const key of Object.keys(rec)) {
		const child = rec[key];
		if ((key === "on" || key === "frozen" || key === "locked") && (child === 0 || child === 1)) out[key] = child === 1;
		else out[key] = coerceFlags(child);
	}
	return out;
}
function verifyMutation(request, response) {
	if (!response.ok) return response;
	const handles = response.handles ?? [];
	const warnings = response.warnings ?? [];
	if ((request.op === "draw" || request.op === "addDimension" || request.op === "addHatch" || request.op === "modify") && handles.length === 0) return {
		ok: false,
		error: {
			code: "BACKEND_ERROR",
			message: `${request.op} 报告成功但没有可回读的句柄`
		}
	};
	if ((request.op === "transform" || request.op === "delete") && handles.length === 0 && warnings.length === 0) return {
		ok: false,
		error: {
			code: "BACKEND_ERROR",
			message: `${request.op} 没有改到任何图元，也没有说明跳过原因`
		}
	};
	return response;
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/transport/sim-document.ts
function dist(a, b) {
	return Math.hypot(b.x - a.x, b.y - a.y);
}
function centroid(points) {
	const sum = points.reduce((acc, p) => ({
		x: acc.x + p.x,
		y: acc.y + p.y
	}), {
		x: 0,
		y: 0
	});
	return {
		x: sum.x / points.length,
		y: sum.y / points.length
	};
}
/** Shoelace area; positive for counter-clockwise rings. */
function ringArea(points) {
	let a = 0;
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		const q = points[(i + 1) % points.length];
		a += p.x * q.y - q.x * p.y;
	}
	return Math.abs(a) / 2;
}
function bboxOf(points) {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const zs = points.map((p) => "z" in p ? p.z : 0);
	return {
		min: {
			x: Math.min(...xs),
			y: Math.min(...ys),
			z: Math.min(...zs)
		},
		max: {
			x: Math.max(...xs),
			y: Math.max(...ys),
			z: Math.max(...zs)
		}
	};
}
/**
* An in-memory drawing that speaks the same operation surface as the COM
* backend. It exists so every tool, the service layer and the tests can run on
* a machine with no AutoCAD installed, and so prompt rehearsals never risk a
* real drawing.
*/
var SimulatedDocument = class {
	entities = /* @__PURE__ */ new Map();
	counter = 0;
	doc = {
		name: "Drawing1.dwg",
		path: null,
		unitsName: "Unitless",
		modelSpaceCount: 0,
		activeSpace: "model"
	};
	layers = /* @__PURE__ */ new Map();
	commandLog = [];
	constructor() {
		this.layers.set("0", {
			name: "0",
			color: 7,
			linetype: "Continuous",
			on: true,
			frozen: false,
			locked: false,
			entityCount: 0
		});
	}
	get document() {
		return {
			...this.doc,
			modelSpaceCount: this.entities.size
		};
	}
	get commands() {
		return this.commandLog;
	}
	nextHandle() {
		this.counter += 1;
		return `SIM${String(this.counter).padStart(5, "0")}`;
	}
	/** Create the layer if absent, mirroring AutoCAD's implicit-layer behaviour. */
	ensureLayer(name) {
		if (this.layers.has(name)) return;
		this.layers.set(name, {
			name,
			color: 7,
			linetype: "Continuous",
			on: true,
			frozen: false,
			locked: false,
			entityCount: 0
		});
	}
	recountLayers() {
		const counts = /* @__PURE__ */ new Map();
		for (const e of this.entities.values()) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
		for (const [name, info] of this.layers) info.entityCount = counts.get(name) ?? 0;
	}
	listLayers() {
		this.recountLayers();
		return [...this.layers.values()].map((l) => ({ ...l })).sort((a, b) => a.name.localeCompare(b.name));
	}
	open(req) {
		const name = req.path.split(/[\\/]/).pop() ?? req.path;
		this.entities.clear();
		this.counter = 0;
		this.doc = {
			...this.doc,
			name,
			path: req.path
		};
	}
	saveAs(req) {
		const name = req.path.split(/[\\/]/).pop() ?? req.path;
		this.doc = {
			...this.doc,
			name,
			path: req.path
		};
		return req.path;
	}
	runCommand(req) {
		const line = [req.command, ...req.args ?? []].join(" ");
		this.commandLog.push(line);
		return [line];
	}
	createEntity(spec, warnings) {
		const layer = spec.layer ?? "0";
		this.ensureLayer(layer);
		const handle = this.nextHandle();
		const base = {
			handle,
			kind: spec.kind,
			layer,
			color: spec.color ?? 256,
			linetype: "ByLayer"
		};
		switch (spec.kind) {
			case "line": {
				const len = dist(spec.start, spec.end);
				if (len === 0) warnings.push(`零长度直线已跳过 (${handle})`);
				base.measure = { length: len };
				base.points = [spec.start, spec.end];
				break;
			}
			case "circle":
				if (spec.radius <= 0) warnings.push(`非正半径圆已跳过 (${handle})`);
				base.measure = { radius: spec.radius };
				base.radius = spec.radius;
				base.points = [spec.center];
				break;
			case "arc": {
				if (spec.radius <= 0) warnings.push(`非正半径圆弧已跳过 (${handle})`);
				const sweep = ((spec.endAngle - spec.startAngle) % 360 + 360) % 360;
				base.measure = {
					radius: spec.radius,
					angle: sweep
				};
				base.radius = spec.radius;
				base.startAngle = spec.startAngle;
				base.endAngle = spec.endAngle;
				base.points = [spec.center];
				break;
			}
			case "polyline": {
				if (spec.vertices.length < 2) warnings.push(`顶点不足的多段线已跳过 (${handle})`);
				const pts = spec.closed ? [...spec.vertices, spec.vertices[0]] : spec.vertices;
				const length = pts.slice(1).reduce((acc, p, i) => acc + dist(pts[i], p), 0);
				base.measure = spec.closed ? {
					length,
					area: ringArea(spec.vertices)
				} : { length };
				base.points = spec.vertices;
				break;
			}
			case "text": {
				base.text = spec.text;
				const h = spec.height ?? 2.5;
				base.height = h;
				base.rotation = spec.rotation ?? 0;
				base.measure = { length: spec.text.length * (h * .6) };
				base.points = [spec.position];
				break;
			}
			case "mtext": {
				base.text = spec.text;
				const h = spec.height ?? 2.5;
				const w = spec.width ?? 100;
				base.height = h;
				const box = [
					spec.position,
					{
						x: spec.position.x + w,
						y: spec.position.y
					},
					{
						x: spec.position.x + w,
						y: spec.position.y + h * 4
					},
					{
						x: spec.position.x,
						y: spec.position.y + h * 4
					}
				];
				base.measure = {
					length: spec.text.length * (h * .6),
					area: ringArea(box)
				};
				base.points = [spec.position];
				break;
			}
		}
		this.entities.set(handle, base);
		return handle;
	}
	draw(req) {
		const warnings = [];
		return {
			handles: req.items.map((spec) => this.createEntity(spec, warnings)),
			warnings
		};
	}
	query(req) {
		const out = [];
		for (const e of this.entities.values()) {
			if (req.layer && e.layer.toLowerCase() !== req.layer.toLowerCase()) continue;
			if (req.kind && e.kind !== req.kind) continue;
			if (req.textContains) {
				if (!(e.text ?? "").toLowerCase().includes(req.textContains.toLowerCase())) continue;
			}
			if (req.window) {
				const c = e.points?.length ? centroid(e.points) : void 0;
				if (!c) continue;
				const { min, max } = req.window;
				if (c.x < min.x || c.x > max.x || c.y < min.y || c.y > max.y) continue;
			}
			out.push(this.summarize(e));
		}
		return req.limit ? out.slice(0, req.limit) : out;
	}
	summarize(e) {
		const pts = e.points ?? [];
		const summary = {
			handle: e.handle,
			kind: e.kind,
			layer: e.layer,
			bbox: pts.length ? bboxOf(pts) : null,
			color: e.color,
			linetype: e.linetype
		};
		if (e.measure) summary.measure = { ...e.measure };
		if (e.text !== void 0) summary.text = e.text;
		return summary;
	}
	getEntity(req) {
		const e = this.entities.get(req.handle);
		return e ? this.summarize(e) : void 0;
	}
	addDimension(req) {
		const warnings = [];
		const handle = this.nextHandle();
		this.ensureLayer(req.layer ?? "0");
		const expected = req.kind === "angular" ? 3 : 2;
		if (req.points.length !== expected) {
			const detail = req.kind === "angular" ? "角度标注需要 3 个点(顶点和两条射线端点)" : req.kind === "radius" ? "半径标注需要 2 个点(圆心和圆周点)" : req.kind === "diameter" ? "直径标注需要 2 个点(直径两端)" : "线性/对齐标注需要 2 个点";
			throw new Error(detail);
		}
		const span = dist(req.points[0], req.points[1]);
		const measure = req.kind === "angular" ? { angle: Math.atan2(req.points[2].y - req.points[0].y, req.points[2].x - req.points[0].x) - Math.atan2(req.points[1].y - req.points[0].y, req.points[1].x - req.points[0].x) } : req.kind === "radius" ? { radius: span } : { length: req.kind === "diameter" ? span : span };
		this.entities.set(handle, {
			handle,
			kind: "dimension",
			layer: req.layer ?? "0",
			color: req.color ?? 256,
			linetype: "ByLayer",
			text: req.textOverride,
			points: req.points,
			measure
		});
		return {
			handle,
			warnings
		};
	}
	addHatch(req) {
		const warnings = [];
		if (req.loops.length === 0) throw new Error("填充至少需要一个闭合边界环");
		for (const loop of req.loops) if (loop.length < 3) throw new Error("填充边界环至少需要 3 个顶点");
		const handle = this.nextHandle();
		this.ensureLayer(req.layer ?? "0");
		const area = req.loops.reduce((acc, loop) => acc + ringArea(loop), 0);
		if (area === 0) warnings.push("填充边界面积为 0,请检查顶点是否构成闭合环");
		const pts = req.loops.flat();
		this.entities.set(handle, {
			handle,
			kind: "hatch",
			layer: req.layer ?? "0",
			color: req.color ?? 256,
			linetype: "ByLayer",
			points: pts,
			measure: { area }
		});
		return {
			handle,
			warnings
		};
	}
	modify(req) {
		const e = this.entities.get(req.handle);
		if (!e) throw new Error(`图元不存在: ${req.handle}`);
		const warnings = [];
		if (req.set.layer) {
			this.ensureLayer(req.set.layer);
			e.layer = req.set.layer;
		}
		if (req.set.color !== void 0) e.color = req.set.color;
		if (req.set.linetype) e.linetype = req.set.linetype;
		if (req.set.text !== void 0) e.text = req.set.text;
		if (req.set.height !== void 0) e.height = req.set.height;
		if (req.set.rotation !== void 0) e.rotation = req.set.rotation;
		if (req.set.radius !== void 0) {
			e.radius = req.set.radius;
			if (e.measure) e.measure.radius = req.set.radius;
		}
		return {
			handle: req.handle,
			warnings
		};
	}
	transform(req) {
		const warnings = [];
		const touched = [];
		for (const h of req.handles) {
			const src = this.entities.get(h);
			if (!src) {
				warnings.push(`图元不存在,已跳过: ${h}`);
				continue;
			}
			if (this.layers.get(src.layer)?.locked) {
				warnings.push(`图层 ${src.layer} 已锁定,已跳过: ${h}`);
				continue;
			}
			const e = req.copy ? {
				...src,
				points: src.points ? [...src.points] : void 0,
				measure: { ...src.measure }
			} : src;
			if (!e.points) e.points = [];
			if (req.mode === "move") {
				const dx = req.value;
				const dy = req.valueY ?? 0;
				e.points = e.points.map((p) => ({
					...p,
					x: p.x + dx,
					y: p.y + dy
				}));
			} else if (req.mode === "rotate") {
				const c = req.center ?? {
					x: 0,
					y: 0
				};
				const rad = req.value * Math.PI / 180;
				const cos = Math.cos(rad);
				const sin = Math.sin(rad);
				e.points = e.points.map((p) => {
					const dx = p.x - c.x;
					const dy = p.y - c.y;
					return {
						...p,
						x: c.x + dx * cos - dy * sin,
						y: c.y + dx * sin + dy * cos
					};
				});
				e.rotation = ((e.rotation ?? 0) + req.value) % 360;
			} else {
				const c = req.center ?? {
					x: 0,
					y: 0
				};
				if (req.value <= 0) {
					warnings.push(`非正缩放系数已跳过: ${h}`);
					continue;
				}
				e.points = e.points.map((p) => ({
					...p,
					x: c.x + (p.x - c.x) * req.value,
					y: c.y + (p.y - c.y) * req.value
				}));
				if (e.radius !== void 0) e.radius *= req.value;
				if (e.measure?.radius !== void 0) e.measure.radius *= req.value;
				if (e.measure?.area !== void 0) e.measure.area *= req.value * req.value;
				if (e.measure?.length !== void 0) e.measure.length *= req.value;
			}
			if (req.copy) {
				e.handle = this.nextHandle();
				this.entities.set(e.handle, e);
			}
			touched.push(e.handle);
		}
		return {
			handles: touched,
			warnings
		};
	}
	delete(req) {
		const warnings = [];
		const removed = [];
		for (const h of req.handles) {
			const e = this.entities.get(h);
			if (!e) {
				warnings.push(`图元不存在,已跳过: ${h}`);
				continue;
			}
			if (this.layers.get(e.layer)?.locked) {
				warnings.push(`图层 ${e.layer} 已锁定,已跳过: ${h}`);
				continue;
			}
			this.entities.delete(h);
			removed.push(h);
		}
		return {
			handles: removed,
			warnings
		};
	}
};
//#endregion
//#region src/transport/simulation.ts
/**
* Serves the full operation surface from an in-memory drawing.
*
* Used for wiring checks, CI, and prompt rehearsal on machines without
* AutoCAD. It is a real implementation of {@link CadTransport}, not a stub:
* every tool runs against it unchanged.
*/
var SimulationTransport = class {
	kind = "simulation";
	doc = new SimulatedDocument();
	running = false;
	async start() {
		this.running = true;
	}
	async stop() {
		this.running = false;
	}
	/** Escape hatch for tests and debugging. */
	get document() {
		return this.doc;
	}
	async send(request) {
		if (!this.running) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "仿真后端尚未启动"
			}
		};
		try {
			switch (request.op) {
				case "status": return {
					ok: true,
					data: {
						backend: this.kind,
						document: this.doc.document
					}
				};
				case "open":
					this.doc.open(request);
					return {
						ok: true,
						data: { document: this.doc.document }
					};
				case "saveAs": return {
					ok: true,
					data: { path: this.doc.saveAs(request) }
				};
				case "listLayers": return {
					ok: true,
					data: { layers: this.doc.listLayers() }
				};
				case "queryEntities": {
					const entities = this.doc.query(request);
					return {
						ok: true,
						data: {
							count: entities.length,
							entities
						},
						warnings: request.limit && entities.length === request.limit ? [`结果已截断至 limit=${request.limit},可能还有更多图元未显示`] : void 0
					};
				}
				case "getEntity": {
					const entity = this.doc.getEntity(request);
					if (!entity) return {
						ok: false,
						error: {
							code: "NOT_FOUND",
							message: `图元不存在: ${request.handle}`
						}
					};
					return {
						ok: true,
						data: { entity }
					};
				}
				case "draw": {
					const { handles, warnings } = this.doc.draw(request);
					return {
						ok: true,
						data: { count: handles.length },
						handles,
						warnings
					};
				}
				case "addDimension": {
					const { handle, warnings } = this.doc.addDimension(request);
					return {
						ok: true,
						data: { count: 1 },
						handles: [handle],
						warnings
					};
				}
				case "addHatch": {
					const { handle, warnings } = this.doc.addHatch(request);
					return {
						ok: true,
						data: { count: 1 },
						handles: [handle],
						warnings
					};
				}
				case "modify": {
					const { handle, warnings } = this.doc.modify(request);
					return {
						ok: true,
						data: { count: 1 },
						handles: [handle],
						warnings
					};
				}
				case "transform": {
					const { handles, warnings } = this.doc.transform(request);
					return {
						ok: true,
						data: { count: handles.length },
						handles,
						warnings
					};
				}
				case "delete": {
					const { handles, warnings } = this.doc.delete(request);
					return {
						ok: true,
						data: { count: handles.length },
						handles,
						warnings
					};
				}
				case "runCommand": return {
					ok: true,
					data: { executed: this.doc.runCommand(request) }
				};
			}
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "INVALID_ARGUMENT",
					message: err instanceof Error ? err.message : String(err)
				}
			};
		}
	}
};
//#endregion
//#region src/tools/shared.ts
/**
* Shared JSON-Schema fragments.
*
* The Harness schema DSL marks requiredness per property with `required: true`
* and has no `required` array on object nodes, so these follow that shape.
*/
/** A point in metres, as the model supplies it. */
const pointSchema = {
	type: "object",
	additionalProperties: false,
	description: "平面坐标,单位为米",
	properties: {
		x: {
			type: "number",
			required: true,
			description: "X 坐标(米)"
		},
		y: {
			type: "number",
			required: true,
			description: "Y 坐标(米)"
		}
	}
};
const layerSchema = {
	type: "string",
	description: "图层名。不存在时后端会自动创建该图层"
};
const colorSchema = {
	type: "integer",
	description: "AutoCAD 颜色索引(ACI)。256 表示 ByLayer 随层色"
};
/** Render a structured failure as model-facing text plus a recovery hint. */
function renderError(op, error) {
	const lines = [`${op} 失败: ${error.message}`];
	if (error.details) lines.push(`详情: ${error.details}`);
	switch (error.code) {
		case "BACKEND_UNAVAILABLE":
		case "NOT_CONNECTED":
			lines.push("提示: 请确认 AutoCAD 已启动、已打开图形,然后重试 cad_status。");
			break;
		case "NO_DOCUMENT":
			lines.push("提示: 请先在 AutoCAD 中打开或新建一个图形。");
			break;
		case "NOT_FOUND":
			lines.push("提示: 请先用 cad_query_entities 定位图元,确认 handle 是否正确。");
			break;
		case "TIMEOUT": lines.push("提示: AutoCAD 可能正忙(例如弹出了对话框),请稍后重试。");
	}
	return [{
		type: "text",
		text: lines.join("\n")
	}];
}
/** Render warnings so the model always surfaces them instead of hiding them. */
function warningBlock(warnings) {
	if (!warnings.length) return [];
	return [{
		type: "text",
		text: `注意事项:\n${warnings.map((w) => `- ${w}`).join("\n")}`
	}];
}
//#endregion
//#region src/tools/cad-status.ts
/** `cad_status` — connection, units and active drawing. */
function createStatusTool(deps) {
	return defineTool({
		name: "cad_status",
		description: "查看 CAD 后端连接状态、当前打开的图形、图纸单位与模型空间图元数量。开始任何 CAD 操作前,先用本工具确认已连接到正确的图纸和正确的单位比例。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					backend: {
						type: "string",
						description: "后端类型: lisp-ipc、com 或 simulation"
					},
					connected: {
						type: "boolean",
						description: "是否已成功连接"
					},
					unitsPerMeter: {
						type: "number",
						description: "每米对应的图纸单位数"
					},
					document: {
						type: "object",
						additionalProperties: false,
						description: "当前图形信息,未连接时为空",
						properties: {
							name: { type: "string" },
							path: { type: "string" },
							unitsName: { type: "string" },
							modelSpaceCount: { type: "integer" },
							activeSpace: { type: "string" }
						}
					},
					bridge: {
						type: "object",
						additionalProperties: false,
						description: "桥接进程诊断(仅 COM 后端):运行中的子进程实际加载的脚本路径与版本。插件升级后若此版本仍是旧的,说明桥接进程尚未重启。",
						properties: {
							script: {
								type: "string",
								description: "桥接脚本的绝对路径"
							},
							loadedAt: {
								type: "string",
								description: "运行中进程载入的脚本版本(脚本文件修改时间,ISO 8601);未运行时为空"
							},
							running: {
								type: "boolean",
								description: "桥接子进程是否存活"
							}
						}
					},
					ipc: {
						type: "object",
						additionalProperties: false,
						description: "File IPC 调度器诊断。fresh 为 false 时需要 APPLOAD assets/cad-ipc.lsp。",
						properties: {
							dir: { type: "string" },
							fresh: { type: "boolean" },
							ageMs: { type: "integer" },
							version: { type: "string" },
							script: { type: "string" }
						}
					},
					degraded: {
						type: "string",
						description: "能力降级原因；空表示没有降级"
					},
					message: {
						type: "string",
						description: "未连接或出错时的说明"
					}
				}
			},
			render: (_args, value) => {
				if (!value.connected) {
					const extra = [
						value.message ?? "未知原因",
						value.degraded ? `降级: ${value.degraded}` : "",
						value.ipc?.script ? `调度器: ${value.ipc.script}` : ""
					].filter(Boolean);
					return [{
						type: "text",
						text: `CAD 未连接(${value.backend}): ${extra.join("\n")}`
					}];
				}
				const d = value.document;
				const lines = [`后端: ${value.backend}`, `单位比例: 1 米 = ${value.unitsPerMeter} 图纸单位`];
				if (d) lines.push(`当前图形: ${d.name}`, `路径: ${d.path || "(未保存)"}`, `图纸单位: ${d.unitsName}`, `模型空间图元数: ${d.modelSpaceCount}`, `活动空间: ${d.activeSpace === "paper" ? "图纸空间" : "模型空间"}`);
				const b = value.bridge;
				if (b?.script) lines.push(`桥接脚本: ${b.script}`, `桥接版本: ${b.loadedAt || "(未运行)"}${b.running ? "" : " [进程未运行]"}`);
				if (value.ipc?.dir) lines.push(`IPC 目录: ${value.ipc.dir}`, `调度器: ${value.ipc.fresh ? "在运行" : "未运行"} ${value.ipc.script || ""}`.trim());
				if (value.degraded) lines.push(`降级: ${value.degraded}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute() {
			const diag = deps.cad.describeBackend();
			const bridge = {
				script: String(diag.bridgeScript ?? ""),
				loadedAt: diag.bridgeLoadedAt ? String(diag.bridgeLoadedAt) : "",
				running: Boolean(diag.bridgeRunning)
			};
			const ipc = diag.ipcDir ? {
				dir: String(diag.ipcDir),
				fresh: Boolean(diag.ipcFresh),
				ageMs: Number(diag.ipcAgeMs ?? -1),
				version: String(diag.ipcVersion ?? ""),
				script: String(diag.dispatcherScript ?? "")
			} : void 0;
			const degraded = diag.degraded ? String(diag.degraded) : void 0;
			const res = await deps.cad.raw({ op: "status" });
			if (!res.ok) return {
				backend: deps.cad.backend,
				connected: false,
				unitsPerMeter: deps.unitsPerMeter,
				bridge,
				...ipc ? { ipc } : {},
				...degraded ? { degraded } : {},
				message: res.error.message
			};
			const data = res.data;
			const document = data.document ? {
				name: String(data.document.name ?? ""),
				path: String(data.document.path ?? ""),
				unitsName: String(data.document.unitsName ?? ""),
				modelSpaceCount: Number(data.document.modelSpaceCount ?? 0),
				activeSpace: String(data.document.activeSpace ?? "model")
			} : void 0;
			return {
				backend: data.backend ?? deps.cad.backend,
				connected: true,
				unitsPerMeter: deps.unitsPerMeter,
				document,
				bridge,
				...ipc ? { ipc } : {},
				...degraded ? { degraded } : {}
			};
		}
	});
}
//#endregion
//#region src/tools/cad-layers.ts
/** `cad_list_layers` — layer inventory with entity counts. */
function createListLayersTool(deps) {
	return defineTool({
		name: "cad_list_layers",
		description: "列出当前图纸的全部图层,含颜色、线型、开关/冻结/锁定状态及每个图层的图元数量。新建图层或判断某图层是否锁定之前,先调用本工具确认。",
		parameters: { onlyPopulated: {
			type: "boolean",
			description: "为 true 时只返回含有图元的图层"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "integer",
						description: "返回的图层数量"
					},
					layers: {
						type: "array",
						description: "图层清单",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								color: { type: "integer" },
								linetype: { type: "string" },
								on: { type: "boolean" },
								frozen: { type: "boolean" },
								locked: { type: "boolean" },
								entityCount: { type: "integer" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const layers = value.layers ?? [];
				if (!layers.length) return [{
					type: "text",
					text: "图纸中没有图层。"
				}];
				const rows = layers.map((l) => {
					const flags = [
						l.on ? null : "关闭",
						l.frozen ? "冻结" : null,
						l.locked ? "锁定" : null
					].filter(Boolean).join(",");
					return `- ${l.name} | 颜色 ${l.color} | 线型 ${l.linetype || "-"} | 图元 ${l.entityCount}${flags ? ` | ${flags}` : ""}`;
				});
				return [{
					type: "text",
					text: `共 ${layers.length} 个图层:\n${rows.join("\n")}`
				}];
			}
		},
		async execute(args) {
			const res = await deps.cad.raw({ op: "listLayers" });
			if (!res.ok) return {
				count: 0,
				layers: []
			};
			const all = res.data.layers ?? [];
			const layers = args.onlyPopulated ? all.filter((l) => l.entityCount > 0) : all;
			return {
				count: layers.length,
				layers
			};
		}
	});
}
//#endregion
//#region src/tools/cad-query.ts
/** `cad_query_entities` — locate entities before modifying them. */
function createQueryEntitiesTool(deps) {
	return defineTool({
		name: "cad_query_entities",
		description: "按图层、图元类型、文字内容或空间范围检索图元,返回图元句柄(handle)、包围盒及长度/半径/面积。任何修改类操作之前都必须先用本工具定位到具体图元并确认 handle,不要凭猜测直接修改。每条结果的 meters 字段是换算后的工程米制值(长度m/半径m/面积m²),可直接用于核对尺寸,从而避免图纸无比例尺时把量取尺寸误当成真实尺寸。",
		parameters: {
			layer: {
				type: "string",
				description: "限定图层名(不区分大小写)"
			},
			kind: {
				type: "string",
				enum: [
					"line",
					"circle",
					"arc",
					"polyline",
					"text",
					"mtext",
					"dimension",
					"hatch",
					"point",
					"ellipse",
					"spline",
					"block",
					"unknown"
				],
				description: "限定图元类型"
			},
			textContains: {
				type: "string",
				description: "按文字内容或块名的子串过滤"
			},
			window: {
				type: "object",
				additionalProperties: false,
				description: "空间范围过滤(单位:米)",
				properties: {
					min: {
						...pointSchema,
						description: "范围左下角(米)"
					},
					max: {
						...pointSchema,
						description: "范围右上角(米)"
					}
				}
			},
			limit: {
				type: "integer",
				description: "最多返回多少个图元,默认 100"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "integer",
						description: "匹配到的图元数量"
					},
					truncated: {
						type: "boolean",
						description: "结果是否因 limit 被截断"
					},
					entities: {
						type: "array",
						description: "图元摘要列表",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								handle: { type: "string" },
								kind: { type: "string" },
								layer: { type: "string" },
								bbox: {
									type: "json",
									description: "包围盒(图纸单位)"
								},
								measure: {
									type: "json",
									description: "长度/半径/面积(图纸单位)"
								},
								meters: {
									type: "json",
									description: "换算后的米制度量"
								},
								text: { type: "string" },
								color: { type: "integer" },
								linetype: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (!value.count) return [{
					type: "text",
					text: "未找到匹配的图元。请放宽过滤条件,或先用 cad_list_layers 确认图层名是否正确。"
				}];
				const rows = value.entities.map((e) => {
					const m = e.meters ?? {};
					const bits = [
						`handle=${e.handle}`,
						String(e.kind),
						`图层=${e.layer}`
					];
					if (typeof m.length === "number") bits.push(`长 ${m.length}m`);
					if (typeof m.radius === "number") bits.push(`半径 ${m.radius}m`);
					if (typeof m.area === "number") bits.push(`面积 ${m.area}m²`);
					if (typeof e.text === "string") bits.push(`"${e.text}"`);
					return `- ${bits.join(" | ")}`;
				});
				const tail = value.truncated ? "\n注意: 结果已达 limit 上限,可能还有更多图元未显示。" : "";
				return [{
					type: "text",
					text: `找到 ${value.count} 个图元(尺寸已换算为米):\n${rows.join("\n")}${tail}`
				}];
			}
		},
		async execute(args) {
			const request = {
				op: "queryEntities",
				limit: args.limit ?? 100
			};
			if (args.layer !== void 0) request.layer = args.layer;
			if (args.kind !== void 0) request.kind = args.kind;
			if (args.textContains !== void 0) request.textContains = args.textContains;
			if (args.window?.min && args.window.max) request.window = {
				min: deps.cad.units.pointToDrawing(args.window.min),
				max: deps.cad.units.pointToDrawing(args.window.max)
			};
			const res = await deps.cad.raw(request);
			if (!res.ok) return {
				count: 0,
				truncated: false,
				entities: []
			};
			const data = res.data;
			const entities = deps.cad.describe(data.entities ?? []);
			return {
				count: entities.length,
				truncated: Boolean(res.warnings?.length),
				entities
			};
		}
	});
}
//#endregion
//#region src/tools/mutation.ts
/**
* Build the shared output contract for a mutating tool.
*
* This is a function rather than a shared constant because `defineTool` infers
* its return type from a `const` schema literal; a value exported from another
* module widens `type` to `string` and the tool stops type-checking.
*/
function mutationOutput() {
	return {
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: {
					type: "boolean",
					description: "本次操作是否成功"
				},
				count: {
					type: "integer",
					description: "实际创建/修改的图元数量"
				},
				handles: {
					type: "array",
					description: "新生成或受影响图元的句柄,后续修改请使用这些句柄",
					items: { type: "string" }
				},
				warnings: {
					type: "array",
					description: "被跳过的对象或需要人工确认的事项",
					items: { type: "string" }
				},
				summary: {
					type: "string",
					description: "一句话结果说明"
				},
				error: {
					type: "json",
					description: "失败时的结构化错误"
				}
			}
		},
		render: (_args, value) => {
			if (!value.ok) return renderError(value.summary, value.error ?? {
				code: "BACKEND_ERROR",
				message: "未知错误"
			});
			return [{
				type: "text",
				text: `${value.summary}:成功 ${value.count} 个图元` + (value.handles.length ? `\n句柄: ${value.handles.join(", ")}` : "")
			}, ...warningBlock(value.warnings)];
		}
	};
}
/** Normalise a backend response into the shared mutation result. */
function toResult(res, summary) {
	if (!res.ok) return {
		ok: false,
		count: 0,
		handles: [],
		warnings: [],
		summary,
		error: res.error
	};
	return {
		ok: true,
		count: res.handles?.length ?? 0,
		handles: res.handles ?? [],
		warnings: res.warnings ?? [],
		summary
	};
}
//#endregion
//#region src/tools/cad-draw.ts
/** Metres -> drawing units for one create spec. */
function convertItem(item, units) {
	const p = (pt) => units.pointToDrawing(pt);
	switch (item.kind) {
		case "line": return {
			...item,
			start: p(item.start),
			end: p(item.end)
		};
		case "circle": return {
			...item,
			center: p(item.center),
			radius: units.toDrawing(item.radius)
		};
		case "arc": return {
			...item,
			center: p(item.center),
			radius: units.toDrawing(item.radius)
		};
		case "polyline": return {
			...item,
			vertices: item.vertices.map(p)
		};
		case "text": return {
			...item,
			position: p(item.position),
			height: item.height === void 0 ? void 0 : units.toDrawing(item.height)
		};
		case "mtext": return {
			...item,
			position: p(item.position),
			height: item.height === void 0 ? void 0 : units.toDrawing(item.height),
			width: item.width === void 0 ? void 0 : units.toDrawing(item.width)
		};
	}
}
/** `cad_draw` — create primitives in one undoable batch. */
function createDrawTool(deps) {
	return defineTool({
		name: "cad_draw",
		description: "在当前图纸中批量绘制基本图元(直线/圆/圆弧/多段线/单行文字/多行文字)。所有坐标与尺寸一律使用【米】,由插件按图纸单位自动换算,请勿自行换算。整批图元构成一个撤销步骤,可一次 Ctrl+Z 全部回退。绘制前应先用 cad_query_entities 确认目标区域是否已有同类图元,避免重复绘制。",
		parameters: {
			items: {
				type: "array",
				required: true,
				description: "待创建的图元列表",
				items: {
					type: "object",
					additionalProperties: false,
					description: "单个图元,按 kind 提供对应几何参数",
					properties: {
						kind: {
							type: "string",
							required: true,
							enum: [
								"line",
								"circle",
								"arc",
								"polyline",
								"text",
								"mtext"
							],
							description: "图元类型"
						},
						start: {
							...pointSchema,
							description: "line: 起点"
						},
						end: {
							...pointSchema,
							description: "line: 终点"
						},
						center: {
							...pointSchema,
							description: "circle/arc: 圆心"
						},
						radius: {
							type: "number",
							description: "circle/arc: 半径(米)"
						},
						startAngle: {
							type: "number",
							description: "arc: 起始角(度)"
						},
						endAngle: {
							type: "number",
							description: "arc: 终止角(度)"
						},
						vertices: {
							type: "array",
							description: "polyline: 顶点序列",
							items: {
								...pointSchema,
								description: "顶点(米)"
							}
						},
						closed: {
							type: "boolean",
							description: "polyline: 是否闭合"
						},
						position: {
							...pointSchema,
							description: "text/mtext: 插入点"
						},
						text: {
							type: "string",
							description: "text/mtext: 文字内容"
						},
						height: {
							type: "number",
							description: "text/mtext: 字高(米)"
						},
						width: {
							type: "number",
							description: "mtext: 文字框宽度(米)"
						},
						rotation: {
							type: "number",
							description: "text: 旋转角(度)"
						},
						layer: {
							...layerSchema,
							description: "所属图层"
						},
						color: {
							...colorSchema,
							description: "颜色"
						}
					}
				}
			},
			undoLabel: {
				type: "string",
				description: "撤销步骤名称,便于工程师回退"
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const request = {
				op: "draw",
				items: args.items.map((raw) => {
					const base = {
						layer: raw.layer,
						color: raw.color
					};
					switch (raw.kind) {
						case "line": return {
							kind: "line",
							start: raw.start,
							end: raw.end,
							...base
						};
						case "circle": return {
							kind: "circle",
							center: raw.center,
							radius: raw.radius,
							...base
						};
						case "arc": return {
							kind: "arc",
							center: raw.center,
							radius: raw.radius,
							startAngle: raw.startAngle ?? 0,
							endAngle: raw.endAngle ?? 90,
							...base
						};
						case "polyline": return {
							kind: "polyline",
							vertices: raw.vertices ?? [],
							closed: raw.closed,
							...base
						};
						case "text": return {
							kind: "text",
							position: raw.position,
							text: raw.text ?? "",
							height: raw.height,
							rotation: raw.rotation,
							...base
						};
						case "mtext": return {
							kind: "mtext",
							position: raw.position,
							text: raw.text ?? "",
							width: raw.width,
							height: raw.height,
							...base
						};
					}
				}).map((item) => convertItem(item, deps.cad.units)),
				undoLabel: args.undoLabel
			};
			return toResult(await deps.cad.raw(request), "绘制图元");
		}
	});
}
//#endregion
//#region src/tools/cad-annotate.ts
/** `cad_add_dimension` — real dimension objects, not drawn approximations. */
function createDimensionTool(deps) {
	return defineTool({
		name: "cad_add_dimension",
		description: "在图纸中添加尺寸标注对象(线性/对齐/角度/半径/直径)。请使用真正的标注对象而不是手工画线,以保证标注值随图元变化自动更新。所有坐标与尺寸使用【米】。线性/对齐需要 2 个点,角度需要 3 个点(顶点和两条射线端点),半径需要 2 个点(圆心和圆周点),直径需要 2 个点(直径两端)。",
		parameters: {
			kind: {
				type: "string",
				required: true,
				enum: [
					"linear",
					"aligned",
					"angular",
					"radius",
					"diameter"
				],
				description: "标注类型"
			},
			points: {
				type: "array",
				required: true,
				description: "标注点集:linear/aligned 2 点,angular 3 点,radius 2 点(圆心+圆周点),diameter 2 点(直径两端)",
				items: {
					...pointSchema,
					description: "标注点(米)"
				}
			},
			offset: {
				type: "number",
				description: "尺寸线相对测量点的偏移(米),用于避免压线"
			},
			textOverride: {
				type: "string",
				description: "自定义标注文字(留空则显示实测值)"
			},
			layer: {
				...layerSchema,
				description: "所属图层"
			},
			color: {
				...colorSchema,
				description: "颜色"
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const u = deps.cad.units;
			const request = {
				op: "addDimension",
				kind: args.kind,
				points: args.points.map((p) => u.pointToDrawing(p)),
				offset: args.offset === void 0 ? void 0 : u.toDrawing(args.offset),
				textOverride: args.textOverride,
				layer: args.layer,
				color: args.color
			};
			return toResult(await deps.cad.raw(request), "添加尺寸标注");
		}
	});
}
/** `cad_add_hatch` — closed-region fill for soil strata and poche. */
function createHatchTool(deps) {
	return defineTool({
		name: "cad_add_hatch",
		description: "在指定的闭合边界内填充图案(用于土层剖面、混凝土剖面等)。每个边界环至少需要 3 个顶点,坐标使用【米】。",
		parameters: {
			loops: {
				type: "array",
				required: true,
				description: "边界环列表,每个环是一组闭合顶点",
				items: {
					type: "array",
					description: "一个闭合边界环",
					items: {
						...pointSchema,
						description: "顶点(米)"
					}
				}
			},
			patternName: {
				type: "string",
				description: "图案名,如 ANSI31;纯色填充用 SOLID"
			},
			patternScale: {
				type: "number",
				description: "图案比例(仅对非实心图案有效)"
			},
			layer: {
				...layerSchema,
				description: "所属图层"
			},
			color: {
				...colorSchema,
				description: "颜色"
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const u = deps.cad.units;
			const request = {
				op: "addHatch",
				loops: args.loops.map((loop) => loop.map((p) => u.pointToDrawing(p))),
				patternName: args.patternName,
				patternScale: args.patternScale,
				layer: args.layer,
				color: args.color
			};
			return toResult(await deps.cad.raw(request), "添加填充图案");
		}
	});
}
//#endregion
//#region src/tools/cad-edit.ts
/** `cad_modify` — change one entity's properties, preserving the rest. */
function createModifyTool(deps) {
	return defineTool({
		name: "cad_modify",
		description: "修改单个图元的属性(图层/颜色/线型/文字/字高/旋转角/半径)。只修改明确给出的字段,其余属性保持不变。handle 必须来自 cad_query_entities 的检索结果,不要凭猜测填写。",
		parameters: {
			handle: {
				type: "string",
				required: true,
				description: "目标图元句柄"
			},
			set: {
				type: "object",
				required: true,
				additionalProperties: false,
				description: "要修改的字段(只需给出要改的项)",
				properties: {
					layer: {
						...layerSchema,
						description: "新图层"
					},
					color: {
						...colorSchema,
						description: "新颜色"
					},
					linetype: {
						type: "string",
						description: "新线型,如 CENTER、DASHED"
					},
					text: {
						type: "string",
						description: "新文字内容"
					},
					height: {
						type: "number",
						description: "新字高(米)"
					},
					rotation: {
						type: "number",
						description: "新旋转角(度)"
					},
					radius: {
						type: "number",
						description: "新半径(米)"
					}
				}
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const u = deps.cad.units;
			const set = {};
			if (args.set.layer !== void 0) set.layer = args.set.layer;
			if (args.set.color !== void 0) set.color = args.set.color;
			if (args.set.linetype !== void 0) set.linetype = args.set.linetype;
			if (args.set.text !== void 0) set.text = args.set.text;
			if (args.set.height !== void 0) set.height = u.toDrawing(args.set.height);
			if (args.set.rotation !== void 0) set.rotation = args.set.rotation;
			if (args.set.radius !== void 0) set.radius = u.toDrawing(args.set.radius);
			const request = {
				op: "modify",
				handle: args.handle,
				set
			};
			return toResult(await deps.cad.raw(request), "修改图元属性");
		}
	});
}
/**
* `cad_transform` — move/rotate/scale a set of entities together.
*
* This is the tool for the "局部联动" case the Codex-for-CAD evaluation flagged
* as unreliable: applying one offset to every related handle keeps their
* relative spacing intact by construction.
*/
function createTransformTool(deps) {
	return defineTool({
		name: "cad_transform",
		description: "对一组图元执行统一的平移/旋转/缩放,保持它们之间的相对关系不变。典型用途是\"某段边线外侧偏移 500mm,同时该段的尺寸线、文字、符号一起偏移\"。handles 必须来自 cad_query_entities 的检索结果。rotate/scale 必须提供 center 基准点。copy=true 时复制而不移动原图元。注意: 变换通过重写图元的几何属性实现,适用于直线/圆/圆弧/文字/点/块参照;其他类型(如填充、标注对象)会返回警告并跳过,不会静默失败。",
		parameters: {
			handles: {
				type: "array",
				required: true,
				description: "目标图元句柄列表",
				items: {
					type: "string",
					description: "图元句柄"
				}
			},
			mode: {
				type: "string",
				required: true,
				enum: [
					"move",
					"rotate",
					"scale"
				],
				description: "变换类型"
			},
			value: {
				type: "number",
				required: true,
				description: "move: X 偏移(米);rotate: 角度(度);scale: 缩放系数"
			},
			valueY: {
				type: "number",
				description: "move: Y 偏移(米),默认为 0"
			},
			center: {
				...pointSchema,
				description: "rotate/scale 的基准点(米)"
			},
			copy: {
				type: "boolean",
				description: "为 true 时复制副本,原图元保持不动"
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const u = deps.cad.units;
			const request = {
				op: "transform",
				handles: args.handles,
				mode: args.mode,
				value: args.mode === "move" ? u.toDrawing(args.value) : args.value,
				valueY: args.valueY === void 0 ? void 0 : u.toDrawing(args.valueY),
				center: args.center ? u.pointToDrawing(args.center) : void 0,
				copy: args.copy
			};
			const label = {
				move: "平移",
				rotate: "旋转",
				scale: "缩放"
			}[args.mode];
			return toResult(await deps.cad.raw(request), `批量${label}图元`);
		}
	});
}
/** `cad_delete` — erase entities by handle. */
function createDeleteTool(deps) {
	return defineTool({
		name: "cad_delete",
		description: "按句柄删除图元。此操作在 AutoCAD 中可用一次 Ctrl+Z 撤销。删除前务必先用 cad_query_entities 确认句柄,并向用户说明将删除哪些对象。",
		parameters: { handles: {
			type: "array",
			required: true,
			description: "待删除图元的句柄列表",
			items: {
				type: "string",
				description: "图元句柄"
			}
		} },
		output: mutationOutput(),
		async execute(args) {
			const request = {
				op: "delete",
				handles: args.handles
			};
			return toResult(await deps.cad.raw(request), "删除图元");
		}
	});
}
//#endregion
//#region src/tools/cad-measure.ts
/** `cad_measure` — convert between drawing units and engineering metres. */
function createMeasureTool(deps) {
	return defineTool({
		name: "cad_measure",
		description: "测量距离或两点间长度,输入点坐标(米),返回图纸单位长度与米制长度。当图纸没有明确比例尺时,不要凭肉眼量取尺寸当作真实尺寸,应先用本工具确认图纸单位比例,再据此换算。",
		parameters: {
			a: {
				...pointSchema,
				required: true,
				description: "起点(米)"
			},
			b: {
				...pointSchema,
				required: true,
				description: "终点(米)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					distanceMeters: {
						type: "number",
						description: "两点间距离(米)"
					},
					distanceDrawingUnits: {
						type: "number",
						description: "两点间距离(图纸单位)"
					},
					unitsPerMeter: {
						type: "number",
						description: "当前图纸单位比例"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: [`距离: ${value.distanceMeters} 米 (${value.distanceDrawingUnits} 图纸单位)`, `单位比例: 1 米 = ${value.unitsPerMeter} 图纸单位`].join("\n")
			}]
		},
		async execute(args) {
			const u = deps.cad.units;
			const a = args.a;
			const b = args.b;
			const meters = Math.hypot(b.x - a.x, b.y - a.y);
			return {
				distanceMeters: Math.round(meters * 1e6) / 1e6,
				distanceDrawingUnits: Math.round(u.toDrawing(meters) * 1e6) / 1e6,
				unitsPerMeter: u.unitsPerMeter
			};
		}
	});
}
/** `cad_get_entity` — full detail for one handle. */
function createGetEntityTool(deps) {
	return defineTool({
		name: "cad_get_entity",
		description: "获取单个图元的完整信息(图层、几何度量、包围盒、文字内容),尺寸同时给出图纸单位与米制值。在修改某个图元之前可调用本工具确认其当前状态。",
		parameters: { handle: {
			type: "string",
			required: true,
			description: "图元句柄"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: {
						type: "boolean",
						description: "是否找到该图元"
					},
					entity: {
						type: "json",
						description: "图元详情(含 meters 米制度量)"
					}
				}
			},
			render: (_args, value) => {
				if (!value.found || !value.entity) return [{
					type: "text",
					text: "未找到该图元。请先用 cad_query_entities 检索。"
				}];
				const e = value.entity;
				const m = e.meters ?? {};
				const lines = [
					`句柄: ${e.handle}`,
					`类型: ${e.kind}`,
					`图层: ${e.layer}`
				];
				if (typeof m.length === "number") lines.push(`长度: ${m.length} 米`);
				if (typeof m.radius === "number") lines.push(`半径: ${m.radius} 米`);
				if (typeof m.area === "number") lines.push(`面积: ${m.area} 平方米`);
				if (typeof e.text === "string") lines.push(`文字: "${e.text}"`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args) {
			const res = await deps.cad.raw({
				op: "getEntity",
				handle: args.handle
			});
			if (!res.ok) return { found: false };
			const data = res.data;
			if (!data.entity) return { found: false };
			return {
				found: true,
				entity: deps.cad.units.describeEntity(data.entity)
			};
		}
	});
}
//#endregion
//#region src/tools/cad-batch.ts
/**
* `cad_batch` — resolve a query and act on the result in one call.
*
* Locating entities and then transforming them in separate turns is where the
* Codex-for-CAD evaluation saw linkage edits drift: the drawing can change
* between the query and the edit. Doing both against one resolved handle set
* keeps the "what moved" and "what was targeted" consistent, and returns the
* full list of affected handles for the change report.
*/
function createBatchTool(deps) {
	return defineTool({
		name: "cad_batch",
		description: "按条件批量定位图元并立即对其执行同一变换(平移/旋转/缩放),一次完成\"定位 + 联动修改\"。典型场景:查出某图层某区域内与某关键字相关的所有图元,整体外移 500mm。返回实际被影响的图元清单与被跳过的对象,便于输出修改说明。",
		parameters: {
			query: {
				type: "object",
				required: true,
				additionalProperties: false,
				description: "图元筛选条件",
				properties: {
					layer: {
						type: "string",
						description: "限定图层"
					},
					kind: {
						type: "string",
						enum: [
							"line",
							"circle",
							"arc",
							"polyline",
							"text",
							"mtext",
							"dimension",
							"hatch",
							"point",
							"ellipse",
							"spline",
							"block",
							"unknown"
						],
						description: "限定图元类型"
					},
					textContains: {
						type: "string",
						description: "按文字/块名子串过滤"
					},
					window: {
						type: "object",
						additionalProperties: false,
						description: "空间范围(米)",
						properties: {
							min: {
								...pointSchema,
								description: "左下角(米)"
							},
							max: {
								...pointSchema,
								description: "右上角(米)"
							}
						}
					},
					limit: {
						type: "integer",
						description: "最多处理多少个图元,默认 100"
					}
				}
			},
			mode: {
				type: "string",
				required: true,
				enum: [
					"move",
					"rotate",
					"scale"
				],
				description: "对匹配图元执行的变换"
			},
			value: {
				type: "number",
				required: true,
				description: "move: X 偏移(米);rotate: 角度(度);scale: 缩放系数"
			},
			valueY: {
				type: "number",
				description: "move: Y 偏移(米)"
			},
			center: {
				...pointSchema,
				description: "rotate/scale 基准点(米)"
			},
			copy: {
				type: "boolean",
				description: "为 true 时复制副本"
			},
			dryRun: {
				type: "boolean",
				description: "为 true 时只定位并返回将受影响的图元,不做任何修改(建议先试运行)"
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const u = deps.cad.units;
			const q = args.query;
			const request = {
				op: "queryEntities",
				limit: q.limit ?? 100
			};
			if (q.layer !== void 0) request.layer = q.layer;
			if (q.kind !== void 0) request.kind = q.kind;
			if (q.textContains !== void 0) request.textContains = q.textContains;
			if (q.window?.min && q.window.max) request.window = {
				min: u.pointToDrawing(q.window.min),
				max: u.pointToDrawing(q.window.max)
			};
			const found = await deps.cad.raw(request);
			if (!found.ok) return {
				ok: false,
				count: 0,
				handles: [],
				warnings: [],
				summary: "批量定位并修改",
				error: found.error
			};
			const entities = found.data.entities ?? [];
			if (!entities.length) return {
				ok: false,
				count: 0,
				handles: [],
				warnings: ["没有匹配到任何图元,未执行任何修改。请放宽筛选条件。"],
				summary: "批量定位并修改",
				error: {
					code: "NOT_FOUND",
					message: "没有匹配到任何图元"
				}
			};
			const handles = entities.map((e) => e.handle);
			if (args.dryRun) return {
				ok: true,
				count: handles.length,
				handles,
				warnings: ["这是试运行(dryRun),未对图纸做任何修改。"],
				summary: `试运行:定位到 ${handles.length} 个图元`
			};
			const res = await deps.cad.raw({
				op: "transform",
				handles,
				mode: args.mode,
				value: args.mode === "move" ? u.toDrawing(args.value) : args.value,
				valueY: args.valueY === void 0 ? void 0 : u.toDrawing(args.valueY),
				center: args.center ? u.pointToDrawing(args.center) : void 0,
				copy: args.copy
			});
			const label = {
				move: "平移",
				rotate: "旋转",
				scale: "缩放"
			}[args.mode];
			return toResult(res, `批量${label}(定位 ${handles.length} 个图元)`);
		}
	});
}
/** `cad_run_command` — escape hatch to native AutoCAD commands. */
function createRunCommandTool(deps) {
	return defineTool({
		name: "cad_run_command",
		description: "在 AutoCAD 命令行执行一条原生命令(逃生舱)。当本插件的工具无法表达某个操作时使用,例如 QLEAVE(清空)、ZOOM、SAVE。命令会真实作用于当前图形,请谨慎使用。",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "AutoCAD 命令名,如 ZOOM"
			},
			args: {
				type: "array",
				description: "命令参数",
				items: {
					type: "string",
					description: "参数"
				}
			}
		},
		output: mutationOutput(),
		async execute(args) {
			const request = {
				op: "runCommand",
				command: args.command,
				args: args.args
			};
			return toResult(await deps.cad.raw(request), `执行命令 ${args.command}`);
		}
	});
}
//#endregion
//#region src/tools/cad-document.ts
/** `cad_open` — open a DWG and make it the active drawing. */
function createOpenTool(deps) {
	return defineTool({
		name: "cad_open",
		description: "在 AutoCAD 中打开指定的 DWG/DXF 文件并设为当前活动图形。路径必须是本机绝对路径。修改前建议先另存副本(cad_save_as),避免覆盖原始图纸。",
		parameters: { path: {
			type: "string",
			required: true,
			description: "DWG/DXF 文件的绝对路径"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						description: "是否成功打开"
					},
					name: {
						type: "string",
						description: "图形文件名"
					},
					path: {
						type: "string",
						description: "完整路径"
					},
					modelSpaceCount: {
						type: "integer",
						description: "模型空间图元数量"
					},
					error: {
						type: "json",
						description: "失败时的结构化错误"
					}
				}
			},
			render: (_args, value) => {
				if (!value.ok) {
					const err = value.error;
					return renderError("打开图形", {
						code: "BACKEND_ERROR",
						message: err?.message ?? "未知错误"
					});
				}
				return [{
					type: "text",
					text: `已打开 ${value.name}\n路径: ${value.path}\n模型空间图元数: ${value.modelSpaceCount}`
				}];
			}
		},
		async execute(args) {
			const request = {
				op: "open",
				path: args.path
			};
			const res = await deps.cad.raw(request);
			if (!res.ok) return {
				ok: false,
				error: res.error
			};
			const data = res.data;
			return {
				ok: true,
				name: String(data.name ?? ""),
				path: String(data.path ?? args.path),
				modelSpaceCount: Number(data.modelSpaceCount ?? 0)
			};
		}
	});
}
/** `cad_save_as` — save to a new path, leaving the original untouched. */
function createSaveAsTool(deps) {
	return defineTool({
		name: "cad_save_as",
		description: "将当前图形另存为指定的 DWG 文件(不改变原文件)。改图任务的标准收尾动作:先用本工具输出新图纸,再向用户说明改动内容。",
		parameters: { path: {
			type: "string",
			required: true,
			description: "目标 DWG 文件绝对路径"
		} },
		output: mutationOutput(),
		async execute(args) {
			const request = {
				op: "saveAs",
				path: args.path
			};
			const res = await deps.cad.raw(request);
			if (!res.ok) return {
				ok: false,
				count: 0,
				handles: [],
				warnings: [],
				summary: "另存图形",
				error: res.error
			};
			return {
				ok: true,
				count: 1,
				handles: [],
				warnings: [],
				summary: `已另存为 ${res.data.path ?? args.path}`
			};
		}
	});
}
//#endregion
//#region src/index.ts
const name = "dsh-plugin-cad";
const inject = ["tools"];
const Config = Schema.object({
	transport: Schema.union([
		"auto",
		"lisp",
		"com",
		"simulation"
	]).default("auto"),
	ipcDir: Schema.string().default(""),
	progId: Schema.string().default("AutoCAD.Application"),
	progIdFallbacks: Schema.array(Schema.string()).default([
		"AutoCAD.Application.25.2",
		"AutoCAD.Application.25.1",
		"AutoCAD.Application.25.0",
		"AutoCAD.Application.24.3"
	]),
	unitsPerMeter: Schema.number().min(1).default(1),
	requestTimeoutMs: Schema.number().min(1e3).default(12e4)
});
function createTransport(config) {
	if (config.transport === "simulation") return new SimulationTransport();
	const comOpts = {
		progId: config.progId,
		progIdFallbacks: config.progIdFallbacks,
		requestTimeoutMs: config.requestTimeoutMs
	};
	if (config.transport === "com") return new ComTransport(comOpts);
	const lisp = new LispIpcTransport({
		ipcDir: config.ipcDir || void 0,
		requestTimeoutMs: config.requestTimeoutMs
	});
	if (config.transport === "lisp") return lisp;
	return new AutoTransport({
		lisp,
		createCom: () => new ComTransport(comOpts)
	});
}
function apply(ctx, config) {
	const service = new CadService(createTransport(config), config.unitsPerMeter);
	const deps = {
		cad: service,
		unitsPerMeter: config.unitsPerMeter
	};
	const tools = [
		createStatusTool(deps),
		createOpenTool(deps),
		createSaveAsTool(deps),
		createListLayersTool(deps),
		createQueryEntitiesTool(deps),
		createGetEntityTool(deps),
		createMeasureTool(deps),
		createDrawTool(deps),
		createDimensionTool(deps),
		createHatchTool(deps),
		createModifyTool(deps),
		createTransformTool(deps),
		createDeleteTool(deps),
		createBatchTool(deps),
		createRunCommandTool(deps)
	];
	for (const tool of tools) ctx.tools.register(tool);
	ctx.effect(async () => {
		try {
			await service.start();
			ctx.logger.info("[dsh-plugin-cad] backend ready: %s (1m = %d units)", service.backend, config.unitsPerMeter);
		} catch (err) {
			ctx.logger.warn("[dsh-plugin-cad] backend not ready: %s", err instanceof Error ? err.message : String(err));
		}
		return () => service.stop();
	}, "dsh-plugin-cad:backend");
}
//#endregion
export { Config, apply, inject, name };
