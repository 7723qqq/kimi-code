#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { YAMLParseError, parse, stringify } from "yaml";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
//#region src/engine/types.ts
const PROTOCOLS = [
	"http",
	"ws",
	"rpc",
	"amqp",
	"kafka",
	"mysql",
	"redis",
	"file",
	"grpc",
	"graphql"
];
const DEP_KINDS = [
	"call",
	"event",
	"dataflow",
	"reference"
];
/** 模块生命周期状态：active=已实现；planned=计划态（先建树后实现）；deprecated=已废弃。 */
const MODULE_STATES = [
	"active",
	"planned",
	"deprecated"
];
/** 架构规则的完整规则集（policy.yml）。 */
const POLICY_RULE_TYPES = [
	"forbid-dependency",
	"dependency-direction",
	"acyclic",
	"max-depth",
	"cross-tree",
	"naming"
];
/** 开发变更日志（changes/<id>.json）：结构目录内，便于随工程回档。 */
const CHANGE_STATUSES = [
	"proposed",
	"in_progress",
	"verified",
	"abandoned"
];
/** 渲染数据集的布局模式：auto=自动选择；layers=按依赖分层（左→右流）；groups=分组块；grid=均衡网格。 */
const LAYOUT_MODES = [
	"auto",
	"layers",
	"groups",
	"grid"
];
//#endregion
//#region src/engine/ids.ts
const SEG = /^[a-z0-9][a-z0-9-]*$/;
/** 字符串数组的显式比较器：与 `Array#sort()` 默认的 UTF-16 码元序完全一致，
*  但显式给比较器才能满足 require-array-sort-compare（打包后类型擦除也照样成立）。 */
function byCodeUnit(a, b) {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
function splitId(id) {
	if (typeof id !== "string" || id.length === 0 || id.length > 4096) return null;
	const segs = id.split(".");
	if (segs.length === 0) return null;
	for (const s of segs) if (!SEG.test(s)) return null;
	return segs;
}
function isValidId(id) {
	return splitId(id) !== null;
}
/** 父 id = 去掉最后一段；单段（树名/根）的父为 null。 */
function deriveParent(id) {
	const segs = splitId(id);
	if (segs === null) return null;
	return segs.length === 1 ? null : segs.slice(0, -1).join(".");
}
function treeOf(id) {
	const segs = splitId(id);
	return segs === null ? "" : segs[0] ?? "";
}
function depthOf(id) {
	const segs = splitId(id);
	return segs === null ? 0 : segs.length;
}
function slugify(name) {
	return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project";
}
/** API 键：http 类为 "METHOD path"，其余为 "protocol:path"。 */
function apiKey(api) {
	const proto = String(api.protocol).toLowerCase();
	if (proto === "http") return String(api.method ?? "").toUpperCase() + " " + api.path;
	return proto + ":" + api.path;
}
/** modules/ 相对路径 → 模块 id（根 <tree>/index.md → <tree>）。 */
function idFromFilePath(relPath) {
	const rel = relPath.replace(/\\/g, "/");
	if (!rel.startsWith("modules/")) return null;
	const parts = rel.slice(8).split("/");
	const file = parts.pop();
	if (file === void 0 || !file.endsWith(".md")) return null;
	if (parts.length === 0) return null;
	const stem = file.slice(0, -3);
	const segs = stem === "index" ? parts : [...parts, stem];
	for (const s of segs) if (!SEG.test(s)) return null;
	return segs.join(".");
}
/** 模块文件的绝对路径。容器 = <seg>/index.md，叶子 = <last>.md，根 = modules/<tree>/index.md。 */
function moduleFilePath(projectDir, id, isContainer) {
	const segs = splitId(id);
	if (segs === null) throw new Error("normify: invalid module id: " + JSON.stringify(id));
	const tree = segs[0] ?? "";
	if (segs.length === 1) return join(projectDir, "modules", tree, "index.md");
	const rest = segs.slice(1);
	if (isContainer) return join(projectDir, "modules", tree, ...rest, "index.md");
	const last = rest[rest.length - 1] ?? "";
	return join(projectDir, "modules", tree, ...rest.slice(0, -1), last + ".md");
}
//#endregion
//#region src/engine/diag.ts
function diag(severity, code, message, subject, evidence, supportedFixes) {
	const d = {
		code,
		severity,
		message
	};
	if (subject !== void 0) d.subject = subject;
	if (evidence !== void 0) d.evidence = evidence;
	if (supportedFixes !== void 0 && supportedFixes.length > 0) d.supportedFixes = supportedFixes;
	return d;
}
function fmtDiag(d) {
	const where = d.subject ? " @ " + JSON.stringify(d.subject) : "";
	const fix = d.supportedFixes && d.supportedFixes.length > 0 ? " → 修复: " + d.supportedFixes.join("; ") : "";
	return "[" + d.severity + "] " + d.code + ": " + d.message + where + fix;
}
//#endregion
//#region src/engine/frontmatter.ts
const TOP_KEYS = [
	"uid",
	"id",
	"parent",
	"name",
	"description",
	"source",
	"revision",
	"updated_at",
	"fingerprint",
	"repository",
	"state",
	"replacement",
	"tags",
	"apis",
	"deps"
];
const SOURCE_KEYS = [
	"path",
	"line",
	"end_line"
];
const API_KEYS = [
	"protocol",
	"method",
	"path",
	"description"
];
const DEP_KEYS = [
	"kind",
	"to",
	"from_api",
	"to_api",
	"label"
];
function isL10n$3(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.zh === "string" && typeof v.en === "string";
}
function isPlain$3(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function checkL10n(value, field, maxLen, where, out) {
	if (!isL10n$3(value)) {
		out.push(diag("error", "structure/" + field + "-shape", field + " 必须为 {zh, en} 字符串对象", { path: where + "/" + field }, { value }, ["补全 {zh, en} 双语字段"]));
		return;
	}
	for (const lang of ["zh", "en"]) {
		const s = value[lang].trim();
		if (s.length === 0) out.push(diag("error", "structure/" + field + "-empty", field + "." + lang + " 不能为空", { path: where + "/" + field + "/" + lang }, {}, ["补写" + lang + "文案"]));
		else if (s.length > maxLen) out.push(diag("error", "structure/" + field + "-too-long", field + "." + lang + " 超过 " + maxLen + " 字符", { path: where + "/" + field + "/" + lang }, {
			length: s.length,
			max: maxLen
		}, ["精简文案到 " + maxLen + " 字符以内"]));
	}
}
function checkSourceEntry(v, where, out) {
	if (!isPlain$3(v)) {
		out.push(diag("error", "structure/source-entry-shape", "source 条目必须为对象", { path: where }, {}, []));
		return false;
	}
	for (const k of Object.keys(v)) if (!SOURCE_KEYS.includes(k)) out.push(diag("error", "structure/unknown-field", "source 条目不支持字段 " + k, { path: where }, {}, ["删除字段 " + k]));
	const p = v.path;
	if (typeof p !== "string" || p.length === 0 || p.length > 240) {
		out.push(diag("error", "structure/source-path-invalid", "source.path 必须为 1-240 字符的 repo 相对路径", { path: where + "/path" }, {}, ["填写仓库内相对路径"]));
		return false;
	}
	if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "")) {
		out.push(diag("error", "structure/source-path-invalid", "source.path 必须是正斜杠的 repo 相对路径（无 .. 与空段）", { path: where + "/path" }, { path: p }, ["改为相对路径，如 src/order/payment.ts"]));
		return false;
	}
	for (const k of ["line", "end_line"]) {
		const n = v[k];
		if (n !== void 0 && (typeof n !== "number" || !Number.isInteger(n) || n < 1)) {
			out.push(diag("error", "structure/source-" + k + "-invalid", "source." + k + " 必须为正整数", { path: where + "/" + k }, { value: n }, ["修正行号"]));
			return false;
		}
	}
	if (typeof v.line === "number" && typeof v.end_line === "number" && v.end_line < v.line) {
		out.push(diag("error", "structure/source-range-invalid", "source.end_line 不能小于 line", { path: where }, {
			line: v.line,
			end_line: v.end_line
		}, ["修正行号范围"]));
		return false;
	}
	return true;
}
function checkApiEntry(v, where, out) {
	if (!isPlain$3(v)) {
		out.push(diag("error", "api/entry-shape", "apis 条目必须为对象", { path: where }, {}, []));
		return false;
	}
	for (const k of Object.keys(v)) if (!API_KEYS.includes(k)) out.push(diag("error", "api/unknown-field", "apis 条目不支持字段 " + k, { path: where }, {}, ["删除字段 " + k]));
	const proto = v.protocol;
	if (typeof proto !== "string" || !PROTOCOLS.includes(proto)) {
		out.push(diag("error", "api/protocol-unknown", "protocol 不在允许枚举内", { path: where + "/protocol" }, {
			value: proto,
			allowed: PROTOCOLS
		}, ["使用枚举值之一：" + PROTOCOLS.join(", ")]));
		return false;
	}
	if (typeof v.path !== "string" || v.path.trim().length === 0) {
		out.push(diag("error", "api/path-empty", "path 不能为空", { path: where + "/path" }, {}, ["填写 URL 路径或 topic/队列名/表名"]));
		return false;
	}
	if (proto === "http") {
		if (typeof v.method !== "string" || !/^[A-Z]+$/.test(v.method)) {
			out.push(diag("error", "api/method-required", "http 类 API 必须有大写 method", { path: where + "/method" }, {}, ["填写 METHOD，如 POST"]));
			return false;
		}
	} else if (v.method !== void 0) {
		out.push(diag("error", "api/method-forbidden", "非 http 类 API 不能有 method 字段", { path: where + "/method" }, {}, ["删除 method 字段"]));
		return false;
	}
	checkL10n(v.description, "description", 200, where, out);
	return true;
}
function checkDepEntry(v, where, out) {
	if (!isPlain$3(v)) {
		out.push(diag("error", "dep/entry-shape", "deps 条目必须为对象", { path: where }, {}, []));
		return false;
	}
	for (const k of Object.keys(v)) if (!DEP_KEYS.includes(k)) out.push(diag("error", "dep/unknown-field", "deps 条目不支持字段 " + k, { path: where }, {}, ["删除字段 " + k]));
	if (typeof v.kind !== "string" || !DEP_KINDS.includes(v.kind)) {
		out.push(diag("error", "dep/kind-unknown", "kind 不在允许枚举内", { path: where + "/kind" }, {
			value: v.kind,
			allowed: DEP_KINDS
		}, ["使用枚举值之一：" + DEP_KINDS.join(", ")]));
		return false;
	}
	if (typeof v.to !== "string" || v.to.trim().length === 0) {
		out.push(diag("error", "dep/to-empty", "to 必须为目标模块 id", { path: where + "/to" }, {}, ["填写目标模块 id"]));
		return false;
	}
	for (const k of ["from_api", "to_api"]) if (v[k] !== void 0 && (typeof v[k] !== "string" || v[k].trim().length === 0)) {
		out.push(diag("error", "dep/" + k + "-invalid", k + " 必须为非空字符串", { path: where + "/" + k }, {}, ["填写 API 键或删除该字段"]));
		return false;
	}
	if (v.label !== void 0) checkL10n(v.label, "label", 30, where, out);
	return true;
}
/** L1：单文件级字段校验（规范 §5.2 结构/API/边类的格式部分）。 */
function l1Validate(data, where) {
	const errors = [];
	const warnings = [];
	if (!isPlain$3(data)) {
		errors.push(diag("error", "input/not-object", "frontmatter 解析结果必须为映射", { path: where }, {}, []));
		return {
			module: null,
			errors,
			warnings
		};
	}
	for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) errors.push(diag("error", "structure/unknown-field", "frontmatter 不支持字段 " + k, { path: where }, {}, ["删除字段 " + k]));
	for (const k of [
		"uid",
		"id",
		"parent",
		"name",
		"description",
		"source",
		"revision",
		"updated_at",
		"fingerprint"
	]) if (!(k in data)) errors.push(diag("error", "structure/missing-field", "缺少必填字段 " + k, { path: where + "/" + k }, {}, ["补充 " + k + " 字段"]));
	const uid = data.uid;
	if (typeof uid !== "string" || !/^[a-f0-9]{8}$/.test(uid)) errors.push(diag("error", "structure/uid-format", "uid 必须为 8 位小写 hex", { path: where + "/uid" }, { value: uid }, ["使用 8 位小写十六进制随机串"]));
	const id = data.id;
	if (typeof id !== "string" || !isValidId(id)) errors.push(diag("error", "structure/id-format", "id 段格式必须为 [a-z0-9][a-z0-9-]*，点分隔（深度不设上限）", { path: where + "/id" }, { value: id }, ["修正 id，如 demo.order.checkout.payment"]));
	const parent = data.parent;
	if (parent !== null && typeof parent !== "string") errors.push(diag("error", "structure/parent-type", "parent 必须为字符串或 null", { path: where + "/parent" }, { value: parent }, ["填写父模块 id 或 null"]));
	else if (typeof id === "string" && isValidId(id)) {
		const derived = deriveParent(id);
		if (parent === null) {
			if (derived !== null) errors.push(diag("error", "structure/parent-mismatch", "parent 必须等于 id 去掉最后一段", { path: where + "/parent" }, {
				parent: null,
				derived
			}, ["将 parent 改为 " + derived]));
		} else if (parent !== derived) errors.push(diag("error", "structure/parent-mismatch", "parent 必须等于 id 去掉最后一段", { path: where + "/parent" }, {
			parent,
			derived
		}, ["将 parent 改为 " + derived]));
	}
	if (data.repository !== void 0) {
		if (typeof data.repository !== "string" || !/^https?:\/\//.test(data.repository)) errors.push(diag("error", "structure/repository-invalid", "repository 必须为 http(s) URL", { path: where + "/repository" }, {}, ["填写仓库 URL"]));
		else if (parent !== null) errors.push(diag("error", "structure/repository-root-only", "repository 只允许出现在根模块", { path: where + "/repository" }, {}, ["删除该字段"]));
	}
	checkL10n(data.name, "name", 60, where, errors);
	checkL10n(data.description, "description", 500, where, errors);
	const source = data.source;
	if (!Array.isArray(source)) errors.push(diag("error", "structure/source-type", "source 必须为数组", { path: where + "/source" }, {}, []));
	else source.forEach((s, i) => checkSourceEntry(s, where + "/source/" + i, errors));
	if (typeof data.revision !== "string" || !/^[a-f0-9]{40}$/.test(data.revision)) errors.push(diag("error", "structure/revision-invalid", "revision 必须为 40 位 git SHA", { path: where + "/revision" }, { value: data.revision }, ["填写完整 40 位提交 SHA"]));
	const updated = data.updated_at;
	if (typeof updated !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(updated) || Number.isNaN(Date.parse(updated))) errors.push(diag("error", "structure/updated-at-invalid", "updated_at 必须为 ISO 8601 时间", { path: where + "/updated_at" }, { value: updated }, ["使用 ISO 8601，如 2026-08-30T12:00:00Z"]));
	const rawState = data.state;
	let moduleState = "active";
	if (rawState !== void 0) if (typeof rawState !== "string" || !MODULE_STATES.includes(rawState)) errors.push(diag("error", "structure/state-invalid", "state 必须为 " + MODULE_STATES.join(" | "), { path: where + "/state" }, { value: rawState }, ["改为合法状态或删除该字段"]));
	else moduleState = rawState;
	if (data.replacement !== void 0) {
		if (moduleState !== "deprecated") errors.push(diag("error", "structure/replacement-state", "replacement 只允许出现在 state=deprecated 的模块上", { path: where + "/replacement" }, { state: moduleState }, ["删除 replacement 或把 state 改为 deprecated"]));
		else if (typeof data.replacement !== "string" || !isValidId(data.replacement)) errors.push(diag("error", "structure/replacement-invalid", "replacement 必须为合法模块 id", { path: where + "/replacement" }, { value: data.replacement }, ["填写替代模块的 id"]));
	}
	if (data.tags !== void 0) if (!Array.isArray(data.tags)) errors.push(diag("error", "structure/tags-shape", "tags 必须为字符串数组", { path: where + "/tags" }, {}, []));
	else {
		const seenTags = /* @__PURE__ */ new Set();
		for (const t of data.tags) {
			if (typeof t !== "string" || t.trim() === "" || t.length > 24) {
				errors.push(diag("error", "structure/tag-invalid", "tag 必须为非空字符串（≤24 字符）", { path: where + "/tags" }, { value: t }, []));
				continue;
			}
			if (seenTags.has(t)) errors.push(diag("error", "structure/tag-duplicate", "tag 重复", { path: where + "/tags" }, { value: t }, []));
			seenTags.add(t);
		}
		if (seenTags.size > 12) errors.push(diag("error", "structure/tags-too-many", "tags 最多 12 个", { path: where + "/tags" }, { count: seenTags.size }, []));
	}
	if (!(data.fingerprint === "pending" && (moduleState === "planned" || Array.isArray(data.source) && data.source.length === 0)) && (typeof data.fingerprint !== "string" || !/^[a-f0-9]{8,}$/.test(data.fingerprint))) errors.push(diag("error", "structure/fingerprint-invalid", "fingerprint 必须为非空十六进制哈希（planned 或空 source 的模块可用 pending）", { path: where + "/fingerprint" }, { value: data.fingerprint }, ["重新计算 source 文件的 SHA-256，或计划态填 pending"]));
	if (data.apis !== void 0 && !Array.isArray(data.apis)) errors.push(diag("error", "api/type", "apis 必须为数组", { path: where + "/apis" }, {}, []));
	if (data.deps !== void 0 && !Array.isArray(data.deps)) errors.push(diag("error", "dep/type", "deps 必须为数组", { path: where + "/deps" }, {}, []));
	if (errors.length > 0) return {
		module: null,
		errors,
		warnings
	};
	const module = {
		uid,
		id,
		parent,
		name: data.name,
		description: data.description,
		source,
		revision: data.revision,
		updated_at: data.updated_at,
		fingerprint: data.fingerprint
	};
	if (typeof data.repository === "string") module.repository = data.repository;
	if (typeof data.state === "string" && MODULE_STATES.includes(data.state)) module.state = data.state;
	if (typeof data.replacement === "string") module.replacement = data.replacement;
	if (Array.isArray(data.tags)) module.tags = data.tags;
	if (Array.isArray(data.apis)) {
		module.apis = data.apis;
		data.apis.forEach((a, i) => checkApiEntry(a, where + "/apis/" + i, errors));
		if (errors.length > 0) return {
			module: null,
			errors,
			warnings
		};
	}
	if (Array.isArray(data.deps)) {
		module.deps = data.deps;
		data.deps.forEach((d, i) => checkDepEntry(d, where + "/deps/" + i, errors));
		if (errors.length > 0) return {
			module: null,
			errors,
			warnings
		};
	}
	return {
		module,
		errors,
		warnings
	};
}
/** 解析模块文件文本：frontmatter（严格子集 YAML）+ 正文。 */
function parseModuleText(text, where) {
	const lines = text.split(/\r?\n/);
	if (lines[0] === void 0 || lines[0].trim() !== "---") return {
		module: null,
		body: "",
		errors: [diag("error", "input/no-frontmatter", "模块文件必须以 --- 开头的 YAML frontmatter 开始", { path: where }, {}, ["以 --- 开始 frontmatter"])],
		warnings: []
	};
	let close = -1;
	for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === "---") {
		close = i;
		break;
	}
	if (close < 0) return {
		module: null,
		body: "",
		errors: [diag("error", "input/unclosed-frontmatter", "frontmatter 缺少结束行 ---", { path: where }, {}, ["在 frontmatter 末尾补 ---"])],
		warnings: []
	};
	const yamlText = lines.slice(1, close).join("\n");
	const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
	let data;
	try {
		data = parse(yamlText, { uniqueKeys: true });
	} catch (error) {
		return {
			module: null,
			body: "",
			errors: [diag("error", "input/yaml-parse", "frontmatter YAML 解析失败" + (error instanceof YAMLParseError && Array.isArray(error.linePos) && error.linePos[0] !== void 0 ? "（第 " + error.linePos[0].line + " 行）" : "") + "：" + (error instanceof Error ? error.message : String(error)), { path: where }, {}, ["修复 YAML 语法（只允许规范 §3.3 的安全子集）"])],
			warnings: []
		};
	}
	const { module, errors, warnings } = l1Validate(data, where);
	return {
		module,
		body,
		errors,
		warnings
	};
}
function q(value) {
	return JSON.stringify(value);
}
const YAML_NON_STRING = /^(?:[-+]?\d+|\d+\.\d*|\.\d+|\d+(?:\.\d+)?[eE][-+]?\d+|true|false|null|~|yes|no|on|off)$/i;
function plainScalar(value) {
	if (value !== "" && /^[A-Za-z0-9_\-./]+$/.test(value) && !YAML_NON_STRING.test(value) && !/^[-?:,[\]{}#&*!|>'"%@]/.test(value)) return value;
	return q(value);
}
function l10nInline(v) {
	return "{zh: " + q(v.zh) + ", en: " + q(v.en) + "}";
}
/** 折叠块双语：indent 为 zh/en 键所在缩进，内容行再缩进 2。 */
function l10nBlock(indent, v) {
	const inner = indent + "    ";
	const fold = (s) => {
		return ">\n" + s.replace(/\r?\n/g, "\n").split("\n").map((l) => inner + l).join("\n");
	};
	return indent + "zh: " + fold(v.zh) + "\n" + indent + "en: " + fold(v.en);
}
function serializeModule(module, body) {
	const out = ["---"];
	out.push("uid: " + plainScalar(module.uid));
	out.push("id: " + plainScalar(module.id));
	out.push("parent: " + (module.parent === null ? "null" : plainScalar(module.parent)));
	if (module.repository !== void 0) out.push("repository: " + plainScalar(module.repository));
	if (module.state !== void 0 && module.state !== "active") out.push("state: " + plainScalar(module.state));
	if (module.replacement !== void 0) out.push("replacement: " + plainScalar(module.replacement));
	if (module.tags !== void 0 && module.tags.length > 0) out.push("tags: [" + module.tags.map((t) => plainScalar(t)).join(", ") + "]");
	out.push("name: " + l10nInline(module.name));
	out.push("description:");
	out.push(l10nBlock("  ", module.description));
	out.push("revision: " + plainScalar(module.revision));
	out.push("updated_at: " + plainScalar(module.updated_at));
	out.push("fingerprint: " + plainScalar(module.fingerprint));
	if (module.source.length === 0) out.push("source: []");
	else {
		out.push("source:");
		for (const s of module.source) {
			out.push("  - path: " + q(s.path));
			if (s.line !== void 0) out.push("    line: " + s.line);
			if (s.end_line !== void 0) out.push("    end_line: " + s.end_line);
		}
	}
	if (module.apis !== void 0) if (module.apis.length === 0) out.push("apis: []");
	else {
		out.push("apis:");
		for (const a of module.apis) {
			out.push("  - protocol: " + plainScalar(a.protocol));
			if (a.method !== void 0) out.push("    method: " + plainScalar(a.method));
			out.push("    path: " + q(a.path));
			out.push("    description:");
			out.push(l10nBlock("      ", a.description));
		}
	}
	if (module.deps !== void 0 && module.deps.length > 0) {
		out.push("deps:");
		for (const d of module.deps) {
			out.push("  - kind: " + plainScalar(d.kind));
			out.push("    to: " + plainScalar(d.to));
			if (d.from_api !== void 0) out.push("    from_api: " + q(d.from_api));
			if (d.to_api !== void 0) out.push("    to_api: " + q(d.to_api));
			if (d.label !== void 0) out.push("    label: " + l10nInline(d.label));
		}
	}
	out.push("---");
	const text = out.join("\n") + "\n";
	if (body.trim().length === 0) return text;
	return text + "\n" + body.trimEnd() + "\n";
}
/** 为 AI 生成器准备的字段速查（与 skills/normify-gen/SKILL.md 同步维护）。 */
function fieldReference() {
	const proto = PROTOCOLS.join(" | ");
	const kinds = DEP_KINDS.join(" | ");
	return [
		"模块字段（必填）: uid(8位hex) id(路径式,深度不限) parent(id去尾段|根为null) name{zh,en} description{zh,en} source[{path,line?,end_line?}] revision(40位SHA) updated_at(ISO) fingerprint(hex)",
		"可选: repository(仅根,http(s)URL) state(active|planned|deprecated) replacement(仅deprecated) tags[] apis(仅叶子) deps(出向箭头)",
		"plan-first: 计划态模块 state=planned + fingerprint=pending，允许 source 尚未落地；实现完成后用 normify_module_refresh(ids, activate=true) 激活",
		"apis 条目: protocol(" + proto + ") method(仅http,大写) path description{zh,en}",
		"deps 条目: kind(" + kinds + ") to(目标id,可跨树) from_api?(本模块API,仅叶子) to_api?(目标自身API) label?{zh,en}",
		"叶子 = 无任何模块以其为 parent；叶子必须写 apis（可为 []，记 warning）；非叶子与根禁止 apis",
		"未接箭头的 API 完全合法，不得删除",
		"fingerprint 算法（v1 全量哈希）: 按 source.path 升序，逐个 hash.update(UTF-8(path)) + hash.update(0x00) + hash.update(文件字节)，最后 hex；优先用 normify_fingerprint 工具计算，不要手估",
		"渲染数据（仅容器模块）: renders/<id 点号换斜杠>.json；用 normify_layout_upsert 写 mode(auto|groups|layers|grid)/max_columns/order/groups[{id,title,children}]/reading{zh,en}/edge_hints[{from,to,lane?,style?}]，让每一层按数据流与领域分组排布；叶子不需要"
	].join("\n");
}
//#endregion
//#region src/engine/args.ts
/** 批量入参的体量上限（超出即拒绝，避免长驻进程被单次调用打爆）。 */
const LIMITS = {
	/** 数组类参数（items / source / order / groups / edge_hints / files …）的最大条目数。 */
	arrayItems: 500,
	/** 单个自由文本字段（body / task / message / acceptance …）的最大字符数。 */
	textLength: 2e5,
	/** 单个对象类参数（frontmatter / patch / root / proposal）的最大 JSON 字节数。 */
	objectBytes: 1024 * 1024,
	/** 整个入参的最大 JSON 字节数。 */
	totalBytes: 4 * 1024 * 1024
};
const BOOL_STRINGS = new Map([
	["true", true],
	["false", false],
	["1", true],
	["0", false]
]);
function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
function byteLength(value) {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}
/** 布尔位（dry_run / direct_only / activate / enable …）的字符串归一：模型爱传 "true"/"false"。 */
function coerceBoolean(value) {
	if (typeof value === "boolean") return {
		ok: true,
		value
	};
	if (typeof value === "string") {
		const hit = BOOL_STRINGS.get(value.trim().toLowerCase());
		if (hit !== void 0) return {
			ok: true,
			value: hit
		};
	}
	return {
		ok: false,
		message: "必须是布尔值（true/false）"
	};
}
/** 单个值的类型检查（未知键 / 缺失由上层负责）。 */
function checkValue(key, schema, value, out) {
	const type = schema.type;
	if (type === void 0) return value;
	if (type === "boolean") {
		const coerced = coerceBoolean(value);
		if (!coerced.ok) {
			out.push(key + ": " + coerced.message);
			return value;
		}
		return coerced.value;
	}
	if (type === "string") {
		if (typeof value !== "string") {
			out.push(key + ": 必须是 string（实际 " + typeName(value) + "）");
			return value;
		}
		if (value.length > LIMITS.textLength) out.push(key + ": 超过 " + LIMITS.textLength + " 字符上限（实际 " + value.length + "）");
		if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(key + ": 必须是 " + JSON.stringify(schema.enum) + " 之一");
		return value;
	}
	if (type === "number" || type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			out.push(key + ": 必须是 " + type + "（实际 " + typeName(value) + "）");
			return value;
		}
		if (type === "integer" && !Number.isInteger(value)) out.push(key + ": 必须是整数");
		return value;
	}
	if (type === "array") {
		if (!Array.isArray(value)) {
			out.push(key + ": 必须是 array（实际 " + typeName(value) + "）");
			return value;
		}
		if (value.length > LIMITS.arrayItems) out.push(key + ": 超过 " + LIMITS.arrayItems + " 条上限（实际 " + value.length + "）");
		const items = schema.items;
		if (items?.type !== void 0 && items.type !== "object") {
			for (const [i, entry] of value.entries()) if (items.type === "string" && typeof entry !== "string") out.push(key + "[" + i + "]: 必须是 string（实际 " + typeName(entry) + "）");
			else if (items.type === "number" && (typeof entry !== "number" || !Number.isFinite(entry))) out.push(key + "[" + i + "]: 必须是 number");
		}
		return value;
	}
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			out.push(key + ": 必须是 object（实际 " + typeName(value) + "）");
			return value;
		}
		if (byteLength(value) > LIMITS.objectBytes) out.push(key + ": 超过 " + LIMITS.objectBytes + " 字节上限");
		return value;
	}
	return value;
}
/** 递归检查已编译 schema（对象/数组/标量），返回归一化后的入参副本。 */
function walk$1(schema, value, prefix, out) {
	const checked = checkValue(prefix, schema, value, out);
	if (schema.type === "array" && Array.isArray(checked)) {
		const items = schema.items;
		if (items?.properties === void 0) return checked;
		return checked.map((entry, i) => entry === null ? entry : walk$1(items, entry, prefix + "[" + i + "]", out));
	}
	if (schema.type === "object" && typeof checked === "object" && checked !== null && !Array.isArray(checked)) {
		const source = checked;
		const next = { ...source };
		const properties = schema.properties;
		for (const [key, entry] of Object.entries(source)) {
			const child = properties?.[key];
			if (child === void 0) {
				if (schema.additionalProperties === false && entry !== null) out.push((prefix === "" ? "" : prefix + ".") + key + ": 不支持的参数");
				continue;
			}
			if (entry === null) continue;
			next[key] = walk$1(child, entry, (prefix === "" ? "" : prefix + ".") + key, out);
		}
		return next;
	}
	return checked;
}
/**
* 校验一次 `tools/call` 的 arguments：未知键、类型、体量。
* `parent` 的显式 null 被保留（根模块语义），其余必填/未知键问题在此之前由注册表判存在性。
*/
function validateArgs(schema, rawArgs) {
	const given = rawArgs ?? {};
	if (typeof given !== "object" || Array.isArray(given)) return {
		ok: false,
		code: "args/shape",
		message: "arguments 必须是对象"
	};
	const problems = [];
	let args = given;
	if (schema === void 0) {
		if (Object.keys(args).length > 0) problems.push("该工具不接受任何参数：" + Object.keys(args).join(", "));
	} else args = walk$1(schema, args, "", problems);
	if (byteLength(args) > LIMITS.totalBytes) problems.push("arguments 超过 " + LIMITS.totalBytes + " 字节上限");
	if (problems.length > 0) return {
		ok: false,
		code: "args/invalid",
		message: problems.join("; ")
	};
	return {
		ok: true,
		args
	};
}
//#endregion
//#region src/engine/atomic.ts
function tempFor(path) {
	return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}
/** 单文件原子写：临时文件与目标同目录（跨卷 rename 会失败），失败时清理临时文件。 */
async function writeFileAtomic(path, data) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = tempFor(path);
	try {
		await writeFile(tmp, data);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}
/**
* 多产物原子写（compile 的 tree.json / outline.md / api-index.json / receipt.json）：
* 先把全部临时文件写完，再逐个 rename；任一步失败回滚已 rename 的目标并清理临时文件，
* 不会留下"新旧混合"的产物集。
*/
async function writeAllAtomic(writes) {
	const staged = [];
	const done = [];
	const previous = /* @__PURE__ */ new Map();
	try {
		for (const w of writes) {
			await mkdir(dirname(w.path), { recursive: true });
			const tmp = tempFor(w.path);
			await writeFile(tmp, w.data);
			staged.push({
				tmp,
				path: w.path
			});
		}
		for (const { tmp, path } of staged) {
			if (!previous.has(path)) previous.set(path, await readFile(path).catch(() => null));
			await rename(tmp, path);
			done.push(path);
		}
	} catch (error) {
		for (const path of done) {
			const before = previous.get(path) ?? null;
			if (before === null) await rm(path, { force: true });
			else await writeFileAtomic(path, before);
		}
		await Promise.all(staged.map((s) => rm(s.tmp, { force: true }).catch(() => {})));
		throw error;
	}
}
//#endregion
//#region src/engine/layout.ts
/**
* 渲染数据集：与结构数据集并行的一份可读性数据，只存在于容器模块（有子级的模块）。
* 文件路径 = renders/ + 模块 id 的点号换成斜杠 + .json，例如：
*   demo          → renders/demo.json
*   demo.order    → renders/demo/order.json
*   demo.order.checkout → renders/demo/order/checkout.json
* 叶子模块没有渲染图，因此没有渲染数据文件。
*/
const LAYOUT_KEYS = [
	"schema_version",
	"id",
	"updated_at",
	"mode",
	"max_columns",
	"max_api_rows",
	"reading",
	"order",
	"groups",
	"edge_hints"
];
const GROUP_KEYS = [
	"id",
	"title",
	"children"
];
const HINT_KEYS = [
	"from",
	"to",
	"kind",
	"lane",
	"style",
	"bundle",
	"priority"
];
/** sibling 边集合的 key：避免 NUL 字面量在源码/JSON 转义中踩坑。 */
function edgeKey(from, to) {
	return from + String.fromCharCode(0) + to;
}
/** 模块 id → 渲染数据文件的项目相对路径（正斜杠）。 */
function layoutRelPath(id) {
	const segs = splitId(id);
	if (segs === null) throw new Error("normify: invalid module id: " + JSON.stringify(id));
	return "renders/" + segs.join("/") + ".json";
}
function layoutFilePath(projectDir, id) {
	const segs = splitId(id);
	if (segs === null) throw new Error("normify: invalid module id: " + JSON.stringify(id));
	return join(projectDir, "renders", ...segs) + ".json";
}
/** 渲染数据相对路径 → 模块 id（demo/order.json 或 renders/demo/order.json → demo.order）。 */
function idFromLayoutPath(relPath) {
	const rel = relPath.replace(/\\/g, "/");
	const relBody = rel.startsWith("renders/") ? rel.slice(8) : rel;
	if (!relBody.endsWith(".json")) return null;
	const body = relBody.slice(0, -5);
	if (body.length === 0) return null;
	const segs = body.split("/");
	for (const s of segs) if (s.length === 0) return null;
	const id = segs.join(".");
	return isValidId(id) ? id : null;
}
async function walkJson(dir, base, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const rel = base === "" ? e.name : base + "/" + e.name;
		if (e.isDirectory()) await walkJson(join(dir, e.name), rel, out);
		else if (e.name.endsWith(".json")) out.push(rel);
	}
}
/** 列出全部渲染数据文件（renders/ 下相对路径，正斜杠）。 */
async function listLayoutFiles(projectDir) {
	const out = [];
	await walkJson(join(projectDir, "renders"), "", out);
	return out.sort(byCodeUnit);
}
/** 读取单个渲染数据文件；不存在返回 null。 */
async function loadLayoutFile(projectDir, id) {
	const path = layoutFilePath(projectDir, id);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {
			layout: null,
			error: null
		};
	}
	try {
		return {
			layout: JSON.parse(text),
			error: null
		};
	} catch (error) {
		return {
			layout: null,
			error: diag("error", "layout/json-parse", "渲染数据 JSON 解析失败：" + String(error instanceof Error ? error.message : error), { module: id }, { file: layoutRelPath(id) }, ["修复 JSON 语法或用 normify_layout_upsert 重写"])
		};
	}
}
function isPlain$2(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isL10n$2(v) {
	return isPlain$2(v) && typeof v.zh === "string" && typeof v.en === "string";
}
function isIsoish(s) {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
}
/**
* L1：渲染数据文件自身校验（形状 + 与直接子级集合的一致性）。
* 需要 children（直接子模块 id 列表）与 siblingEdges（'from\0to' 集合）。
*/
function l1ValidateLayout(data, id, children, siblingEdges, where) {
	const errors = [];
	const warnings = [];
	if (!isPlain$2(data)) {
		errors.push(diag("error", "layout/shape", "渲染数据必须为 JSON 对象", { module: id }, { path: where }, ["用 normify_layout_upsert 写入"]));
		return {
			layout: null,
			errors,
			warnings
		};
	}
	for (const k of Object.keys(data)) if (!LAYOUT_KEYS.includes(k)) errors.push(diag("error", "layout/unknown-field", "渲染数据不支持字段 " + k, { module: id }, { path: where + "/" + k }, ["删除字段 " + k]));
	if (data.schema_version !== 1) errors.push(diag("error", "layout/schema-version", "schema_version 必须为 1", { module: id }, { value: data.schema_version }, ["改为 1"]));
	if (data.id !== id) errors.push(diag("error", "layout/id-mismatch", "渲染数据的 id 必须等于对应模块 id", { module: id }, { value: data.id }, ["改为 " + id]));
	if (typeof data.updated_at !== "string" || !isIsoish(data.updated_at)) errors.push(diag("error", "layout/updated-at", "updated_at 必须为 ISO 8601 时间", { module: id }, { value: data.updated_at }, ["如 2026-09-11T12:00:00Z"]));
	const childSet = new Set(children);
	let mode;
	if (data.mode !== void 0) if (typeof data.mode !== "string" || !LAYOUT_MODES.includes(data.mode)) errors.push(diag("error", "layout/mode", "mode 必须为 " + LAYOUT_MODES.join(" | "), { module: id }, { value: data.mode }, ["改为合法模式"]));
	else mode = data.mode;
	if (data.max_columns !== void 0) {
		if (!Number.isInteger(data.max_columns) || data.max_columns < 1 || data.max_columns > 6) errors.push(diag("error", "layout/max-columns", "max_columns 必须为 1..6 的整数", { module: id }, { value: data.max_columns }, ["改为 1..6"]));
	}
	if (data.max_api_rows !== void 0) {
		if (!Number.isInteger(data.max_api_rows) || data.max_api_rows < 0 || data.max_api_rows > 48) errors.push(diag("error", "layout/max-api-rows", "max_api_rows 必须为 0..48 的整数（0 = 全部展开）", { module: id }, { value: data.max_api_rows }, ["改为 0..48"]));
	}
	let reading;
	if (data.reading !== void 0) if (!isL10n$2(data.reading) || data.reading.zh.trim() === "" || data.reading.en.trim() === "") errors.push(diag("error", "layout/reading", "reading 必须为 {zh, en} 非空双语", { module: id }, {}, ["补全双语阅读导语或删除该字段"]));
	else reading = {
		zh: data.reading.zh,
		en: data.reading.en
	};
	let order;
	if (data.order !== void 0) if (!Array.isArray(data.order)) errors.push(diag("error", "layout/order-shape", "order 必须为子模块 id 数组", { module: id }, {}, []));
	else {
		order = [];
		const seen = /* @__PURE__ */ new Set();
		for (const entry of data.order) {
			if (typeof entry !== "string" || !childSet.has(entry)) {
				errors.push(diag("error", "layout/order-child", "order 只能包含直接子模块 id", { module: id }, {
					value: entry,
					children
				}, ["改为直接子模块 id"]));
				continue;
			}
			if (seen.has(entry)) {
				errors.push(diag("error", "layout/order-duplicate", "order 中重复的子模块 id", { module: id }, { value: entry }, ["删除重复项"]));
				continue;
			}
			seen.add(entry);
			order.push(entry);
		}
		const missing = children.filter((c) => !seen.has(c));
		if (missing.length > 0) warnings.push(diag("warning", "layout/order-incomplete", "order 未覆盖全部子模块（未列出的按启发式追加）", { module: id }, { missing }, ["在 order 中补全或依赖自动追加"]));
	}
	let groups;
	if (data.groups !== void 0) if (!Array.isArray(data.groups)) errors.push(diag("error", "layout/groups-shape", "groups 必须为数组", { module: id }, {}, []));
	else {
		groups = [];
		const groupIds = /* @__PURE__ */ new Set();
		const assigned = /* @__PURE__ */ new Map();
		for (const g of data.groups) {
			if (!isPlain$2(g)) {
				errors.push(diag("error", "layout/group-shape", "group 必须为对象", { module: id }, {}, []));
				continue;
			}
			for (const k of Object.keys(g)) if (!GROUP_KEYS.includes(k)) errors.push(diag("error", "layout/group-unknown-field", "group 不支持字段 " + k, { module: id }, {}, []));
			const gid = typeof g.id === "string" && g.id.trim() !== "" ? g.id : null;
			if (gid === null) {
				errors.push(diag("error", "layout/group-id", "group.id 必须为非空字符串", { module: id }, {}, []));
				continue;
			}
			if (groupIds.has(gid)) {
				errors.push(diag("error", "layout/group-id-duplicate", "group.id 重复", { module: id }, { value: gid }, []));
				continue;
			}
			groupIds.add(gid);
			if (!isL10n$2(g.title) || g.title.zh.trim() === "" || g.title.en.trim() === "") {
				errors.push(diag("error", "layout/group-title", "group.title 必须为 {zh, en} 非空双语", { module: id }, { group: gid }, []));
				continue;
			}
			if (!Array.isArray(g.children) || g.children.length === 0) {
				errors.push(diag("error", "layout/group-children", "group.children 必须为非空数组", { module: id }, { group: gid }, []));
				continue;
			}
			const kids = [];
			for (const c of g.children) {
				if (typeof c !== "string" || !childSet.has(c)) {
					errors.push(diag("error", "layout/group-child", "group.children 只能包含直接子模块 id", { module: id }, {
						group: gid,
						value: c,
						children
					}, []));
					continue;
				}
				if (assigned.has(c)) {
					errors.push(diag("error", "layout/group-child-duplicate", "子模块被分到多个 group", { module: id }, {
						child: c,
						groups: [assigned.get(c), gid]
					}, []));
					continue;
				}
				assigned.set(c, gid);
				kids.push(c);
			}
			if (kids.length > 0) groups.push({
				id: gid,
				title: {
					zh: g.title.zh,
					en: g.title.en
				},
				children: kids
			});
		}
		if (mode === "groups" && groups.length === 0) errors.push(diag("error", "layout/groups-empty", "mode=groups 时必须提供至少一个 group", { module: id }, {}, ["补 groups 或改用其它 mode"]));
	}
	let edgeHints;
	if (data.edge_hints !== void 0) if (!Array.isArray(data.edge_hints)) errors.push(diag("error", "layout/hints-shape", "edge_hints 必须为数组", { module: id }, {}, []));
	else {
		edgeHints = [];
		let i = 0;
		for (const h of data.edge_hints) {
			const at = where + "/edge_hints/" + i;
			i++;
			if (!isPlain$2(h)) {
				errors.push(diag("error", "layout/hint-shape", "edge_hint 必须为对象", { module: id }, { path: at }, []));
				continue;
			}
			for (const k of Object.keys(h)) if (!HINT_KEYS.includes(k)) errors.push(diag("error", "layout/hint-unknown-field", "edge_hint 不支持字段 " + k, { module: id }, { path: at }, []));
			const from = h.from;
			const to = h.to;
			if (typeof from !== "string" || !childSet.has(from) || typeof to !== "string" || !childSet.has(to)) {
				errors.push(diag("error", "layout/hint-endpoint", "edge_hint.from/to 必须是直接子模块 id", { module: id }, {
					from,
					to,
					children
				}, []));
				continue;
			}
			if (from === to) {
				errors.push(diag("error", "layout/hint-self", "edge_hint 不能指向自身", { module: id }, { from }, []));
				continue;
			}
			if (!siblingEdges.has(edgeKey(from, to))) {
				errors.push(diag("error", "layout/hint-edge-missing", "edge_hint 指向的兄弟依赖边不存在", { module: id }, {
					from,
					to
				}, ["删除该 hint 或先在源模块的 deps 中补边"]));
				continue;
			}
			const hint = {
				from,
				to
			};
			if (h.kind !== void 0) if (typeof h.kind !== "string" || !DEP_KINDS.includes(h.kind)) errors.push(diag("error", "layout/hint-kind", "edge_hint.kind 必须为 " + DEP_KINDS.join(" | "), { module: id }, { value: h.kind }, []));
			else hint.kind = h.kind;
			if (h.lane !== void 0) if (!Number.isInteger(h.lane) || h.lane < 0 || h.lane > 9) errors.push(diag("error", "layout/hint-lane", "edge_hint.lane 必须为 0..9 整数", { module: id }, { value: h.lane }, []));
			else hint.lane = h.lane;
			if (h.style !== void 0) if (h.style !== "orthogonal" && h.style !== "curve") errors.push(diag("error", "layout/hint-style", "edge_hint.style 必须为 'orthogonal' | 'curve'", { module: id }, { value: h.style }, []));
			else hint.style = h.style;
			if (h.bundle !== void 0) if (typeof h.bundle !== "string" || h.bundle.trim() === "") errors.push(diag("error", "layout/hint-bundle", "edge_hint.bundle 必须为非空字符串", { module: id }, { value: h.bundle }, []));
			else hint.bundle = h.bundle;
			if (h.priority !== void 0) if (!Number.isInteger(h.priority)) errors.push(diag("error", "layout/hint-priority", "edge_hint.priority 必须为整数", { module: id }, { value: h.priority }, []));
			else hint.priority = h.priority;
			edgeHints.push(hint);
		}
	}
	if (errors.length > 0) return {
		layout: null,
		errors,
		warnings
	};
	return {
		layout: {
			schema_version: 1,
			id,
			updated_at: String(data.updated_at),
			...mode !== void 0 ? { mode } : {},
			...data.max_columns !== void 0 ? { max_columns: data.max_columns } : {},
			...data.max_api_rows !== void 0 ? { max_api_rows: data.max_api_rows } : {},
			...reading !== void 0 ? { reading } : {},
			...order !== void 0 ? { order } : {},
			...groups !== void 0 ? { groups } : {},
			...edgeHints !== void 0 ? { edge_hints: edgeHints } : {}
		},
		errors,
		warnings
	};
}
/** 稳定序列化（字段顺序固定，便于 diff）。 */
function serializeLayout(layout) {
	const out = {
		schema_version: layout.schema_version,
		id: layout.id,
		updated_at: layout.updated_at
	};
	if (layout.mode !== void 0) out.mode = layout.mode;
	if (layout.max_columns !== void 0) out.max_columns = layout.max_columns;
	if (layout.max_api_rows !== void 0) out.max_api_rows = layout.max_api_rows;
	if (layout.reading !== void 0) out.reading = layout.reading;
	if (layout.order !== void 0) out.order = layout.order;
	if (layout.groups !== void 0) out.groups = layout.groups;
	if (layout.edge_hints !== void 0) out.edge_hints = layout.edge_hints;
	return JSON.stringify(out, null, 2) + "\n";
}
async function writeLayoutFile(projectDir, layout) {
	const path = layoutFilePath(projectDir, layout.id);
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, serializeLayout(layout));
	return layoutRelPath(layout.id);
}
async function deleteLayoutFile(projectDir, id) {
	const path = layoutFilePath(projectDir, id);
	try {
		await rm(path, { force: true });
		return true;
	} catch {
		return false;
	}
}
/** L2：全项目渲染数据校验 + 与结构数据集的交叉校验。 */
async function validateLayouts(projectDir, byId, childrenOf, siblingEdges) {
	const errors = [];
	const warnings = [];
	const layouts = /* @__PURE__ */ new Map();
	const rels = await listLayoutFiles(projectDir);
	const seen = /* @__PURE__ */ new Set();
	for (const rel of rels) {
		const id = idFromLayoutPath(rel);
		if (id === null) {
			errors.push(diag("error", "layout/file-name", "渲染数据文件名不符合 renders/<id>.json 约定", { path: rel }, {}, ["重命名为 renders/<模块 id 路径>.json"]));
			continue;
		}
		if (seen.has(id)) {
			errors.push(diag("error", "layout/id-duplicate", "同一模块出现多份渲染数据", { module: id }, { path: rel }, []));
			continue;
		}
		seen.add(id);
		if (byId.get(id) === void 0) {
			errors.push(diag("error", "layout/orphan", "渲染数据没有对应的模块", { module: id }, { path: rel }, ["删除该文件或用 normify_module_upsert 创建模块"]));
			continue;
		}
		const children = childrenOf.get(id) ?? [];
		if (children.length === 0) {
			errors.push(diag("error", "layout/not-container", "叶子模块不需要渲染数据（没有可渲染的子层）", { module: id }, { path: rel }, ["删除该渲染数据文件"]));
			continue;
		}
		const { layout, error } = await loadLayoutFile(projectDir, id);
		if (error !== null) {
			errors.push(error);
			continue;
		}
		if (layout === null) continue;
		const r = l1ValidateLayout(layout, id, children, siblingEdges.get(id) ?? /* @__PURE__ */ new Set(), "renders/" + rel);
		errors.push(...r.errors);
		warnings.push(...r.warnings);
		if (r.layout !== null) layouts.set(id, r.layout);
	}
	const missing = [];
	for (const [id, kids] of childrenOf) if (kids.length >= 2 && !layouts.has(id) && byId.has(id)) missing.push(id);
	for (const id of missing.slice(0, 15)) warnings.push(diag("warning", "layout/missing", "容器模块缺少渲染数据（图谱将回退自动布局）", { module: id }, { children: childrenOf.get(id) }, ["用 normify_layout_upsert 写该层渲染数据（order / groups / mode）"]));
	if (missing.length > 15) warnings.push(diag("warning", "layout/missing-many", "还有更多容器缺少渲染数据", {}, {
		remaining: missing.length - 15,
		total: missing.length
	}, []));
	return {
		layouts,
		errors,
		warnings
	};
}
const RULE_KEYS = [
	"id",
	"type",
	"severity",
	"enabled",
	"message",
	"from",
	"to",
	"kind",
	"fromState",
	"toState",
	"layers",
	"allowSameLayer",
	"allowBackward",
	"scope",
	"includeCrossTree",
	"maxDepth",
	"mode",
	"pattern"
];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATTERN_CHARS = /^[a-z0-9.*-]+$/;
function policyFilePath(projectDir) {
	return join(projectDir, "policy.yml");
}
/** id 模式匹配：`*` 恰一段、`**` 任意段（含零段），其余精确匹配。 */
function matchIdPattern(pattern, id) {
	const p = pattern.split(".");
	const s = id.split(".");
	const memo = /* @__PURE__ */ new Map();
	const walk = (pi, si) => {
		const key = pi + ":" + si;
		const hit = memo.get(key);
		if (hit !== void 0) return hit;
		let result;
		if (pi === p.length) result = si === s.length;
		else if (p[pi] === "**") result = walk(pi + 1, si) || si < s.length && walk(pi, si + 1);
		else if (si >= s.length) result = false;
		else if (p[pi] === "*") result = walk(pi + 1, si + 1);
		else result = p[pi] === s[si] && walk(pi + 1, si + 1);
		memo.set(key, result);
		return result;
	};
	return walk(0, 0);
}
function anyMatch(patterns, id) {
	if (patterns === void 0 || patterns.length === 0) return true;
	for (const p of patterns) if (matchIdPattern(p, id)) return true;
	return false;
}
function effectiveState(m) {
	return m.state ?? "active";
}
/** 默认规则模板（项目创建时写入；含两条启用的基础规则与全部类型的注释示例）。 */
function defaultPolicyTemplate() {
	return `# Normify 架构规则（policy.yml）
# 在项目设计阶段安装，normify_validate 强制执行；severity: error（默认，阻断）| warning（提示）。
# 规则类型：forbid-dependency | dependency-direction | acyclic | max-depth | cross-tree | naming
# id 模式：* 单段、** 任意段；例如 dsh-normify.engine.** 匹配引擎下全部模块。
schema_version: 1
updated_at: "${(/* @__PURE__ */ new Date()).toISOString()}"
rules:
  # 基础规则 1：依赖图禁止环（含跨树，自环由核心校验拦截）
  - id: core-acyclic
    type: acyclic
    severity: error
    includeCrossTree: true
  # 基础规则 2：不新增指向已废弃模块的依赖（存量记 warning，便于迁移）
  - id: core-no-deprecated-target
    type: forbid-dependency
    from: ["**"]
    to: ["**"]
    toState: deprecated
    severity: warning

  # ---- 以下为完整规则集的示例，按项目需要取消注释/改写 ----
  # 依赖方向：层顺序 = 允许方向（前 → 后），同层是否允许由 allowSameLayer 控制
  # - id: layer-order
  #   type: dependency-direction
  #   severity: error
  #   allowSameLayer: true
  #   layers:
  #     - { name: engine,  match: ["<tree>.engine.**", "<tree>.engine"] }
  #     - { name: surface, match: ["<tree>.tools.**", "<tree>.tools", "<tree>.skill.**"] }
  #     - { name: boot,    match: ["<tree>.bootstrap.**", "<tree>.build"] }
  # 禁止/只允许某些依赖
  # - id: no-ui-to-core
  #   type: forbid-dependency
  #   from: ["<tree>.ui.**"]
  #   to: ["<tree>.engine.**"]
  #   kind: [call, reference]
  # 跨树依赖策略：forbid 禁止 / require-to-api 必须写 to_api / allow 允许
  # - id: cross-tree-api
  #   type: cross-tree
  #   mode: require-to-api
  # 深度上限（含树名段）
  # - id: depth-limit
  #   type: max-depth
  #   maxDepth: 10
  #   scope: ["<tree>.ui.**"]
  # 命名约束：作用域内每个 id 段必须匹配该正则
  # - id: naming-no-underscore
  #   type: naming
  #   pattern: "^[a-z][a-z0-9-]*$"
  #   scope: ["<tree>.**"]
`;
}
function isPlain$1(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isL10n$1(v) {
	return isPlain$1(v) && typeof v.zh === "string" && typeof v.en === "string" && v.zh.trim() !== "" && v.en.trim() !== "";
}
function validPatternList(v) {
	return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0 && PATTERN_CHARS.test(x));
}
/** naming 规则正则的长度上限：段名最长 4096 字符（ids.ts），模式再长也没有增益。 */
const MAX_PATTERN_LENGTH = 200;
/** 单条模式允许的量词个数：相邻多个量词（`\d+\.?\d*\d+`）会退化成多项式回溯。 */
const MAX_PATTERN_QUANTIFIERS = 3;
/** `{n,m}` 的重复上限。 */
const MAX_PATTERN_REPEAT = 64;
/**
* 灾难性回溯（ReDoS）闸门。naming 的 pattern 会被逐个模块 id 段反复 test，
* 而 stdio MCP 是单线程事件循环、没有超时——`(a+)+$` 之类一个模式就能把服务卡死。
* policy.yml 每次加载都过 L1，所以手改文件同样被挡。
*
* 判定：①过长；②量词作用在分组上（指数级回溯的经典形态）；③量词叠量词；
* ④`{n,m}` 次数过大。只放行线性模式——naming 只需要匹配 `[a-z0-9-]` 的段名。
*/
function isUnsafePattern(pattern) {
	if (pattern.length > MAX_PATTERN_LENGTH) return true;
	let inClass = false;
	let quantifiers = 0;
	let lastWasGroupEnd = false;
	let lastWasQuantifier = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			lastWasQuantifier = false;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === "(") {
			if (pattern[i + 1] === "?" && pattern[i + 2] !== ":") return true;
			if (pattern[i + 1] === "?") i++;
			lastWasGroupEnd = false;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === ")") {
			lastWasGroupEnd = true;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === "{") {
			const close = pattern.indexOf("}", i);
			if (close !== -1) {
				for (const part of pattern.slice(i + 1, close).split(",")) if (part !== "" && Number(part) > MAX_PATTERN_REPEAT) return true;
				i = close;
				quantifiers++;
				lastWasGroupEnd = false;
				lastWasQuantifier = true;
				continue;
			}
		}
		if (ch === "*" || ch === "+" || ch === "?") {
			if (lastWasGroupEnd) return true;
			if (lastWasQuantifier && ch !== "?") return true;
			quantifiers++;
			if (quantifiers > MAX_PATTERN_QUANTIFIERS) return true;
			lastWasQuantifier = true;
			continue;
		}
		lastWasQuantifier = false;
		lastWasGroupEnd = false;
	}
	return false;
}
/** L1：policy.yml 结构与规则字段校验。 */
function l1ValidatePolicy(data, where) {
	const errors = [];
	const warnings = [];
	if (!isPlain$1(data)) {
		errors.push(diag("error", "policy/shape", "policy.yml 必须为映射对象", { path: where }, {}, ["参照默认模板重写"]));
		return {
			policy: null,
			errors,
			warnings
		};
	}
	for (const k of Object.keys(data)) if (![
		"schema_version",
		"updated_at",
		"rules"
	].includes(k)) errors.push(diag("error", "policy/unknown-field", "policy.yml 不支持字段 " + k, { path: where + "/" + k }, {}, ["删除该字段"]));
	if (data.schema_version !== 1) errors.push(diag("error", "policy/schema-version", "schema_version 必须为 1", { path: where }, { value: data.schema_version }, []));
	if (typeof data.updated_at !== "string" || Number.isNaN(Date.parse(data.updated_at))) errors.push(diag("error", "policy/updated-at", "updated_at 必须为 ISO 8601 时间", { path: where }, { value: data.updated_at }, []));
	if (!Array.isArray(data.rules)) {
		errors.push(diag("error", "policy/rules-shape", "rules 必须为数组", { path: where }, {}, []));
		return {
			policy: null,
			errors,
			warnings
		};
	}
	const rules = [];
	const seen = /* @__PURE__ */ new Set();
	let i = 0;
	for (const raw of data.rules) {
		const at = where + "/rules/" + i;
		const errorsBefore = errors.length;
		i++;
		if (!isPlain$1(raw)) {
			errors.push(diag("error", "policy/rule-shape", "rule 必须为对象", { path: at }, {}, []));
			continue;
		}
		for (const k of Object.keys(raw)) if (!RULE_KEYS.includes(k)) errors.push(diag("error", "policy/rule-unknown-field", "rule 不支持字段 " + k, { path: at }, {}, []));
		const id = raw.id;
		if (typeof id !== "string" || !ID_PATTERN.test(id)) {
			errors.push(diag("error", "policy/rule-id", "rule.id 必须为 kebab-case 字符串", { path: at + "/id" }, { value: id }, []));
			continue;
		}
		if (seen.has(id)) {
			errors.push(diag("error", "policy/rule-id-duplicate", "rule.id 重复", { path: at + "/id" }, { value: id }, []));
			continue;
		}
		seen.add(id);
		const type = raw.type;
		if (typeof type !== "string" || !POLICY_RULE_TYPES.includes(type)) {
			errors.push(diag("error", "policy/rule-type", "rule.type 必须为 " + POLICY_RULE_TYPES.join(" | "), { path: at + "/type" }, { value: type }, []));
			continue;
		}
		if (raw.severity !== void 0 && raw.severity !== "error" && raw.severity !== "warning") errors.push(diag("error", "policy/rule-severity", "severity 必须为 'error' | 'warning'", { path: at + "/severity" }, { value: raw.severity }, []));
		if (raw.enabled !== void 0 && typeof raw.enabled !== "boolean") errors.push(diag("error", "policy/rule-enabled", "enabled 必须为布尔值", { path: at + "/enabled" }, {}, []));
		if (raw.message !== void 0 && !isL10n$1(raw.message)) errors.push(diag("error", "policy/rule-message", "message 必须为 {zh,en} 非空双语", { path: at + "/message" }, {}, []));
		const ruleType = type;
		if (raw.from !== void 0 && !validPatternList(raw.from) || raw.to !== void 0 && !validPatternList(raw.to) || raw.scope !== void 0 && !validPatternList(raw.scope)) errors.push(diag("error", "policy/rule-patterns", "from/to/scope 必须为非空 id 模式数组（字符集 a-z0-9.*-）", { path: at }, {}, []));
		if (raw.kind !== void 0 && (!Array.isArray(raw.kind) || raw.kind.some((k) => typeof k !== "string" || !DEP_KINDS.includes(k)))) errors.push(diag("error", "policy/rule-kind", "kind 必须为 " + DEP_KINDS.join(" | ") + " 数组", { path: at }, {}, []));
		for (const key of ["fromState", "toState"]) if (raw[key] !== void 0 && (typeof raw[key] !== "string" || !MODULE_STATES.includes(raw[key]))) errors.push(diag("error", "policy/rule-state", key + " 必须为 " + MODULE_STATES.join(" | "), { path: at + "/" + key }, {}, []));
		if (ruleType === "forbid-dependency") {
			if (raw.from === void 0 && raw.to === void 0 && raw.fromState === void 0 && raw.toState === void 0) errors.push(diag("error", "policy/rule-forbid-empty", "forbid-dependency 至少需要 from/to/fromState/toState 之一", { path: at }, {}, []));
		} else if (ruleType === "dependency-direction") {
			const layers = raw.layers;
			if (!Array.isArray(layers) || layers.length < 2) errors.push(diag("error", "policy/rule-layers", "dependency-direction 需要 ≥2 个 layer", { path: at + "/layers" }, {}, []));
			else {
				let li = 0;
				for (const layer of layers) {
					const lat = at + "/layers/" + li;
					li++;
					if (!isPlain$1(layer) || typeof layer.name !== "string" || layer.name.trim() === "" || !validPatternList(layer.match)) errors.push(diag("error", "policy/rule-layer-shape", "layer 需要 { name, match[] }", { path: lat }, {}, []));
				}
			}
			for (const key of ["allowSameLayer", "allowBackward"]) if (raw[key] !== void 0 && typeof raw[key] !== "boolean") errors.push(diag("error", "policy/rule-boolean", key + " 必须为布尔值", { path: at + "/" + key }, {}, []));
		} else if (ruleType === "acyclic") {
			if (raw.includeCrossTree !== void 0 && typeof raw.includeCrossTree !== "boolean") errors.push(diag("error", "policy/rule-boolean", "includeCrossTree 必须为布尔值", { path: at + "/includeCrossTree" }, {}, []));
		} else if (ruleType === "max-depth") {
			if (raw.maxDepth !== void 0 && (!Number.isInteger(raw.maxDepth) || raw.maxDepth < 1 || raw.maxDepth > 64)) errors.push(diag("error", "policy/rule-max-depth", "maxDepth 必须为 1..64 整数", { path: at + "/maxDepth" }, { value: raw.maxDepth }, []));
			if (raw.maxDepth === void 0) errors.push(diag("error", "policy/rule-max-depth-missing", "max-depth 规则必须提供 maxDepth", { path: at }, {}, []));
		} else if (ruleType === "cross-tree") {
			if (raw.mode !== "forbid" && raw.mode !== "allow" && raw.mode !== "require-to-api") errors.push(diag("error", "policy/rule-mode", "cross-tree 的 mode 必须为 'forbid' | 'allow' | 'require-to-api'", { path: at + "/mode" }, { value: raw.mode }, []));
		} else if (ruleType === "naming") if (typeof raw.pattern !== "string" || raw.pattern === "") errors.push(diag("error", "policy/rule-pattern", "naming 规则必须提供 pattern 正则", { path: at + "/pattern" }, {}, []));
		else if (isUnsafePattern(raw.pattern)) errors.push(diag("error", "policy/rule-pattern-unsafe", "pattern 过长（上限 " + MAX_PATTERN_LENGTH + " 字符）或含嵌套/叠加量词，可能触发灾难性回溯并卡死校验进程", { path: at + "/pattern" }, {
			value: raw.pattern,
			max_length: MAX_PATTERN_LENGTH,
			max_quantifiers: MAX_PATTERN_QUANTIFIERS
		}, ["改写为线性模式：不要用量词包裹分组，最多 3 个量词，如 ^[a-z][a-z0-9-]*$"]));
		else try {
			new RegExp(raw.pattern);
		} catch {
			errors.push(diag("error", "policy/rule-pattern-invalid", "pattern 不是合法正则", { path: at + "/pattern" }, { value: raw.pattern }, []));
		}
		if (errors.length === errorsBefore) rules.push(raw);
	}
	if (errors.length > 0) return {
		policy: null,
		errors,
		warnings
	};
	return {
		policy: {
			schema_version: 1,
			updated_at: String(data.updated_at),
			rules
		},
		errors,
		warnings
	};
}
/** 读取 policy.yml；不存在返回 null（不报错）。 */
async function loadPolicyFile(projectDir) {
	let text;
	try {
		text = await readFile(policyFilePath(projectDir), "utf8");
	} catch {
		return {
			policy: null,
			exists: false,
			errors: []
		};
	}
	let data;
	try {
		data = parse(text, { uniqueKeys: true });
	} catch (error) {
		return {
			policy: null,
			exists: true,
			errors: [diag("error", "policy/yaml-parse", "policy.yml 解析失败" + (error instanceof YAMLParseError && Array.isArray(error.linePos) && error.linePos[0] !== void 0 ? "（第 " + error.linePos[0].line + " 行）" : "") + "：" + (error instanceof Error ? error.message : String(error)), {}, {}, ["修复 YAML 语法"])]
		};
	}
	const r = l1ValidatePolicy(data, "policy.yml");
	return {
		policy: r.policy,
		exists: true,
		errors: r.errors
	};
}
async function writePolicyFile(projectDir, policy) {
	const text = "# Normify 架构规则（policy.yml）：normify_validate 强制执行；规则类型与示例见 normify_policy_get。\n" + stringify({
		schema_version: 1,
		updated_at: policy.updated_at,
		rules: policy.rules
	}, { lineWidth: 0 });
	await mkdir(projectDir, { recursive: true });
	await writeFileAtomic(policyFilePath(projectDir), text);
	return "policy.yml";
}
/** 项目创建时安装默认规则（已存在则不覆盖）。 */
async function installDefaultPolicy(projectDir) {
	const { exists } = await loadPolicyFile(projectDir);
	if (exists) return;
	await mkdir(projectDir, { recursive: true });
	await writeFileAtomic(policyFilePath(projectDir), defaultPolicyTemplate());
}
/** L2：执行全部启用的规则。 */
function evaluatePolicy(policy, ctx) {
	const out = [];
	for (const rule of policy.rules) {
		if (rule.enabled === false) continue;
		const severity = rule.severity ?? "error";
		const push = (message, subject, evidence, fixes) => {
			out.push(diag(severity, "policy/" + rule.id, message, subject, {
				...evidence,
				rule: rule.id,
				type: rule.type
			}, fixes));
		};
		if (rule.type === "forbid-dependency") for (const f of ctx.files) {
			const m = f.module;
			if (rule.fromState !== void 0 && effectiveState(m) !== rule.fromState) continue;
			if (!anyMatch(rule.from, m.id)) continue;
			for (const d of m.deps ?? []) {
				if (rule.kind !== void 0 && !rule.kind.includes(d.kind)) continue;
				const target = ctx.byId.get(d.to);
				if (rule.toState !== void 0 && (target === void 0 || effectiveState(target.module) !== rule.toState)) continue;
				if (!anyMatch(rule.to, d.to)) continue;
				push(rule.message?.zh ?? "禁止的依赖：" + m.id + " → " + d.to + "（规则 " + rule.id + "）", {
					module: m.id,
					to: d.to,
					kind: d.kind
				}, {}, ["删除该依赖、改走允许的路径，或与维护者确认后调整 policy.yml"]);
			}
		}
		else if (rule.type === "dependency-direction") {
			const layers = rule.layers ?? [];
			const layerOf = (id) => {
				for (let i = 0; i < layers.length; i++) if (anyMatch(layers[i]?.match ?? [], id)) return i;
				return -1;
			};
			/** Layer display name, indexed only through layerOf()'s non-negative result. */
			const layerName = (index) => layers[index]?.name ?? String(index);
			for (const f of ctx.files) {
				const m = f.module;
				const fromLayer = layerOf(m.id);
				if (fromLayer < 0) continue;
				for (const d of m.deps ?? []) {
					const toLayer = layerOf(d.to);
					if (toLayer < 0) continue;
					if (!(fromLayer < toLayer || fromLayer === toLayer && rule.allowSameLayer !== false) && !(rule.allowBackward === true)) push(rule.message?.zh ?? "依赖方向违规：" + m.id + "（" + layerName(fromLayer) + "）→ " + d.to + "（" + layerName(toLayer) + "）", {
						module: m.id,
						to: d.to
					}, {
						from_layer: layerName(fromLayer),
						to_layer: layerName(toLayer)
					}, ["改为从后层指向前层，或调整 policy.yml 的层定义"]);
				}
			}
		} else if (rule.type === "acyclic") {
			const nodes = /* @__PURE__ */ new Set();
			for (const f of ctx.files) if (anyMatch(rule.scope, f.module.id)) nodes.add(f.module.id);
			const adjacency = /* @__PURE__ */ new Map();
			for (const f of ctx.files) {
				if (!nodes.has(f.module.id)) continue;
				for (const d of f.module.deps ?? []) {
					if (!nodes.has(d.to)) continue;
					if (rule.includeCrossTree === false && treeOf(f.module.id) !== treeOf(d.to)) continue;
					const list = adjacency.get(f.module.id) ?? [];
					list.push(d.to);
					adjacency.set(f.module.id, list);
				}
			}
			const color = /* @__PURE__ */ new Map();
			const stack = [];
			const reported = /* @__PURE__ */ new Set();
			const dfs = (id) => {
				color.set(id, 1);
				stack.push(id);
				for (const next of adjacency.get(id) ?? []) {
					if (next === id) continue;
					const c = color.get(next) ?? 0;
					if (c === 1) {
						const start = stack.indexOf(next);
						const cycle = [...stack.slice(start), next];
						const key = [...cycle].sort(byCodeUnit).join("|");
						if (!reported.has(key)) {
							reported.add(key);
							push(rule.message?.zh ?? "依赖环：" + cycle.join(" → "), { module: next }, { cycle }, ["打断环中的一条边或调整模块边界"]);
						}
					} else if (c === 0) dfs(next);
				}
				stack.pop();
				color.set(id, 2);
			};
			for (const id of nodes) if ((color.get(id) ?? 0) === 0) dfs(id);
		} else if (rule.type === "max-depth") {
			const limit = rule.maxDepth ?? 64;
			for (const f of ctx.files) {
				if (!anyMatch(rule.scope, f.module.id)) continue;
				const depth = depthOf(f.module.id);
				if (depth > limit) push(rule.message?.zh ?? "模块 id 深度 " + depth + " 超过上限 " + limit + "：" + f.module.id, { module: f.module.id }, {
					depth,
					limit
				}, ["合并/上移模块或调整 policy.yml"]);
			}
		} else if (rule.type === "cross-tree") {
			if (rule.mode === "allow") continue;
			for (const f of ctx.files) for (const d of f.module.deps ?? []) {
				if (treeOf(f.module.id) === treeOf(d.to)) continue;
				if (rule.mode === "forbid") push(rule.message?.zh ?? "禁止跨树依赖：" + f.module.id + " → " + d.to, {
					module: f.module.id,
					to: d.to
				}, {}, ["删除该依赖或调整 policy.yml"]);
				else if (rule.mode === "require-to-api" && d.to_api === void 0) push(rule.message?.zh ?? "跨树依赖必须写 to_api：" + f.module.id + " → " + d.to, {
					module: f.module.id,
					to: d.to
				}, {}, ["补充目标模块自身的 API 键"]);
			}
		} else if (rule.type === "naming") {
			if (isUnsafePattern(rule.pattern ?? "")) continue;
			let re = null;
			try {
				re = new RegExp(rule.pattern ?? "");
			} catch {
				continue;
			}
			for (const f of ctx.files) {
				if (!anyMatch(rule.scope, f.module.id)) continue;
				for (const seg of f.module.id.split(".")) if (!re.test(seg)) {
					push(rule.message?.zh ?? "命名违规：" + f.module.id + " 的段 \"" + seg + "\" 不匹配 " + rule.pattern, { module: f.module.id }, {
						segment: seg,
						pattern: rule.pattern
					}, ["重命名该段（用 normify_module_move）或调整 policy.yml"]);
					break;
				}
			}
		}
	}
	return out;
}
/** 供工具/诊断展示的规则类型说明。 */
function policyReference() {
	return [
		"policy.yml 规则类型：",
		"1) forbid-dependency: from[]/to[](id 模式，** 任意段)、kind?、fromState?/toState?，命中记违规",
		"2) dependency-direction: layers[{name,match[]}] 顺序即允许方向；allowSameLayer(默认true)/allowBackward(默认false)",
		"3) acyclic: scope?、includeCrossTree?(默认true) 检测依赖环",
		"4) max-depth: maxDepth(1..64)、scope? 限制 id 段数",
		"5) cross-tree: mode=forbid|allow|require-to-api（require 时跨树必须写 to_api）",
		"6) naming: pattern(正则)、scope? 限制 id 段的命名",
		"severity 默认 error（阻断 build），可设 warning；规则可用 enabled:false 临时停用。",
		"项目创建时会自动写入默认模板（policy.yml）；用 normify_policy_get / normify_policy_upsert 读取与更新。"
	].join("\n");
}
//#endregion
//#region src/engine/paths.ts
/**
* 路径围栏（path containment）：所有"外部可控的路径"在落盘/读盘前都要过一次这里。
* 词法比较挡不住符号链接，所以两侧都取 realpath 再比 `relative`。
*/
/** 解析 realpath；目标不存在时退化为"最深的已存在祖先"的 realpath + 余下段（创建场景）。 */
function realpathDeepest(target) {
	let current = resolve(target);
	const tail = [];
	for (;;) try {
		return resolve(realpathSync(current), ...tail);
	} catch {
		const parent = dirname(current);
		if (parent === current) return resolve(target);
		tail.unshift(basename(current));
		current = parent;
	}
}
/** `rel` 是否越界：`..` 前缀、绝对路径、或空（等于 root 自身）都算越界。 */
function escapesRoot(rel) {
	return rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel);
}
/** target 是否严格位于 root 之内（两侧 realpath 后比较；root 自身返回 false）。 */
function isWithinRoot(root, target) {
	return !escapesRoot(relative(realpathDeepest(root), realpathDeepest(target)));
}
/**
* 校验 render 的 `out`：只允许结构数据目录下的正斜杠相对文件名。
* 绝对路径、`..` 段、反斜杠一律拒绝（写越界/覆盖任意文件都从这条进来）。
*/
function resolveOutputPath(projectDir, out) {
	const raw = (out ?? "").trim();
	const rel = raw === "" ? "normify.html" : raw;
	if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return {
		ok: false,
		reason: "输出路径必须是结构数据目录下的相对文件名，不能是绝对路径：" + rel
	};
	if (rel.includes("\\")) return {
		ok: false,
		reason: "输出路径只允许正斜杠：" + rel
	};
	if (rel.split("/").some((seg) => seg === "..")) return {
		ok: false,
		reason: "输出路径不允许包含 .. 段：" + rel
	};
	const target = resolve(projectDir, rel);
	if (escapesRoot(relative(resolve(projectDir), target))) return {
		ok: false,
		reason: "输出路径越出结构数据目录：" + rel
	};
	return {
		ok: true,
		path: target
	};
}
//#endregion
//#region src/engine/store.ts
const PROJECT_PREFIX = "normify-";
var NormifyError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "NormifyError";
	}
};
/**
* 项目目录互斥锁：按项目目录串行化读-改-写。
* MCP 的 stdio 分发已经串行（mcp.ts 的 promise 链），但 CLI / 宿主直调引擎时两个请求仍可交错，
* `expect_updated_at` 这类 TOCTOU 检查会双双通过、后写覆盖先写。
* 用 AsyncLocalStorage 记"当前上下文已持有的目录"，让嵌套调用（batch → writeModuleFile）不会自锁。
*/
const lockChains = /* @__PURE__ */ new Map();
const heldLocks = new AsyncLocalStorage();
/** 跨进程（多个 normify 进程同时写同一项目）不在本锁的覆盖范围内：锁是进程内的。 */
function withProjectLock(projectDir, fn) {
	const key = resolve(projectDir);
	const held = heldLocks.getStore();
	if (held?.has(key) === true) return fn();
	const run = (lockChains.get(key) ?? Promise.resolve()).then(() => heldLocks.run(new Set([...held ?? [], key]), fn));
	const tail = run.then(() => void 0, () => void 0);
	lockChains.set(key, tail);
	tail.then(() => {
		if (lockChains.get(key) === tail) lockChains.delete(key);
	});
	return run;
}
/** 跨根读写（结构数据目录落在 rootDir 之外）必须显式开关，不靠目录名前缀兜底。 */
function outsideRootAllowed() {
	const flag = (process.env.NORMIFY_ALLOW_PROJECT_OUTSIDE_ROOT ?? "").trim().toLowerCase();
	return flag === "1" || flag === "true";
}
/** 解析结构数据目录：dir 显式给出，或 normify-<project> 落在 rootDir 下。create=true 时自动创建空项目目录（仅写工具使用）。 */
async function resolveProject(rootDir, args, opts = {}) {
	const root = resolve(rootDir);
	const ensureModules = async (p) => {
		if (!existsSync(join(p, "modules"))) if (opts.create) {
			await mkdir(join(p, "modules"), { recursive: true });
			await installDefaultPolicy(p);
		} else throw new NormifyError("project/no-modules", "目录不存在或缺少 modules/：" + p);
	};
	/** 围栏：结构数据目录必须落在声明的 root 内（realpath 两侧比较，挡住符号链接与 .. 逃逸）。 */
	const fromDirArg = async (raw) => {
		const p = resolve(root, raw);
		if (!outsideRootAllowed() && !isWithinRoot(root, p)) throw new NormifyError("project/out-of-root", "结构数据目录必须位于 rootDir 内（" + root + "）：" + p + "；确需跨根请设置 NORMIFY_ALLOW_PROJECT_OUTSIDE_ROOT=1");
		const base = p.split(sep).pop() ?? "";
		if (!base.startsWith("normify-")) throw new NormifyError("project/dir-name", "结构数据目录名必须以 " + PROJECT_PREFIX + " 开头，如 normify-demo-repo（实际: " + base + "）");
		await ensureModules(p);
		return {
			dir: p,
			slug: base.slice(8)
		};
	};
	if (args.dir !== void 0 && args.dir.trim() !== "") return fromDirArg(args.dir);
	if (args.project !== void 0 && args.project.trim() !== "") {
		if (/[\\/\\:]/.test(args.project)) return fromDirArg(args.project);
		const slug = slugify(args.project);
		const p = resolve(root, PROJECT_PREFIX + slug);
		await ensureModules(p);
		return {
			dir: p,
			slug
		};
	}
	throw new NormifyError("project/required", "必须提供 project（项目 slug）或 dir（结构数据目录绝对路径）");
}
function listProjects(rootDir) {
	const root = resolve(rootDir);
	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
	return entries.filter((n) => n.startsWith(PROJECT_PREFIX)).map((n) => ({
		slug: n.slice(8),
		dir: join(root, n)
	})).sort((a, b) => a.slug.localeCompare(b.slug));
}
async function walk(dir, base, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const rel = base === "" ? e.name : base + "/" + e.name;
		if (e.isDirectory()) await walk(join(dir, e.name), rel, out);
		else if (e.name.endsWith(".md")) out.push(rel);
	}
}
async function listModuleFiles(projectDir) {
	const out = [];
	await walk(join(projectDir, "modules"), "", out);
	return out.sort(byCodeUnit);
}
/** 找模块现有文件（容器 index.md 优先，其次叶子 x.md）。 */
function findModuleFile(projectDir, id) {
	if (!isValidId(id)) return null;
	const container = moduleFilePath(projectDir, id, true);
	if (existsSync(container)) return container;
	const leaf = moduleFilePath(projectDir, id, false);
	if (existsSync(leaf)) return leaf;
	return null;
}
async function loadAllModules(projectDir) {
	const errors = [];
	const warnings = [];
	const files = [];
	for (const rel of await listModuleFiles(projectDir)) {
		const abs = join(projectDir, "modules", rel.replace(/\//g, sep));
		let text;
		try {
			text = await readFile(abs, "utf8");
		} catch (error) {
			errors.push(diag("error", "input/read", "无法读取模块文件", { path: rel }, { reason: String(error) }, []));
			continue;
		}
		const parsed = parseModuleText(text, rel);
		errors.push(...parsed.errors);
		warnings.push(...parsed.warnings);
		if (parsed.module !== null) files.push({
			module: parsed.module,
			body: parsed.body,
			file: rel
		});
	}
	return {
		files,
		errors,
		warnings
	};
}
/** 判断某模块当前是否为容器（有子模块或是根）。 */
function isContainer(module, all) {
	if (module.parent === null) return true;
	return all.some((m) => m.parent === module.id);
}
/** 写入模块文件；自动晋升父模块（leaf 文件 → index.md）。 */
/** 晋升为容器时 API 必须下放到叶子：摘掉容器上的 apis，并给出丢失的 API 键清单。 */
function stripApisForContainer(file) {
	const dropped = (file.module.apis ?? []).map((a) => a.protocol + ":" + a.path);
	if (dropped.length === 0) return {
		module: file.module,
		dropped
	};
	const next = {
		...file.module,
		updated_at: (/* @__PURE__ */ new Date()).toISOString()
	};
	delete next.apis;
	return {
		module: next,
		dropped
	};
}
function apiDropWarning(id, rel, dropped) {
	return diag("warning", "structure/api-dropped-on-promote", "模块晋升为容器（" + id + "）：容器不允许声明 API，已从容器上摘除 " + dropped.join("、"), { module: id }, {
		file: rel,
		dropped_apis: dropped
	}, ["把这些 API 写到合适的叶子子模块的 apis 字段上"]);
}
async function writeModuleFile(projectDir, module, body) {
	return withProjectLock(projectDir, () => writeModuleFileLocked(projectDir, module, body));
}
async function writeModuleFileLocked(projectDir, module, body) {
	const promoted = [];
	const warnings = [];
	const loaded = await loadAllModules(projectDir);
	const container = isContainer(module, loaded.files.map((f) => f.module));
	const target = moduleFilePath(projectDir, module.id, container);
	const existing = findModuleFile(projectDir, module.id);
	if (existing !== null && existing !== target) {
		await rename(existing, target);
		promoted.push(module.id);
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFileAtomic(target, serializeModule(module, body));
	const parentId = deriveParent(module.id);
	if (parentId !== null) {
		const parentLeaf = moduleFilePath(projectDir, parentId, false);
		if (existsSync(parentLeaf)) {
			const parentContainer = moduleFilePath(projectDir, parentId, true);
			await mkdir(dirname(parentContainer), { recursive: true });
			const parentFile = loaded.files.find((f) => f.module.id === parentId);
			const stripped = parentFile !== void 0 ? stripApisForContainer(parentFile) : null;
			if (parentFile === void 0 || stripped === null || stripped.dropped.length === 0) await rename(parentLeaf, parentContainer);
			else {
				await writeFileAtomic(parentContainer, serializeModule(stripped.module, parentFile.body ?? ""));
				await rm(parentLeaf, { force: true });
				warnings.push(apiDropWarning(parentId, relative(projectDir, parentContainer).replace(/\\/g, "/"), stripped.dropped));
			}
			promoted.push(parentId);
		}
	}
	return {
		file: relative(projectDir, target).replace(/\\/g, "/"),
		promoted,
		warnings
	};
}
/** 删除模块及其子树（含空目录清理与父模块降级）。 */
async function deleteModuleTree(projectDir, id) {
	const warnings = [];
	const { files } = await loadAllModules(projectDir);
	const all = files.map((f) => f.module);
	if (!all.some((m) => m.id === id)) throw new NormifyError("module/not-found", "模块不存在：" + id);
	const toDelete = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const m of all) if (!toDelete.has(m.id) && m.parent !== null && toDelete.has(m.parent)) {
			toDelete.add(m.id);
			grew = true;
		}
	}
	const order = all.filter((m) => toDelete.has(m.id)).sort((a, b) => b.id.length - a.id.length);
	const deleted = [];
	for (const m of order) {
		const file = findModuleFile(projectDir, m.id);
		if (file !== null) {
			await rm(file, { force: true });
			deleted.push(m.id);
		}
	}
	await pruneEmptyDirs(join(projectDir, "modules"), deleted);
	for (const deletedId of deleted) await deleteLayoutFile(projectDir, deletedId);
	const parentId = deriveParent(id);
	let demoted = null;
	if (parentId !== null) {
		const remaining = all.filter((m) => !toDelete.has(m.id));
		const parentStill = remaining.find((m) => m.id === parentId);
		if (parentStill !== void 0 && parentStill.parent !== null && !remaining.some((m) => m.parent === parentId)) {
			const container = moduleFilePath(projectDir, parentId, true);
			if (existsSync(container)) {
				const leaf = moduleFilePath(projectDir, parentId, false);
				await mkdir(dirname(leaf), { recursive: true });
				await rename(container, leaf);
				await deleteLayoutFile(projectDir, parentId);
				demoted = parentId;
			}
		}
	}
	return {
		deleted,
		demoted,
		warnings
	};
}
async function pruneEmptyDirs(base, deletedIds) {
	const dirs = /* @__PURE__ */ new Set();
	for (const id of deletedIds) {
		const segs = id.split(".");
		for (let i = 1; i <= segs.length; i++) dirs.add(join(base, ...segs.slice(0, i)));
	}
	const sorted = [...dirs].sort((a, b) => b.length - a.length);
	for (const d of sorted) try {
		if ((await readdir(d)).length === 0) await rm(d, { force: true });
	} catch {}
}
/** 叶子晋升容器：x.md → x/index.md。 */
async function promoteModule(projectDir, id) {
	const warnings = [];
	const container = moduleFilePath(projectDir, id, true);
	const leaf = moduleFilePath(projectDir, id, false);
	const rel = relative(projectDir, container).replace(/\\/g, "/");
	if (existsSync(container)) return {
		file: rel,
		warnings
	};
	if (!existsSync(leaf)) throw new NormifyError("module/not-found", "模块不存在：" + id);
	await mkdir(dirname(container), { recursive: true });
	const file = (await loadAllModules(projectDir)).files.find((f) => f.module.id === id);
	const stripped = file !== void 0 ? stripApisForContainer(file) : null;
	if (file === void 0 || stripped === null || stripped.dropped.length === 0) {
		await rename(leaf, container);
		return {
			file: rel,
			warnings
		};
	}
	await writeFileAtomic(container, serializeModule(stripped.module, file.body ?? ""));
	await rm(leaf, { force: true });
	warnings.push(apiDropWarning(id, rel, stripped.dropped));
	return {
		file: rel,
		warnings
	};
}
/** 仓库当前 HEAD（40 位 SHA）。 */
function gitHead(repoRoot) {
	const result = spawnSync("git", [
		"-C",
		repoRoot,
		"rev-parse",
		"HEAD"
	], { encoding: "utf8" });
	if (result.error !== void 0) return {
		sha: null,
		error: "git 不可用：" + result.error.message
	};
	if (result.status !== 0) return {
		sha: null,
		error: "git rev-parse 失败：" + String(result.stderr ?? "").slice(0, 200)
	};
	const sha = String(result.stdout).trim();
	if (!/^[a-f0-9]{40}$/.test(sha)) return {
		sha: null,
		error: "git HEAD 不是 40 位 SHA：" + sha
	};
	return {
		sha,
		error: null
	};
}
/** git 变更文件清单（增量再生成的输入）。 */
function gitChangedFiles(repoRoot, diffSpec) {
	const result = spawnSync("git", [
		"-C",
		repoRoot,
		"diff",
		"--name-only",
		diffSpec.trim() === "" ? "HEAD" : diffSpec.trim()
	], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024
	});
	if (result.error !== void 0) return {
		files: null,
		error: "git 不可用：" + result.error.message
	};
	if (result.status !== 0) return {
		files: null,
		error: "git diff 失败（exit " + result.status + "）：" + String(result.stderr ?? "").slice(0, 300)
	};
	const changed = String(result.stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
	const untracked = spawnSync("git", [
		"-C",
		repoRoot,
		"ls-files",
		"--others",
		"--exclude-standard"
	], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024
	});
	if (untracked.error === void 0 && untracked.status === 0) {
		for (const f of String(untracked.stdout).split(/\r?\n/).map((s) => s.trim())) if (f.length > 0 && !changed.includes(f)) changed.push(f);
	}
	return {
		files: changed,
		error: null
	};
}
/** source 文件集合的 SHA-256 指纹（全量哈希，v1 不做采样）。 */
async function fingerprintOf(repoRoot, sources) {
	const paths = [...new Set(sources.map((s) => s.path))].sort(byCodeUnit);
	const missing = [];
	const hash = createHash("sha256");
	for (const p of paths) {
		if (!isWithinRoot(repoRoot, resolve(repoRoot, p))) {
			missing.push(p);
			continue;
		}
		try {
			const buf = await readFile(join(repoRoot, p));
			hash.update(p);
			hash.update("\0");
			hash.update(buf);
		} catch {
			missing.push(p);
		}
	}
	return {
		hash: missing.length > 0 ? null : hash.digest("hex"),
		missing
	};
}
function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
//#endregion
//#region src/engine/edit.ts
async function loadProject(projectDir) {
	const loaded = await loadAllModules(projectDir);
	return {
		files: loaded.files,
		byId: new Map(loaded.files.map((f) => [f.module.id, f])),
		errors: loaded.errors,
		warnings: loaded.warnings
	};
}
function containerStatus(module, all) {
	if (module.parent === null) return true;
	return all.some((m) => m.parent === module.id);
}
function targetPath(projectDir, module, all) {
	return moduleFilePath(projectDir, module.id, containerStatus(module, all));
}
async function walkRel(base, rel, out) {
	let entries;
	try {
		entries = await readdir(join(base, rel), { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const child = rel === "" ? e.name : rel + "/" + e.name;
		if (e.isDirectory()) await walkRel(base, child, out);
		else out.push(child);
	}
}
/** 快照 modules/ 与 renders/（用于失败回滚；数据集很小，直接全量）。 */
async function snapshotProject(projectDir) {
	const files = /* @__PURE__ */ new Map();
	for (const dir of ["modules", "renders"]) {
		const rels = [];
		await walkRel(join(projectDir, dir), "", rels);
		for (const rel of rels) try {
			files.set(dir + "/" + rel, await readFile(join(projectDir, dir, rel)));
		} catch {}
	}
	return { files };
}
async function restoreProject(projectDir, snap) {
	for (const dir of ["modules", "renders"]) {
		const rels = [];
		await walkRel(join(projectDir, dir), "", rels);
		for (const rel of rels) {
			const key = dir + "/" + rel;
			if (!snap.files.has(key)) await rm(join(projectDir, dir, rel), { force: true });
		}
	}
	for (const [key, buf] of snap.files) {
		const path = join(projectDir, key);
		await mkdir(dirname(path), { recursive: true });
		await writeFileAtomic(path, buf);
	}
}
async function pruneEmpty(base, dirs) {
	const sorted = [...dirs].sort((a, b) => b.length - a.length);
	for (const d of sorted) try {
		if ((await readdir(d)).length === 0) await rm(d, { force: true });
	} catch {}
}
function cloneModule(m) {
	return JSON.parse(JSON.stringify(m));
}
/** 预览模块将写入的文件路径（不落盘）。 */
function previewModuleFile(projectDir, module, all) {
	return relative(projectDir, targetPath(projectDir, module, all)).replace(/\\/g, "/");
}
/** 合并 patch 到模块（字段级替换；id/uid 不可变，parent 必须由 move 改）。 */
function applyPatch(existing, patch) {
	const errors = [];
	for (const key of Object.keys(patch)) {
		if (key === "id" || key === "uid") errors.push(diag("error", "module/immutable-field", key + " 不可通过 patch 修改", { module: existing.id }, { field: key }, ["用 normify_module_move 处理重命名/移动"]));
		if (key === "parent" && patch.parent !== existing.parent) errors.push(diag("error", "module/parent-patch", "parent 不可通过 patch 修改", { module: existing.id }, {
			parent: patch.parent,
			expected: existing.parent
		}, ["用 normify_module_move({ id, new_parent })"]));
	}
	if (errors.length > 0) return {
		module: null,
		errors
	};
	const data = { ...cloneModule(existing) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) continue;
		data[key] = value;
	}
	data.updated_at = typeof patch.updated_at === "string" ? patch.updated_at : (/* @__PURE__ */ new Date()).toISOString();
	const r = l1Validate(data, "patch:" + existing.id);
	if (r.module === null) return {
		module: null,
		errors: r.errors
	};
	return {
		module: r.module,
		errors: []
	};
}
/** 读-改-写整体串行：并发 patch 的 expect_updated_at 检查会双双通过、后写覆盖先写。 */
function patchModule(projectDir, id, patch, opts = {}) {
	return withProjectLock(projectDir, () => patchModuleLocked(projectDir, id, patch, opts));
}
async function patchModuleLocked(projectDir, id, patch, opts = {}) {
	const { files, byId, errors, warnings } = await loadProject(projectDir);
	const errorsOut = [...errors];
	if (!byId.has(id)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/not-found", "模块不存在：" + id, { module: id }, {}, [])],
		warnings,
		changed: [],
		detail: {}
	};
	const existing = byId.get(id).module;
	if (typeof patch.expect_updated_at === "string" && patch.expect_updated_at !== existing.updated_at) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/conflict", "模块已被其他写入修改（updated_at 不一致），请先重新读取", { module: id }, {
			expected: patch.expect_updated_at,
			actual: existing.updated_at
		}, ["先 normify_module_get 复核再重写"])],
		warnings,
		changed: [],
		detail: {}
	};
	const cleanPatch = { ...patch };
	delete cleanPatch.expect_updated_at;
	const bodyOverride = typeof cleanPatch.body === "string" ? cleanPatch.body : void 0;
	delete cleanPatch.body;
	if (Object.keys(cleanPatch).length === 0 && bodyOverride === void 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "args/empty-patch", "没有任何字段要改：patch 里至少要有一个字段（或传 body）", { module: id }, { got_keys: Object.keys(patch) }, ["把要改的字段放进 patch，如 { tags: [\"a\"] }；只想读的话用 normify_module_get"])],
		warnings,
		changed: [],
		detail: {}
	};
	const merged = applyPatch(existing, cleanPatch);
	errorsOut.push(...merged.errors);
	if (merged.module === null) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: errorsOut,
		warnings,
		changed: [],
		detail: {}
	};
	const all = files.map((f) => f.module);
	const rel = relative(projectDir, targetPath(projectDir, merged.module, all)).replace(/\\/g, "/");
	if (opts.dryRun === true) return {
		ok: errorsOut.length === 0,
		dryRun: true,
		errors: errorsOut,
		warnings,
		changed: [],
		detail: {
			file: rel,
			module: merged.module
		}
	};
	const writeRes = await writeModuleFile(projectDir, merged.module, bodyOverride ?? byId.get(id).body ?? "");
	warnings.push(...writeRes.warnings);
	return {
		ok: errorsOut.length === 0,
		dryRun: false,
		errors: errorsOut,
		warnings,
		changed: [rel],
		detail: { file: rel },
		module: merged.module,
		file: rel
	};
}
/** 批量 upsert/patch：全部 L1 + 结构预检通过才落盘（原子，失败回滚）。 */
/** 整批读-改-写串行（内部调 writeModuleFile 命中同项目锁，不自锁）。 */
function batchWrite(projectDir, items, mode, opts = {}) {
	return withProjectLock(projectDir, () => batchWriteLocked(projectDir, items, mode, opts));
}
async function batchWriteLocked(projectDir, items, mode, opts = {}) {
	const { files, errors: loadErrors, warnings } = await loadProject(projectDir);
	const errorsOut = [...loadErrors];
	const working = /* @__PURE__ */ new Map();
	for (const f of files) working.set(f.module.id, cloneModule(f.module));
	const bodies = /* @__PURE__ */ new Map();
	for (const f of files) bodies.set(f.module.id, f.body ?? "");
	const batchIds = /* @__PURE__ */ new Set();
	const droppedByL1 = /* @__PURE__ */ new Map();
	for (const item of items) if (mode === "upsert") {
		const fm = { ...item.frontmatter };
		if (fm.parent === "null" || fm.parent === null) fm.parent = null;
		if (typeof fm.updated_at !== "string") fm.updated_at = (/* @__PURE__ */ new Date()).toISOString();
		const id = typeof fm.id === "string" ? fm.id : "?";
		const r = l1Validate(fm, "batch:" + id);
		errorsOut.push(...r.errors);
		const firstError = r.errors[0];
		if (r.module === null && firstError !== void 0) droppedByL1.set(id, firstError);
		if (r.module !== null) {
			if (batchIds.has(r.module.id)) errorsOut.push(diag("error", "module/batch-duplicate", "同一批次中模块 id 重复", { module: r.module.id }, {}, []));
			batchIds.add(r.module.id);
			working.set(r.module.id, r.module);
			bodies.set(r.module.id, typeof fm.body === "string" ? fm.body : bodies.get(r.module.id) ?? "");
		}
	} else {
		const id = String(item.patch?.id ?? "");
		if (!working.has(id)) {
			errorsOut.push(diag("error", "module/not-found", "patch 目标模块不存在：" + id, { module: id }, {}, []));
			continue;
		}
		const inner = item.patch?.patch;
		if (inner === void 0 || inner === null || typeof inner !== "object" || Array.isArray(inner) || Object.keys(inner).length === 0) {
			errorsOut.push(diag("error", "args/invalid-patch", "patch 模式要求 items[i] = { patch: { id, patch: { ...要改的字段 } } } —— 内层 patch 才是字段补丁；当前内层缺失或为空（若直接放行，会\"返回 ok 但一个字段都没改\"）", { module: id }, {
				got_keys: Object.keys(item.patch ?? {}),
				inner_patch: inner === void 0 ? "missing" : JSON.stringify(inner).slice(0, 80)
			}, ["改成 { patch: { id: \"" + id + "\", patch: { tags: [\"...\"] } } }"]));
			continue;
		}
		const r = applyPatch(working.get(id), { ...inner });
		errorsOut.push(...r.errors);
		if (r.module !== null) {
			if (batchIds.has(r.module.id)) errorsOut.push(diag("error", "module/batch-duplicate", "同一批次中模块 id 重复", { module: r.module.id }, {}, []));
			batchIds.add(r.module.id);
			working.set(r.module.id, r.module);
		}
	}
	const all = [...working.values()];
	const idSet = new Set(all.map((m) => m.id));
	for (const m of all) {
		if (m.parent !== null && !idSet.has(m.parent)) {
			const cause = droppedByL1.get(m.parent);
			if (cause !== void 0) errorsOut.push(diag("error", "structure/parent-dropped", "parent「" + m.parent + "」因本批 L1 校验失败被移出批次（根因见该模块的 " + cause.code + " 诊断），本模块随之无法落盘", { module: m.id }, {
				parent: m.parent,
				root_cause_code: cause.code,
				root_cause: cause.message
			}, ["先按 " + cause.code + " 的诊断修正 " + m.parent + "，再整批重试（本批为原子写入，未落盘）"]));
			else errorsOut.push(diag("error", "structure/parent-not-exist", "parent 不存在（批次内也找不到）", { module: m.id }, { parent: m.parent }, ["先写父模块或修正 parent"]));
		}
		if (m.parent !== deriveParent(m.id)) errorsOut.push(diag("error", "structure/parent-mismatch", "parent 必须等于 id 去掉最后一段", { module: m.id }, {
			parent: m.parent,
			derived: deriveParent(m.id)
		}, []));
		if (splitId(m.id) === null) errorsOut.push(diag("error", "structure/id-format", "id 非法", { module: m.id }, {}, []));
		for (const d of m.deps ?? []) if (d.to === m.id) errorsOut.push(diag("error", "dep/self-loop", "箭头不能指向自身", { module: m.id }, {}, []));
		else if (!idSet.has(d.to)) {
			const cause = droppedByL1.get(d.to);
			if (cause !== void 0) errorsOut.push(diag("error", "dep/target-dropped", "箭头目标「" + d.to + "」因本批 L1 校验失败被移出批次（根因见该模块的 " + cause.code + " 诊断），因此本模块的这条箭头成了悬空边", { module: m.id }, {
				to: d.to,
				root_cause_code: cause.code,
				root_cause: cause.message
			}, ["先按 " + cause.code + " 的诊断修正 " + d.to + "，再整批重试（本批为原子写入，未落盘）"]));
			else errorsOut.push(diag("error", "dep/target-missing", "箭头目标不存在（批次内也找不到）", { module: m.id }, { to: d.to }, ["同批写入目标模块或修正 to"]));
		}
	}
	if (errorsOut.length > 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: errorsOut,
		warnings,
		changed: [],
		files: [],
		detail: {
			validated: items.length,
			dropped_by_l1: [...droppedByL1.entries()].map(([id, d]) => ({
				module: id,
				code: d.code,
				message: d.message
			})),
			root_cause_hint: droppedByL1.size > 0 ? "本批有 " + droppedByL1.size + " 个模块未通过 L1（见 dropped_by_l1）；连带诊断 dep/target-dropped 与 structure/parent-dropped 都指向它们，先修这些再整批重试" : null
		}
	};
	const targets = all.filter((m) => batchIds.has(m.id)).map((m) => ({
		module: m,
		path: targetPath(projectDir, m, all)
	}));
	if (opts.dryRun === true) return {
		ok: true,
		dryRun: true,
		errors: [],
		warnings,
		changed: [],
		files: targets.map((t) => relative(projectDir, t.path).replace(/\\/g, "/")),
		detail: { validated: targets.length }
	};
	const snap = await snapshotProject(projectDir);
	try {
		targets.sort((a, b) => a.module.id.length - b.module.id.length);
		for (const t of targets) {
			const writeRes = await writeModuleFile(projectDir, t.module, bodies.get(t.module.id) ?? "");
			warnings.push(...writeRes.warnings);
		}
	} catch (error) {
		await restoreProject(projectDir, snap);
		return {
			ok: false,
			dryRun: false,
			errors: [diag("error", "module/batch-write-failed", "批量写入失败，已回滚：" + String(error instanceof Error ? error.message : error), {}, {}, [])],
			warnings,
			changed: [],
			files: [],
			detail: {}
		};
	}
	return {
		ok: true,
		dryRun: false,
		errors: [],
		warnings,
		changed: targets.map((t) => relative(projectDir, t.path).replace(/\\/g, "/")),
		files: targets.map((t) => relative(projectDir, t.path).replace(/\\/g, "/")),
		detail: { written: targets.length }
	};
}
/** 迁移计划 + 落盘整体串行：并发 move 会各自基于同一份旧快照写回。 */
function moveModuleTree(projectDir, id, opts) {
	return withProjectLock(projectDir, () => moveModuleTreeLocked(projectDir, id, opts));
}
async function moveModuleTreeLocked(projectDir, id, opts) {
	const { files, byId, errors: loadErrors, warnings } = await loadProject(projectDir);
	const empty = {
		moves: [],
		rewired: []
	};
	if (!byId.has(id)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/not-found", "模块不存在：" + id, { module: id }, {}, []), ...loadErrors],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	let newId = opts.newId?.trim();
	if (newId === "") newId = void 0;
	const newParent = opts.newParent?.trim() === "" ? void 0 : opts.newParent?.trim();
	const lastSeg = splitId(id).slice(-1)[0];
	if (newId === void 0 && newParent !== void 0) newId = newParent + "." + lastSeg;
	if (newId === void 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/move-noop", "必须提供 new_id 或 new_parent", { module: id }, {}, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	if (newId === id && newParent === void 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/move-noop", "新 id 与旧 id 相同", { module: id }, {}, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	if (!isValidId(newId)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "structure/id-format", "new_id 非法或超过深度上限", { module: id }, { new_id: newId }, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	const derivedParent = deriveParent(newId);
	if (newParent !== void 0 && newParent !== derivedParent) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/move-parent-mismatch", "new_parent 必须等于 new_id 去掉最后一段", { module: id }, {
			new_id: newId,
			new_parent: newParent,
			derived: derivedParent
		}, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	if (newParent !== void 0 && !byId.has(newParent)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "structure/parent-not-exist", "目标父模块不存在", { module: id }, { new_parent: newParent }, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	const subtree = files.filter((f) => f.module.id === id || f.module.id.startsWith(id + ".")).map((f) => f.module);
	const subtreeIds = new Set(subtree.map((m) => m.id));
	if (newParent !== void 0 && subtreeIds.has(newParent)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/move-cycle", "目标父模块在被移动的子树内", { module: id }, { new_parent: newParent }, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	const mapping = /* @__PURE__ */ new Map();
	for (const m of subtree) mapping.set(m.id, newId + m.id.slice(id.length));
	const outsideIds = new Set(files.filter((f) => !subtreeIds.has(f.module.id)).map((f) => f.module.id));
	for (const [, to] of mapping) if (outsideIds.has(to)) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "module/id-conflict", "移动后 id 与现有模块冲突", { module: id }, { conflict: to }, [])],
		warnings,
		changed: [],
		detail: {},
		...empty
	};
	const moved = /* @__PURE__ */ new Map();
	const rewired = [];
	for (const f of files) {
		const m = cloneModule(f.module);
		if (mapping.has(m.id)) {
			m.id = mapping.get(m.id);
			m.parent = deriveParent(m.id);
		}
		if (m.deps !== void 0) for (const d of m.deps) {
			const target = mapping.get(d.to);
			if (target !== void 0) {
				rewired.push({
					module: m.id,
					from: d.to,
					to: target
				});
				d.to = target;
			}
		}
		moved.set(m.id, m);
	}
	const all = [...moved.values()];
	const bodyOf = new Map(files.map((f) => [f.module.id, f.body ?? ""]));
	const moves = [];
	for (const [from, to] of mapping) moves.push({
		from,
		to
	});
	const dirty = /* @__PURE__ */ new Set();
	for (const [, to] of mapping) dirty.add(to);
	for (const r of rewired) dirty.add(r.module);
	const oldParentId = deriveParent(id);
	const newParentId = deriveParent(newId);
	if (oldParentId !== null) dirty.add(oldParentId);
	if (newParentId !== null) dirty.add(newParentId);
	const writePlan = [];
	for (const did of [...dirty].sort((a, b) => a.length - b.length)) {
		const m = moved.get(did);
		if (m === void 0) continue;
		const to = relative(projectDir, targetPath(projectDir, m, all)).replace(/\\/g, "/");
		const oldEntry = [...mapping.entries()].find(([, toId]) => toId === did);
		const oldId = oldEntry !== void 0 ? oldEntry[0] : did;
		const oldSrc = byId.get(oldId);
		const from = oldSrc !== void 0 ? "modules/" + oldSrc.file : null;
		writePlan.push({
			from,
			to,
			module: m,
			moved: oldEntry !== void 0,
			body: bodyOf.get(oldId) ?? ""
		});
	}
	const layoutPlan = [];
	const layoutDeletes = [];
	for (const p of writePlan) if (!(all.some((x) => x.parent === p.module.id) || p.module.parent === null) && existsSync(join(projectDir, layoutRelPath(p.module.id)))) layoutDeletes.push(p.module.id);
	const deletedLayoutIds = new Set(layoutDeletes);
	const movedOldIds = new Set(mapping.keys());
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const remap = (old) => mapping.get(old) ?? old;
	const unparsedLayouts = [];
	/** 父层渲染数据：删掉指向已迁出子模块的 order / groups / edge_hints 引用；无改动返回 null。 */
	const pruneLayoutRefs = (layout) => {
		const next = { ...layout };
		let touched = false;
		if (layout.order !== void 0) {
			const kept = layout.order.filter((x) => !movedOldIds.has(x));
			if (kept.length !== layout.order.length) {
				touched = true;
				if (kept.length > 0) next.order = kept;
				else delete next.order;
			}
		}
		if (layout.groups !== void 0) {
			const kept = layout.groups.map((g) => ({
				...g,
				children: g.children.filter((x) => !movedOldIds.has(x))
			})).filter((g) => g.children.length > 0);
			if (kept.length !== layout.groups.length) {
				touched = true;
				if (kept.length > 0) next.groups = kept;
				else delete next.groups;
			}
		}
		if (next.groups === void 0 && next.mode === "groups") delete next.mode;
		if (layout.edge_hints !== void 0) {
			const kept = layout.edge_hints.filter((h) => !movedOldIds.has(h.from) && !movedOldIds.has(h.to));
			if (kept.length !== layout.edge_hints.length) {
				touched = true;
				if (kept.length > 0) next.edge_hints = kept;
				else delete next.edge_hints;
			}
		}
		if (!touched) return null;
		next.updated_at = now;
		return next;
	};
	for (const [from, to] of mapping) {
		const oldLayout = layoutRelPath(from);
		if (!existsSync(join(projectDir, oldLayout))) continue;
		const loaded = await loadLayoutFile(projectDir, from);
		if (loaded.layout === null) {
			unparsedLayouts.push(oldLayout);
			layoutPlan.push({
				from: oldLayout,
				to: layoutRelPath(to),
				id: to
			});
			continue;
		}
		const children = new Set(all.filter((m) => m.parent === to).map((m) => m.id));
		const migrated = {
			...loaded.layout,
			id: to,
			updated_at: now
		};
		if (loaded.layout.order !== void 0) migrated.order = loaded.layout.order.map(remap).filter((x) => children.has(x));
		if (loaded.layout.groups !== void 0) {
			const groups = loaded.layout.groups.map((g) => ({
				...g,
				children: g.children.map(remap).filter((x) => children.has(x))
			})).filter((g) => g.children.length > 0);
			if (groups.length > 0) migrated.groups = groups;
			else delete migrated.groups;
		}
		if (migrated.groups === void 0 && migrated.mode === "groups") delete migrated.mode;
		if (loaded.layout.edge_hints !== void 0) {
			const hints = loaded.layout.edge_hints.map((h) => ({
				...h,
				from: remap(h.from),
				to: remap(h.to)
			})).filter((h) => children.has(h.from) && children.has(h.to) && h.from !== h.to);
			if (hints.length > 0) migrated.edge_hints = hints;
			else delete migrated.edge_hints;
		}
		layoutPlan.push({
			from: oldLayout,
			to: layoutRelPath(to),
			id: to,
			data: migrated
		});
	}
	const layoutRewrites = [];
	const parentIds = /* @__PURE__ */ new Set();
	if (oldParentId !== null) parentIds.add(oldParentId);
	if (newParentId !== null) parentIds.add(newParentId);
	for (const pid of [...parentIds].sort(byCodeUnit)) {
		if (deletedLayoutIds.has(pid) || movedOldIds.has(pid)) continue;
		if (!existsSync(join(projectDir, layoutRelPath(pid)))) continue;
		const loaded = await loadLayoutFile(projectDir, pid);
		if (loaded.layout === null) {
			unparsedLayouts.push(layoutRelPath(pid));
			continue;
		}
		let data = pid === oldParentId ? pruneLayoutRefs(loaded.layout) : null;
		if (pid === newParentId) {
			const base = data ?? loaded.layout;
			if (base.order !== void 0 && !base.order.includes(newId)) data = {
				...base,
				order: [...base.order, newId],
				updated_at: now
			};
		}
		if (data !== null) layoutRewrites.push({
			id: pid,
			data
		});
	}
	if (unparsedLayouts.length > 0) warnings.push(diag("warning", "layout/unparsed-carried", "渲染数据无法解析，已按原样搬运（未重写 id/order）：" + unparsedLayouts.join("、"), {}, { paths: unparsedLayouts }, ["用 normify_layout_upsert 重写这些层"]));
	const writeTos = writePlan.filter((p) => p.from === null || p.from !== p.to).map((p) => p.to);
	const rewritePaths = layoutRewrites.map((r) => layoutRelPath(r.id));
	const changed = [
		...writeTos,
		...layoutPlan.map((p) => p.to),
		...rewritePaths,
		...layoutDeletes.map((id) => layoutRelPath(id))
	];
	if (opts.dryRun === true) return {
		ok: true,
		dryRun: true,
		errors: [],
		warnings,
		changed,
		detail: {
			moves,
			rewired,
			layouts: layoutPlan,
			layout_rewrites: layoutRewrites.map((r) => ({
				id: r.id,
				path: layoutRelPath(r.id)
			})),
			layout_deletes: layoutDeletes,
			writes: writePlan.map((p) => ({
				id: p.module.id,
				from: p.from,
				to: p.to
			}))
		},
		moves,
		rewired
	};
	const snap = await snapshotProject(projectDir);
	try {
		for (const p of writePlan) if (p.moved && p.from !== null) await rm(join(projectDir, p.from), { force: true });
		for (const l of layoutPlan) {
			if (l.data !== void 0) {
				await writeLayoutFile(projectDir, l.data);
				await rm(join(projectDir, l.from), { force: true });
				continue;
			}
			const buf = await readFile(join(projectDir, l.from), "utf8");
			await mkdir(dirname(join(projectDir, l.to)), { recursive: true });
			await writeFileAtomic(join(projectDir, l.to), buf);
			await rm(join(projectDir, l.from), { force: true });
		}
		for (const r of layoutRewrites) await writeLayoutFile(projectDir, r.data);
		for (const delId of layoutDeletes) await deleteLayoutFile(projectDir, delId);
		for (const p of writePlan) {
			const writeRes = await writeModuleFile(projectDir, p.module, p.body);
			warnings.push(...writeRes.warnings);
		}
		const emptyDirs = /* @__PURE__ */ new Set();
		for (const p of writePlan) if (p.from !== null && p.from !== p.to) {
			let cur = dirname(join(projectDir, p.from));
			while (cur.length > join(projectDir, "modules").length) {
				emptyDirs.add(cur);
				cur = dirname(cur);
			}
		}
		for (const l of layoutPlan) {
			let cur = dirname(join(projectDir, l.from));
			while (cur.length > join(projectDir, "renders").length) {
				emptyDirs.add(cur);
				cur = dirname(cur);
			}
		}
		await pruneEmpty(join(projectDir, "modules"), emptyDirs);
		await pruneEmpty(join(projectDir, "renders"), emptyDirs);
	} catch (error) {
		await restoreProject(projectDir, snap);
		return {
			ok: false,
			dryRun: false,
			errors: [diag("error", "module/move-failed", "移动失败，已回滚：" + String(error instanceof Error ? error.message : error), {}, {}, [])],
			warnings,
			changed: [],
			detail: {},
			moves: [],
			rewired: []
		};
	}
	return {
		ok: true,
		dryRun: false,
		errors: [],
		warnings,
		changed,
		detail: {
			moves,
			rewired,
			layouts: layoutPlan,
			layout_rewrites: layoutRewrites.map((r) => ({
				id: r.id,
				path: layoutRelPath(r.id)
			})),
			layout_deletes: layoutDeletes
		},
		moves,
		rewired
	};
}
/** 读取 + 指纹重算 + 写回整体串行：并发 refresh 会基于同一份旧 updated_at 写回。 */
function refreshModules(projectDir, opts) {
	return withProjectLock(projectDir, () => refreshModulesLocked(projectDir, opts));
}
async function refreshModulesLocked(projectDir, opts) {
	const { files, byId, errors: loadErrors, warnings } = await loadProject(projectDir);
	const errorsOut = [...loadErrors];
	const refreshed = [];
	const missing = [];
	const targets = opts.all === true ? files.map((f) => f.module.id) : opts.ids ?? [];
	if (targets.length === 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: [diag("error", "refresh/no-target", "必须提供 ids 或 all:true", {}, {}, [])],
		warnings,
		changed: [],
		detail: {},
		refreshed,
		missing
	};
	const head = gitHead(opts.repoRoot);
	if (head.sha === null) warnings.push(diag("warning", "refresh/git-unavailable", "无法获取 git HEAD（" + (head.error ?? "未知原因") + "）：本次只重算 fingerprint/updated_at，revision 保持模块原值", { repoRoot: opts.repoRoot }, {}, ["在 repoRoot 下 git init && git commit 后重跑 refresh 即可写入真实 revision"]));
	const activate = opts.activate === true;
	const planned = [];
	for (const id of targets) {
		const f = byId.get(id);
		if (f === void 0) {
			errorsOut.push(diag("error", "module/not-found", "模块不存在：" + id, { module: id }, {}, []));
			continue;
		}
		const m = cloneModule(f.module);
		const hasChildren = files.some((x) => x.module.parent === id) || m.parent === null;
		if (m.source.length === 0) {
			if (activate && m.state === "planned" && hasChildren) {
				m.state = "active";
				m.updated_at = (/* @__PURE__ */ new Date()).toISOString();
				planned.push({
					id,
					module: m
				});
			} else if (activate && m.state === "planned") errorsOut.push(diag("error", "refresh/activate-no-source", "计划态叶子没有 source，无法激活：" + id, { module: id }, {}, ["先补 source 指向落地文件"]));
			else missing.push({
				id,
				paths: []
			});
			continue;
		}
		const fp = await fingerprintOf(opts.repoRoot, m.source);
		if (fp.hash === null) {
			if (activate) errorsOut.push(diag("error", "refresh/activate-not-landed", "请求激活但 source 尚未落地：" + id, { module: id }, { missing: fp.missing }, ["先实现 source 指向的文件，或去掉 activate"]));
			else if (m.state === "planned") {
				warnings.push(diag("warning", "refresh/planned-not-landed", "计划态模块的 source 尚未落地，跳过：" + id, { module: id }, { missing: fp.missing }, []));
				missing.push({
					id,
					paths: fp.missing
				});
			} else errorsOut.push(diag("error", "evidence/source-missing", "source 指向的文件不存在，无法刷新：" + id, { module: id }, { missing: fp.missing }, []));
			continue;
		}
		m.fingerprint = fp.hash;
		if (head.sha !== null) m.revision = head.sha;
		m.updated_at = (/* @__PURE__ */ new Date()).toISOString();
		if (activate) m.state = "active";
		planned.push({
			id,
			module: m
		});
	}
	if (errorsOut.length > 0) return {
		ok: false,
		dryRun: opts.dryRun === true,
		errors: errorsOut,
		warnings,
		changed: [],
		detail: {},
		refreshed,
		missing
	};
	const all = files.map((f) => f.module);
	for (const p of planned) {
		const rel = relative(projectDir, targetPath(projectDir, p.module, all)).replace(/\\/g, "/");
		refreshed.push({
			id: p.id,
			fingerprint: p.module.fingerprint,
			state: p.module.state ?? "active",
			file: rel
		});
	}
	if (opts.dryRun === true) return {
		ok: true,
		dryRun: true,
		errors: [],
		warnings,
		changed: [],
		detail: {},
		refreshed,
		missing
	};
	const snap = await snapshotProject(projectDir);
	try {
		for (const p of planned) {
			const writeRes = await writeModuleFile(projectDir, p.module, byId.get(p.id).body ?? "");
			warnings.push(...writeRes.warnings);
		}
	} catch (error) {
		await restoreProject(projectDir, snap);
		return {
			ok: false,
			dryRun: false,
			errors: [diag("error", "refresh/write-failed", "刷新写入失败，已回滚：" + String(error instanceof Error ? error.message : error), {}, {}, [])],
			warnings,
			changed: [],
			detail: {},
			refreshed: [],
			missing
		};
	}
	return {
		ok: true,
		dryRun: false,
		errors: [],
		warnings,
		changed: refreshed.map((r) => r.file),
		detail: {
			refreshed: refreshed.length,
			activated: planned.filter((p) => p.module.state === "active").length
		},
		refreshed,
		missing
	};
}
/** 编码/设计前预检：拟新增的模块与依赖是否违反核心约束与 policy。 */
async function checkProposal(projectDir, proposal) {
	const { files, errors: loadErrors, warnings } = await loadProject(projectDir);
	const errors = [...loadErrors];
	const simulated = /* @__PURE__ */ new Map();
	for (const f of files) simulated.set(f.module.id, cloneModule(f.module));
	for (const item of proposal.modules ?? []) {
		if (typeof item.id !== "string" || !isValidId(item.id)) {
			errors.push(diag("error", "proposal/id-format", "拟建模块 id 非法", { module: item.id }, {}, []));
			continue;
		}
		const parent = item.parent === void 0 ? deriveParent(item.id) : item.parent;
		const existing = simulated.get(item.id);
		if (existing !== void 0) {
			if (item.state !== void 0) existing.state = item.state;
			if (parent !== void 0 && parent !== existing.parent) errors.push(diag("error", "proposal/parent-patch", "拟建/变更的 parent 与现有模块不一致（应使用 move）", { module: item.id }, {
				parent,
				actual: existing.parent
			}, []));
			continue;
		}
		if (parent !== null && !simulated.has(parent)) errors.push(diag("error", "proposal/parent-not-exist", "拟建模块的 parent 不存在", { module: item.id }, { parent }, ["同批创建父模块，或修正 parent"]));
		if (parent !== deriveParent(item.id)) errors.push(diag("error", "proposal/parent-mismatch", "parent 必须等于 id 去掉最后一段", { module: item.id }, {
			parent,
			derived: deriveParent(item.id)
		}, []));
		simulated.set(item.id, {
			uid: "00000000",
			id: item.id,
			parent: parent ?? null,
			name: {
				zh: item.id,
				en: item.id
			},
			description: {
				zh: "proposal",
				en: "proposal"
			},
			source: [],
			revision: "0".repeat(40),
			updated_at: (/* @__PURE__ */ new Date()).toISOString(),
			fingerprint: "pending",
			...item.state !== void 0 ? { state: item.state } : {}
		});
	}
	for (const d of proposal.deps ?? []) {
		if (!simulated.has(d.from)) {
			errors.push(diag("error", "proposal/from-missing", "依赖源模块不存在", { module: d.from }, {}, []));
			continue;
		}
		if (!simulated.has(d.to)) {
			errors.push(diag("error", "proposal/to-missing", "依赖目标不存在（可同时把它列入 modules）", { module: d.from }, { to: d.to }, []));
			continue;
		}
		if (d.to === d.from) {
			errors.push(diag("error", "proposal/self-loop", "依赖不能指向自身", { module: d.from }, {}, []));
			continue;
		}
		if (d.kind !== void 0 && !DEP_KINDS.includes(d.kind)) {
			errors.push(diag("error", "proposal/kind", "kind 必须为 " + DEP_KINDS.join(" | "), { module: d.from }, { kind: d.kind }, []));
			continue;
		}
		const from = simulated.get(d.from);
		from.deps = from.deps ?? [];
		from.deps.push({
			kind: d.kind ?? "reference",
			to: d.to,
			...d.to_api !== void 0 ? { to_api: d.to_api } : {}
		});
	}
	const fakeFiles = [...simulated.values()].map((m) => ({
		module: m,
		body: "",
		file: ""
	}));
	const policyResult = await loadPolicyFile(projectDir);
	errors.push(...policyResult.errors);
	if (policyResult.policy !== null) {
		const diags = evaluatePolicy(policyResult.policy, {
			files: fakeFiles,
			byId: new Map(fakeFiles.map((f) => [f.module.id, f]))
		});
		for (const d of diags) if (d.severity === "error") errors.push(d);
		else warnings.push(d);
	}
	return {
		ok: errors.length === 0,
		errors,
		warnings
	};
}
const CHANGES_DIR = "changes";
const CHANGE_KEYS = [
	"schema_version",
	"id",
	"title",
	"status",
	"intent",
	"modules",
	"acceptance",
	"note",
	"revision",
	"created_at",
	"updated_at",
	"closed_at"
];
const MODULE_KEYS = [
	"create",
	"modify",
	"delete",
	"api_add",
	"api_remove"
];
function isValidChangeId(id) {
	return /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
function changeFilePath(projectDir, id) {
	return join(projectDir, CHANGES_DIR, id + ".json");
}
function isPlain(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isL10n(v) {
	return isPlain(v) && typeof v.zh === "string" && typeof v.en === "string" && v.zh.trim() !== "" && v.en.trim() !== "";
}
function isIso(v) {
	return typeof v === "string" && !Number.isNaN(Date.parse(v));
}
/** L1：单个变更文件的形状校验。 */
function l1ValidateChange(data, id, where) {
	const errors = [];
	const warnings = [];
	if (!isPlain(data)) {
		errors.push(diag("error", "change/shape", "变更文件必须为 JSON 对象", { change: id }, { path: where }, ["用 normify_change_open 创建"]));
		return {
			change: null,
			errors,
			warnings
		};
	}
	for (const k of Object.keys(data)) if (!CHANGE_KEYS.includes(k)) errors.push(diag("error", "change/unknown-field", "变更文件不支持字段 " + k, { change: id }, { path: where + "/" + k }, ["删除该字段"]));
	if (!isValidChangeId(id)) errors.push(diag("error", "change/id-format", "变更 id 必须为 YYYY-MM-DD-<slug>", { change: id }, {}, ["重命名为形如 2026-09-12-add-feature"]));
	if (data.schema_version !== 1) errors.push(diag("error", "change/schema-version", "schema_version 必须为 1", { change: id }, { value: data.schema_version }, []));
	if (data.id !== id) errors.push(diag("error", "change/id-mismatch", "data.id 必须等于文件名", { change: id }, { value: data.id }, []));
	if (!isL10n(data.title)) errors.push(diag("error", "change/title", "title 必须为 {zh,en} 非空双语", { change: id }, {}, []));
	if (!isL10n(data.intent)) errors.push(diag("error", "change/intent", "intent 必须为 {zh,en} 非空双语", { change: id }, {}, []));
	if (typeof data.status !== "string" || !CHANGE_STATUSES.includes(data.status)) errors.push(diag("error", "change/status", "status 必须为 " + CHANGE_STATUSES.join(" | "), { change: id }, { value: data.status }, []));
	if (!isIso(data.created_at)) errors.push(diag("error", "change/created-at", "created_at 必须为 ISO 8601", { change: id }, { value: data.created_at }, []));
	if (!isIso(data.updated_at)) errors.push(diag("error", "change/updated-at", "updated_at 必须为 ISO 8601", { change: id }, { value: data.updated_at }, []));
	if (data.closed_at !== void 0 && data.closed_at !== null && !isIso(data.closed_at)) errors.push(diag("error", "change/closed-at", "closed_at 必须为 ISO 8601 或 null", { change: id }, { value: data.closed_at }, []));
	if (data.note !== void 0 && typeof data.note !== "string") errors.push(diag("error", "change/note", "note 必须为字符串", { change: id }, {}, []));
	if (!Array.isArray(data.acceptance) || data.acceptance.length === 0 || data.acceptance.some((s) => typeof s !== "string" || s.trim() === "")) {
		let message = "acceptance 必须是**纯字符串数组**（验收清单）";
		let evidence = { received_type: typeof data.acceptance };
		if (Array.isArray(data.acceptance)) if (data.acceptance.length === 0) {
			message = "acceptance 不能为空：至少写一条可验证的验收标准";
			evidence = { length: 0 };
		} else {
			const idx = data.acceptance.findIndex((s) => typeof s !== "string" || s.trim() === "");
			const bad = data.acceptance[idx];
			message = "acceptance 第 " + (idx + 1) + " 条不是非空字符串（收到 " + JSON.stringify(bad) + "）：验收标准只接受纯字符串，不接受 {zh,en} 双语对象";
			evidence = {
				index: idx + 1,
				value: bad,
				expected: "string"
			};
		}
		errors.push(diag("error", "change/acceptance", message, { change: id }, evidence, ["改成 [\"验收点 A\", \"验收点 B\"] 这样的字符串数组；需要双语描述请写在 title / intent 里"]));
	} else if (data.acceptance.length > 20) errors.push(diag("error", "change/acceptance-too-many", "acceptance 最多 20 条", { change: id }, { count: data.acceptance.length }, []));
	const rev = data.revision;
	if (!isPlain(rev)) errors.push(diag("error", "change/revision", "revision 必须为 { before, after }", { change: id }, {}, []));
	else for (const key of ["before", "after"]) {
		const v = rev[key];
		if (v !== null && v !== void 0 && (typeof v !== "string" || !/^[a-f0-9]{7,40}$/.test(v))) errors.push(diag("error", "change/revision-sha", "revision." + key + " 必须为 git SHA 或 null", { change: id }, { value: v }, []));
	}
	const modules = data.modules;
	if (!isPlain(modules)) errors.push(diag("error", "change/modules", "modules 必须为对象（create/modify/delete/api_add/api_remove）", { change: id }, {}, []));
	else {
		for (const k of Object.keys(modules)) if (!MODULE_KEYS.includes(k)) errors.push(diag("error", "change/modules-unknown", "modules 不支持字段 " + k, { change: id }, {}, []));
		for (const key of [
			"create",
			"modify",
			"delete"
		]) {
			const list = modules[key];
			if (list === void 0) continue;
			if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !isValidId(x))) errors.push(diag("error", "change/module-id", key + " 必须为合法模块 id 数组", { change: id }, {}, []));
			else if (new Set(list).size !== list.length) errors.push(diag("error", "change/module-id-duplicate", key + " 中存在重复模块 id", { change: id }, {}, []));
		}
		for (const key of ["api_add", "api_remove"]) {
			const list = modules[key];
			if (list === void 0) continue;
			if (!Array.isArray(list) || list.some((x) => !isPlain(x) || typeof x.module !== "string" || !isValidId(x.module) || typeof x.key !== "string" || x.key.trim() === "")) errors.push(diag("error", "change/api-ref", key + " 必须为 [{ module, key }] 数组", { change: id }, {}, []));
		}
	}
	if (errors.length > 0) return {
		change: null,
		errors,
		warnings
	};
	const change = {
		schema_version: 1,
		id,
		title: data.title,
		status: data.status,
		intent: data.intent,
		modules,
		acceptance: data.acceptance,
		...typeof data.note === "string" ? { note: data.note } : {},
		revision: {
			before: rev.before ?? null,
			after: rev.after ?? null
		},
		created_at: String(data.created_at),
		updated_at: String(data.updated_at),
		...data.closed_at !== void 0 ? { closed_at: typeof data.closed_at === "string" ? data.closed_at : null } : {}
	};
	if (change.status === "verified" && (change.closed_at === void 0 || change.closed_at === null)) errors.push(diag("error", "change/verified-closed-at", "status=verified 的变更必须有 closed_at", { change: id }, {}, []));
	if ((change.status === "proposed" || change.status === "in_progress") && change.closed_at !== void 0 && change.closed_at !== null) errors.push(diag("error", "change/open-closed-at", "未关闭的变更 closed_at 必须为空", { change: id }, { value: change.closed_at }, []));
	return errors.length > 0 ? {
		change: null,
		errors,
		warnings
	} : {
		change,
		errors,
		warnings
	};
}
async function listChangeIds(projectDir) {
	try {
		return (await readdir(join(projectDir, CHANGES_DIR), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name.slice(0, -5)).sort(byCodeUnit);
	} catch {
		return [];
	}
}
async function loadChangeFile(projectDir, id) {
	let text;
	try {
		text = await readFile(changeFilePath(projectDir, id), "utf8");
	} catch {
		return {
			change: null,
			error: null
		};
	}
	let data;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return {
			change: null,
			error: diag("error", "change/json-parse", "变更文件 JSON 解析失败：" + String(error instanceof Error ? error.message : error), { change: id }, {}, ["修复 JSON 或重写变更"])
		};
	}
	const r = l1ValidateChange(data, id, CHANGES_DIR + "/" + id + ".json");
	if (r.change === null) return {
		change: null,
		error: r.errors[0] ?? diag("error", "change/invalid", "变更文件无效", { change: id }, {}, [])
	};
	return {
		change: r.change,
		error: null
	};
}
async function writeChangeFile(projectDir, change) {
	await mkdir(join(projectDir, CHANGES_DIR), { recursive: true });
	await writeFileAtomic(changeFilePath(projectDir, change.id), JSON.stringify(change, null, 2) + "\n");
	return CHANGES_DIR + "/" + change.id + ".json";
}
/** L2：全部变更文件与当前模块集的一致性校验。 */
async function validateChanges(projectDir, byId) {
	const errors = [];
	const warnings = [];
	const changes = [];
	const ids = await listChangeIds(projectDir);
	let inProgress = 0;
	for (const id of ids) {
		const { change, error } = await loadChangeFile(projectDir, id);
		if (error !== null) {
			errors.push(error);
			continue;
		}
		if (change === null) continue;
		changes.push(change);
		if (change.status === "in_progress") inProgress++;
		const refs = [
			...change.modules.create ?? [],
			...change.modules.modify ?? [],
			...change.modules.delete ?? []
		];
		for (const ref of refs) if (!byId.has(ref)) errors.push(diag("error", "change/module-missing", "变更引用的模块不存在", {
			change: id,
			module: ref
		}, {}, ["先创建该模块（计划态允许）或修正变更清单"]));
		for (const key of ["api_add", "api_remove"]) for (const ref of change.modules[key] ?? []) {
			const target = byId.get(ref.module);
			if (target === void 0) errors.push(diag("error", "change/api-module-missing", "变更引用的 API 所属模块不存在", {
				change: id,
				module: ref.module
			}, {}, []));
			else if (key === "api_remove" && !(target.module.apis ?? []).some((a) => apiKey(a) === ref.key)) warnings.push(diag("warning", "change/api-already-removed", "要移除的 API 当前不在模块上（可能已移除）", {
				change: id,
				module: ref.module,
				api: ref.key
			}, {}, []));
		}
	}
	if (inProgress > 1) warnings.push(diag("warning", "change/multiple-in-progress", "同时存在多个 in_progress 变更", {}, { count: inProgress }, ["建议同一时间只推进一个变更，避免结构数据互相覆盖"]));
	return {
		changes,
		errors,
		warnings
	};
}
//#endregion
//#region src/engine/validate.ts
const BILINGUAL_CODES = new Set([
	"structure/name-shape",
	"structure/name-empty",
	"structure/name-too-long",
	"structure/description-shape",
	"structure/description-empty",
	"structure/description-too-long",
	"api/description-shape",
	"api/description-empty",
	"api/description-too-long",
	"dep/label-shape",
	"dep/label-empty",
	"dep/label-too-long"
]);
/** L2：全项目校验（规范 §5.2 规则全集）。零容忍：任何 error 阻断构建。 */
async function validateProject(projectDir, opts) {
	const loaded = await loadAllModules(projectDir);
	let errors = loaded.errors;
	let warnings = loaded.warnings;
	if (!opts.requireBilingual) errors = errors.filter((e) => {
		if (BILINGUAL_CODES.has(e.code)) {
			warnings.push({
				...e,
				severity: "warning"
			});
			return false;
		}
		return true;
	});
	const files = loaded.files;
	const byId = /* @__PURE__ */ new Map();
	const byUid = /* @__PURE__ */ new Map();
	const childrenOf = /* @__PURE__ */ new Map();
	for (const f of files) {
		const m = f.module;
		const prev = byId.get(m.id);
		if (prev !== void 0) errors.push(diag("error", "structure/id-duplicate", "模块 id 重复", { module: m.id }, { files: [prev.file, f.file] }, ["合并或重命名其中一个模块"]));
		else byId.set(m.id, f);
		const list = byUid.get(m.uid) ?? [];
		list.push(m.id);
		byUid.set(m.uid, list);
	}
	for (const [uid, ids] of byUid) if (ids.length > 1) errors.push(diag("error", "structure/uid-duplicate", "uid 重复", { uid }, { modules: ids }, ["为其中一个模块重新分配 uid"]));
	for (const f of files) {
		const p = f.module.parent;
		if (p === null) continue;
		const list = childrenOf.get(p) ?? [];
		list.push(f.module.id);
		childrenOf.set(p, list);
	}
	for (const list of childrenOf.values()) list.sort(byCodeUnit);
	const roots = files.filter((f) => f.module.parent === null).map((f) => f.module.id).sort(byCodeUnit);
	if (roots.length === 0) errors.push(diag("error", "structure/no-root", "全项目必须至少一个根模块（id 单段、parent: null）", {}, {}, ["创建根模块，如 id: demo, parent: null"]));
	for (const r of roots) if (r.includes(".")) errors.push(diag("error", "structure/root-single-segment", "根模块 id 必须为单段（树名）", { module: r }, {}, ["将根 id 改为单段树名"]));
	const seen = /* @__PURE__ */ new Set();
	const checkChain = (id, chain) => {
		if (seen.has(id)) return;
		const f = byId.get(id);
		if (f === void 0) return;
		const m = f.module;
		if (chain.includes(id)) {
			errors.push(diag("error", "structure/cycle", "parent 链存在环", { module: id }, { chain: [...chain, id] }, ["修复 parent 使链条终止于根"]));
			return;
		}
		seen.add(id);
		if (m.parent !== null) if (byId.get(m.parent) === void 0) errors.push(diag("error", "structure/parent-not-exist", "parent 指向的模块不存在（孤儿）", { module: id }, { parent: m.parent }, ["创建父模块 " + m.parent + " 或修正 parent"]));
		else checkChain(m.parent, [...chain, id]);
	};
	for (const id of byId.keys()) checkChain(id, []);
	const apiOwners = /* @__PURE__ */ new Map();
	const coarseLeaves = [];
	for (const f of files) {
		const m = f.module;
		const derivedFileId = idFromFilePath("modules/" + f.file);
		if (derivedFileId !== m.id) errors.push(diag("error", "structure/file-id-mismatch", "文件路径与 id 映射不一致", { module: m.id }, {
			file: f.file,
			expected: derivedFileId
		}, ["将文件移至 " + expectedPathHint(f.file, m.id)]));
		const isLeaf = !childrenOf.has(m.id);
		if (isLeaf) {
			const spans = m.source.map((s) => (s.end_line ?? s.line ?? 0) - (s.line ?? 0));
			const maxSpan = spans.length > 0 ? Math.max(...spans) : 0;
			if (m.source.length >= 2 || maxSpan >= 220) coarseLeaves.push({
				id: m.id,
				files: m.source.length,
				span: maxSpan
			});
			if (m.apis === void 0) errors.push(diag("error", "api/leaf-missing", "叶子模块必须写 apis 字段", { module: m.id }, {}, ["提取该模块的 API/接口并写入 apis（可为空数组，记 warning）"]));
			else if (m.apis.length === 0) warnings.push(diag("warning", "api/leaf-empty", "叶子模块 apis 为空（无接口的功能单元）", { module: m.id }, {}, []));
		} else if (m.apis !== void 0) errors.push(diag("error", "api/non-leaf", "非叶子（含根）模块禁止 apis 字段；API 只定义在叶子上", { module: m.id }, {}, ["将 apis 下放到叶子模块并删除本字段"]));
		if (m.apis !== void 0) {
			for (const a of m.apis) {
				const key = apiKey(a);
				const list = apiOwners.get(key) ?? [];
				list.push(m.id);
				apiOwners.set(key, list);
			}
			const fromApiKeys = new Set(m.apis.map((a) => apiKey(a)));
			if (m.deps !== void 0) {
				for (const d of m.deps) {
					if (d.to === m.id) errors.push(diag("error", "dep/self-loop", "依赖箭头不能指向自身", { module: m.id }, { to: d.to }, ["删除该箭头"]));
					const target = byId.get(d.to);
					if (target === void 0) {
						errors.push(diag("error", "dep/target-missing", "箭头目标模块不存在（悬空边）", { module: m.id }, { to: d.to }, ["创建目标模块或修正/删除该箭头"]));
						continue;
					}
					if (d.from_api !== void 0) {
						if (!isLeaf) errors.push(diag("error", "dep/from-api-non-leaf", "from_api 只能引用本模块 API（非叶子没有 API）", { module: m.id }, { from_api: d.from_api }, ["删除 from_api 或改为模块级箭头"]));
						else if (!fromApiKeys.has(d.from_api)) errors.push(diag("error", "dep/from-api-invalid", "from_api 不是本模块的 API 键", { module: m.id }, {
							from_api: d.from_api,
							own: [...fromApiKeys]
						}, ["使用本模块 apis 中的键"]));
					}
					if (d.to_api !== void 0) {
						const targetApis = new Set((target.module.apis ?? []).map((a) => apiKey(a)));
						if (!targetApis.has(d.to_api)) errors.push(diag("error", "dep/to-api-invalid", "to_api 不是目标模块自身的 API 键", { module: m.id }, {
							to: d.to,
							to_api: d.to_api,
							target_apis: [...targetApis]
						}, ["使用目标模块 apis 中的键或删除 to_api"]));
					}
				}
				const seenDeps = /* @__PURE__ */ new Set();
				for (const d of m.deps) {
					const sig = [
						d.from_api ?? "",
						d.to,
						d.to_api ?? "",
						d.kind
					].join("|");
					if (seenDeps.has(sig)) errors.push(diag("error", "dep/duplicate", "重复的依赖箭头", { module: m.id }, { sig }, ["删除重复项"]));
					seenDeps.add(sig);
				}
			}
		}
	}
	for (const [key, ids] of apiOwners) if (ids.length > 1) errors.push(diag("error", "api/key-duplicate", "API 键全项目重复", { api: key }, { modules: ids }, ["只保留一个定义，或调整 path/method"]));
	for (const f of files) {
		const m = f.module;
		if (m.state === "deprecated") if (m.replacement === void 0) warnings.push(diag("warning", "deprecation/no-replacement", "已废弃模块未提供 replacement，调用方无从迁移", { module: m.id }, {}, ["补 replacement 指向替代模块"]));
		else {
			const r = byId.get(m.replacement);
			if (r === void 0) errors.push(diag("error", "deprecation/replacement-missing", "replacement 指向的模块不存在", { module: m.id }, { replacement: m.replacement }, ["改为存在的模块 id 或删除 replacement"]));
			else if (r.module.state === "deprecated") warnings.push(diag("warning", "deprecation/replacement-deprecated", "replacement 本身也是 deprecated", { module: m.id }, { replacement: m.replacement }, ["改用未废弃的替代模块"]));
		}
	}
	for (const f of files) for (const d of f.module.deps ?? []) {
		const target = byId.get(d.to);
		if (target !== void 0 && target.module.state === "deprecated") warnings.push(diag("warning", "deprecation/inbound", "依赖指向已废弃模块，建议迁移", { module: f.module.id }, {
			to: d.to,
			replacement: target.module.replacement ?? null
		}, ["迁移到 replacement 或删除该依赖"]));
	}
	const unanchored = [];
	for (const f of files) for (const d of f.module.deps ?? []) {
		if (d.from_api !== void 0 || d.to_api !== void 0) continue;
		const target = byId.get(d.to);
		if (target === void 0) continue;
		if ((f.module.apis ?? []).length === 0 || (target.module.apis ?? []).length === 0) continue;
		unanchored.push({
			from: f.module.id,
			to: d.to,
			kind: d.kind
		});
	}
	if (unanchored.length > 0) {
		const examples = unanchored.slice(0, 6).map((u) => u.from + " → " + u.to + "（" + u.kind + "）");
		const preview = unanchored.slice(0, 3).map((u) => u.from + " → " + u.to).join("；");
		warnings.push(diag("warning", "dep/unanchored", "有 " + unanchored.length + " 条箭头可锚定到具体 API 但未锚定（如 " + preview + (unanchored.length > 3 ? " 等" : "") + "）：两端都声明了 API，补上 from_api/to_api 后箭头才会钉在 API 行上（图的\"精细\"价值在这里）", {}, {
			total: unanchored.length,
			examples,
			hint: "在源模块 deps 条目里补 from_api（本模块 API 键）与 to_api（目标模块 API 键）；两者都必须是模块自身 apis 里的键"
		}, ["给这些箭头补 from_api/to_api", "若这条边确实不该锚定，忽略该 warning 或用 policy 忽略"]));
	}
	for (const c of coarseLeaves.slice(0, 15)) warnings.push(diag("warning", "structure/leaf-too-coarse", "叶子模块可能过大（source " + c.files + " 个文件，最大行跨度 " + c.span + "），建议下沉一层拆分", { module: c.id }, {
		source_files: c.files,
		max_line_span: c.span
	}, ["用 normify_module_promote 晋升为容器并拆出子模块"]));
	if (coarseLeaves.length > 15) warnings.push(diag("warning", "structure/leaf-too-coarse-many", "还有更多过粗的叶子模块", {}, {
		remaining: coarseLeaves.length - 15,
		total: coarseLeaves.length
	}, []));
	const maxDepth = files.reduce((acc, f) => Math.max(acc, f.module.id.split(".").length), 0);
	if (files.length >= 24 && maxDepth <= 3) warnings.push(diag("warning", "structure/shallow-hierarchy", "模块数已较多但层级过浅（最深 " + maxDepth + " 段），建议继续下钻以获得更精细的架构图", {}, {
		module_count: files.length,
		max_depth: maxDepth
	}, ["对功能较多的容器继续拆分子模块"]));
	const siblingEdges = /* @__PURE__ */ new Map();
	for (const [parent, kids] of childrenOf) {
		const set = /* @__PURE__ */ new Set();
		const kidSet = new Set(kids);
		for (const kid of kids) {
			const kf = byId.get(kid);
			if (kf === void 0) continue;
			for (const d of kf.module.deps ?? []) if (kidSet.has(d.to) && d.to !== kid) set.add(edgeKey(kid, d.to));
		}
		siblingEdges.set(parent, set);
	}
	const layoutResult = await validateLayouts(projectDir, byId, childrenOf, siblingEdges);
	errors.push(...layoutResult.errors);
	warnings.push(...layoutResult.warnings);
	const policyResult = await loadPolicyFile(projectDir);
	errors.push(...policyResult.errors);
	let policy = policyResult.policy;
	if (!policyResult.exists) warnings.push(diag("warning", "policy/missing", "项目未安装架构规则（policy.yml），结构演进缺少约束", {}, {}, ["用 normify_policy_get 查看完整规则模板，或 normify_policy_upsert 安装"]));
	else if (policy !== null) {
		const ruleDiags = evaluatePolicy(policy, {
			files,
			byId
		});
		for (const d of ruleDiags) if (d.severity === "error") errors.push(d);
		else warnings.push(d);
	}
	const changeResult = await validateChanges(projectDir, byId);
	for (const d of changeResult.errors) errors.push(d);
	for (const d of changeResult.warnings) warnings.push(d);
	if (opts.repoRoot !== void 0 && opts.repoRoot.trim() !== "") {
		const repoRoot = opts.repoRoot.trim();
		for (const f of files) {
			const m = f.module;
			const planned = m.state === "planned";
			if (m.source.length === 0) {
				if (m.parent === null && !planned) warnings.push(diag("warning", "evidence/root-no-source", "根模块无 source（纯文档根）", { module: m.id }, {}, []));
				continue;
			}
			const missing = m.source.filter((s) => !existsSync(join(repoRoot, s.path)));
			if (missing.length > 0) {
				if (planned) warnings.push(diag("warning", "structure/planned-source-missing", "计划态模块的 source 尚未落地（实现后刷新即可）", { module: m.id }, { missing: missing.map((s) => s.path) }, ["实现对应文件后调用 normify_module_refresh({ ids: [\"" + m.id + "\"], activate: true })"]));
				else errors.push(diag("error", "evidence/source-missing", "source 指向的文件在仓库中不存在", { module: m.id }, { missing: missing.map((s) => s.path) }, ["修正 source.path 或运行 normify_sync 增量重建"]));
				continue;
			}
			if (m.fingerprint === "pending") {
				if (!planned) errors.push(diag("error", "evidence/fingerprint-pending", "只有 planned 模块可以使用 fingerprint: pending", { module: m.id }, {}, ["用 normify_fingerprint 重算或把 state 改为 planned"]));
				continue;
			}
			const fp = await fingerprintOf(repoRoot, m.source);
			if (fp.hash === null) errors.push(diag("error", "evidence/fingerprint-unavailable", "无法计算 fingerprint（文件缺失）", { module: m.id }, { missing: fp.missing }, []));
			else if (fp.hash !== m.fingerprint) errors.push(diag("error", "evidence/fingerprint-drift", "fingerprint 与仓库当前内容不一致（结构数据已过期）", { module: m.id }, {
				authored: m.fingerprint,
				actual: fp.hash
			}, ["运行 normify_sync 计划增量重建，或更新 fingerprint"]));
		}
	} else if (files.some((f) => f.module.source.length > 0)) warnings.push(diag("warning", "evidence/checks-skipped", "未提供 repoRoot，跳过 source 存在性与 fingerprint 一致性校验", {}, {}, ["传入 repoRoot 参数以启用证据校验"]));
	return {
		ok: errors.length === 0,
		errors,
		warnings,
		files,
		childrenOf,
		byId,
		layouts: layoutResult.layouts,
		policy,
		changes: changeResult.changes
	};
}
function expectedPathHint(file, id) {
	const segs = id.split(".");
	if (segs.length === 1) return "modules/" + id + "/index.md";
	const rest = segs.slice(1);
	return "modules/" + segs[0] + "/" + rest.join("/") + ".md 或 modules/" + segs[0] + "/" + rest.join("/") + "/index.md";
}
//#endregion
//#region src/engine/compile.ts
function oneLine(desc, max = 100) {
	const line = desc.split(/\r?\n/)[0]?.trim() ?? "";
	return line.length > max ? line.slice(0, max) + "…" : line;
}
function outlineText(slug, v) {
	const files = [...v.files].sort((a, b) => a.module.id.localeCompare(b.module.id));
	const byId = new Map(files.map((f) => [f.module.id, f.module]));
	const roots = files.filter((f) => f.module.parent === null).sort((a, b) => a.module.id.localeCompare(b.module.id));
	const descendantMemo = /* @__PURE__ */ new Map();
	const countDesc = (id) => {
		const hit = descendantMemo.get(id);
		if (hit !== void 0) return hit;
		const kids = v.childrenOf.get(id) ?? [];
		let total = kids.length;
		for (const k of kids) total += countDesc(k);
		descendantMemo.set(id, total);
		return total;
	};
	const apiCount = (id) => {
		const kids = v.childrenOf.get(id) ?? [];
		let total = 0;
		for (const k of kids) {
			const m = byId.get(k);
			total += (m !== void 0 && m.apis !== void 0 ? m.apis.length : 0) + apiCount(k);
		}
		return total;
	};
	const lines = [];
	lines.push("# " + slug + " · Normify Outline");
	lines.push("");
	lines.push("> 派生索引（每次 normify_build 重建）。AI 导航入口：先广度后深度。");
	lines.push("");
	const walk = (id, indent) => {
		const m = byId.get(id);
		if (m === void 0) return;
		const modules = countDesc(id) + 1;
		const apis = (m.apis?.length ?? 0) + apiCount(id);
		lines.push("  ".repeat(indent) + "- " + id + (m.state === "planned" ? " [计划]" : m.state === "deprecated" ? " [废弃]" : "") + " — " + m.name.zh + " / " + m.name.en + " — " + oneLine(m.description.zh, 80) + " — [模块 " + modules + " · API " + apis + "]");
		for (const k of v.childrenOf.get(id) ?? []) walk(k, indent + 1);
	};
	for (const r of roots) {
		const m = r.module;
		lines.push("## " + m.id + (m.repository !== void 0 ? "（" + m.repository + "）" : ""));
		lines.push("");
		walk(m.id, 0);
		lines.push("");
	}
	return lines.join("\n") + "\n";
}
/** L3：校验通过后编译 tree.json / outline.md / api-index.json / receipt.json（冻结）。 */
async function buildProject(projectDir, opts) {
	const v = await validateProject(projectDir, opts);
	if (!v.ok) return {
		ok: false,
		receipt: null,
		errors: v.errors,
		warnings: v.warnings,
		validate: v
	};
	const slug = projectDir.split(/[\\/]/).pop() ?? "project";
	const files = [...v.files].sort((a, b) => a.module.id.localeCompare(b.module.id));
	const byId = new Map(files.map((f) => [f.module.id, f.module]));
	const roots = files.filter((f) => f.module.parent === null).sort((a, b) => a.module.id.localeCompare(b.module.id));
	const descendantMemo = /* @__PURE__ */ new Map();
	const countDesc = (id) => {
		const hit = descendantMemo.get(id);
		if (hit !== void 0) return hit;
		const kids = v.childrenOf.get(id) ?? [];
		let total = kids.length;
		for (const k of kids) total += countDesc(k);
		descendantMemo.set(id, total);
		return total;
	};
	const apiBelow = (id) => {
		let total = 0;
		for (const k of v.childrenOf.get(id) ?? []) {
			const m = byId.get(k);
			total += (m !== void 0 && m.apis !== void 0 ? m.apis.length : 0) + apiBelow(k);
		}
		return total;
	};
	const depIn = /* @__PURE__ */ new Map();
	let depCount = 0;
	let crossTreeDepCount = 0;
	const edges = [];
	for (const f of files) {
		const m = f.module;
		if (m.deps === void 0) continue;
		for (const d of m.deps) {
			depCount++;
			depIn.set(d.to, (depIn.get(d.to) ?? 0) + 1);
			const cross = treeOf(d.to) !== treeOf(m.id);
			if (cross) crossTreeDepCount++;
			edges.push({
				from: m.id,
				from_api: d.from_api,
				to: d.to,
				to_api: d.to_api,
				kind: d.kind,
				cross_tree: cross,
				label: d.label
			});
		}
	}
	edges.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)));
	const modules = {};
	let apiCount = 0;
	let leafCount = 0;
	let maxDepth = 0;
	let plannedCount = 0;
	let deprecatedCount = 0;
	for (const f of files) {
		const m = f.module;
		const ownApis = m.apis ?? [];
		apiCount += ownApis.length;
		if (!v.childrenOf.has(m.id)) leafCount++;
		maxDepth = Math.max(maxDepth, depthOf(m.id));
		if (m.state === "planned") plannedCount++;
		if (m.state === "deprecated") deprecatedCount++;
		modules[m.id] = {
			uid: m.uid,
			id: m.id,
			parent: m.parent,
			tree: treeOf(m.id),
			depth: depthOf(m.id),
			...m.state !== void 0 ? { state: m.state } : {},
			...m.replacement !== void 0 ? { replacement: m.replacement } : {},
			...m.tags !== void 0 ? { tags: m.tags } : {},
			name: m.name,
			description: m.description,
			source: m.source,
			revision: m.revision,
			updated_at: m.updated_at,
			fingerprint: m.fingerprint,
			...m.repository !== void 0 ? { repository: m.repository } : {},
			...ownApis.length > 0 ? { apis: ownApis.map((a) => ({
				...a,
				key: apiKey(a)
			})) } : {},
			...m.deps !== void 0 && m.deps.length > 0 ? { deps: m.deps.map((d) => ({
				...d,
				cross_tree: treeOf(d.to) !== treeOf(m.id)
			})) } : {},
			aggregate: {
				descendant_count: countDesc(m.id),
				own_api_count: ownApis.length,
				inherited_api_count: apiBelow(m.id),
				dep_out: m.deps?.length ?? 0,
				dep_in: depIn.get(m.id) ?? 0
			}
		};
	}
	const apiIndex = {};
	for (const f of files) {
		const m = f.module;
		for (const a of m.apis ?? []) apiIndex[apiKey(a)] = m.id;
	}
	const compiledAt = (/* @__PURE__ */ new Date()).toISOString();
	const layouts = {};
	for (const id of [...v.layouts.keys()].sort(byCodeUnit)) layouts[id] = v.layouts.get(id);
	const treeJson = {
		schema_version: 1,
		project: {
			name: slug,
			trees: roots.map((r) => ({
				tree_id: r.module.id,
				root_uid: r.module.uid,
				...r.module.repository !== void 0 ? { repository: r.module.repository } : {}
			})),
			compiled_at: compiledAt,
			stats: {
				tree_count: roots.length,
				module_count: files.length,
				leaf_count: leafCount,
				api_count: apiCount,
				dep_count: depCount,
				cross_tree_dep_count: crossTreeDepCount,
				max_depth: maxDepth,
				layout_count: v.layouts.size,
				planned_count: plannedCount,
				deprecated_count: deprecatedCount,
				policy_rule_count: v.policy === null ? 0 : v.policy.rules.length,
				change_count: v.changes.length,
				open_change_count: v.changes.filter((c) => c.status === "proposed" || c.status === "in_progress").length
			}
		},
		modules,
		api_index: Object.fromEntries(Object.entries(apiIndex).sort(([a], [b]) => a.localeCompare(b))),
		edges,
		layouts,
		policy: v.policy,
		changes: v.changes.map((c) => ({
			id: c.id,
			status: c.status,
			title: c.title,
			updated_at: c.updated_at
		}))
	};
	try {
		const treeText = JSON.stringify(treeJson, null, 2) + "\n";
		const outline = outlineText(slug, v);
		const apiIndexText = JSON.stringify(Object.fromEntries(Object.entries(apiIndex).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n";
		const warningSummary = {};
		for (const w of v.warnings) warningSummary[w.code] = (warningSummary[w.code] ?? 0) + 1;
		const artifacts = {
			"tree.json": {
				sha256: sha256Text(treeText),
				bytes: Buffer.byteLength(treeText, "utf8")
			},
			"outline.md": {
				sha256: sha256Text(outline),
				bytes: Buffer.byteLength(outline, "utf8")
			},
			"api-index.json": {
				sha256: sha256Text(apiIndexText),
				bytes: Buffer.byteLength(apiIndexText, "utf8")
			}
		};
		const receipt = {
			schema_version: 1,
			ok: true,
			project: slug,
			compiled_at: compiledAt,
			stats: treeJson.project && typeof treeJson.project === "object" ? treeJson.project.stats : {},
			warnings: warningSummary,
			artifacts
		};
		const receiptText0 = JSON.stringify(receipt, null, 2) + "\n";
		artifacts["receipt.json"] = {
			sha256: sha256Text(receiptText0),
			bytes: Buffer.byteLength(receiptText0, "utf8")
		};
		const receiptText = JSON.stringify(receipt, null, 2) + "\n";
		await writeAllAtomic([
			{
				path: join(projectDir, "tree.json"),
				data: treeText
			},
			{
				path: join(projectDir, "outline.md"),
				data: outline
			},
			{
				path: join(projectDir, "api-index.json"),
				data: apiIndexText
			},
			{
				path: join(projectDir, "receipt.json"),
				data: receiptText
			}
		]);
		return {
			ok: true,
			receipt,
			errors: [],
			warnings: v.warnings,
			validate: v
		};
	} catch (error) {
		return {
			ok: false,
			receipt: null,
			errors: [diag("error", "build/write-failed", "编译产物写入失败：" + String(error), {}, {}, [])],
			warnings: v.warnings,
			validate: v
		};
	}
}
//#endregion
//#region src/engine/template.ts
function renderTemplate(dataJson, summary) {
	const safeJson = dataJson.replace(/</g, "\\u003c");
	return `<!DOCTYPE html>
<html lang="zh" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="normify">
<title>${summary.name} · Normify</title>
<style>
:root {
  --bg: #0b1220; --panel: #111a2c; --panel2: #16223a; --border: #24344f;
  --text: #e6edf7; --muted: #93a4bf; --accent: #38bdf8; --accent2: #34d399;
  --node: #16223a; --node-leaf: #122036; --node-stroke: #2c4367; --leaf-stroke: #2f6f5f;
  --edge: #5b6f92; --edge-call: #64748b; --edge-event: #a78bfa; --edge-dataflow: #34d399; --edge-reference: #94a3b8; --edge-cross: #f59e0b; --danger: #f87171; --warn: #fbbf24;
}
[data-theme="light"] {
  --bg: #f6f8fc; --panel: #ffffff; --panel2: #eef2f9; --border: #d7dfec;
  --text: #16233b; --muted: #5c6b85; --accent: #0284c7; --accent2: #059669;
  --node: #ffffff; --node-leaf: #f4fbf8; --node-stroke: #9fb4d4; --leaf-stroke: #4fae96;
  --edge: #7c93b5; --edge-call: #64748b; --edge-event: #8b5cf6; --edge-dataflow: #059669; --edge-reference: #94a3b8; --edge-cross: #d97706; --danger: #dc2626; --warn: #b45309;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 20; }
#brand { font-weight: 700; color: var(--accent); margin-right: 6px; }
#breadcrumb { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
#breadcrumb a { color: var(--accent); text-decoration: none; padding: 2px 4px; border-radius: 4px; }
#breadcrumb a:hover { background: var(--panel2); }
#breadcrumb .sep { color: var(--muted); }
#controls { margin-left: auto; display: flex; gap: 6px; align-items: center; }
button { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
button:hover { border-color: var(--accent); }
#searchBox { position: relative; }
#searchInput { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 8px; width: 180px; }
#searchDrop { position: absolute; top: 32px; right: 0; width: 340px; max-height: 320px; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; display: none; z-index: 40; }
#searchDrop.open { display: block; }
#searchDrop .item { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--border); }
#searchDrop .item:hover { background: var(--panel2); }
#searchDrop .sub { color: var(--muted); font-size: 12px; }
main { padding: 16px; max-width: 1200px; margin: 0 auto; }
.level-head { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
.level-head h1 { margin: 0 0 6px; font-size: 20px; }
.level-head .desc { color: var(--muted); margin: 0 0 8px; font-size: 14px; }
.level-head .meta { color: var(--muted); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
.level-head .meta a { color: var(--accent); }
svg.diagram { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; width: 100%; height: auto; }
.node { fill: var(--node); stroke: var(--node-stroke); stroke-width: 1.5; cursor: pointer; }
.node.leaf { fill: var(--node-leaf); stroke: var(--leaf-stroke); }
.node:hover { stroke: var(--accent); stroke-width: 2; }
.node text, .node-name { fill: var(--text); pointer-events: none; }
.node-name { text-anchor: middle; }
.edge { stroke: var(--edge); stroke-width: 1.6; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.edge.kind-call { stroke: var(--edge-call); }
.edge.kind-event { stroke: var(--edge-event); }
.edge.kind-dataflow { stroke: var(--edge-dataflow); }
.edge.kind-reference { stroke: var(--edge-reference); stroke-dasharray: 6 4; }
.edge.cross { stroke: var(--edge-cross); stroke-dasharray: 5 3; }
.edge-label { fill: var(--muted); font-size: 10px; }
.arrow { fill: var(--edge); }
.arrow.kind-call { fill: var(--edge-call); }
.arrow.kind-event { fill: var(--edge-event); }
.arrow.kind-dataflow { fill: var(--edge-dataflow); }
.arrow.kind-reference { fill: var(--edge-reference); }
.arrow.cross { fill: var(--edge-cross); }
.legendbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 10px 2px; font-size: 12px; color: var(--muted); }
.legendbar .chip { display: inline-flex; align-items: center; gap: 6px; }
.legendbar .swatch { width: 24px; border-top: 3px solid var(--edge-call); }
.legendbar .swatch.kind-call { border-color: var(--edge-call); }
.legendbar .swatch.kind-event { border-color: var(--edge-event); }
.legendbar .swatch.kind-dataflow { border-color: var(--edge-dataflow); }
.legendbar .swatch.kind-reference { border-color: var(--edge-reference); border-top-style: dashed; }
.legendbar .swatch.cross { border-color: var(--edge-cross); border-top-style: dashed; }
#tooltip { position: fixed; z-index: 60; max-width: 300px; background: var(--panel); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 10px; display: none; pointer-events: none; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
#tooltip .t-name { font-weight: 700; margin-bottom: 4px; }
#tooltip .t-desc { color: var(--muted); }
#tooltip .t-meta { color: var(--accent2); font-size: 11px; margin-top: 4px; }
.crosslist { margin-top: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
.crosslist h3 { margin: 4px 0 6px; font-size: 13px; color: var(--muted); }
.crosslist .row { margin: 3px 0; }
.crosslist .badge { display: inline-block; background: var(--panel2); border: 1px solid var(--edge-cross); color: var(--edge-cross); border-radius: 4px; padding: 0 5px; font-size: 11px; margin-left: 6px; }
details.api-group { margin: 4px 0 4px 14px; }
details.api-group summary { cursor: pointer; color: var(--accent); font-size: 13px; }
details.api-group summary .cnt { color: var(--muted); font-size: 12px; }
.api-list { list-style: none; margin: 4px 0 8px 12px; padding: 0; }
.api-list li { padding: 3px 0; font-size: 13px; border-bottom: 1px dashed var(--border); }
.api-list .key { font-family: Consolas, monospace; color: var(--accent2); font-size: 12px; }
.api-list .desc { color: var(--muted); font-size: 12px; margin-left: 8px; }
.trees { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.tree-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; cursor: pointer; }
.tree-card:hover { border-color: var(--accent); }
.tree-card h2 { margin: 0 0 6px; font-size: 17px; }
.tree-card .repo { font-size: 12px; color: var(--muted); word-break: break-all; }
.section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
.section h2 { margin: 0 0 8px; font-size: 15px; }
.section h3 { margin: 10px 0 4px; font-size: 13px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; }
footer { color: var(--muted); font-size: 12px; text-align: center; padding: 18px; }
.outline ul { list-style: none; margin: 2px 0 2px 16px; padding: 0; }
.outline > ul { margin-left: 0; }
.outline li { padding: 2px 0; }
.outline a { color: var(--text); text-decoration: none; }
.outline a:hover { color: var(--accent); }
.outline .stat { color: var(--muted); font-size: 12px; }
.hint { color: var(--muted); font-size: 12px; }
/* —— 布局与可读性（v0.3）—— */
.reading { background: var(--panel2); border-left: 3px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin: 0 0 10px; font-size: 13px; }
.group-box { fill: var(--panel2); fill-opacity: .45; stroke: var(--border); stroke-width: 1; stroke-dasharray: 5 4; }
.group-title { fill: var(--muted); font-size: 12px; font-weight: 600; paint-order: stroke; stroke: var(--panel); stroke-width: 4px; stroke-linejoin: round; }
.node-g { cursor: pointer; }
.edge { opacity: .78; }
.edge.hl { stroke-width: 3.2; opacity: 1; }
.node-g:hover .node { stroke: var(--accent); stroke-width: 2; }
.node.state-planned { stroke-dasharray: 6 4; opacity: .88; }
.node.state-deprecated { stroke: var(--danger); stroke-dasharray: 3 3; opacity: .65; }
.state-badge { font-size: 9px; }
.state-badge.state-planned { fill: var(--accent); }
.state-badge.state-deprecated { fill: var(--danger); }
/* —— 渲染器 v3：API 明细 / 端口 / 缩放 —— */
.diagram-wrap { overflow: auto; max-height: 80vh; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
.diagram-wrap svg.diagram { overflow: visible; display: block; border: none; background: transparent; }
.diagram-tools { display: flex; align-items: center; gap: 6px; margin: 8px 2px 4px; font-size: 12px; color: var(--muted); }
.zoom-btn { min-width: 30px; padding: 2px 8px; font-size: 12px; }
.zoom-label { min-width: 40px; text-align: center; color: var(--muted); }
.api-sep { stroke: var(--border); stroke-width: 1; }
.api-chip { fill: var(--muted); font-size: 9px; font-family: ui-monospace, Consolas, monospace; }
.api-more { fill: var(--muted); font-size: 9px; }
.edge.agg { stroke-dasharray: 3 5; stroke-width: 1; opacity: .38; }
.hide-agg .edge.agg, .hide-agg .arrow.agg, .hide-agg .edge-label.agg { display: none; }
.zoom-btn.agg-toggle.on { border-color: var(--accent); color: var(--accent); }
.arrow.agg { opacity: .38; }
.edge-label.agg { font-size: 9px; }
.legendbar .swatch.agg { border-top-style: dashed; border-color: var(--edge); }
.edge.dim, .arrow.dim { opacity: .06; }
.node-g:hover .node { stroke-width: 2.4; }
</style>
</head>
<body>
<header>
  <span id="brand">⬡ Normify</span>
  <nav id="breadcrumb"></nav>
  <div id="controls">
    <div id="searchBox">
      <input id="searchInput" placeholder="搜索模块 / API">
      <div id="searchDrop"></div>
    </div>
    <button id="btnLang" title="切换语言">EN</button>
    <button id="btnTheme" title="切换主题">☀</button>
    <button id="btnOutline" title="大纲视图">大纲</button>
    <button id="btnApis" title="API 浏览器">API</button>
  </div>
</header>
<main id="main"></main>
<footer id="footer"></footer>
<div id="tooltip"></div>
<script type="application/json" id="normify-data">${safeJson}<\/script>
<script>
(function () {
  'use strict'
  var DATA = JSON.parse(document.getElementById('normify-data').textContent)
  var mods = DATA.modules
  var apiIndex = DATA.api_index
  var edges = DATA.edges
  var stats = DATA.project.stats
  var trees = DATA.project.trees
  var lang = initLang()
  var current = parseHash()
  var children = {}
  var roots = []
  Object.keys(mods).forEach(function (id) {
    var m = mods[id]
    if (m.parent === null) roots.push(id)
    else (children[m.parent] = children[m.parent] || []).push(id)
  })
  roots.sort()
  Object.keys(children).forEach(function (k) { children[k].sort() })
  var depIn = {}
  edges.forEach(function (e) { (depIn[e.to] = depIn[e.to] || []).push(e) })
  var corpus = buildCorpus()

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
  function L(o) { if (!o) return ''; return o[lang] || o.zh || '' }
  function treeRepo(treeId) { for (var i = 0; i < trees.length; i++) if (trees[i].tree_id === treeId) return trees[i].repository || null; return null }
  function idOfSegs(segs) { return segs.join('.') }
  function sourceHref(m) {
    var repo = treeRepo(m.tree)
    if (!repo || !m.source || m.source.length === 0) return null
    var s = m.source[0]
    var href = repo.replace(/\\/$/, '') + '/blob/' + m.revision + '/' + s.path
    if (s.line) href += '#L' + s.line + (s.end_line && s.end_line !== s.line ? '-L' + s.end_line : '')
    return href
  }
  function initLang() {
    var p = new URLSearchParams(location.search).get('lang')
    if (p === 'zh' || p === 'en') return p
    try { var s = localStorage.getItem('normify-lang'); if (s === 'zh' || s === 'en') return s } catch (e) {}
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  }
  function initTheme() {
    var p = new URLSearchParams(location.search).get('theme')
    var t = null
    try { t = localStorage.getItem('normify-theme') } catch (e) {}
    if (p === 'dark' || p === 'light') t = p
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark')
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, '')
    if (h === 'trees') return { view: 'trees' }
    var params = {}
    h.split('&').forEach(function (kv) {
      if (!kv) return
      var i = kv.indexOf('=')
      if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
    })
    if (params.view === 'outline') return { view: 'outline' }
    if (params.view === 'apis') return { view: 'apis' }
    if (params.api) {
      var owner = apiIndex[params.api]
      if (owner) return { view: 'level', moduleId: owner, apiKey: params.api }
    }
    if (params.module && mods[params.module]) return { view: 'level', moduleId: params.module }
    if (params.tree && mods[params.tree]) return { view: 'level', moduleId: params.tree }
    return { view: 'trees' }
  }
  function buildCorpus() {
    var out = []
    Object.keys(mods).forEach(function (id) {
      var m = mods[id]
      out.push({ kind: 'module', id: id, text: (id + ' ' + m.name.zh + ' ' + m.name.en + ' ' + L(m.description)).toLowerCase() })
    })
    Object.keys(apiIndex).forEach(function (key) {
      out.push({ kind: 'api', id: key, moduleId: apiIndex[key], text: key.toLowerCase() })
    })
    return out
  }

  function goto(hash) { location.hash = hash }
  function render() {
    var main = document.getElementById('main')
    main.innerHTML = ''
    renderBreadcrumb()
    document.getElementById('btnLang').textContent = lang === 'zh' ? 'EN' : '中'
    if (current.view === 'trees') renderTrees(main)
    else if (current.view === 'level') renderLevel(main)
    else if (current.view === 'outline') renderOutline(main)
    else renderApis(main)
    var footer = document.getElementById('footer')
    footer.textContent = 'Normify · ' + DATA.project.name + ' · 模块 ' + stats.module_count + ' / API ' + stats.api_count + ' / 箭头 ' + stats.dep_count + ' · 构建于 ' + DATA.project.compiled_at
    if (current.apiKey) highlightApi()
  }
  function renderBreadcrumb() {
    var bc = document.getElementById('breadcrumb')
    bc.innerHTML = ''
    var a
    if (roots.length > 1) {
      a = document.createElement('a')
      a.href = '#trees'
      a.textContent = '树'
      bc.appendChild(a)
      bc.appendChild(sepEl())
    }
    if (current.moduleId) {
      var segs = current.moduleId.split('.')
      for (var i = 0; i < segs.length; i++) {
        a = document.createElement('a')
        a.href = '#module=' + encodeURIComponent(idOfSegs(segs.slice(0, i + 1)))
        a.textContent = segs[i]
        bc.appendChild(a)
        if (i < segs.length - 1) bc.appendChild(sepEl())
      }
    }
  }
  function sepEl() { var s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; return s }

  function renderTrees(main) {
    var wrap = el('div', 'trees')
    roots.forEach(function (id) {
      var m = mods[id]
      var card = el('div', 'tree-card')
      card.innerHTML = '<h2>' + esc(L(m.name)) + '</h2><div class="hint">' + esc(m.id) + '</div><div class="repo">' + esc(treeRepo(m.id) || '') + '</div><div class="hint">' + esc(oneLine(L(m.description), 120)) + '</div>'
      card.onclick = function () { goto('#module=' + encodeURIComponent(id)) }
      card.onmouseenter = function () { showTip(card, m) }
      card.onmouseleave = hideTip
      wrap.appendChild(card)
    })
    main.appendChild(wrap)
  }

  function renderLevel(main) {
    var m = mods[current.moduleId]
    var head = el('div', 'level-head')
    var repo = treeRepo(m.tree)
    var srcHref = sourceHref(m)
    head.innerHTML = '<h1>' + esc(L(m.name)) + ' <span class="hint">' + esc(m.id) + '</span></h1>'
      + '<p class="desc">' + esc(L(m.description)) + '</p>'
      + '<div class="meta">' + (m.state ? '<span>状态 ' + (m.state === 'planned' ? '计划' : m.state === 'deprecated' ? '废弃' : '已实现') + '</span>' : '') + '<span>模块 ' + (m.aggregate.descendant_count + 1) + '</span><span>API ' + (m.aggregate.own_api_count + m.aggregate.inherited_api_count) + '</span><span>出边 ' + m.aggregate.dep_out + '</span><span>入边 ' + m.aggregate.dep_in + '</span><span>' + ((DATA.layouts && DATA.layouts[current.moduleId]) ? '布局 渲染数据' : '布局 自动') + '</span>'
      + (repo ? '<a href="' + esc(repo) + '" target="_blank" rel="noopener">仓库</a>' : '')
      + (srcHref ? '<a href="' + esc(srcHref) + '" target="_blank" rel="noopener">源码 ' + esc(m.source[0].path) + '</a>' : '')
      + '</div>'
    main.appendChild(head)
    var kids = children[current.moduleId] || []
    if (kids.length === 0) {
      renderLeafDetail(main, m)
    } else {
      renderDiagram(main, m, kids)
      renderCrossEdges(main, m, kids)
      renderInheritedApis(main, m)
    }
  }

  function estWidth(s, fs) {
    var w = 0
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? fs : fs * 0.56
    return w
  }

  function wrapName(name, maxW, fs) {
    var s = String(name).replace(/s+/g, ' ')
    var words = s.split(' ')
    var lines = []
    if (words.length > 1) {
      var cur = ''
      for (var i = 0; i < words.length; i++) {
        var t = cur === '' ? words[i] : cur + ' ' + words[i]
        if (estWidth(t, fs) <= maxW || cur === '') cur = t
        else { lines.push(cur); cur = words[i] }
      }
      lines.push(cur)
    } else {
      lines.push(s)
    }
    if (lines.length > 2) lines = [lines[0], lines.slice(1).join(' ')]
    if (lines.length === 1 && estWidth(lines[0], fs) > maxW) {
      var l = lines[0], cut = 1
      while (cut < l.length && estWidth(l.slice(0, cut), fs) <= maxW) cut++
      cut = Math.max(1, cut - 1)
      lines = [l.slice(0, cut), l.slice(cut)]
    }
    if (lines.length === 2 && estWidth(lines[0], fs) > maxW) {
      var l2 = lines[0], cut2 = 1
      while (cut2 < l2.length && estWidth(l2.slice(0, cut2), fs) <= maxW) cut2++
      cut2 = Math.max(1, cut2 - 1)
      lines = [l2.slice(0, cut2), l2.slice(cut2) + ' ' + lines[1]]
    }
    return lines
  }

  function fitName(name, maxW) {
    var best = null
    for (var fs = 13; fs >= 8.5; fs -= 0.5) {
      var lines = wrapName(name, maxW, fs)
      var ok = true
      for (var i = 0; i < lines.length; i++) if (estWidth(lines[i], fs) > maxW) ok = false
      best = { lines: lines, fs: fs }
      if (ok) break
    }
    for (var j = 0; j < best.lines.length; j++) {
      var ln = best.lines[j]
      if (estWidth(ln, best.fs) <= maxW) continue
      while (ln.length > 1 && estWidth(ln + '…', best.fs) > maxW) ln = ln.slice(0, -1)
      best.lines[j] = ln + '…'
    }
    return best
  }

  var BOX = 200, GX = 220, GY = 220, MARGIN = 56, GPAD = 22, GTITLE = 24

  function orderedKids(kids, lay) {
    var kidSet = {}
    kids.forEach(function (k) { kidSet[k] = true })
    var edges = directEdges(kids)
    var order = []
    var seen = {}
    if (lay && lay.order) lay.order.forEach(function (id) { if (kidSet[id] && !seen[id]) { seen[id] = true; order.push(id) } })
    var rest = kids.filter(function (id) { return !seen[id] })
    if (edges.length > 0) {
      var layer = layerize(kids, edges)
      rest.sort(function (a, b) { return (layer[a] - layer[b]) || (a < b ? -1 : a > b ? 1 : 0) })
    } else {
      rest.sort()
    }
    return order.concat(rest)
  }

  /** 当前层可见的模块级直连边（仅用于自动排序/分层）。 */
  function directEdges(kids) {
    var kidSet = {}
    kids.forEach(function (k) { kidSet[k] = true })
    var out = []
    kids.forEach(function (id) {
      ;(mods[id].deps || []).forEach(function (d) {
        if (kidSet[d.to] && d.to !== id) out.push({ from: id, to: d.to, kind: d.kind })
      })
    })
    return out
  }

  /**
   * 当前层要画的全部边（对齐"API 直接连线"的原始目标）：
   * - exact：两端都在本层（孩子）——用真实 from_api/to_api 锚点，一条不合并；
   * - agg：某一端在可见孩子的子树内部（跨层）——聚合到可见模块上，虚线 + ×N + 明细 tooltip。
   */
  function collectEdges(kids) {
    var kidSet = {}
    kids.forEach(function (k) { kidSet[k] = true })
    var visibleOf = function (id) {
      if (kidSet[id]) return id
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i]
        if (id.length > k.length && id.indexOf(k + '.') === 0) return k
      }
      return null
    }
    var exact = []
    var seenExact = {}
    var aggMap = {}
    Object.keys(mods).forEach(function (srcId) {
      var m = mods[srcId]
      ;(m.deps || []).forEach(function (d) {
        var from = visibleOf(srcId)
        var to = visibleOf(d.to)
        if (from === null || to === null || from === to) return
        if (kidSet[srcId] && kidSet[d.to]) {
          var sig = srcId + '|' + d.to + '|' + (d.from_api || '') + '|' + (d.to_api || '') + '|' + d.kind
          if (seenExact[sig]) return
          seenExact[sig] = true
          exact.push({
            from: srcId, to: d.to,
            from_api: d.from_api || null, to_api: d.to_api || null,
            kind: d.kind, label: d.label || null, cross_tree: !!d.cross_tree,
            agg: false, count: 1, samples: [srcId + (d.from_api ? ' [' + d.from_api + ']' : '') + ' -> ' + d.to + (d.to_api ? ' [' + d.to_api + ']' : '')],
          })
          return
        }
        var key = from + '|' + to + '|' + d.kind
        var hit = aggMap[key]
        if (hit === undefined) {
          hit = { from: from, to: to, from_api: null, to_api: null, kind: d.kind, label: null, cross_tree: !!d.cross_tree, agg: true, count: 0, samples: [] }
          aggMap[key] = hit
        }
        hit.count++
        hit.cross_tree = hit.cross_tree || !!d.cross_tree
        if (hit.samples.length < 12) hit.samples.push(srcId + (d.from_api ? ' [' + d.from_api + ']' : '') + ' -> ' + d.to + (d.to_api ? ' [' + d.to_api + ']' : ''))
      })
    })
    var agg = Object.keys(aggMap).map(function (k) { return aggMap[k] }).sort(function (a, b) { return (b.count - a.count) || String(a.from).localeCompare(String(b.from)) })
    return { exact: exact, agg: agg }
  }

  function layerize(ids, edges) {
    var layer = {}
    ids.forEach(function (id) { layer[id] = 0 })
    for (var pass = 0; pass < ids.length + 1; pass++) {
      var changed = false
      edges.forEach(function (e) {
        if (layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; changed = true }
      })
      if (!changed) break
    }
    return layer
  }

  /** 叶子框内最多展示几行 API：由该层渲染数据的 max_api_rows 控制（0 = 全部），缺省 0 = 全展开。 */
  var MAX_API_ROWS = 0

  /** 叶子模块展示的 API 行（容器不展示）。 */
  function apiRows(id) {
    var m = mods[id]
    if (m === undefined || children[id] !== undefined) return []
    var apis = m.apis || []
    return MAX_API_ROWS > 0 ? apis.slice(0, MAX_API_ROWS) : apis
  }

  function apiRowCount(id) { return apiRows(id).length }

  /** 节点高度：名称区 42 + 每行 API 13（无 API 的叶子/容器 54）。 */
  function nodeHeight(id) {
    var rows = apiRowCount(id)
    return rows === 0 ? 54 : 44 + rows * 13
  }

  /** 边的端口 y：优先钉在具体 API 行上（"API 直接连线"），否则名称区中心。 */
  function apiPortY(node, apiKey) {
    if (!apiKey) return node.y + 26
    var rows = apiRows(node.id)
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === apiKey) return node.y + 40 + i * 13 + 6
    }
    return node.y + 26
  }

  function layoutBlock(members, edges, inner, maxCols) {
    var memberSet = {}
    members.forEach(function (id) { memberSet[id] = true })
    var internal = edges.filter(function (e) { return memberSet[e.from] && memberSet[e.to] })
    var nodes = []
    var W = 0, H = 0
    if (inner === 'column') {
      var y = 0
      members.forEach(function (id) {
        var h = nodeHeight(id)
        nodes.push({ id: id, x: 0, y: y, w: BOX, h: h })
        y += h + GY
      })
      W = BOX
      H = Math.max(0, y - GY)
    } else if (inner === 'layers' && internal.length > 0) {
      var layer = layerize(members, internal)
      var cols = {}
      members.forEach(function (id) { (cols[layer[id]] = cols[layer[id]] || []).push(id) })
      Object.keys(cols).forEach(function (k) { cols[k].sort() })
      var keys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b })
      var perBand = Math.max(2, Math.min(maxCols, 5))
      var bands = []
      for (var bi = 0; bi < keys.length; bi += perBand) bands.push(keys.slice(bi, bi + perBand))
      var yBand = 0
      var maxW = 0
      bands.forEach(function (band) {
        var bandH = 0
        band.forEach(function (k) {
          var colH = 0
          cols[k].forEach(function (id) { colH += nodeHeight(id) + GY })
          colH = Math.max(0, colH - GY)
          bandH = Math.max(bandH, colH)
        })
        var x = 0
        band.forEach(function (k) {
          var colH = 0
          cols[k].forEach(function (id) { colH += nodeHeight(id) + GY })
          colH = Math.max(0, colH - GY)
          var y0 = yBand + (bandH - colH) / 2
          cols[k].forEach(function (id) {
            var h = nodeHeight(id)
            nodes.push({ id: id, x: x, y: y0, w: BOX, h: h })
            y0 += h + GY
          })
          x += BOX + GX
        })
        maxW = Math.max(maxW, x - GX)
        yBand += bandH + GY + 34
      })
      W = maxW
      H = Math.max(0, yBand - GY - 34)
    } else {
      var n = members.length
      var colsN = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(n))))
      var rows = Math.ceil(n / colsN)
      var rowH = []
      for (var r = 0; r < rows; r++) {
        var hRow = 0
        for (var c = 0; c < colsN; c++) {
          var idx = r * colsN + c
          if (idx < n) hRow = Math.max(hRow, nodeHeight(members[idx]))
        }
        rowH.push(hRow)
      }
      var yAcc = []
      var acc = 0
      for (var r2 = 0; r2 < rows; r2++) { yAcc.push(acc); acc += rowH[r2] + GY }
      members.forEach(function (id, i) {
        var c2 = i % colsN, r3 = Math.floor(i / colsN)
        var h2 = nodeHeight(id)
        var yTop = yAcc[r3] + (rowH[r3] - h2) / 2
        nodes.push({ id: id, x: c2 * (BOX + GX), y: yTop, w: BOX, h: h2 })
      })
      W = colsN * BOX + (colsN - 1) * GX
      H = Math.max(0, acc - GY)
    }
    return { nodes: nodes, w: W, h: H, members: members, internal: internal }
  }

  function renderDiagram(main, m, kids) {
    var lay = (DATA.layouts || {})[m.id] || null
    MAX_API_ROWS = (lay && typeof lay.max_api_rows === 'number') ? Math.max(0, Math.min(48, lay.max_api_rows)) : 0
    if (lay && lay.reading) {
      var rb = el('div', 'reading')
      rb.innerHTML = '<b>' + esc(lang === 'zh' ? '阅读导语' : 'Reading guide') + '</b> ' + esc(L(lay.reading))
      main.appendChild(rb)
    }
    var maxCols = (lay && lay.max_columns) ? Math.max(1, Math.min(6, lay.max_columns)) : 4
    var ordered = orderedKids(kids, lay)
    var direct = directEdges(kids)
    var edgeSet = collectEdges(kids)
    var exactEdges = edgeSet.exact
    var aggEdges = edgeSet.agg
    var groups = null
    if (lay && lay.groups && lay.groups.length > 0) {
      var assigned = {}
      groups = []
      lay.groups.forEach(function (g) {
        var members = (g.children || []).filter(function (id) { return kids.indexOf(id) >= 0 && !assigned[id] })
        members.forEach(function (id) { assigned[id] = true })
        if (members.length > 0) groups.push({ id: g.id, title: g.title, members: members })
      })
      var rest = ordered.filter(function (id) { return !assigned[id] })
      if (rest.length > 0) groups.push({ id: '__rest__', title: { zh: '其它', en: 'Others' }, members: rest })
    } else {
      groups = [{ id: '__all__', title: null, members: ordered }]
    }
    var mode = (lay && lay.mode && lay.mode !== 'auto') ? lay.mode : null
    if (mode === null) mode = (groups.length > 1) ? 'groups' : (direct.length >= 2 ? 'layers' : 'grid')
    if (mode === 'groups' && groups.length === 1 && !groups[0].title) mode = direct.length >= 2 ? 'layers' : 'grid'

    var TOP_PAD = 72
    var BOTTOM_PAD = 56
    var ROW_MAX = 3200
    var blocks = []
    var usedW = 0
    var rowX = MARGIN, rowY = TOP_PAD, rowH = 0
    groups.forEach(function (g) {
      var inner = mode === 'layers' ? 'layers' : (mode === 'groups' ? (g.members.length > 5 ? 'grid' : 'column') : 'grid')
      var block = layoutBlock(g.members, direct, inner, maxCols)
      block.title = g.title
      block.gid = g.id
      var bw = block.w + GPAD * 2
      if (rowX > MARGIN && rowX + bw > ROW_MAX) { rowX = MARGIN; rowY += rowH + GY; rowH = 0 }
      block.offsetX = rowX + GPAD
      block.offsetY = rowY + (block.title ? GTITLE + 8 : 0)
      rowX += bw + GX + 80
      usedW = Math.max(usedW, rowX - 40)
      rowH = Math.max(rowH, block.h + (block.title ? GTITLE + GPAD + 8 : 0))
      blocks.push(block)
    })
    var W = Math.max(MARGIN + usedW + MARGIN, 460)
    var H = rowY + rowH + BOTTOM_PAD
    var groupRects = []
    blocks.forEach(function (b) {
      if (!b.title) return
      groupRects.push({ x: b.offsetX - GPAD, y: b.offsetY - GTITLE - GPAD + 6, w: b.w + GPAD * 2, h: b.h + GTITLE + GPAD * 2 - 6 })
    })
    var corridorXs = []
    var corridorYs = []
    var blockIdx = {}
    blocks.forEach(function (b, bi) { b.nodes.forEach(function (n) { blockIdx[n.id] = bi }) })
    for (var bi2 = 0; bi2 < blocks.length - 1; bi2++) {
      var b1 = blocks[bi2], b2b = blocks[bi2 + 1]
      if (Math.abs(b1.offsetY - b2b.offsetY) < 48) corridorXs.push((b1.offsetX + b1.w + b2b.offsetX) / 2)
      else corridorYs.push((b1.offsetY + b1.h + b2b.offsetY) / 2)
    }

    var nodes = []
    blocks.forEach(function (b) {
      b.nodes.forEach(function (n) {
        nodes.push({ id: n.id, x: n.x + b.offsetX, y: n.y + b.offsetY, w: n.w, h: n.h, cx: n.x + b.offsetX + n.w / 2, cy: n.y + b.offsetY + n.h / 2 })
      })
    })
    var byId = {}
    nodes.forEach(function (n) { byId[n.id] = n })
    var rects = nodes.map(function (n) { return { x: n.x, y: n.y, w: n.w, h: n.h } })
    var rectById = {}
    nodes.forEach(function (n, i) { rectById[n.id] = rects[i] })
    /** 线段是否穿入某节点框的"内部"（内缩 PAD：贴着端口的那一小段不算穿框）。 */
    function segEntersRect(x1, y1, x2, y2, r) {
      var PAD = 2
      var rx = r.x + PAD, ry = r.y + PAD, rw = r.w - PAD * 2, rh = r.h - PAD * 2
      if (rw <= 0 || rh <= 0) return false
      if (Math.max(x1, x2) <= rx || Math.min(x1, x2) >= rx + rw) return false
      if (Math.max(y1, y2) <= ry || Math.min(y1, y2) >= ry + rh) return false
      return true
    }
    var nodesById = {}
    nodes.forEach(function (n) { nodesById[n.id] = n })
    var maxY = 0
    rects.forEach(function (r) { maxY = Math.max(maxY, r.y + r.h) })
    var CLEAR = 16
    // 自由通道：相邻列/相邻行之间的空隙中线（线走通道就不贴框）
    var vchans = []
    var hchans = []
    var xsSeen = [], ysSeen = []
    rects.forEach(function (r) {
      if (xsSeen.indexOf(r.x) < 0) xsSeen.push(r.x)
      if (ysSeen.indexOf(r.y) < 0) ysSeen.push(r.y)
    })
    xsSeen.sort(function (a, b) { return a - b })
    ysSeen.sort(function (a, b) { return a - b })
    function nearGroupBorderX(x) {
      for (var gi = 0; gi < groupRects.length; gi++) {
        var g = groupRects[gi]
        if (Math.abs(x - g.x) < 18 || Math.abs(x - (g.x + g.w)) < 18) return true
      }
      return false
    }
    function nearGroupBorderY(y) {
      for (var gi = 0; gi < groupRects.length; gi++) {
        var g = groupRects[gi]
        if (Math.abs(y - g.y) < 18 || Math.abs(y - (g.y + g.h)) < 18) return true
      }
      return false
    }
    function groupBorderDistX(x) {
      var d = Infinity
      for (var gi = 0; gi < groupRects.length; gi++) {
        var g = groupRects[gi]
        d = Math.min(d, Math.abs(x - g.x), Math.abs(x - (g.x + g.w)))
      }
      return d
    }
    function groupBorderDistY(y) {
      var d = Infinity
      for (var gi = 0; gi < groupRects.length; gi++) {
        var g = groupRects[gi]
        d = Math.min(d, Math.abs(y - g.y), Math.abs(y - (g.y + g.h)))
      }
      return d
    }
    for (var xi = 0; xi < xsSeen.length - 1; xi++) {
      var xa = xsSeen[xi], xb = xsSeen[xi + 1]
      var xgap = xb - (xa + BOX)
      if (xgap < CLEAR * 2 + 12) continue
      ;[0.18, 0.5, 0.82].forEach(function (fr) {
        var cx = xa + BOX + xgap * fr
        var sp = Math.min(xgap, 120) / 2 - CLEAR
        if (!nearGroupBorderX(cx) && groupBorderDistX(cx) >= 18 + Math.max(0, sp)) vchans.push({ x: cx, span: sp })
      })
    }
    for (var yi = 0; yi < ysSeen.length - 1; yi++) {
      var ya = ysSeen[yi], yb = ysSeen[yi + 1]
      var minH = 0
      rects.forEach(function (r) { if (Math.abs(r.y - ya) < 2) minH = Math.max(minH, r.h) })
      var ygap = yb - (ya + minH)
      if (ygap < CLEAR * 2 + 10) continue
      ;[0.22, 0.5, 0.78].forEach(function (fr) {
        var cy = ya + minH + ygap * fr
        var sp2 = Math.min(ygap, 140) / 2 - CLEAR
        if (!nearGroupBorderY(cy) && groupBorderDistY(cy) >= 18 + Math.max(0, sp2)) hchans.push({ y: cy, span: sp2 })
      })
    }

    // 全高自由列 / 全宽自由行：竖线或横线整条不与任何节点框相交（用于保底总线路由）
    var freeCols = []
    var freeRows = []
    for (var fx = Math.round(MARGIN * 0.6); fx <= W - MARGIN * 0.6; fx += 10) {
      var cxClr = Infinity
      for (var fi = 0; fi < rects.length; fi++) {
        var rr1 = rects[fi]
        if (fx > rr1.x - 1 && fx < rr1.x + rr1.w + 1) { cxClr = -1; break }
        cxClr = Math.min(cxClr, Math.min(Math.abs(fx - rr1.x), Math.abs(fx - (rr1.x + rr1.w))))
      }
      var spC = Math.max(0, Math.min(80, cxClr - CLEAR - 3))
      if (cxClr >= CLEAR + 4 && groupBorderDistX(fx) >= 18 + spC && !nearGroupBorderX(fx)) freeCols.push({ x: fx, span: spC })
    }
    for (var fy = Math.round(TOP_PAD * 0.35); fy <= maxY + BOTTOM_PAD; fy += 8) {
      var cyClr = Infinity
      for (var fi2 = 0; fi2 < rects.length; fi2++) {
        var rr2 = rects[fi2]
        if (fy > rr2.y - 1 && fy < rr2.y + rr2.h + 1) { cyClr = -1; break }
        cyClr = Math.min(cyClr, Math.min(Math.abs(fy - rr2.y), Math.abs(fy - (rr2.y + rr2.h))))
      }
      var spR = Math.max(0, Math.min(80, cyClr - CLEAR - 3))
      if (cyClr >= CLEAR + 4 && groupBorderDistY(fy) >= 18 + spR && !nearGroupBorderY(fy)) freeRows.push({ y: fy, span: spR })
    }

    // 外围合成车道：顶部/底部/左侧/右侧无节点区域，用于总线兜底，保证任何边都有干净路径
    for (var syn = 0; syn < 8; syn++) freeRows.push({ y: 8 + syn * 9, span: 80, synthetic: true })
    for (var syn2 = 0; syn2 < 22; syn2++) freeRows.push({ y: Math.round(maxY + 32 + syn2 * 9), span: 80, synthetic: true })
    for (var syn3 = 0; syn3 < 16; syn3++) freeCols.push({ x: 8 + syn3 * 9, span: 80, synthetic: true })
    for (var syn4 = 0; syn4 < 16; syn4++) freeCols.push({ x: Math.round(W - 8 - syn4 * 9), span: 80, synthetic: true })

    function segClear(x1, y1, x2, y2, skipFrom, skipTo) {
      var minX = Math.min(x1, x2), maxX = Math.max(x1, x2)
      var minY = Math.min(y1, y2), maxYv = Math.max(y1, y2)
      for (var i = 0; i < rects.length; i++) {
        var n = nodes[i]
        if (n.id === skipFrom || n.id === skipTo) continue
        var r = rects[i]
        var rx = r.x - CLEAR, ry = r.y - CLEAR, rw = r.w + CLEAR * 2, rh = r.h + CLEAR * 2
        if (maxX <= rx || minX >= rx + rw) continue
        if (maxYv <= ry || minY >= ry + rh) continue
        return false
      }
      return true
    }
    /** 平行于组框边且距离过近（视觉上"贴着组框走线"）判定。 */
    function segHugsGroup(x1, y1, x2, y2) {
      var horiz = Math.abs(y1 - y2) < 0.6
      var vert = Math.abs(x1 - x2) < 0.6
      if (!horiz && !vert) return false
      for (var gi = 0; gi < groupRects.length; gi++) {
        var g = groupRects[gi]
        if (horiz) {
          if (y1 < g.y - 2 || y1 > g.y + g.h + 2) continue
          if (Math.abs(y1 - g.y) >= 13 && Math.abs(y1 - (g.y + g.h)) >= 13) continue
          var lx = Math.min(x1, x2), rx = Math.max(x1, x2)
          if (Math.min(rx, g.x + g.w) - Math.max(lx, g.x) > 36) return true
        } else {
          if (x1 < g.x - 2 || x1 > g.x + g.w + 2) continue
          if (Math.abs(x1 - g.x) >= 13 && Math.abs(x1 - (g.x + g.w)) >= 13) continue
          var ty = Math.min(y1, y2), by = Math.max(y1, y2)
          if (Math.min(by, g.y + g.h) - Math.max(ty, g.y) > 36) return true
        }
      }
      return false
    }
    var usedH = []
    var usedV = []
    function segOverlapsUsed(x1, y1, x2, y2) {
      var horiz = Math.abs(y1 - y2) < 0.6
      var vert = Math.abs(x1 - x2) < 0.6
      if (!horiz && !vert) return false
      if (horiz) {
        var y = y1, lx = Math.min(x1, x2), rx = Math.max(x1, x2)
        for (var i = 0; i < usedH.length; i++) {
          var u = usedH[i]
          if (Math.abs(u.y - y) < 0.6 && Math.min(rx, u.x2) - Math.max(lx, u.x1) > 20) return true
        }
      } else {
        var x = x1, ty = Math.min(y1, y2), by = Math.max(y1, y2)
        for (var j = 0; j < usedV.length; j++) {
          var v = usedV[j]
          if (Math.abs(v.x - x) < 0.6 && Math.min(by, v.y2) - Math.max(ty, v.y1) > 20) return true
        }
      }
      return false
    }
    function commitRoute(pts) {
      for (var i = 0; i < pts.length - 1; i++) {
        var x1 = pts[i].x, y1 = pts[i].y, x2 = pts[i + 1].x, y2 = pts[i + 1].y
        if (Math.abs(y1 - y2) < 0.6) usedH.push({ y: y1, x1: Math.min(x1, x2), x2: Math.max(x1, x2) })
        else if (Math.abs(x1 - x2) < 0.6) usedV.push({ x: x1, y1: Math.min(y1, y2), y2: Math.max(y1, y2) })
      }
    }
    function pathClear(pts, skipFrom, skipTo) {
      for (var i = 0; i < pts.length - 1; i++) {
        if (!segClear(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, skipFrom, skipTo)) return false
        if (segHugsGroup(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)) return false
      }
      return true
    }
    function clean(pts) {
      var out = []
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i]
        var last = out[out.length - 1]
        if (last && Math.abs(p.x - last.x) < 0.5 && Math.abs(p.y - last.y) < 0.5) continue
        out.push({ x: p.x, y: p.y })
      }
      for (var j = 1; j < out.length - 1; j++) {
        var a = out[j - 1], b = out[j], c = out[j + 1]
        if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) {
          out.splice(j, 1)
          j--
        }
      }
      return out
    }

    var allEdges = aggEdges.concat(exactEdges)
    var sideCount = {}, sideUsed = {}, apiPortCount = {}
    function sideOf(A, B) {
      var dx = B.cx - A.cx, dy = B.cy - A.cy
      var a, b
      if (Math.abs(dx) >= Math.abs(dy)) { a = dx >= 0 ? 'R' : 'L'; b = dx >= 0 ? 'L' : 'R' }
      else { a = dy >= 0 ? 'B' : 'T'; b = dy >= 0 ? 'T' : 'B' }
      return [a, b]
    }
    allEdges.forEach(function (e) {
      var A = byId[e.from], B = byId[e.to]
      if (!A || !B) return
      e.sides = sideOf(A, B)
      sideCount[e.from + e.sides[0]] = (sideCount[e.from + e.sides[0]] || 0) + 1
      sideCount[e.to + e.sides[1]] = (sideCount[e.to + e.sides[1]] || 0) + 1
      // API 锚定的端口也要"端口分离"：同一个 API 行常被多条边共用，
      // 若都钉在同一个点，最后一段必然共线重叠（线压线）。
      if (e.from_api) { var k1 = e.from + e.sides[0] + '|api:' + e.from_api; apiPortCount[k1] = (apiPortCount[k1] || 0) + 1 }
      if (e.to_api) { var k2 = e.to + e.sides[1] + '|api:' + e.to_api; apiPortCount[k2] = (apiPortCount[k2] || 0) + 1 }
    })
    function portOf(node, side, key, apiKey) {
      // API 锚点只在左右边有意义（API 行是横排的一行）。
      // 上下边一律走"按边均匀分离"：否则同一节点不同 API 的边会各自取中点而重合。
      if (apiKey && (side === 'L' || side === 'R')) {
        // 同一 (节点, 侧, API 行) 上的多条边按到达顺序扇形分离：
        // ① 左右边：±5.5px 仍落在该 API 行（行高 13px）内，视觉上依旧"钉在 API 行"，但不再共线；
        // ② 上下边：API 行是"横排的一行"，纵向边上没有对应的行位置——退回按边均匀分离，
        //    否则端口会被放到框内部，连线横穿自身框。
        var fk = key + '|api:' + apiKey
        sideUsed[fk] = (sideUsed[fk] || 0) + 1
        var ftotal = apiPortCount[fk] || 1
        var ffrac = sideUsed[fk] / (ftotal + 1)
        var foff = (ffrac - 0.5) * 11
        return { x: side === 'R' ? node.x + node.w : node.x, y: apiPortY(node, apiKey) + foff, side: side, api: true }
      }
      sideUsed[key] = (sideUsed[key] || 0) + 1
      var total = sideCount[key] || 1
      var frac = sideUsed[key] / (total + 1)
      if (side === 'L' || side === 'R') {
        var y = node.y + 10 + (node.h - 20) * frac
        return { x: side === 'R' ? node.x + node.w : node.x, y: y, side: side, api: false }
      }
      var x = node.x + 10 + (node.w - 20) * frac
      return { x: x, y: side === 'B' ? node.y + node.h : node.y, side: side, api: false }
    }
    var hintList = (lay && lay.edge_hints) || []
    function hintFor(e) {
      for (var i = 0; i < hintList.length; i++) {
        var h = hintList[i]
        if (h.from === e.from && h.to === e.to && (h.kind === undefined || h.kind === e.kind)) return h
      }
      return null
    }
    var laneUse = {}
    var railTopUse = 0
    var railBotUse = 0
    var chanUse = {}
    var laneXUsed = {}
    var laneYUsed = {}
    function chanKey(base, key) { return key + ':' + Math.round(base / 4) }
    function chanLoad(base, key) {
      var used = chanUse[chanKey(base, key)]
      if (used === undefined) return 0
      var n = 0
      for (var k in used) n++
      return n
    }
    /**
     * 分配一条全局唯一的车道坐标：同一坐标（x 或 y）绝不会分配给两条边，
     * 从根本上避免"线压线"（共线重叠）。axis: 'x' 竖线 / 'y' 横线。
     */
    function laneAt(base, key, span, axis) {
      var ax = axis === undefined ? (key === 'v' || key === 'fc' || key === 'mh' ? 'x' : 'y') : axis
      var reg = ax === 'x' ? laneXUsed : laneYUsed
      var k = chanKey(base, key)
      var used = chanUse[k]
      if (used === undefined) { used = {}; chanUse[k] = used }
      var step = 9
      var max = Math.max(9, span === undefined ? 36 : span)
      var slots = Math.max(1, Math.floor((max * 2) / step) + 1)
      for (var i = 0; i < slots; i++) {
        var off = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * step * Math.ceil(i / 2)
        if (Math.abs(off) > max || used[off] !== undefined) continue
        var pos = Math.round((base + off) * 10) / 10
        if (reg[pos] === undefined) { reg[pos] = key; used[off] = 1; return pos }
      }
      return null
    }
    function route(e, pa, pb) {
      var hint = hintFor(e)
      var lane = hint && typeof hint.lane === 'number' ? hint.lane : 0
      var a = pa.side, b = pb.side
      var cands = []
      var aVert = (a === 'T' || a === 'B'), bVert = (b === 'T' || b === 'B')
      if (aVert && bVert) {
        var midY2 = (pa.y + pb.y) / 2
        var midY1 = pa.y + (pb.y - pa.y) * 0.34
        var midY3 = pa.y + (pb.y - pa.y) * 0.66
        cands.push([pa, { x: pa.x, y: midY2 }, { x: pb.x, y: midY2 }, pb])
        cands.push([pa, { x: pa.x, y: midY1 }, { x: pb.x, y: midY1 }, pb])
        cands.push([pa, { x: pa.x, y: midY3 }, { x: pb.x, y: midY3 }, pb])
      }
      var midCx = (pa.x + pb.x) / 2, midCy = (pa.y + pb.y) / 2
      var vc = [], hc = []
      for (var ci = 0; ci < vchans.length; ci++) {
        var ch = vchans[ci]
        if ((ch.x - pa.x) * (ch.x - pb.x) <= 0 && Math.abs(ch.x - pa.x) > 6 && Math.abs(ch.x - pb.x) > 6) vc.push({ ch: ch, d: Math.abs(ch.x - midCx), load: chanLoad(ch.x, 'v') })
      }
      for (var yi = 0; yi < hchans.length; yi++) {
        var chh = hchans[yi]
        if ((chh.y - pa.y) * (chh.y - pb.y) <= 0 && Math.abs(chh.y - pa.y) > 6 && Math.abs(chh.y - pb.y) > 6) hc.push({ ch: chh, d: Math.abs(chh.y - midCy), load: chanLoad(chh.y, 'h') })
      }
      vc.sort(function (p1, p2) { return (p1.load - p2.load) || (p1.d - p2.d) })
      hc.sort(function (p1, p2) { return (p1.load - p2.load) || (p1.d - p2.d) })
      var vLimit = Math.min(vc.length, 8)
      for (var vi = 0; vi < vLimit; vi++) {
        var mvx = laneAt(vc[vi].ch.x, 'v', vc[vi].ch.span)
        if (mvx === null) continue
        cands.push([pa, { x: mvx, y: pa.y }, { x: mvx, y: pb.y }, pb])
      }
      var hLimit = Math.min(hc.length, 8)
      for (var hi2 = 0; hi2 < hLimit; hi2++) {
        var mhy = laneAt(hc[hi2].ch.y, 'h', hc[hi2].ch.span)
        if (mhy === null) continue
        cands.push([pa, { x: pa.x, y: mhy }, { x: pb.x, y: mhy }, pb])
      }
      if ((a === 'R' && b === 'L') || (a === 'L' && b === 'R')) {
        if (pa.x <= pb.x) {
          var mx0 = laneAt((pa.x + pb.x) / 2, 'mh', 40)
          var mx = mx0 === null ? (pa.x + pb.x) / 2 : mx0
          cands.push([pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb])
        } else {
          var outX = Math.max(pa.x, pb.x) + MARGIN * 0.8
          var outX2 = Math.min(pa.x, pb.x) - MARGIN * 0.8
          cands.push([pa, { x: outX, y: pa.y }, { x: outX, y: pb.y }, pb])
          cands.push([pa, { x: outX2, y: pa.y }, { x: outX2, y: pb.y }, pb])
        }
      } else if ((a === 'B' && b === 'T') || (a === 'T' && b === 'B')) {
        if (pa.y <= pb.y) {
          var my0 = laneAt((pa.y + pb.y) / 2, 'mv', 30)
          var my = my0 === null ? (pa.y + pb.y) / 2 : my0
          cands.push([pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb])
        } else {
          var outY = Math.max(pa.y, pb.y) + GY * 0.9
          var outY2 = Math.min(pa.y, pb.y) - GY * 0.9
          cands.push([pa, { x: pa.x, y: outY }, { x: pb.x, y: outY }, pb])
          cands.push([pa, { x: pa.x, y: outY2 }, { x: pb.x, y: outY2 }, pb])
        }
      } else {
        cands.push([pa, { x: pb.x, y: pa.y }, pb])
        cands.push([pa, { x: pa.x, y: pb.y }, pb])
        var cornerX = (a === 'R') ? Math.max(pa.x, pb.x) + MARGIN * 0.8 : Math.min(pa.x, pb.x) - MARGIN * 0.8
        cands.push([pa, { x: cornerX, y: pa.y }, { x: cornerX, y: pb.y }, pb])
      }
      function nearestHChan(v) {
        var best = null, bd = Infinity
        for (var hci = 0; hci < hchans.length; hci++) {
          var chh2 = hchans[hci]
          var dh = Math.abs(chh2.y - v) + chanLoad(chh2.y, 'h') * 6
          if (dh < bd) { bd = dh; best = chh2 }
        }
        return best
      }
      var hNearA = nearestHChan(pa.y)
      var hNearB = nearestHChan(pb.y)
      if (hNearA !== null) {
        var hAy = laneAt(hNearA.y, 'h', hNearA.span)
        if (hAy !== null) cands.push([pa, { x: pa.x, y: hAy }, { x: pb.x, y: hAy }, pb])
      }
      if (hNearB !== null) {
        var hBy = laneAt(hNearB.y, 'h', hNearB.span)
        if (hBy !== null) cands.push([pa, { x: pa.x, y: hBy }, { x: pb.x, y: hBy }, pb])
      }
      function nearestChan(arr, v, side) {
        var best = null, bd = Infinity
        for (var ci2 = 0; ci2 < arr.length; ci2++) {
          var ch2 = arr[ci2]
          if (side === 'R' && ch2.x < v + 6) continue
          if (side === 'L' && ch2.x > v - 6) continue
          var d2 = Math.abs(ch2.x - v) + chanLoad(ch2.x, 'v') * 6
          if (d2 < bd) { bd = d2; best = ch2 }
        }
        return best
      }
      var cands2 = []
      var chA = nearestChan(vchans, pa.x, pa.side === 'R' ? 'R' : pa.side === 'L' ? 'L' : undefined)
      var chB = nearestChan(vchans, pb.x, pb.side === 'L' ? 'L' : pb.side === 'R' ? 'R' : undefined)
      if (chA === null) chA = nearestChan(vchans, pa.x, undefined)
      if (chB === null) chB = nearestChan(vchans, pb.x, undefined)
      var preferTop = (pa.y + pb.y) / 2 < (TOP_PAD + maxY) / 2
      if (chA !== null && chB !== null) {
        var cAx0 = laneAt(chA.x, 'v', chA.span)
        var cBx0 = laneAt(chB.x, 'v', chB.span)
        var railY2 = laneAt(preferTop ? 8 : Math.round(maxY + 32), 'rail', 80, 'y')
        if (cAx0 !== null && cBx0 !== null && railY2 !== null) {
          cands2.push([pa, { x: cAx0, y: pa.y }, { x: cAx0, y: railY2 }, { x: cBx0, y: railY2 }, { x: cBx0, y: pb.y }, pb])
        }
      }
      function pickFreeCol(x, dir) {
        var best = null, bd = Infinity
        for (var pi2 = 0; pi2 < freeCols.length; pi2++) {
          var fc0 = freeCols[pi2]
          if (dir === 'L' && fc0.x > x - 4) continue
          if (dir === 'R' && fc0.x < x + 4) continue
          var dd = Math.abs(fc0.x - x)
          if (dd < bd) { bd = dd; best = fc0 }
        }
        return best
      }
      function pickFreeRow(y, dir) {
        var best = null, bd = Infinity
        for (var pi3 = 0; pi3 < freeRows.length; pi3++) {
          var fr0 = freeRows[pi3]
          if (dir === 'T' && fr0.y > y - 4) continue
          if (dir === 'B' && fr0.y < y + 4) continue
          var dd2 = Math.abs(fr0.y - y)
          if (dd2 < bd) { bd = dd2; best = fr0 }
        }
        return best
      }
      /** 在候选自由列中选一条仍有空车道的（按距离+负载排序），返回 {col, laneX} */
      function allocFreeCol(x, dir) {
        var list = []
        for (var ai = 0; ai < freeCols.length; ai++) {
          var fcA = freeCols[ai]
          if (dir === 'L' && fcA.x > x - 4) continue
          if (dir === 'R' && fcA.x < x + 4) continue
          list.push({ col: fcA, score: Math.abs(fcA.x - x) + chanLoad(fcA.x, 'fc') * 10 })
        }
        list.sort(function (u, v) { return u.score - v.score })
        for (var ai2 = 0; ai2 < list.length; ai2++) {
          var lane = laneAt(list[ai2].col.x, 'fc', list[ai2].col.span)
          if (lane !== null) return { col: list[ai2].col, laneX: lane }
        }
        return null
      }
      function allocFreeRow(y) {
        var list = []
        for (var ri = 0; ri < freeRows.length; ri++) {
          list.push({ row: freeRows[ri], score: Math.abs(freeRows[ri].y - y) + chanLoad(freeRows[ri].y, 'fr') * 10 })
        }
        list.sort(function (u, v) { return u.score - v.score })
        for (var ri2 = 0; ri2 < list.length; ri2++) {
          var lane = laneAt(list[ri2].row.y, 'fr', list[ri2].row.span)
          if (lane !== null) return { row: list[ri2].row, laneY: lane }
        }
        return null
      }
      function busEntry(port) {
        if (port.side === 'L' || port.side === 'R') {
          var ac = allocFreeCol(port.x, port.side)
          if (ac === null) ac = allocFreeCol(port.x, undefined)
          return ac === null ? null : { col: ac.col, laneX: ac.laneX, row: null }
        }
        var ar = allocFreeRow(port.side === 'T' ? port.y + 6 : port.y - 6)
        if (ar === null) return null
        var ac2 = allocFreeCol(port.x, undefined)
        if (ac2 === null) return null
        return { col: ac2.col, laneX: ac2.laneX, row: ar.row, rowY: ar.laneY }
      }
      var eA = busEntry(pa), eB = busEntry(pb)
      if (eA !== null && eB !== null) {
        var midTarget = (pa.y + pb.y) / 2
        var rowOrder = freeRows.slice().sort(function (u, v) {
          return (Math.abs(u.y - midTarget) + chanLoad(u.y, 'fr') * 4) - (Math.abs(v.y - midTarget) + chanLoad(v.y, 'fr') * 4)
        })
        var built = 0
        for (var ri3 = 0; ri3 < rowOrder.length && built < 4; ri3++) {
          var gY = laneAt(rowOrder[ri3].y, 'fr', rowOrder[ri3].span)
          if (gY === null) continue
          var gxA = eA.laneX
          var gxB = eB.laneX
          var gpts = [{ x: pa.x, y: pa.y }]
          if (eA.row === null) gpts.push({ x: gxA, y: pa.y })
          else { gpts.push({ x: pa.x, y: eA.rowY }); gpts.push({ x: gxA, y: eA.rowY }) }
          gpts.push({ x: gxA, y: gY })
          gpts.push({ x: gxB, y: gY })
          if (eB.row === null) { gpts.push({ x: gxB, y: pb.y }); gpts.push({ x: pb.x, y: pb.y }) }
          else { gpts.push({ x: gxB, y: eB.rowY }); gpts.push({ x: pb.x, y: eB.rowY }); gpts.push({ x: pb.x, y: pb.y }) }
          cands2.push(gpts)
          built++
        }
      }
      var ordered = cands2.concat(cands)
      // 首选：任何一项违规都为 0 的候选（不穿别的框、不压已画的线、不横穿自己的框、端口法向正确）。
      // 旧实现只判 pathClear（不穿别人的框）就返回，于是"第一条不撞框的路径"可能是压着别的线走的。
      for (var oi = 0; oi < ordered.length; oi++) {
        var opts = clean(ordered[oi])
        if (pathClear(opts, e.from, e.to) && violations(opts) === 0) return { pts: opts, hint: hint, fallback: e.agg }
      }
      // 次选：没有完全干净的路径时，取违规最少的一条
      var bestV1 = Infinity, bestPts1 = null
      for (var oj = 0; oj < ordered.length; oj++) {
        var opj = clean(ordered[oj])
        if (!pathClear(opj, e.from, e.to)) continue
        var vj = violations(opj)
        if (vj < bestV1) { bestV1 = vj; bestPts1 = opj }
      }
      if (bestPts1 !== null) return { pts: bestPts1, hint: hint, fallback: true }
      function violations(pts) {
        var v = 0
        // 端口法向：T/B 端口的首段必须是竖直的，L/R 端口必须是水平的；
        // 否则线会沿着节点自己的边滑行，多条边叠在同一条边线上（线压线）。
        if (pts.length >= 2) {
          var f = pts[1]
          if ((pa.side === 'T' || pa.side === 'B') ? Math.abs(f.y - pa.y) < 0.6 : Math.abs(f.x - pa.x) < 0.6) v += 6
          var l = pts[pts.length - 2]
          if ((pb.side === 'T' || pb.side === 'B') ? Math.abs(l.y - pb.y) < 0.6 : Math.abs(l.x - pb.x) < 0.6) v += 6
        }
        for (var si = 0; si < pts.length - 1; si++) {
          for (var ri = 0; ri < rects.length; ri++) {
            var rn = nodes[ri]
            if (rn.id === e.from || rn.id === e.to) continue
            if (!segClear(pts[si].x, pts[si].y, pts[si + 1].x, pts[si + 1].y, e.from, e.to)) v += 8
          }
          if (segHugsGroup(pts[si].x, pts[si].y, pts[si + 1].x, pts[si + 1].y)) v += 2
          if (segOverlapsUsed(pts[si].x, pts[si].y, pts[si + 1].x, pts[si + 1].y)) v += 3
          // 端点框：segClear 会整块跳过源/目标框，若不额外检查，连线可以横穿自己的框
          var rA = rectById[e.from], rB = rectById[e.to]
          if (rA && segEntersRect(pts[si].x, pts[si].y, pts[si + 1].x, pts[si + 1].y, rA)) v += 4
          if (rB && segEntersRect(pts[si].x, pts[si].y, pts[si + 1].x, pts[si + 1].y, rB)) v += 4
        }
        return v
      }
      var bestPts = clean(ordered[ordered.length - 1]), bestV = Infinity
      for (var pi = 0; pi < ordered.length; pi++) {
        var cp = clean(ordered[pi])
        var v1 = violations(cp)
        if (v1 < bestV) { bestV = v1; bestPts = cp }
      }
      return { pts: bestPts, hint: hint, fallback: true }
    }
    function roundedPath(pts, r) {
      if (pts.length < 2) return ''
      var d = 'M ' + pts[0].x + ' ' + pts[0].y
      for (var i = 1; i < pts.length - 1; i++) {
        var p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1]
        var d1 = Math.sqrt((p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y))
        var d2 = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y))
        var rr = Math.min(r, d1 / 2 - 0.5, d2 / 2 - 0.5)
        if (rr < 3) { d += ' L ' + p1.x + ' ' + p1.y; continue }
        var ax = p1.x - (p1.x - p0.x) * rr / d1
        var ay = p1.y - (p1.y - p0.y) * rr / d1
        var bx = p1.x + (p2.x - p1.x) * rr / d2
        var by = p1.y + (p2.y - p1.y) * rr / d2
        d += ' L ' + ax + ' ' + ay + ' Q ' + p1.x + ' ' + p1.y + ' ' + bx + ' ' + by
      }
      var last = pts[pts.length - 1]
      d += ' L ' + last.x + ' ' + last.y
      return d
    }
    function arrowPoints(tip, prev) {
      var dx = tip.x - prev.x, dy = tip.y - prev.y
      var len = Math.sqrt(dx * dx + dy * dy) || 1
      var c = dx / len, s = dy / len
      var bx = tip.x - 9 * c, by = tip.y - 9 * s
      var px = -s * 4.5, py = c * 4.5
      return tip.x + ',' + tip.y + ' ' + (bx + px) + ',' + (by + py) + ' ' + (bx - px) + ',' + (by - py)
    }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'diagram')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

    blocks.forEach(function (b) {
      if (!b.title) return
      var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('x', b.offsetX - GPAD)
      bg.setAttribute('y', b.offsetY - GTITLE - GPAD + 6)
      bg.setAttribute('width', b.w + GPAD * 2)
      bg.setAttribute('height', b.h + GTITLE + GPAD * 2 - 6)
      bg.setAttribute('rx', 12)
      bg.setAttribute('class', 'group-box')
      svg.appendChild(bg)
      var gt = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      gt.setAttribute('x', b.offsetX - GPAD + 4)
      gt.setAttribute('y', b.offsetY - 10)
      gt.setAttribute('class', 'group-title')
      gt.textContent = L(b.title)
      svg.appendChild(gt)
    })

    var drawn = []
    var labelBudget = {}
    var placedLabels = []
    var bounds = { minX: 0, minY: 0, maxX: W, maxY: H }
    function extend(x, y) {
      if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return
      if (x < bounds.minX) bounds.minX = x
      if (y < bounds.minY) bounds.minY = y
      if (x > bounds.maxX) bounds.maxX = x
      if (y > bounds.maxY) bounds.maxY = y
    }
    function labelPos(pts, text, skipFrom, skipTo) {
      var w = estWidth(text, 10)
      var best = null, bestLen = -1
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i], p1 = pts[i + 1]
        var dx = p1.x - p0.x, dy = p1.y - p0.y
        var len = Math.sqrt(dx * dx + dy * dy)
        if (len < 30) continue
        var horiz = Math.abs(dx) > Math.abs(dy)
        var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2
        var lx = mx - w / 2 - 4, ly = horiz ? my - 14 : my - 5, lw = w + 8, lh = 12
        var ok = true
        for (var r = 0; r < rects.length; r++) {
          var n = nodes[r]
          if (n.id === skipFrom || n.id === skipTo) continue
          var b2 = rects[r]
          if (lx + lw > b2.x + 3 && lx < b2.x + b2.w - 3 && ly + lh > b2.y + 3 && ly < b2.y + b2.h - 3) { ok = false; break }
        }
        for (var pl = 0; pl < placedLabels.length; pl++) {
          var b3 = placedLabels[pl]
          if (lx + lw > b3.x && lx < b3.x + b3.w && ly + lh > b3.y && ly < b3.y + b3.h) { ok = false; break }
        }
        if (ok && len > bestLen) { bestLen = len; best = { x: mx, y: horiz ? my - 9 : my, len: len, rect: { x: lx, y: ly, w: lw, h: lh } } }
      }
      if (best !== null && best.rect !== undefined) placedLabels.push(best.rect)
      return best
    }
    function drawEdge(e, pa, pb, r) {
      var pts = r.pts
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', roundedPath(pts, (r.hint && r.hint.style === 'curve') || e.agg ? 16 : 10))
      path.setAttribute('class', 'edge kind-' + (e.kind || 'reference') + (e.cross_tree ? ' cross' : '') + (e.agg ? ' agg' : ''))
      path.setAttribute('data-from', e.from)
      path.setAttribute('data-to', e.to)
      var tip = pts[pts.length - 1], prev = pts[pts.length - 2] || pa
      var entry = { path: path, arrow: mk, label: null, from: e.from, to: e.to }
      var title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = e.agg
        ? '聚合 ' + e.count + ' 条依赖：\\n' + e.samples.join('\\n')
        : e.from + (e.from_api ? ' [' + e.from_api + ']' : '') + ' -> ' + e.to + (e.to_api ? ' [' + e.to_api + ']' : '') + ' (' + e.kind + ')'
      path.appendChild(title)
      svg.appendChild(path)
      var mk = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      mk.setAttribute('points', arrowPoints(tip, prev))
      mk.setAttribute('class', 'arrow kind-' + (e.kind || 'reference') + (e.cross_tree ? ' cross' : '') + (e.agg ? ' agg' : ''))
      svg.appendChild(mk)
      var text = e.agg ? ('×' + e.count) : (e.label ? L(e.label) : e.kind)
      var budget = labelBudget[text] || 0
      var lp = budget < 2 ? labelPos(pts, text, e.from, e.to) : null
      if (lp) {
        labelBudget[text] = budget + 1
        var t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t.setAttribute('x', lp.x)
        t.setAttribute('y', lp.y)
        t.setAttribute('text-anchor', 'middle')
        t.setAttribute('class', 'edge-label' + (e.agg ? ' agg' : ''))
        t.setAttribute('style', 'paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;')
        t.textContent = text
        svg.appendChild(t)
        entry.label = t
        extend(lp.x - 30, lp.y - 10)
        extend(lp.x + 30, lp.y + 12)
      }
      for (var i = 0; i < pts.length; i++) extend(pts[i].x, pts[i].y)
      commitRoute(pts)
      drawn.push(entry)
    }

    // 先画精确边（API 直连，优先占用干净通道），再画聚合边（虚线、更轻）
    exactEdges.forEach(function (e) {
      var A = byId[e.from], B = byId[e.to]
      if (!A || !B) return
      var pa = portOf(A, e.sides[0], e.from + e.sides[0], e.from_api)
      var pb = portOf(B, e.sides[1], e.to + e.sides[1], e.to_api)
      drawEdge(e, pa, pb, route(e, pa, pb))
    })
    aggEdges.forEach(function (e) {
      var A = byId[e.from], B = byId[e.to]
      if (!A || !B) return
      var pa = portOf(A, e.sides[0], e.from + e.sides[0], null)
      var pb = portOf(B, e.sides[1], e.to + e.sides[1], null)
      drawEdge(e, pa, pb, route(e, pa, pb))
    })

    var nodeGroups = []
    nodes.forEach(function (n) {
      var km = mods[n.id]
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', 'node-g')
      g.setAttribute('data-id', n.id)
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', n.x); rect.setAttribute('y', n.y)
      rect.setAttribute('width', n.w); rect.setAttribute('height', n.h)
      rect.setAttribute('rx', 9)
      rect.setAttribute('data-id', n.id)
      rect.setAttribute('class', 'node' + (children[n.id] ? '' : ' leaf') + (km.state ? ' state-' + km.state : ''))
      g.appendChild(rect)
      var rows = apiRows(n.id)
      var nameH = rows.length > 0 ? 36 : n.h
      var fit = fitName(L(km.name), n.w - 14)
      var lh = fit.fs * 1.28
      var y0 = n.y + nameH / 2 - (fit.lines.length - 1) * lh / 2
      for (var li = 0; li < fit.lines.length; li++) {
        var t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t.setAttribute('x', n.cx)
        t.setAttribute('y', y0 + li * lh)
        t.setAttribute('font-size', fit.fs)
        t.setAttribute('text-anchor', 'middle')
        t.setAttribute('dominant-baseline', 'middle')
        t.setAttribute('class', 'node-name')
        t.textContent = fit.lines[li]
        g.appendChild(t)
      }
      if (rows.length > 0) {
        var sep = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        sep.setAttribute('x1', n.x + 8); sep.setAttribute('x2', n.x + n.w - 8)
        sep.setAttribute('y1', n.y + 36); sep.setAttribute('y2', n.y + 36)
        sep.setAttribute('class', 'api-sep')
        g.appendChild(sep)
        rows.forEach(function (a, ai) {
          var at = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          at.setAttribute('x', n.x + 9)
          at.setAttribute('y', n.y + 36 + ai * 13 + 9)
          at.setAttribute('class', 'api-chip')
          at.textContent = clipText(String(a.key || a.protocol + ':' + a.path), n.w - 24, 9)
          g.appendChild(at)
        })
        var total = (km.apis || []).length
        if (total > rows.length) {
          var more = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          more.setAttribute('x', n.x + n.w - 9)
          more.setAttribute('y', n.y + n.h - 4)
          more.setAttribute('text-anchor', 'end')
          more.setAttribute('class', 'api-more')
          more.textContent = '+' + (total - rows.length)
          g.appendChild(more)
        }
      }
      if (km.state === 'planned' || km.state === 'deprecated') {
        var badge = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        badge.setAttribute('x', n.x + n.w - 6)
        badge.setAttribute('y', n.y + 12)
        badge.setAttribute('text-anchor', 'end')
        badge.setAttribute('class', 'state-badge state-' + km.state)
        badge.textContent = km.state === 'planned' ? (lang === 'zh' ? '计划' : 'planned') : (lang === 'zh' ? '废弃' : 'deprecated')
        g.appendChild(badge)
      }
      g.onclick = function () { goto('#module=' + encodeURIComponent(n.id)) }
      g.onmouseenter = function () {
        showTip(g, km)
        drawn.forEach(function (d) {
          var hit = d.from === n.id || d.to === n.id
          ;[d.path, d.arrow].forEach(function (el2) { el2.classList.toggle('hl', hit); el2.classList.toggle('dim', !hit) })
          if (d.label) d.label.classList.toggle('dim', !hit)
        })
      }
      g.onmouseleave = function () {
        hideTip()
        drawn.forEach(function (d) {
          ;[d.path, d.arrow].forEach(function (el2) { el2.classList.remove('hl'); el2.classList.remove('dim') })
          if (d.label) d.label.classList.remove('dim')
        })
      }
      svg.appendChild(g)
      nodeGroups.push(g)
      extend(n.x, n.y)
      extend(n.x + n.w, n.y + n.h)
    })

    var PADB = 28
    var vbW = Math.max(320, bounds.maxX - bounds.minX + PADB * 2)
    var vbH = Math.max(240, bounds.maxY - bounds.minY + PADB * 2)
    svg.setAttribute('viewBox', (bounds.minX - PADB) + ' ' + (bounds.minY - PADB) + ' ' + vbW + ' ' + vbH)
    svg.setAttribute('width', vbW)
    svg.setAttribute('height', vbH)

    var wrap = el('div', 'diagram-wrap')
    wrap.appendChild(svg)
    main.appendChild(wrap)

    var zoomSteps = [0, 1, 1.5, 2, 3]
    var zi = (vbW > wrap.clientWidth + 20) ? 1 : 0
    var ziLabel = el('span', 'zoom-label')
    function applyZoom() {
      var s = zoomSteps[zi]
      if (s === 0) { svg.style.width = '100%'; svg.style.maxWidth = '100%' } else { svg.style.width = Math.round(vbW * s) + 'px'; svg.style.maxWidth = 'none' }
      svg.style.height = 'auto'
      ziLabel.textContent = s === 0 ? (lang === 'zh' ? '适应' : 'Fit') : Math.round(s * 100) + '%'
    }
    var tools = el('div', 'diagram-tools')
    var minus = el('button', 'zoom-btn', '−')
    minus.onclick = function () { zi = Math.max(0, zi - 1); applyZoom() }
    var fitBtn = el('button', 'zoom-btn', lang === 'zh' ? '适应' : 'Fit')
    fitBtn.onclick = function () { zi = 0; applyZoom() }
    var plus = el('button', 'zoom-btn', '+')
    plus.onclick = function () { zi = Math.min(zoomSteps.length - 1, zi + 1); applyZoom() }
    tools.appendChild(minus); tools.appendChild(fitBtn); tools.appendChild(plus); tools.appendChild(ziLabel)
    if (aggEdges.length > 0) {
      var aggBtn = el('button', 'zoom-btn' + ' agg-toggle', (lang === 'zh' ? '显示跨层聚合 ×' + aggEdges.length : 'Show ' + aggEdges.length + ' cross-level')) 
      aggBtn.onclick = function () {
        var hidden = svg.classList.toggle('hide-agg')
        aggBtn.classList.toggle('on', !hidden)
      }
      if (!/[?&]agg=1/.test(location.search)) svg.classList.add('hide-agg')
      tools.appendChild(aggBtn)
      var aggInfo = el('span', 'hint', lang === 'zh' ? '（虚线 = 跨层聚合 ×N，默认隐藏，可点左侧按钮显示；悬停看明细）' : '(dashed = cross-level aggregate; hidden by default)')
      tools.appendChild(aggInfo)
    }
    main.appendChild(tools)
    applyZoom()

    var bar = el('div', 'legendbar')
    bar.innerHTML = '<span class="hint">连线：</span>'
      + '<span class="chip"><span class="swatch kind-call"></span>call</span>'
      + '<span class="chip"><span class="swatch kind-event"></span>event</span>'
      + '<span class="chip"><span class="swatch kind-dataflow"></span>dataflow</span>'
      + '<span class="chip"><span class="swatch kind-reference"></span>reference</span>'
      + '<span class="chip"><span class="swatch cross"></span>跨树</span>'
      + '<span class="chip"><span class="swatch agg"></span>' + esc(lang === 'zh' ? '跨层聚合' : 'aggregate') + '</span>'
      + '<span class="chip">' + esc(lang === 'zh' ? '悬停模块可高亮其连线；虚线边悬停可看明细' : 'Hover a module to highlight its edges; hover dashed edges for details') + '</span>'
      + '<span class="chip"><span class="swatch" style="border-color: var(--accent); border-top-style: dashed"></span>' + esc(lang === 'zh' ? '计划态' : 'planned') + '</span>'
      + '<span class="chip"><span class="swatch" style="border-color: var(--danger); border-top-style: dotted"></span>' + esc(lang === 'zh' ? '已废弃' : 'deprecated') + '</span>'
    main.appendChild(bar)
  }

  /** 文本截断（保持单行，超长加省略号）。 */
  function clipText(s, maxW, fs) {
    var t = String(s)
    if (estWidth(t, fs) <= maxW) return t
    while (t.length > 1 && estWidth(t + '…', fs) > maxW) t = t.slice(0, -1)
    return t + '…'
  }

  function renderCrossEdges(main, m, kids) {
    var kidsSet = {}
    kids.forEach(function (id) { kidsSet[id] = true })
    var outs = [], ins = []
    kids.forEach(function (id) {
      var km = mods[id]
      ;(km.deps || []).forEach(function (d) {
        if (!kidsSet[d.to]) outs.push({ from: id, dep: d })
      })
      ;(depIn[id] || []).forEach(function (e) {
        if (!kidsSet[e.from]) ins.push({ to: id, edge: e })
      })
    })
    var box = el('div', 'crosslist')
    box.appendChild(el('h3', null, '跨层箭头'))
    if (outs.length === 0 && ins.length === 0) {
      box.appendChild(el('div', 'hint', '本层没有指向外部或来自外部的箭头'))
    }
    outs.forEach(function (o) {
      var row = el('div', 'row')
      row.innerHTML = esc(o.from) + ' → ' + linkTo(o.dep.to)
        + ' <span class="hint">(' + esc(o.dep.kind) + (o.dep.label ? ' · ' + esc(L(o.dep.label)) : '') + ')</span>'
        + (o.dep.cross_tree ? '<span class="badge">跨树</span>' : '')
      box.appendChild(row)
    })
    ins.forEach(function (o) {
      var row = el('div', 'row')
      row.innerHTML = esc(o.to) + ' ← ' + linkTo(o.edge.from)
        + ' <span class="hint">(' + esc(o.edge.kind) + (o.edge.label ? ' · ' + esc(L(o.edge.label)) : '') + ')</span>'
        + (o.edge.cross_tree ? '<span class="badge">跨树</span>' : '')
      box.appendChild(row)
    })
    main.appendChild(box)
  }

  function renderInheritedApis(main, m) {
    var kids = children[m.id] || []
    var total = m.aggregate.own_api_count + m.aggregate.inherited_api_count
    var box = el('div', 'section')
    box.appendChild(el('h2', null, 'API（' + total + '）'))
    if (total === 0) { box.appendChild(el('div', 'hint', '本模块及其子树未定义 API')); main.appendChild(box); return }
    var list = el('ul', 'api-list')
    if (m.apis && m.apis.length > 0) {
      m.apis.forEach(function (a) { list.appendChild(apiItem(a)) })
    }
    box.appendChild(list)
    kids.forEach(function (id) {
      box.appendChild(apiGroup(id, 0))
    })
    main.appendChild(box)
  }

  function apiGroup(id, depth) {
    var km = mods[id]
    var own = (km.apis || []).length
    var below = km.aggregate.inherited_api_count
    var total = own + below
    var det = document.createElement('details')
    det.className = 'api-group'
    if (depth === 0) det.setAttribute('open', '')
    var sum = document.createElement('summary')
    sum.innerHTML = esc(L(km.name)) + ' <span class="cnt">' + esc(id) + ' · ' + total + '</span>'
    det.appendChild(sum)
    var inner = document.createElement('div')
    var ul = document.createElement('ul')
    ul.className = 'api-list'
    ;(km.apis || []).forEach(function (a) { ul.appendChild(apiItem(a)) })
    inner.appendChild(ul)
    var kids = children[id] || []
    kids.forEach(function (cid) { inner.appendChild(apiGroup(cid, depth + 1)) })
    det.appendChild(inner)
    return det
  }

  function apiItem(a) {
    var li = document.createElement('li')
    li.innerHTML = '<span class="key">' + esc(a.key || a.protocol + ':' + a.path) + '</span>'
      + '<span class="desc">' + esc(L(a.description)) + '</span>'
    return li
  }

  function renderLeafDetail(main, m) {
    var box = el('div', 'section')
    box.appendChild(el('h2', null, 'API（' + (m.apis || []).length + '）'))
    if (!m.apis || m.apis.length === 0) box.appendChild(el('div', 'hint', '该叶子模块未定义 API（无接口的功能单元）'))
    else {
      var ul = el('ul', 'api-list')
      m.apis.forEach(function (a) { ul.appendChild(apiItem(a)) })
      box.appendChild(ul)
    }
    var outs = m.deps || []
    box.appendChild(el('h3', null, '出向箭头（' + outs.length + '）'))
    outs.forEach(function (d) {
      var row = el('div', 'row')
      row.innerHTML = '→ ' + linkTo(d.to) + ' <span class="hint">(' + esc(d.kind) + (d.label ? ' · ' + esc(L(d.label)) : '') + ')</span>' + (d.cross_tree ? '<span class="badge">跨树</span>' : '')
      box.appendChild(row)
    })
    var ins = depIn[m.id] || []
    box.appendChild(el('h3', null, '入向箭头（' + ins.length + '）'))
    ins.forEach(function (e) {
      var row = el('div', 'row')
      row.innerHTML = '← ' + linkTo(e.from) + ' <span class="hint">(' + esc(e.kind) + (e.label ? ' · ' + esc(L(e.label)) : '') + ')</span>' + (e.cross_tree ? '<span class="badge">跨树</span>' : '')
      box.appendChild(row)
    })
    main.appendChild(box)
  }

  function renderOutline(main) {
    var box = el('div', 'section')
    box.appendChild(el('h2', null, '大纲（' + roots.length + ' 棵树 · ' + stats.module_count + ' 模块）'))
    var wrap = el('div', 'outline')
    var ul = document.createElement('ul')
    roots.forEach(function (id) { ul.appendChild(outlineItem(id)) })
    wrap.appendChild(ul)
    box.appendChild(wrap)
    main.appendChild(box)
  }

  function outlineItem(id) {
    var m = mods[id]
    var li = document.createElement('li')
    var a = document.createElement('a')
    a.href = '#module=' + encodeURIComponent(id)
    a.textContent = L(m.name) + ' — ' + id
    li.appendChild(a)
    li.appendChild(document.createTextNode(' '))
    var s = document.createElement('span')
    s.className = 'stat'
    s.textContent = '[模块 ' + (m.aggregate.descendant_count + 1) + ' · API ' + (m.aggregate.own_api_count + m.aggregate.inherited_api_count) + ']'
    li.appendChild(s)
    var kids = children[id] || []
    if (kids.length > 0) {
      var ul = document.createElement('ul')
      kids.forEach(function (k) { ul.appendChild(outlineItem(k)) })
      li.appendChild(ul)
    }
    return li
  }

  function renderApis(main) {
    var box = el('div', 'section')
    box.appendChild(el('h2', null, 'API 浏览器（' + Object.keys(apiIndex).length + '）'))
    var input = document.createElement('input')
    input.id = 'apiFilter'
    input.placeholder = '过滤（method / path / protocol）'
    input.style.cssText = 'width:100%;padding:6px 8px;background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:6px;margin-bottom:8px;'
    box.appendChild(input)
    var table = document.createElement('table')
    var keys = Object.keys(apiIndex).sort()
    var MAX = 400
    function draw(filter) {
      table.innerHTML = '<tr><th>API</th><th>归属模块</th></tr>'
      var shown = 0
      for (var i = 0; i < keys.length && shown < MAX; i++) {
        var k = keys[i]
        if (filter && k.toLowerCase().indexOf(filter) === -1 && mods[apiIndex[k]].id.toLowerCase().indexOf(filter) === -1) continue
        var tr = document.createElement('tr')
        var td1 = document.createElement('td')
        var a1 = document.createElement('a')
        a1.href = '#api=' + encodeURIComponent(k)
        a1.textContent = k
        td1.appendChild(a1)
        var td2 = document.createElement('td')
        var a2 = document.createElement('a')
        a2.href = '#module=' + encodeURIComponent(apiIndex[k])
        a2.textContent = apiIndex[k]
        td2.appendChild(a2)
        tr.appendChild(td1); tr.appendChild(td2)
        table.appendChild(tr)
        shown++
      }
      if (shown >= MAX) {
        var tr = document.createElement('tr')
        var td = document.createElement('td')
        td.colSpan = 2
        td.className = 'hint'
        td.textContent = '已显示前 ' + MAX + ' 条，请用过滤缩小范围'
        tr.appendChild(td)
        table.appendChild(tr)
      }
    }
    draw('')
    input.oninput = function () { draw(input.value.trim().toLowerCase()) }
    box.appendChild(table)
    main.appendChild(box)
  }

  function highlightApi() {
    var key = current.apiKey
    var nodes = document.querySelectorAll('.key')
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].textContent === key) {
        nodes[i].scrollIntoView({ block: 'center' })
        nodes[i].style.outline = '2px solid var(--accent)'
      }
    }
  }

  function linkTo(id) {
    return '<a href="#module=' + encodeURIComponent(id) + '">' + esc(id) + '</a>'
  }
  function oneLine(s, max) { var l = (s || '').split('\\n')[0]; return l.length > max ? l.slice(0, max) + '…' : l }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d }

  var tip = document.getElementById('tooltip')
  var tipTimer = null
  function showTip(anchor, m) {
    tipTimer = setTimeout(function () {
      tip.innerHTML = '<div class="t-name">' + esc(L(m.name)) + ' <span class="hint">' + esc(m.id) + '</span></div>'
        + '<div class="t-desc">' + esc(L(m.description)) + '</div>'
        + '<div class="t-meta">' + (m.state ? (m.state === 'planned' ? '计划态 · ' : m.state === 'deprecated' ? '已废弃 · ' : '') : '') + '模块 ' + (m.aggregate.descendant_count + 1) + ' · API ' + (m.aggregate.own_api_count + m.aggregate.inherited_api_count) + '</div>'
      tip.style.display = 'block'
    }, 250)
    document.addEventListener('mousemove', moveTip)
    var r = anchor.getBoundingClientRect()
    moveTip({ clientX: r.right + 8, clientY: r.top })
  }
  function moveTip(e) {
    var pad = 12
    var w = tip.offsetWidth || 280
    var x = Math.min(e.clientX + pad, window.innerWidth - w - 8)
    var y = e.clientY + pad
    if (y + 120 > window.innerHeight) y = e.clientY - 140
    tip.style.left = x + 'px'
    tip.style.top = y + 'px'
  }
  function hideTip() {
    clearTimeout(tipTimer)
    tip.style.display = 'none'
    document.removeEventListener('mousemove', moveTip)
  }

  var input = document.getElementById('searchInput')
  var drop = document.getElementById('searchDrop')
  var searchTimer = null
  input.addEventListener('input', function () {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () {
      var q = input.value.trim().toLowerCase()
      drop.innerHTML = ''
      if (!q) { drop.classList.remove('open'); return }
      var hits = []
      for (var i = 0; i < corpus.length && hits.length < 20; i++) {
        if (corpus[i].text.indexOf(q) >= 0) hits.push(corpus[i])
      }
      hits.forEach(function (h) {
        var item = el('div', 'item')
        if (h.kind === 'module') {
          item.innerHTML = esc(h.id) + '<div class="sub">模块</div>'
          item.onclick = function () { input.value = ''; drop.classList.remove('open'); goto('#module=' + encodeURIComponent(h.id)) }
        } else {
          item.innerHTML = esc(h.id) + '<div class="sub">API · ' + esc(h.moduleId) + '</div>'
          item.onclick = function () { input.value = ''; drop.classList.remove('open'); goto('#api=' + encodeURIComponent(h.id)) }
        }
        drop.appendChild(item)
      })
      drop.classList.add('open')
    }, 150)
  })
  document.addEventListener('click', function (e) {
    if (e.target !== input && e.target !== drop) drop.classList.remove('open')
  })

  document.getElementById('btnLang').addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh'
    try { localStorage.setItem('normify-lang', lang) } catch (e) {}
    render()
  })
  document.getElementById('btnTheme').addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', t)
    try { localStorage.setItem('normify-theme', t) } catch (e) {}
  })
  document.getElementById('btnOutline').addEventListener('click', function () { goto('#view=outline') })
  document.getElementById('btnApis').addEventListener('click', function () { goto('#view=apis') })
  window.addEventListener('hashchange', function () { current = parseHash(); render() })

  initTheme()
  render()
})()
<\/script>
</body>
</html>
`;
}
//#endregion
//#region src/engine/render.ts
/** 读取 tree.json → 注入查看器模板 → 输出单文件 HTML。 */
async function renderProject(projectDir, opts) {
	const errors = [];
	const warnings = [];
	const outPath = resolveOutputPath(projectDir, opts.out);
	if (!outPath.ok) return {
		ok: false,
		htmlPath: null,
		bytes: 0,
		sha256: null,
		summary: null,
		errors: [diag("error", "render/out-escape", "输出路径不合法：" + outPath.reason, { out: opts.out ?? "" }, {}, ["out 只接受结构数据目录下的相对文件名，如 normify.html 或 reports/arch.html"])],
		warnings
	};
	let treeText;
	try {
		treeText = await readFile(join(projectDir, "tree.json"), "utf8");
	} catch {
		return {
			ok: false,
			htmlPath: null,
			bytes: 0,
			sha256: null,
			summary: null,
			errors: [diag("error", "render/no-build", "缺少 tree.json 编译产物", {}, {}, ["先运行 normify_build"])],
			warnings
		};
	}
	let tree;
	try {
		tree = JSON.parse(treeText);
	} catch (error) {
		return {
			ok: false,
			htmlPath: null,
			bytes: 0,
			sha256: null,
			summary: null,
			errors: [diag("error", "render/bad-tree", "tree.json 解析失败：" + String(error), {}, {}, ["重新运行 normify_build"])],
			warnings
		};
	}
	const project = tree.project ?? {};
	const stats = project.stats ?? {};
	const name = typeof project.name === "string" ? project.name : "project";
	const summary = {
		name,
		stats,
		compiledAt: typeof project.compiled_at === "string" ? project.compiled_at : "",
		treeSha12: sha256Text(treeText).slice(0, 12),
		lang: opts.lang ?? "",
		theme: opts.theme ?? ""
	};
	const html = renderTemplate(treeText, {
		name,
		stats,
		compiledAt: summary.compiledAt,
		treeSha12: summary.treeSha12
	});
	const out = outPath.path;
	try {
		await writeFileAtomic(out, html);
	} catch (error) {
		return {
			ok: false,
			htmlPath: null,
			bytes: 0,
			sha256: null,
			summary,
			errors: [diag("error", "render/write-failed", "HTML 写入失败：" + String(error), { out }, {}, [])],
			warnings
		};
	}
	return {
		ok: true,
		htmlPath: out,
		bytes: Buffer.byteLength(html, "utf8"),
		sha256: sha256Text(html),
		summary,
		errors,
		warnings
	};
}
//#endregion
//#region src/engine/companion.ts
/**
* 关闭开发变更（伴随开发收尾）：刷新指纹/激活 planned → validate（0 error 强制）→ build（可选 render）
* → 标记 verified 并记录 revision.after。任何一步失败都不关闭，变更保持原状态。
*/
async function closeChange(projectDir, id, opts) {
	const { change, error } = await loadChangeFile(projectDir, id);
	if (error !== null) return {
		ok: false,
		phase: "load",
		errors: [error],
		warnings: []
	};
	if (change === null) return {
		ok: false,
		phase: "load",
		errors: [diag("error", "change/not-found", "变更不存在：" + id, { change: id }, {}, [])],
		warnings: []
	};
	if (change.status === "verified") return {
		ok: false,
		phase: "load",
		errors: [diag("error", "change/closed", "变更已关闭：" + id, { change: id }, {}, [])],
		warnings: []
	};
	if (change.status === "abandoned") return {
		ok: false,
		phase: "load",
		errors: [diag("error", "change/abandoned", "变更已放弃，不能再关闭：" + id, { change: id }, {}, [])],
		warnings: []
	};
	const repoRoot = opts.repoRoot !== void 0 && opts.repoRoot.trim() !== "" ? opts.repoRoot : void 0;
	let refresh = null;
	if (repoRoot !== void 0) {
		const targets = [...new Set([...change.modules.create ?? [], ...change.modules.modify ?? []])];
		if (targets.length > 0) {
			const rr = await refreshModules(projectDir, {
				ids: targets,
				repoRoot,
				activate: opts.activate !== false
			});
			if (!rr.ok) return {
				ok: false,
				phase: "refresh",
				errors: rr.errors,
				warnings: rr.warnings,
				change,
				hint: "先修正 refresh 报错（源码落地/路径/指纹），再关闭变更。"
			};
			refresh = {
				refreshed: rr.refreshed,
				missing: rr.missing
			};
		}
	}
	if (repoRoot !== void 0) {
		const after = (await loadAllModules(projectDir)).files;
		const notDone = (change.modules.create ?? []).filter((id) => {
			const hit = after.find((f) => f.module.id === id);
			return hit !== void 0 && (hit.module.state ?? "active") === "planned";
		});
		if (notDone.length > 0) return {
			ok: false,
			phase: "landing",
			errors: [diag("error", "change/create-not-landed", "变更 create 清单中仍有 planned 模块：" + notDone.join(", "), { change: change.id }, { modules: notDone }, ["实现 source 后用 normify_module_refresh({ ids, activate: true }) 落地"])],
			warnings: [],
			change,
			hint: "close 要求 create 模块全部落地（0 error 强制）。"
		};
	}
	const v = await validateProject(projectDir, {
		repoRoot,
		requireBilingual: opts.requireBilingual
	});
	if (!v.ok) return {
		ok: false,
		phase: "validate",
		errors: v.errors,
		warnings: v.warnings,
		change,
		message: "close 被拒绝：必须 0 error（0 error 强制）",
		hint: "按 supportedFixes 修复后重试；变更保持 " + change.status + "。"
	};
	const b = await buildProject(projectDir, {
		repoRoot,
		requireBilingual: opts.requireBilingual
	});
	if (!b.ok) return {
		ok: false,
		phase: "build",
		errors: b.errors,
		warnings: v.warnings,
		change
	};
	let render = null;
	if (opts.render === true) {
		const r = await renderProject(projectDir, {});
		if (!r.ok) return {
			ok: false,
			phase: "render",
			errors: r.errors,
			warnings: v.warnings,
			change
		};
		render = {
			html: r.htmlPath,
			bytes: r.bytes,
			sha256: r.sha256
		};
	}
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const head = repoRoot !== void 0 ? gitHead(repoRoot) : { sha: null };
	const r = l1ValidateChange({
		...change,
		status: "verified",
		closed_at: now,
		updated_at: now,
		revision: {
			before: change.revision.before ?? null,
			after: head.sha ?? change.revision.after ?? null
		},
		...opts.note !== void 0 && opts.note !== "" ? { note: (change.note !== void 0 && change.note !== "" ? change.note + "\n" : "") + opts.note } : {}
	}, change.id, "close:" + change.id);
	if (r.change === null) return {
		ok: false,
		phase: "change-write",
		errors: r.errors,
		warnings: r.warnings,
		change
	};
	const file = await writeChangeFile(projectDir, r.change);
	const rebuilt = await buildProject(projectDir, {
		repoRoot,
		requireBilingual: opts.requireBilingual
	});
	if (!rebuilt.ok) return {
		ok: false,
		phase: "rebuild",
		errors: rebuilt.errors,
		warnings: rebuilt.warnings,
		change: r.change
	};
	return {
		ok: true,
		phase: "verified",
		errors: [],
		warnings: v.warnings,
		change: r.change,
		file,
		refresh,
		build: rebuilt.receipt?.stats ?? b.receipt?.stats ?? null,
		render,
		revision: r.change.revision,
		hint: "变更已关闭并冻结。继续下一个变更：normify_change_open。"
	};
}
//#endregion
//#region src/engine/reference.ts
/**
* normify_help 的分主题参考文本（0.5.3 新增）：
* 0.5.2 及以前 normify_help 只有一份固定速查、且完全忽略入参；实测中 AI 为了拿到
* change_open / layout_upsert / change_close 的准确参数名，只能去读插件源码。
* 现在按主题返回，未知主题会直接报错并列出可用主题（不再静默忽略）。
*/
const HELP_TOPICS = [
	"fields",
	"deps",
	"renders",
	"flow",
	"tools",
	"policy",
	"errors",
	"all"
];
const DEPS_REFERENCE = [
	"deps（出向箭头，只存源端）条目：",
	"  { kind: " + DEP_KINDS.join(" | ") + ", to: 目标模块 id（可跨树）, from_api?, to_api?, label?{zh,en} }",
	"**API 直连（0.5.3 强调）**：两端都声明了 API 时，请补 from_api / to_api —— 箭头才会钉在具体 API 行上；",
	"  不锚定则箭头只能落在框边，层级越深越看不清\"谁调用了谁的哪个接口\"。",
	"  · from_api 只能是**本模块** apis 里的键；to_api 只能是**目标模块自身** apis 里的键。",
	"  · API 键形式：http 为 \"METHOD path\"（如 GET /api/boards/:id）；其它 protocol 为 \"protocol:path\"。",
	"  · L2 validate 会给出聚合 warning `dep/unanchored`（列出可锚定却未锚定的箭头总数与前几条示例）。",
	"  · 未接箭头的 API 完全合法，不要为了消 warning 删 API。"
].join("\n");
const RENDERS_REFERENCE = [
	"渲染数据（renders/<id 点号换斜杠>.json，只有容器模块需要）：用 normify_layout_upsert 写，字段：",
	"  · mode: auto | layers | groups | grid（默认 auto：有 groups 用 groups，兄弟边多走 layers，否则 grid）",
	"  · max_columns: 1..6（grid / layers 模式的列数）",
	"  · max_api_rows: 0..48，**0 = 全部展开（缺省即 0）**；叶子 API 默认一行不折叠",
	"  · reading{zh,en}: 本层阅读导语（图上方显示，说明阅读顺序与分组逻辑）——建议每层都写",
	"  · order[]: 直接子模块的阅读顺序（建议覆盖全部子模块；未列出的按启发式追加并记 warning）",
	"  · groups[{id,title{zh,en},children[]}]: 分组（子模块不能重复分组；mode=groups 时至少要有一组）",
	"  · edge_hints[{from,to,kind?,lane?,style?,bundle?,priority?}]: 兄弟边的车道/样式/捆扎提示；from/to 必须是直接子模块且该兄弟边真实存在",
	"写入时机：骨架阶段就写第一版（order + reading 为主），实现过程中按实际复杂度复核。"
].join("\n");
const FLOW_REFERENCE = [
	"伴随开发主流程（先建图、后编码；每一步都可单独调用）：",
	"0) normify_project_init            初始化结构数据目录 + 默认架构规则（可选一步建\"计划态根模块\"）",
	"1) normify_change_open             开变更：意图 + 涉及模块(create/modify) + 验收标准(≥1)；写工具会自动建项目目录",
	"2) normify_brief / normify_check   开发指引与设计预检（写代码前先跑，暴露缺模块/违规依赖）",
	"3) normify_module_batch            state=planned + fingerprint=pending 建**计划态**骨架（原子；叶子必须先声明 apis 契约）",
	"4) normify_layout_upsert           每个容器一层渲染数据（order + reading 起步）",
	"5) 实现代码（逐模块/逐波次）",
	"6) normify_module_refresh          ids=[...] + activate=true：落地模块转 active、重算 fingerprint/revision",
	"7) normify_validate                全项目 L2（要求 0 error；warning 尽量清零）",
	"8) normify_build → normify_render  冻结回执 + 单文件交互式 HTML",
	"9) normify_change_close            收尾（0 error 强制）：刷新 → 校验 → 编译 → 标记 verified",
	"常见坑：change_open 只接受**已存在**的模块 id；计划态叶子也要写 apis（可为 []）；批量写入是原子的，",
	"  一条 L1 失败会整批不落盘，连带错误用 dep/target-dropped 指出根因。"
].join("\n");
const ERRORS_REFERENCE = [
	"常见诊断码与修法（节选，完整表见 skills/normify-gen/SKILL.md）：",
	"  structure/uid-format             uid 必须是 8 位小写 hex（不要用 slug 派生）",
	"  structure/id-format              id 为小写点分路径，段名 ^[a-z][a-z0-9-]*$，深度不限",
	"  structure/parent-mismatch        parent 必须等于 id 去掉最后一段；根模块 parent=null",
	"  structure/label-too-long         name/description/label 的 zh ≤ 30 / en ≤ 30（description ≤ 500）",
	"  structure/fingerprint-invalid    fingerprint 用 normify_fingerprint 重算；planned 或空 source 才能填 pending",
	"  api/non-leaf                     只有叶子能声明 apis；容器/根要把 API 下放到叶子（晋升时会自动摘除并 warning）",
	"  api/leaf-missing                 叶子必须写 apis（可为空数组，会记 warning）",
	"  dep/target-missing               箭头 to 不存在（且**不是**因本批 L1 失败被丢弃）",
	"  dep/target-dropped               箭头 to 因本批 L1 失败被移出批次：根因见 evidence.root_cause_code（0.5.3）",
	"  dep/from-api-invalid             from_api 不在本模块 apis 里；to_api 同理必须在目标模块 apis 里",
	"  dep/unanchored                   两端都有 API 却未锚定：补 from_api/to_api（0.5.3，warning）",
	"  layout/order-child               order 只能列直接子模块 id（move 之后由工具自动重写）",
	"  layout/id-mismatch               渲染数据的 id 必须等于对应模块 id",
	"  evidence/source-missing          source 指向的文件在仓库里不存在（路径相对 repoRoot）",
	"  evidence/fingerprint-drift       结构数据过期：改完代码跑 normify_module_refresh 或 normify_change_close"
].join("\n");
function topicReference(topic, catalog = []) {
	switch (topic) {
		case "fields": return {
			title: "模块字段速查",
			text: fieldReference()
		};
		case "deps": return {
			title: "依赖箭头与 API 直连",
			text: DEPS_REFERENCE
		};
		case "renders": return {
			title: "渲染数据字段",
			text: RENDERS_REFERENCE
		};
		case "flow": return {
			title: "伴随开发主流程",
			text: FLOW_REFERENCE
		};
		case "policy": return {
			title: "架构规则 policy.yml",
			text: policyReference()
		};
		case "errors": return {
			title: "常见诊断码与修法",
			text: ERRORS_REFERENCE
		};
		case "tools": return {
			title: "工具清单（" + catalog.length + " 个）",
			text: [
				catalog.map((t) => {
					const schema = t.parameters ?? {};
					const req = Array.isArray(schema.required) ? schema.required : [];
					const props = Object.keys(schema.properties ?? {});
					const opt = props.filter((x) => !req.includes(x));
					return t.name + " [" + t.behavior + "] " + t.description + (props.length > 0 ? "\n      必填: " + (req.length > 0 ? req.join(", ") : "（无）") + " | 可选: " + (opt.length > 0 ? opt.join(", ") : "（无）") : "");
				}).join("\n"),
				"",
				"想看某个工具的完整参数树（类型/描述/必填）：normify_help { topic: \"tool:<工具名>\" }，例如 \"tool:normify_module_batch\"。"
			].join("\n")
		};
		case "all": return {
			title: "全部参考",
			text: [
				"=== fields ===",
				fieldReference(),
				"",
				"=== deps ===",
				DEPS_REFERENCE,
				"",
				"=== renders ===",
				RENDERS_REFERENCE,
				"",
				"=== flow ===",
				FLOW_REFERENCE,
				"",
				"=== policy ===",
				policyReference(),
				"",
				"=== errors ===",
				ERRORS_REFERENCE,
				"",
				"=== tools ===",
				topicReference("tools", catalog).text
			].join("\n")
		};
	}
}
/** 单个工具的完整参数树（help 的 `tool:<name>` 主题）。 */
function toolReference(entry) {
	if (entry === void 0) return {
		title: "未知工具",
		text: ""
	};
	const schema = entry.parameters ?? {};
	const props = schema.properties ?? {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const lines = [
		entry.name + "  [" + entry.behavior + "]",
		entry.description,
		"",
		"参数（* = 必填）："
	];
	const keys = Object.keys(props);
	if (keys.length === 0) lines.push("  （无参数）");
	for (const k of keys) {
		const prop = props[k] ?? {};
		lines.push("  " + (required.has(k) ? "* " : "  ") + k + ": " + (prop.type ?? "any") + (prop.description !== void 0 ? " — " + prop.description : ""));
	}
	lines.push("", "提示：参数树由插件注册表实时生成，与运行时校验同源。");
	return {
		title: entry.name + " 参数树",
		text: lines.join("\n")
	};
}
//#endregion
//#region src/tools.ts
function str(description) {
	return {
		type: "string",
		description,
		required: true
	};
}
function strOpt(description) {
	return {
		type: "string",
		description,
		required: false
	};
}
function numOpt(description) {
	return {
		type: "number",
		description,
		required: false
	};
}
function boolOpt(description) {
	return {
		type: "boolean",
		description,
		required: false
	};
}
/**
* 把作者态 schema（属性内联 `required: true`，方便手写）编译为标准 JSON Schema：
* 属性级 required 提升为对象级 `required: string[]`，对象补 `additionalProperties: false`。
* dsh 0.1.5+ 会把工具 parameters 原样交给模型/provider，必须是规范 JSON Schema
*（`required: true` 不是合法关键字）。
*/
function toJsonSchema(node) {
	if (Array.isArray(node)) return node.map((entry) => toJsonSchema(entry));
	if (node === null || typeof node !== "object") return node;
	const source = node;
	const out = {};
	const required = [];
	let hasProperties = false;
	for (const [key, value] of Object.entries(source)) {
		if (key === "required") {
			if (Array.isArray(value)) {
				for (const entry of value) if (typeof entry === "string" && !required.includes(entry)) required.push(entry);
			}
			continue;
		}
		if (key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
			hasProperties = true;
			const properties = {};
			for (const [propKey, propValue] of Object.entries(value)) {
				const prop = propValue;
				if (prop !== null && typeof prop === "object" && prop.required === true) required.push(propKey);
				properties[propKey] = toJsonSchema(propValue);
			}
			out.properties = properties;
			continue;
		}
		out[key] = toJsonSchema(value);
	}
	if (hasProperties) {
		out.additionalProperties = false;
		if (required.length > 0) out.required = required;
	}
	return out;
}
function params(props, _required = []) {
	return toJsonSchema({
		type: "object",
		properties: props
	});
}
function l10nParam(description) {
	return {
		type: "object",
		description,
		required: true,
		properties: {
			zh: {
				type: "string",
				description: "中文",
				required: true
			},
			en: {
				type: "string",
				description: "English",
				required: true
			}
		}
	};
}
function sourceParam() {
	return {
		type: "array",
		description: "代码位置证据：仓库内相对路径 + 可选行号",
		required: true,
		items: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "repo 相对 POSIX 路径",
					required: true
				},
				line: {
					type: "number",
					description: "起始行",
					required: false
				},
				end_line: {
					type: "number",
					description: "结束行",
					required: false
				}
			},
			required: ["path"]
		}
	};
}
function apiParam() {
	return {
		type: "array",
		description: "本模块全部 API（仅叶子模块允许；protocol: " + PROTOCOLS.join("|") + "；http 必须带大写 method）",
		required: false,
		items: {
			type: "object",
			properties: {
				protocol: {
					type: "string",
					description: "协议",
					required: true
				},
				method: {
					type: "string",
					description: "仅 http：大写 METHOD",
					required: false
				},
				path: {
					type: "string",
					description: "URL 路径或 topic/队列/表名",
					required: true
				},
				description: l10nParam("API 功能简介")
			},
			required: [
				"protocol",
				"path",
				"description"
			]
		}
	};
}
function depParam() {
	return {
		type: "array",
		description: "出向依赖箭头（只存源端；kind: " + DEP_KINDS.join("|") + "；to 为目标模块 id，可跨树）",
		required: false,
		items: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					description: "箭头类型",
					required: true
				},
				to: {
					type: "string",
					description: "目标模块 id",
					required: true
				},
				from_api: {
					type: "string",
					description: "可选：本模块某 API 键（仅叶子）",
					required: false
				},
				to_api: {
					type: "string",
					description: "可选：目标模块自身某 API 键",
					required: false
				},
				label: l10nParam("箭头标签")
			},
			required: ["kind", "to"]
		}
	};
}
function l10nOptParam(description) {
	return {
		type: "object",
		description,
		required: false,
		properties: {
			zh: {
				type: "string",
				description: "中文",
				required: true
			},
			en: {
				type: "string",
				description: "English",
				required: true
			}
		}
	};
}
function layoutGroupParam() {
	return {
		type: "array",
		description: "视觉分组：把直接子模块按语义聚类渲染（mode=groups 时必填）",
		required: false,
		items: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "分组 id（文件内唯一）",
					required: true
				},
				title: l10nParam("分组标题"),
				children: {
					type: "array",
					description: "属于该组的直接子模块 id",
					required: true,
					items: {
						type: "string",
						description: "子模块 id",
						required: true
					}
				}
			},
			required: [
				"id",
				"title",
				"children"
			]
		}
	};
}
function layoutHintParam() {
	return {
		type: "array",
		description: "单条边的绘制提示（可选）：车道 / 曲线样式 / 捆扎",
		required: false,
		items: {
			type: "object",
			properties: {
				from: {
					type: "string",
					description: "源子模块 id",
					required: true
				},
				to: {
					type: "string",
					description: "目标子模块 id",
					required: true
				},
				kind: {
					type: "string",
					description: "仅当同点多边时区分：" + DEP_KINDS.join("|"),
					required: false
				},
				lane: {
					type: "number",
					description: "车道序号 0..9（越大越靠外）",
					required: false
				},
				style: {
					type: "string",
					description: "orthogonal | curve",
					required: false
				},
				bundle: {
					type: "string",
					description: "捆扎 id：同 bundle 的边共道",
					required: false
				},
				priority: {
					type: "number",
					description: "绘制优先级（越大越先画）",
					required: false
				}
			},
			required: ["from", "to"]
		}
	};
}
function strArrayOpt(description) {
	return {
		type: "array",
		description,
		required: false,
		items: {
			type: "string",
			description: "条目",
			required: true
		}
	};
}
function strArray(description) {
	return {
		type: "array",
		description,
		required: true,
		items: {
			type: "string",
			description: "条目",
			required: true
		}
	};
}
function objArrayParam(description, required = false) {
	return {
		type: "array",
		description,
		required,
		items: {
			type: "object",
			description: "对象条目"
		}
	};
}
function freeObjectParam(description, required = false) {
	return {
		type: "object",
		description,
		required
	};
}
/** frontmatter 的字段 schema：保持"作者态"（属性内联 required），
*  由外层 params() 统一编译，避免二次编译丢掉必填表。 */
function moduleParams() {
	return {
		type: "object",
		description: "模块 frontmatter（写时执行 L1 校验）",
		required: true,
		properties: {
			uid: str("8 位小写 hex 随机串（不变标识，全项目唯一）"),
			id: str("路径式 id：小写段点分隔，含树名段 ≤ 12 段，如 demo.order.checkout.payment"),
			parent: str("父模块 id（= id 去掉最后一段）；根模块传 JSON null 或字符串 \"null\""),
			name: l10nParam("模块名（≤60 字符）"),
			description: l10nParam("功能介绍（≤500 字符，刻意精炼）"),
			source: sourceParam(),
			revision: str("生成时对应的 40 位 git SHA"),
			updated_at: str("ISO 8601 时间，如 2026-08-30T12:00:00Z"),
			fingerprint: str("source 指纹（hex；planned 模块可填 pending）"),
			repository: strOpt("仅根模块：仓库 URL"),
			state: strOpt("生命周期状态：active | planned | deprecated（默认 active；计划态先建树、后实现）"),
			replacement: strOpt("仅 state=deprecated：替代模块 id"),
			tags: strArrayOpt("自由标签（≤12 个，用于检索/分组）"),
			apis: apiParam(),
			deps: depParam()
		}
	};
}
/** 项目定位参数（属性映射，供 `params({ ...projectParams() })` 展开）。 */
function projectParams(_required = false) {
	return {
		project: strOpt("项目 slug（结构数据目录 = normify-<slug>）；也可以直接传结构数据目录绝对路径"),
		dir: strOpt("结构数据目录绝对路径（与 project 二选一）")
	};
}
function toErrorPayload(error) {
	if (error instanceof NormifyError) return {
		ok: false,
		error: {
			code: error.code,
			message: error.message
		}
	};
	if (error instanceof Error) return {
		ok: false,
		error: {
			code: "internal",
			message: error.message
		}
	};
	return {
		ok: false,
		error: {
			code: "internal",
			message: String(error)
		}
	};
}
function diagnosticsOut(errors, warnings) {
	return {
		ok: errors.length === 0,
		errors: errors.map(fmtDiag),
		warnings: warnings.map(fmtDiag),
		summary: errors.length + " error / " + warnings.length + " warning"
	};
}
/**
* 构建工具注册表（宿主无关）：把 30 个 normify_* 工具的「名称 / 描述 / JSON Schema / 执行器」
* 一次性产出为 `ToolSpec[]`，由 MCP server、CLI 或任何宿主按自己的协议暴露出去。
*
* 每个执行器内部已做两件事：必填参数校验（`parent` 允许显式 null）与异常兜底，
* 因此宿主调用 `execute()` 永远不会抛异常——失败统一返回 `{ ok:false, error:{ code, message } }`。
*/
function buildToolRegistry(env) {
	const toolCatalog = [];
	const specs = [];
	const register = (key, def, execute) => {
		const behavior = def.behavior;
		const parameters = def.parameters;
		toolCatalog.push({
			name: key,
			description: def.description,
			behavior,
			parameters
		});
		const wrapped = async (rawArgs) => {
			try {
				const checked = validateArgs(parameters, rawArgs);
				if (!checked.ok) return {
					ok: false,
					error: {
						code: checked.code,
						message: checked.message
					}
				};
				const args = checked.args;
				const missing = (def.parameters?.required ?? []).filter((r) => {
					const value = args[r];
					if (value === void 0 || value === "") return true;
					if (value === null) return r !== "parent";
					return false;
				});
				if (missing.length > 0) return {
					ok: false,
					error: {
						code: "args/missing",
						message: "缺少必填参数: " + missing.join(", ")
					}
				};
				return await execute(args);
			} catch (error) {
				return toErrorPayload(error);
			}
		};
		specs.push({
			name: key,
			description: def.description,
			behavior,
			...parameters !== void 0 ? { parameters } : {},
			execute: wrapped
		});
	};
	const resolve = (args, create = false) => resolveProject(env.rootDir, {
		project: args.project,
		dir: args.dir
	}, { create });
	register("normify_tree_list", {
		description: "列出全部结构数据项目（normify-* 目录，含每棵树的根与仓库）。",
		behavior: "read",
		parameters: params({ root: strOpt("搜索根目录（默认插件配置的 rootDir，可传工作区绝对路径）") })
	}, async (args) => {
		const projects = listProjects(typeof args.root === "string" && args.root.trim() !== "" ? args.root : env.rootDir);
		const out = [];
		for (const p of projects) {
			const roots = (await loadAllModules(p.dir)).files.filter((f) => f.module.parent === null);
			out.push({
				slug: p.slug,
				dir: p.dir,
				trees: roots.map((r) => ({
					tree_id: r.module.id,
					root_uid: r.module.uid,
					repository: r.module.repository ?? null
				}))
			});
		}
		return {
			ok: true,
			rootDir: env.rootDir,
			projects: out
		};
	});
	register("normify_module_get", {
		description: "读取单个模块（frontmatter 字段 + 正文）。",
		behavior: "read",
		parameters: params({
			id: str("模块 id 或 uid"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const files = (await loadAllModules((await resolve(args)).dir)).files;
		const mf = files.find((f) => f.module.id === args.id || f.module.uid === args.id);
		if (mf === void 0) return {
			ok: false,
			error: {
				code: "module/not-found",
				message: "模块不存在：" + String(args.id)
			}
		};
		const kids = files.filter((f) => f.module.parent === mf.module.id).map((f) => f.module.id).sort(byCodeUnit);
		return {
			ok: true,
			module: mf.module,
			children: kids,
			file: mf.file,
			body: mf.body
		};
	});
	register("normify_module_list", {
		description: "列出模块（可按父模块/树过滤），含每个模块的统计。",
		behavior: "read",
		parameters: params({
			parent: strOpt("父模块 id 或树名（默认全部）"),
			direct_only: boolOpt("只列 parent 的直接子模块（默认 false：含整个子树）"),
			...projectParams(true)
		}, [])
	}, async (args) => {
		const proj = await resolve(args);
		const files = (await loadAllModules(proj.dir)).files;
		const kids = /* @__PURE__ */ new Map();
		for (const f of files) {
			if (f.module.parent === null) continue;
			const list = kids.get(f.module.parent) ?? [];
			list.push(f.module.id);
			kids.set(f.module.parent, list);
		}
		const layoutIds = new Set((await listLayoutFiles(proj.dir)).map((rel) => rel.replace(/^renders\//, "").replace(/\.json$/, "").replace(/\//g, ".")));
		const filter = args.parent;
		const directOnly = args.direct_only === true;
		const rows = files.filter((f) => directOnly ? filter === void 0 || filter === "" || f.module.parent === filter : filter === void 0 || filter === "" || f.module.parent === filter || f.module.id === filter || f.module.id.startsWith(filter + ".")).sort((a, b) => a.module.id.localeCompare(b.module.id)).map((f) => ({
			id: f.module.id,
			uid: f.module.uid,
			parent: f.module.parent,
			name: f.module.name,
			is_leaf: !kids.has(f.module.id),
			children_count: (kids.get(f.module.id) ?? []).length,
			has_layout: layoutIds.has(f.module.id),
			api_count: f.module.apis?.length ?? 0,
			dep_count: f.module.deps?.length ?? 0
		}));
		return {
			ok: true,
			count: rows.length,
			modules: rows
		};
	});
	register("normify_project_init", {
		description: "初始化结构数据项目（幂等，写工具）：创建 normify-<slug>/ 目录并安装默认架构规则；可选用 root 一步创建\"计划态根模块\"（state=planned、fingerprint=pending、source 待落地）。之后即可 change_open / brief / 建子树。",
		behavior: "write",
		parameters: params({
			root: freeObjectParam("可选：一步创建计划态根模块 {id, name{zh,en}, description{zh,en}, repository?}；省略则只建目录与规则", false),
			...projectParams(true)
		})
	}, async (args) => {
		const proj = await resolve(args, true);
		const before = (await loadAllModules(proj.dir)).files;
		const ruleCount = (await loadPolicyFile(proj.dir)).policy?.rules?.length ?? 0;
		let rootId = null;
		const rootArgs = args.root;
		if (rootArgs !== void 0 && rootArgs !== null) {
			const id = typeof rootArgs.id === "string" ? rootArgs.id.trim() : "";
			if (!isValidId(id) || splitId(id).length !== 1) return {
				ok: false,
				error: {
					code: "structure/id-format",
					message: "根模块 id 必须是单段合法 id（如 whiteboard），实际：" + id
				}
			};
			if (before.some((f) => f.module.id === id)) rootId = id;
			else {
				const r = l1Validate({
					uid: randomBytes(4).toString("hex"),
					id,
					parent: null,
					name: rootArgs.name,
					description: rootArgs.description,
					source: [],
					revision: "0".repeat(40),
					updated_at: (/* @__PURE__ */ new Date()).toISOString(),
					fingerprint: "pending",
					state: "planned",
					...typeof rootArgs.repository === "string" && rootArgs.repository.trim() !== "" ? { repository: rootArgs.repository.trim() } : {}
				}, "project.init/root");
				if (r.module === null) return {
					ok: false,
					errors: r.errors.map(fmtDiag),
					summary: r.errors.length + " error（未写入）",
					hint: "root 需要 {id, name:{zh,en}, description:{zh,en}}；根模块 parent 固定为 null。"
				};
				await writeModuleFile(proj.dir, r.module, "");
				rootId = r.module.id;
			}
		}
		return {
			ok: true,
			dir: proj.dir,
			slug: proj.slug,
			created: before.length === 0,
			modules_before: before.length,
			policy_rules: ruleCount,
			root_module: rootId,
			next_steps: [
				"normify_change_open：开一个变更（意图 + 涉及模块 + 验收标准）",
				"normify_brief / normify_check：拿开发指引、做设计预检",
				"normify_module_batch：state=planned + fingerprint=pending 建计划态骨架（叶子先声明 apis 契约）",
				"normify_layout_upsert：每个容器写一层渲染数据（order + reading）",
				"实现后 normify_module_refresh(activate=true) → normify_validate → normify_build → normify_render → normify_change_close"
			],
			hint: "目录与默认架构规则已就绪（幂等：重复调用不会破坏已有内容）。"
		};
	});
	register("normify_module_upsert", {
		description: "创建/更新一个模块（写时执行 L1 校验；幂等；自动晋升父模块文件形态）。",
		behavior: "write",
		parameters: params({
			frontmatter: moduleParams(),
			body: strOpt("Markdown 正文（给人类读者的展开介绍，可选）"),
			expect_updated_at: strOpt("可选：期望的当前 updated_at；不匹配则拒绝（防止覆盖他人写入）"),
			dry_run: boolOpt("仅校验并返回将写入的文件，不落盘"),
			...projectParams(true)
		}, ["frontmatter"])
	}, async (args) => {
		const proj = await resolve(args, true);
		const fm = { ...args.frontmatter };
		if (fm.parent === "null" || fm.parent === null) fm.parent = null;
		const { module, errors, warnings } = l1Validate(fm, "module.upsert");
		if (module === null) return {
			ok: false,
			errors: errors.map(fmtDiag),
			warnings: warnings.map(fmtDiag),
			summary: errors.length + " error（未写入）"
		};
		const existing = (await loadAllModules(proj.dir)).files.find((f) => f.module.id === module.id);
		if (typeof args.expect_updated_at === "string" && existing !== void 0 && existing.module.updated_at !== args.expect_updated_at) return {
			ok: false,
			error: {
				code: "module/conflict",
				message: "模块已被其他写入修改（updated_at 不一致），请先重新读取：" + module.id
			}
		};
		if (args.dry_run === true) {
			const all = (await loadAllModules(proj.dir)).files.map((f) => f.module);
			return {
				ok: true,
				dry_run: true,
				file: previewModuleFile(proj.dir, module, all),
				promoted: [],
				l1: {
					errors: errors.map(fmtDiag),
					warnings: warnings.map(fmtDiag)
				},
				hint: "dry_run 通过（未写入）；去掉 dry_run 正式写入。"
			};
		}
		const result = await writeModuleFile(proj.dir, module, args.body ?? "");
		return {
			ok: true,
			file: result.file,
			promoted: result.promoted,
			...result.warnings.length > 0 ? { warnings: result.warnings.map(fmtDiag) } : {},
			l1: {
				errors: errors.map(fmtDiag),
				warnings: warnings.map(fmtDiag)
			},
			hint: "写入完成。请继续创作其它模块；全部完成后运行 normify_validate 做全项目校验（L2），再 normify_build。"
		};
	});
	register("normify_module_delete", {
		description: "删除模块及其整棵子树（含悬空边预警清单，供后续修复）。",
		behavior: "destroy",
		parameters: params({
			id: str("要删除的模块 id"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const proj = await resolve(args);
		const id = String(args.id);
		const before = (await loadAllModules(proj.dir)).files;
		const affected = new Set([id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const f of before) if (f.module.parent !== null && affected.has(f.module.parent) && !affected.has(f.module.id)) {
				affected.add(f.module.id);
				grew = true;
			}
		}
		const dangling = before.filter((f) => !affected.has(f.module.id)).flatMap((f) => (f.module.deps ?? []).filter((d) => affected.has(d.to)).map((d) => ({
			from: f.module.id,
			kind: d.kind,
			to: d.to
		})));
		const result = await deleteModuleTree(proj.dir, id);
		return {
			ok: true,
			deleted: result.deleted,
			demoted: result.demoted,
			dangling_edges: dangling,
			hint: dangling.length > 0 ? "存在悬空箭头（已列出）：请用 normify_module_upsert 修正或删除引用方的 deps，否则 normify_validate 将报错。" : "无悬空边。"
		};
	});
	register("normify_module_promote", {
		description: "把叶子模块晋升为容器（文件 x.md → x/index.md；为它创建子模块前调用）。",
		behavior: "write",
		parameters: params({
			id: str("叶子模块 id"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const result = await promoteModule((await resolve(args)).dir, String(args.id));
		return {
			ok: true,
			file: result.file,
			...result.warnings.length > 0 ? { warnings: result.warnings.map(fmtDiag) } : {},
			hint: "晋升完成。现在可以为它创建子模块（子模块 parent 指向该 id）。"
		};
	});
	register("normify_validate", {
		description: "全项目校验（L2，零容忍）：结构/叶子/API/边/多树/文件映射/仓库证据。返回全部诊断（含 subject/evidence/supportedFixes）。",
		behavior: "read",
		parameters: params({
			repoRoot: strOpt("仓库根目录（提供则校验 source 存在性与 fingerprint 一致性）"),
			...projectParams(true)
		}, [])
	}, async (args) => {
		const v = await validateProject((await resolve(args)).dir, {
			repoRoot: args.repoRoot,
			requireBilingual: env.requireBilingual
		});
		return diagnosticsOut(v.errors, v.warnings);
	});
	register("normify_build", {
		description: "校验并编译：产出 tree.json / outline.md / api-index.json / receipt.json（含 SHA-256 冻结）。任何 error 不产产物。",
		behavior: "idempotent",
		parameters: params({
			repoRoot: strOpt("仓库根目录（启用证据校验）"),
			...projectParams(true)
		}, [])
	}, async (args) => {
		const b = await buildProject((await resolve(args)).dir, {
			repoRoot: args.repoRoot,
			requireBilingual: env.requireBilingual
		});
		if (!b.ok) return {
			ok: false,
			errors: b.errors.map(fmtDiag),
			warnings: b.warnings.map(fmtDiag),
			summary: b.errors.length + " error（未产出任何产物）"
		};
		return {
			ok: true,
			receipt: b.receipt,
			warnings: b.warnings.map(fmtDiag),
			hint: "编译成功。可运行 normify_render 生成交互式 HTML。"
		};
	});
	register("normify_sync", {
		description: "增量再生成计划器 v2（只读）：git diff → 脏子树 / 新增文件建议 / 失效模块 / API 增删与破坏性变更 / planned 进度，供 AI 按清单局部重建。",
		behavior: "read",
		parameters: params({
			repoRoot: str("仓库根目录"),
			diff: strOpt("git diff 范围（默认 HEAD）"),
			...projectParams(true)
		}, ["repoRoot"])
	}, async (args) => {
		const proj = await resolve(args);
		const repoRoot = String(args.repoRoot);
		const diff = args.diff;
		const changed = gitChangedFiles(repoRoot, diff ?? "");
		if (changed.files === null) return {
			ok: false,
			error: {
				code: "sync/git-failed",
				message: changed.error ?? "git 不可用"
			}
		};
		const files = (await loadAllModules(proj.dir)).files;
		const affected = files.filter((f) => f.module.source.some((s) => changed.files.some((cf) => cf === s.path || cf.startsWith(s.path + "/"))));
		const toReview = /* @__PURE__ */ new Set();
		for (const f of affected) {
			let p = f.module.parent;
			while (p !== null) {
				toReview.add(p);
				p = files.find((x) => x.module.id === p)?.module.parent ?? null;
			}
		}
		const drift = [];
		for (const f of affected) {
			const fp = await fingerprintOf(repoRoot, f.module.source);
			if (fp.hash !== null && fp.hash !== f.module.fingerprint) drift.push(f.module.id);
		}
		const layoutIds = new Set((await listLayoutFiles(proj.dir)).map((rel) => rel.replace(/^renders\//, "").replace(/\.json$/, "").replace(/\//g, ".")));
		const layoutsToReview = [...new Set([...affected.map((f) => f.module.id), ...toReview])].filter((id) => layoutIds.has(id)).sort(byCodeUnit);
		const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|mts|cts|py|java|kt|go|rs|cs|c|cpp|h|hpp|rb|php|swift|scala|lua|vue|svelte|md|yml|yaml|json)$/i;
		const IGNORE_DIR = /^(lib|dist|build|out|node_modules|vendor|coverage|\.git|_tmp|\.dsh-module-fallback)\//;
		const kindRank = (p) => p.startsWith("src/") ? 0 : /^(scripts|tests)\//.test(p) ? 1 : p.startsWith("skills/") ? 2 : p.startsWith("docs/") ? 4 : /\.md$/i.test(p) ? 5 : 3;
		const newFiles = changed.files.filter((cf) => CODE_EXT.test(cf) && !IGNORE_DIR.test(cf) && !files.some((f) => f.module.source.some((s) => s.path === cf || cf.startsWith(s.path + "/") || s.path.startsWith(cf + "/")))).sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
		const deletedFiles = changed.files.filter((cf) => !existsSync(join(repoRoot, cf)));
		const staleModules = files.filter((f) => f.module.source.length > 0 && f.module.source.some((s) => !existsSync(join(repoRoot, s.path)))).map((f) => ({
			id: f.module.id,
			missing: f.module.source.filter((s) => !existsSync(join(repoRoot, s.path))).map((s) => s.path)
		}));
		const suggestedModules = newFiles.slice(0, 20).map((cf) => {
			const dir = cf.includes("/") ? cf.slice(0, cf.lastIndexOf("/")) : "";
			let parent = null;
			for (const f of files) for (const s of f.module.source) {
				const sdir = s.path.includes("/") ? s.path.slice(0, s.path.lastIndexOf("/")) : "";
				if (dir === sdir || dir.startsWith(sdir + "/")) {
					if (parent === null || f.module.id.length > parent.length) parent = f.module.id;
				}
			}
			if (parent === null) parent = files.find((f) => f.module.parent === null)?.module.id ?? null;
			const slug = slugify(cf.slice(cf.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, ""));
			const id = parent !== null ? parent + "." + slug : slug;
			const valid = isValidId(id) && splitId(id) !== null && splitId(id).length <= 12;
			return {
				file: cf,
				suggested_parent: parent,
				suggested_id: valid ? id : null,
				state: "planned"
			};
		});
		const plannedRemaining = files.filter((f) => f.module.state === "planned").map((f) => f.module.id);
		const activateCandidates = files.filter((f) => f.module.state === "planned" && f.module.source.length > 0 && f.module.source.every((s) => existsSync(join(repoRoot, s.path)))).map((f) => f.module.id);
		const apiAdded = [];
		const apiRemoved = [];
		const breakingApiRemovals = [];
		try {
			const prev = JSON.parse(await readFile(join(proj.dir, "tree.json"), "utf8")).modules ?? {};
			const refs = /* @__PURE__ */ new Set();
			for (const f of files) for (const d of f.module.deps ?? []) {
				if (d.from_api !== void 0) refs.add(d.from_api);
				if (d.to_api !== void 0) refs.add(d.to_api);
			}
			for (const f of files) {
				const before = new Set((prev[f.module.id]?.apis ?? []).map((a) => String(a.key ?? "")));
				const now = new Set((f.module.apis ?? []).map((a) => apiKey(a)));
				for (const k of now) if (!before.has(k)) apiAdded.push({
					module: f.module.id,
					key: k
				});
				for (const k of before) if (!now.has(k)) {
					apiRemoved.push({
						module: f.module.id,
						key: k
					});
					if (refs.has(k)) breakingApiRemovals.push({
						module: f.module.id,
						key: k,
						reason: "仍被 deps 的 from_api/to_api 引用"
					});
				}
			}
		} catch {}
		return {
			ok: true,
			changed_files: changed.files.slice(0, 500),
			changed_count: changed.files.length,
			affected: affected.map((f) => f.module.id),
			to_review: [...toReview],
			layouts_to_review: layoutsToReview,
			drift_fingerprints: drift,
			new_files: newFiles.slice(0, 100),
			deleted_files: deletedFiles,
			stale_modules: staleModules,
			suggested_modules: suggestedModules,
			planned_remaining: plannedRemaining,
			activate_candidates: activateCandidates,
			api_added: apiAdded,
			api_removed: apiRemoved,
			breaking_api_removals: breakingApiRemovals,
			plan: "1) affected 模块按深度从深到浅重建（重读代码：增删 API、更新介绍、必要时拆分）；2) to_review 的祖先只复核介绍与统计；3) layouts_to_review 的层用 normify_layout_upsert 同步更新渲染数据；4) new_files 按 suggested_modules 用 normify_module_batch 建计划态模块（先 normify_check）；5) stale_modules/deleted_files 确认后删除或修正 source；6) breaking_api_removals 必须迁移引用方；7) planned 落地后用 normify_module_refresh(activate:true)。修复后 normify_validate + normify_build 必须 0 error，建议用 normify_change_close 留痕。"
		};
	});
	register("normify_search", {
		description: "跨 id/名称/介绍/API 检索结构数据。",
		behavior: "read",
		parameters: params({
			query: str("搜索关键词"),
			topK: numOpt("返回条数（默认 20）"),
			...projectParams(true)
		}, ["query"])
	}, async (args) => {
		const proj = await resolve(args);
		const q = String(args.query).toLowerCase();
		const topK = typeof args.topK === "number" ? args.topK : 20;
		const files = (await loadAllModules(proj.dir)).files;
		const hits = [];
		for (const f of files) {
			const m = f.module;
			if ((m.id + " " + m.name.zh + " " + m.name.en + " " + m.description.zh + " " + m.description.en).toLowerCase().includes(q)) hits.push({
				id: m.id,
				name: m.name.zh + " / " + m.name.en,
				snippet: m.description.zh.slice(0, 100)
			});
			for (const a of m.apis ?? []) {
				const key = apiKey(a);
				if ((key + " " + a.description.zh + " " + a.description.en).toLowerCase().includes(q)) hits.push({
					id: m.id,
					name: m.name.zh + " / " + m.name.en,
					snippet: a.description.zh.slice(0, 100),
					api: key
				});
			}
		}
		return {
			ok: true,
			count: hits.length,
			results: hits.slice(0, topK)
		};
	});
	register("normify_deps_find", {
		description: "反查\"谁依赖我\"：列出所有指向指定模块（或其 API）的箭头（含跨树），删除/改名前的安全网。",
		behavior: "read",
		parameters: params({
			to: str("目标模块 id"),
			...projectParams(true)
		}, ["to"])
	}, async (args) => {
		const proj = await resolve(args);
		const target = String(args.to);
		const rows = (await loadAllModules(proj.dir)).files.flatMap((f) => (f.module.deps ?? []).filter((d) => d.to === target || d.to.startsWith(target + ".")).map((d) => ({
			from: f.module.id,
			kind: d.kind,
			to: d.to,
			from_api: d.from_api ?? null,
			to_api: d.to_api ?? null
		})));
		return {
			ok: true,
			target,
			count: rows.length,
			references: rows
		};
	});
	register("normify_outline", {
		description: "仅重建 outline.md 派生索引（不重新编译 tree.json）。",
		behavior: "idempotent",
		parameters: params({ ...projectParams(true) }, [])
	}, async (args) => {
		const b = await buildProject((await resolve(args)).dir, { requireBilingual: env.requireBilingual });
		if (!b.ok) return {
			ok: false,
			errors: b.errors.map(fmtDiag),
			summary: "outline 未更新（存在 error）"
		};
		return {
			ok: true,
			hint: "outline.md 已重建（随 build 一并更新）。"
		};
	});
	register("normify_layout_get", {
		description: "读取某容器模块的渲染数据（renders/<id>.json）：本层子模块顺序/分组/边提示/阅读导语。",
		behavior: "read",
		parameters: params({
			id: str("容器模块 id（有子模块的模块）"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const proj = await resolve(args);
		const files = (await loadAllModules(proj.dir)).files;
		const id = String(args.id);
		if (files.find((f) => f.module.id === id) === void 0) return {
			ok: false,
			error: {
				code: "module/not-found",
				message: "模块不存在：" + id
			}
		};
		const children = files.filter((f) => f.module.parent === id).map((f) => f.module.id).sort(byCodeUnit);
		if (children.length === 0) return {
			ok: false,
			error: {
				code: "layout/not-container",
				message: "叶子模块没有可渲染的子层：" + id
			}
		};
		const { layout, error } = await loadLayoutFile(proj.dir, id);
		if (error !== null) return {
			ok: false,
			errors: [fmtDiag(error)]
		};
		if (layout === null) return {
			ok: true,
			has_layout: false,
			id,
			file: layoutRelPath(id),
			children,
			hint: "该层还没有渲染数据；写模块的同一轮里用 normify_layout_upsert 建立（order / groups / mode / reading）。"
		};
		const listed = new Set(layout.order ?? []);
		const grouped = new Set((layout.groups ?? []).flatMap((g) => g.children));
		return {
			ok: true,
			has_layout: true,
			id,
			file: layoutRelPath(id),
			layout,
			children,
			missing_in_order: children.filter((c) => !listed.has(c)),
			missing_in_groups: children.filter((c) => !grouped.has(c))
		};
	});
	register("normify_layout_delete", {
		description: "删除某容器模块的渲染数据（结构模块保留，图谱回退自动布局）。",
		behavior: "destroy",
		parameters: params({
			id: str("容器模块 id"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const proj = await resolve(args);
		const id = String(args.id);
		const removed = await deleteLayoutFile(proj.dir, id);
		return {
			ok: true,
			id,
			removed,
			hint: removed ? "渲染数据已删除。" : "本来就不存在渲染数据。"
		};
	});
	register("normify_layout_upsert", {
		description: "写入/覆盖某容器模块的渲染数据（order / groups / mode / reading / edge_hints），写时校验并全量落盘；应与结构模块同轮建立与维护，让每一层的图易读。",
		behavior: "write",
		parameters: params({
			id: str("容器模块 id（必须已有 ≥1 个子模块）"),
			mode: strOpt("auto | layers | groups | grid（默认 auto：有分组用 groups，兄弟边多用 layers，否则 grid）"),
			max_columns: numOpt("最大列数 1..6（grid / layers 模式）"),
			max_api_rows: numOpt("叶子框内最多展示几行 API（0 = 全部展开，也是缺省；1..48 = 截断到该行数）"),
			reading: l10nOptParam("本层阅读导语（可选，显示在图上方，说明阅读顺序与分组逻辑）"),
			order: strArrayOpt("子模块阅读顺序（建议覆盖全部直接子模块；未列出的自动追加）"),
			groups: layoutGroupParam(),
			edge_hints: layoutHintParam(),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const proj = await resolve(args, true);
		const files = (await loadAllModules(proj.dir)).files;
		const id = String(args.id);
		const byId = new Map(files.map((f) => [f.module.id, f.module]));
		if (!byId.has(id)) return {
			ok: false,
			error: {
				code: "module/not-found",
				message: "模块不存在：" + id
			}
		};
		const children = files.filter((f) => f.module.parent === id).map((f) => f.module.id).sort(byCodeUnit);
		if (children.length === 0) return {
			ok: false,
			error: {
				code: "layout/not-container",
				message: "叶子模块没有可渲染的子层：" + id
			}
		};
		const childSet = new Set(children);
		const siblingEdges = /* @__PURE__ */ new Set();
		for (const kid of children) {
			const km = byId.get(kid);
			for (const d of km?.deps ?? []) if (childSet.has(d.to) && d.to !== kid) siblingEdges.add(edgeKey(kid, d.to));
		}
		const data = {
			schema_version: 1,
			id,
			updated_at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (args.mode !== void 0) data.mode = args.mode;
		if (args.max_columns !== void 0) data.max_columns = args.max_columns;
		if (args.max_api_rows !== void 0) data.max_api_rows = args.max_api_rows;
		if (args.reading !== void 0) data.reading = { ...args.reading };
		if (Array.isArray(args.order)) data.order = [...args.order];
		if (Array.isArray(args.groups)) data.groups = args.groups.map((g) => {
			const raw = { ...g };
			raw.children = Array.isArray(raw.children) ? [...raw.children] : [];
			return raw;
		});
		if (Array.isArray(args.edge_hints)) data.edge_hints = args.edge_hints.map((h) => ({ ...h }));
		const r = l1ValidateLayout(data, id, children, siblingEdges, "tool:layout_upsert");
		if (r.layout === null) return {
			ok: false,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			summary: r.errors.length + " error（未写入）"
		};
		return {
			ok: true,
			file: await writeLayoutFile(proj.dir, r.layout),
			children,
			warnings: r.warnings.map(fmtDiag),
			hint: "渲染数据已写入。继续创作其它层；全部完成后 normify_validate + normify_build（布局会编入 tree.json）。"
		};
	});
	register("normify_render", {
		description: "把 tree.json 渲染成单文件交互式 HTML（逐层下钻/悬停介绍/深链接/双语切换/多树/API 聚合）。需先 normify_build。",
		behavior: "idempotent",
		parameters: params({
			out: strOpt("输出文件名（默认 normify.html，写在结构数据目录下）"),
			...projectParams(true)
		}, [])
	}, async (args) => {
		const r = await renderProject((await resolve(args)).dir, { out: args.out });
		if (!r.ok) return {
			ok: false,
			errors: r.errors.map(fmtDiag)
		};
		return {
			ok: true,
			html: r.htmlPath,
			bytes: r.bytes,
			sha256: r.sha256,
			stats: r.summary?.stats ?? null,
			hint: "HTML 已生成。浏览器打开后：点击模块下钻；悬停看介绍；?lang=en 或 ?lang=zh 切换语言；#module=<id>、#api=<key>、#view=outline 深链直达。"
		};
	});
	register("normify_fingerprint", {
		description: "按与校验器一致的确定性算法计算 source 指纹（写模块 fingerprint 字段前调用）。",
		behavior: "read",
		parameters: params({
			repoRoot: str("仓库根目录（绝对路径）"),
			source: sourceParam()
		})
	}, async (args) => {
		const repoRoot = String(args.repoRoot);
		const sources = Array.isArray(args.source) ? args.source : [];
		const sourceErrors = [];
		const checked = [];
		for (const [i, entry] of sources.entries()) if (checkSourceEntry(entry, "tool:fingerprint/source/" + i, sourceErrors)) checked.push(entry);
		if (sourceErrors.length > 0) return {
			ok: false,
			errors: sourceErrors.map(fmtDiag),
			summary: sourceErrors.length + " error（未计算指纹）",
			hint: "source 必须是仓库内的正斜杠相对路径（无 ..、无绝对路径、无反斜杠）"
		};
		const fp = await fingerprintOf(repoRoot, checked);
		return {
			ok: fp.missing.length === 0,
			fingerprint: fp.hash,
			files: checked.map((s) => s.path),
			missing: fp.missing,
			algorithm: "sha256: 按 path 升序，逐个 update(UTF-8(path)) + update(0x00) + update(file bytes)"
		};
	});
	register("normify_brief", {
		description: "开发指引（只读）：给任务描述 / 模块 id / 改动文件，返回目标模块与契约、架构规则约束、影响面、建议新增模块（含路径建议）、验收清单与收尾步骤。建议在每次开发任务开始时先调用。",
		behavior: "read",
		parameters: params({
			task: strOpt("任务/需求描述（自由文本，用于检索相关模块）"),
			id: strOpt("目标模块 id（明确改动对象时传）"),
			files: strArrayOpt("涉及的文件路径（repo 相对或绝对；用于定位模块）"),
			depth: numOpt("影响面深度 1..4（默认 2）"),
			...projectParams(true)
		})
	}, async (args) => {
		const proj = await resolve(args);
		const files = (await loadAllModules(proj.dir)).files;
		const byId = new Map(files.map((f) => [f.module.id, f.module]));
		const fileOf = new Map(files.map((f) => [f.module.id, f.file]));
		const childrenOf = /* @__PURE__ */ new Map();
		for (const f of files) if (f.module.parent !== null) {
			const list = childrenOf.get(f.module.parent) ?? [];
			list.push(f.module.id);
			childrenOf.set(f.module.parent, list);
		}
		const layoutIds = new Set((await listLayoutFiles(proj.dir)).map((rel) => rel.replace(/\.json$/, "").replace(/\//g, ".")));
		const policy = (await loadPolicyFile(proj.dir)).policy;
		const depsIn = /* @__PURE__ */ new Map();
		for (const f of files) for (const d of f.module.deps ?? []) {
			const list = depsIn.get(d.to) ?? [];
			list.push({
				from: f.module.id,
				kind: d.kind
			});
			depsIn.set(d.to, list);
		}
		const candidates = /* @__PURE__ */ new Set();
		const unmatchedFiles = [];
		if (typeof args.id === "string" && args.id.trim() !== "") {
			const id = args.id.trim();
			if (!byId.has(id)) return {
				ok: false,
				error: {
					code: "module/not-found",
					message: "模块不存在：" + id
				},
				hint: "该模块还没建：先用 normify_project_init 初始化项目（可顺带建计划态根模块），再用 normify_module_batch/upsert 建子树；若只想拿任务级指引，改用 task 参数（不传 id）。"
			};
			candidates.add(id);
		}
		if (Array.isArray(args.files)) for (const raw of args.files) {
			const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
			const hit = files.find((f) => f.module.source.some((s) => s.path === p || p.startsWith(s.path + "/") || s.path.startsWith(p + "/")));
			if (hit !== void 0) candidates.add(hit.module.id);
			else unmatchedFiles.push(p);
		}
		const task = typeof args.task === "string" ? args.task.trim() : "";
		if (task !== "" && candidates.size === 0) {
			const words = task.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
			const scored = files.map((f) => {
				const m = f.module;
				const hay = (m.id + " " + m.name.zh + " " + m.name.en + " " + m.description.zh + " " + m.description.en + " " + (m.tags ?? []).join(" ") + " " + (m.apis ?? []).map((a) => apiKey(a)).join(" ")).toLowerCase();
				let score = 0;
				for (const w of words) if (hay.includes(w)) score++;
				return {
					id: m.id,
					score
				};
			}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 8);
			for (const s of scored) candidates.add(s.id);
		}
		const depth = typeof args.depth === "number" ? Math.max(1, Math.min(4, Math.round(args.depth))) : 2;
		const impact = {
			direct: [],
			transitive: [],
			cross_tree: []
		};
		const visited = new Set(candidates);
		let frontier = [...candidates];
		for (let d = 1; d <= depth; d++) {
			const next = [];
			for (const id of frontier) for (const ref of depsIn.get(id) ?? []) {
				if (visited.has(ref.from)) continue;
				visited.add(ref.from);
				if (d === 1) impact.direct.push(ref.from);
				else impact.transitive.push(ref.from);
				const tree = (candidate) => candidate.split(".")[0] ?? candidate;
				for (const c of candidates) if (tree(c) !== tree(ref.from)) impact.cross_tree.push(ref.from + " ← " + c);
				next.push(ref.from);
			}
			frontier = next;
		}
		const targets = [...candidates].map((id) => {
			const m = byId.get(id);
			return {
				id,
				state: m.state ?? "active",
				name: m.name,
				description: m.description,
				file: fileOf.get(id) ?? null,
				tags: m.tags ?? [],
				source: m.source,
				apis: (m.apis ?? []).map((a) => ({
					key: apiKey(a),
					description: a.description
				})),
				deps_out: (m.deps ?? []).map((d) => ({
					to: d.to,
					kind: d.kind,
					to_api: d.to_api ?? null
				})),
				deps_in: (depsIn.get(id) ?? []).map((r) => ({
					from: r.from,
					kind: r.kind
				})),
				has_layout: layoutIds.has(id),
				children: childrenOf.get(id) ?? []
			};
		});
		const violations = (policy === null ? [] : evaluatePolicy(policy, {
			files,
			byId: new Map(files.map((f) => [f.module.id, f]))
		})).filter((d) => {
			const s = d.subject ?? {};
			const subject = typeof s.module === "string" ? s.module : "";
			const target = typeof s.to === "string" ? s.to : "";
			return candidates.has(subject) || candidates.has(target);
		});
		const suggestions = [];
		for (const p of unmatchedFiles.slice(0, 20)) {
			const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
			let parent = null;
			for (const f of files) for (const s of f.module.source) {
				const sdir = s.path.includes("/") ? s.path.slice(0, s.path.lastIndexOf("/")) : "";
				if (dir === sdir || dir.startsWith(sdir + "/")) {
					if (parent === null || f.module.id.length > parent.length) parent = f.module.id;
				}
			}
			if (parent === null) parent = files.find((f) => f.module.parent === null)?.module.id ?? null;
			const slug = slugify(p.slice(p.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, ""));
			const id = parent !== null ? parent + "." + slug : slug;
			const valid = isValidId(id) && splitId(id) !== null && splitId(id).length <= 12;
			suggestions.push({
				file: p,
				suggested_parent: parent,
				suggested_id: valid ? id : null,
				state: "planned",
				note: valid ? "先用 normify_check 预检，再用 normify_module_batch/upsert 建计划态模块（source 指向该文件，fingerprint=pending）" : "自动建议的 id 非法或超深，请人工命名"
			});
		}
		const checklist = [];
		if (targets.some((t) => t.state === "planned")) checklist.push("计划态模块：实现 source 指向的文件后调用 normify_module_refresh({ ids: [...], activate: true, repoRoot })");
		if (targets.some((t) => t.children.length >= 2 && !t.has_layout)) checklist.push("该层缺渲染数据：用 normify_layout_upsert 补 order / groups / mode / reading");
		if (violations.length > 0) checklist.push("存在架构规则违规：先按 supportedFixes 修正，或经评审调整 policy.yml");
		checklist.push("收尾（0 error 强制）：normify_validate（带 repoRoot）→ normify_build → normify_render");
		checklist.push("建议留痕：normify_change_open → 实现 → normify_change_close");
		const allChanges = [];
		for (const cid of await listChangeIds(proj.dir)) {
			const c = await loadChangeFile(proj.dir, cid);
			if (c.change !== null) allChanges.push({
				id: c.change.id,
				status: c.change.status,
				title: c.change.title,
				modules: c.change.modules
			});
		}
		const openChanges = allChanges.filter((c) => c.status === "proposed" || c.status === "in_progress");
		const plan = [
			"1) 用 normify_check 预检拟新增模块/依赖（不符合规则先调整设计）",
			"2) 计划态先建树：normify_module_batch 或 normify_module_upsert（state=planned, fingerprint=pending, source 可未落地）",
			"3) 实现代码；结构变化用 normify_module_patch / normify_module_move / normify_layout_upsert",
			"4) 模块落地：normify_module_refresh（ids + activate:true + repoRoot）",
			"5) 收尾：normify_validate（0 error）→ normify_build → normify_render；需要留痕则 normify_change_close"
		];
		return {
			ok: true,
			task,
			candidates: [...candidates],
			targets,
			impact,
			policy: policy === null ? {
				exists: false,
				rule_count: 0
			} : {
				exists: true,
				rule_count: policy.rules.length,
				rules: policy.rules.map((r) => ({
					id: r.id,
					type: r.type,
					severity: r.severity ?? "error"
				}))
			},
			violations: violations.map(fmtDiag),
			suggestions,
			open_changes: openChanges,
			checklist,
			plan,
			hint: "按 plan 顺序执行；实现过程中结构性变更随时 normify_sync 复核。"
		};
	});
	register("normify_module_patch", {
		description: "部分更新模块：只传要改的字段（服务端合并后写时 L1 校验）；支持 expect_updated_at 乐观并发与 dry_run；id/uid/parent 不可在此修改（用 normify_module_move）。",
		behavior: "write",
		parameters: params({
			id: str("模块 id"),
			patch: freeObjectParam("要修改的字段：name/description/source/apis/deps/repository/state/replacement/tags/revision/fingerprint/body 等", true),
			expect_updated_at: strOpt("可选：期望的当前 updated_at；不匹配则拒绝（防止覆盖他人写入）"),
			dry_run: boolOpt("仅校验并返回将写入的文件，不落盘"),
			...projectParams(true)
		}, ["id", "patch"])
	}, async (args) => {
		const r = await patchModule((await resolve(args)).dir, String(args.id), {
			...args.patch,
			...typeof args.expect_updated_at === "string" ? { expect_updated_at: args.expect_updated_at } : {}
		}, { dryRun: args.dry_run === true });
		if (!r.ok) return {
			ok: false,
			dry_run: r.dryRun,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			summary: r.errors.length + " error（未写入）"
		};
		return {
			ok: true,
			dry_run: r.dryRun,
			file: typeof r.detail.file === "string" ? r.detail.file : r.file ?? null,
			changed: r.changed,
			warnings: r.warnings.map(fmtDiag),
			hint: r.dryRun ? "dry_run 通过（未写入）；去掉 dry_run 正式写入。" : "已更新。如代码同时变化，记得 normify_module_refresh 刷新指纹。"
		};
	});
	register("normify_module_batch", {
		description: "批量 upsert/patch 模块：全部 L1 + 结构预检通过才落盘（原子；失败回滚）。计划态建树首选，一轮可写多个模块。",
		behavior: "write",
		parameters: params({
			items: objArrayParam("批次条目：mode=upsert 传 [{ frontmatter }]；mode=patch 传 [{ patch: { id, patch } }]", true),
			mode: strOpt("'upsert'（默认，整模块写入）| 'patch'（部分字段合并）"),
			dry_run: boolOpt("仅校验并返回将写的文件，不落盘"),
			...projectParams(true)
		}, ["items"])
	}, async (args) => {
		const proj = await resolve(args, true);
		const mode = args.mode === "patch" ? "patch" : "upsert";
		const items = args.items.map((i) => ({ ...i }));
		const r = await batchWrite(proj.dir, items, mode, { dryRun: args.dry_run === true });
		if (!r.ok) {
			const dropped = r.detail?.dropped_by_l1 ?? [];
			return {
				ok: false,
				dry_run: r.dryRun,
				errors: r.errors.map(fmtDiag),
				warnings: r.warnings.map(fmtDiag),
				summary: r.errors.length + " error（整批未写入）",
				...dropped.length > 0 ? {
					root_causes: dropped,
					hint: "本批有 " + dropped.length + " 个模块未通过 L1 校验（见 root_causes）；errors 里的 dep/target-dropped 与 structure/parent-dropped 都是它们的连带错误。先修 root_causes 再整批重试（原子写入，本次未落盘）。"
				} : {}
			};
		}
		return {
			ok: true,
			dry_run: r.dryRun,
			files: r.files,
			count: r.files.length,
			warnings: r.warnings.map(fmtDiag),
			hint: r.dryRun ? "dry_run 通过（未写入）。" : "整批已写入。继续建树或进入实现阶段（planned → normify_module_refresh activate）。"
		};
	});
	register("normify_module_move", {
		description: "重命名/移动子树：保 uid、级联 children parent、重写全项目 deps.to、迁移模块文件与 renders/*.json；dry_run 先看计划。",
		behavior: "write",
		parameters: params({
			id: str("要移动的模块 id（子树根）"),
			new_id: strOpt("新 id（重命名/换路径；与 new_parent 至少给一个）"),
			new_parent: strOpt("新父模块 id（换父级；等价于 new_id = new_parent + \".\" + 原末段）"),
			dry_run: boolOpt("仅返回迁移计划（模块/依赖/渲染数据），不落盘"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const proj = await resolve(args);
		if (typeof args.new_id !== "string" && typeof args.new_parent !== "string") return {
			ok: false,
			error: {
				code: "module/move-noop",
				message: "必须提供 new_id 或 new_parent"
			}
		};
		const r = await moveModuleTree(proj.dir, String(args.id), {
			newId: typeof args.new_id === "string" ? args.new_id : void 0,
			newParent: typeof args.new_parent === "string" ? args.new_parent : void 0,
			dryRun: args.dry_run === true
		});
		if (!r.ok) return {
			ok: false,
			dry_run: r.dryRun,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag)
		};
		return {
			ok: true,
			dry_run: r.dryRun,
			moves: r.moves,
			rewired_deps: r.rewired,
			layouts: r.detail.layouts ?? [],
			changed: r.changed,
			warnings: r.warnings.map(fmtDiag),
			hint: r.dryRun ? "dry_run 计划如上（未落盘）；确认后去掉 dry_run 执行。移动后建议 normify_validate 复核。" : "移动完成；渲染数据已随迁，建议 normify_validate + normify_build。"
		};
	});
	register("normify_module_refresh", {
		description: "重算模块 fingerprint/revision(git HEAD)/updated_at：planned 模块源码落地后用 activate:true 一键转 active，是\"逐个模块完成\"的收尾动作。",
		behavior: "idempotent",
		parameters: params({
			ids: strArrayOpt("要刷新的模块 id 数组"),
			all: boolOpt("刷新全部模块（与 ids 二选一）"),
			repoRoot: str("仓库根目录（计算 fingerprint 与 HEAD）"),
			activate: boolOpt("把已落地的 planned 模块转为 active（默认 false）"),
			dry_run: boolOpt("仅计算并返回结果，不写磁盘"),
			...projectParams(true)
		}, ["repoRoot"])
	}, async (args) => {
		const proj = await resolve(args);
		const ids = Array.isArray(args.ids) ? args.ids.map(String) : void 0;
		if ((ids === void 0 || ids.length === 0) && args.all !== true) return {
			ok: false,
			error: {
				code: "refresh/no-target",
				message: "必须提供 ids 或 all:true"
			}
		};
		const r = await refreshModules(proj.dir, {
			ids,
			all: args.all === true,
			repoRoot: String(args.repoRoot),
			activate: args.activate === true,
			dryRun: args.dry_run === true
		});
		if (!r.ok) return {
			ok: false,
			dry_run: r.dryRun,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			missing: r.missing
		};
		return {
			ok: true,
			dry_run: r.dryRun,
			refreshed: r.refreshed,
			missing: r.missing,
			changed: r.changed,
			warnings: r.warnings.map(fmtDiag),
			hint: r.dryRun ? "dry_run 结果如上（未写入）。" : "指纹/修订已刷新。建议接着 normify_validate（0 error 门禁）。"
		};
	});
	register("normify_change_open", {
		description: "开启一个开发变更（changes/<id>.json，随结构目录一起回档）：记录意图、涉及模块（create/modify/delete/api_add/api_remove）与验收标准；实现完成后用 normify_change_close 收尾（强制 0 error）。",
		behavior: "write",
		parameters: params({
			id: strOpt("变更 id（默认 YYYY-MM-DD-<title.en slug>）"),
			title: l10nParam("变更标题"),
			intent: l10nParam("变更意图 / 背景"),
			modules: freeObjectParam("涉及模块 { create?: [], modify?: [], delete?: [], api_add?: [{module,key}], api_remove?: [{module,key}] }", true),
			acceptance: strArray("验收标准（≥1 条**纯字符串**，close 前逐条自检；需要双语描述请写 title/intent）"),
			status: strOpt("'proposed' | 'in_progress'（默认 in_progress）"),
			note: strOpt("备注（可选）"),
			...projectParams(true)
		}, [
			"title",
			"intent",
			"modules",
			"acceptance"
		])
	}, async (args) => {
		const proj = await resolve(args, true);
		const title = { ...args.title };
		const intent = { ...args.intent };
		const id = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + "-" + slugify(String(title.en || title.zh || "change"));
		if (!isValidChangeId(id)) return {
			ok: false,
			error: {
				code: "change/id-format",
				message: "变更 id 必须为 YYYY-MM-DD-<slug>：" + id
			}
		};
		if ((await loadChangeFile(proj.dir, id)).change !== null) return {
			ok: false,
			error: {
				code: "change/exists",
				message: "变更已存在：" + id
			}
		};
		const files = (await loadAllModules(proj.dir)).files;
		const byId = new Set(files.map((f) => f.module.id));
		const modules = { ...args.modules };
		const missing = [
			...modules.create ?? [],
			...modules.modify ?? [],
			...modules.delete ?? []
		].filter((r) => !byId.has(r));
		if (missing.length > 0) return {
			ok: false,
			error: {
				code: "change/module-missing",
				message: "变更引用的模块不存在：" + missing.join(", ") + "（计划态模块也可以先建）"
			}
		};
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const r = l1ValidateChange({
			schema_version: 1,
			id,
			title,
			status: args.status === "proposed" ? "proposed" : "in_progress",
			intent,
			modules,
			acceptance: Array.isArray(args.acceptance) ? [...args.acceptance] : [],
			...typeof args.note === "string" ? { note: args.note } : {},
			revision: {
				before: null,
				after: null
			},
			created_at: now,
			updated_at: now
		}, id, "tool:change_open");
		if (r.change === null) return {
			ok: false,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag)
		};
		return {
			ok: true,
			id,
			file: await writeChangeFile(proj.dir, r.change),
			status: r.change.status,
			hint: "变更已开启。按 normify_brief 的计划实现；收尾用 normify_change_close（0 error 强制）。"
		};
	});
	register("normify_change_update", {
		description: "更新变更日志字段（title/intent/status/acceptance/modules/note）；id/created_at 不可改。关闭请用 normify_change_close。",
		behavior: "write",
		parameters: params({
			id: str("变更 id"),
			patch: freeObjectParam("要更新的字段（title/intent/status/acceptance/modules/note 等）", true),
			...projectParams(true)
		}, ["id", "patch"])
	}, async (args) => {
		const proj = await resolve(args);
		const { change, error } = await loadChangeFile(proj.dir, String(args.id));
		if (error !== null) return {
			ok: false,
			errors: [fmtDiag(error)]
		};
		if (change === null) return {
			ok: false,
			error: {
				code: "change/not-found",
				message: "变更不存在：" + String(args.id)
			}
		};
		if (change.status === "verified") return {
			ok: false,
			error: {
				code: "change/closed",
				message: "变更已关闭，不能再更新：" + change.id
			}
		};
		const patch = { ...args.patch };
		delete patch.id;
		delete patch.created_at;
		delete patch.schema_version;
		const merged = {
			...change,
			...patch,
			updated_at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (merged.status === "abandoned" && merged.closed_at === void 0) merged.closed_at = (/* @__PURE__ */ new Date()).toISOString();
		const r = l1ValidateChange(merged, change.id, "tool:change_update");
		if (r.change === null) return {
			ok: false,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag)
		};
		const file = await writeChangeFile(proj.dir, r.change);
		return {
			ok: true,
			id: r.change.id,
			file,
			status: r.change.status,
			hint: "变更已更新。"
		};
	});
	register("normify_change_list", {
		description: "列出开发变更（按状态汇总）；传 id 返回完整变更详情。",
		behavior: "read",
		parameters: params({
			id: strOpt("变更 id（传则返回详情）"),
			status: strOpt("按状态过滤：proposed | in_progress | verified | abandoned"),
			...projectParams(true)
		})
	}, async (args) => {
		const proj = await resolve(args);
		if (typeof args.id === "string" && args.id.trim() !== "") {
			const { change, error } = await loadChangeFile(proj.dir, args.id.trim());
			if (error !== null) return {
				ok: false,
				errors: [fmtDiag(error)]
			};
			if (change === null) return {
				ok: false,
				error: {
					code: "change/not-found",
					message: "变更不存在：" + args.id
				}
			};
			return {
				ok: true,
				change,
				file: "changes/" + change.id + ".json"
			};
		}
		const out = [];
		for (const id of await listChangeIds(proj.dir)) {
			const { change } = await loadChangeFile(proj.dir, id);
			if (change === null) continue;
			if (typeof args.status === "string" && args.status !== "" && change.status !== args.status) continue;
			out.push({
				id: change.id,
				status: change.status,
				title: change.title,
				modules: change.modules,
				acceptance_count: change.acceptance.length,
				created_at: change.created_at,
				closed_at: change.closed_at ?? null
			});
		}
		const counts = {
			proposed: 0,
			in_progress: 0,
			verified: 0,
			abandoned: 0
		};
		for (const c of out) counts[String(c.status)] = (counts[String(c.status)] ?? 0) + 1;
		return {
			ok: true,
			count: out.length,
			counts,
			changes: out
		};
	});
	register("normify_change_close", {
		description: "关闭变更（收尾，0 error 强制）：刷新涉及模块指纹/激活 planned → validate → build（可选 render）→ 标记 verified 并写 revision.after。任何一步失败都不关闭。",
		behavior: "idempotent",
		parameters: params({
			id: str("变更 id"),
			repoRoot: strOpt("仓库根目录（强烈建议提供：启用指纹证据校验与 HEAD 记录）"),
			activate: boolOpt("自动把 create 中已落地的 planned 模块转 active（默认 true）"),
			render: boolOpt("关闭后顺便重新渲染 HTML（默认 false）"),
			note: strOpt("关闭备注（可选）"),
			...projectParams(true)
		}, ["id"])
	}, async (args) => {
		const r = await closeChange((await resolve(args)).dir, String(args.id), {
			repoRoot: typeof args.repoRoot === "string" ? args.repoRoot : void 0,
			activate: args.activate !== false,
			render: args.render === true,
			note: typeof args.note === "string" ? args.note : void 0,
			requireBilingual: env.requireBilingual
		});
		return {
			ok: r.ok,
			phase: r.phase,
			...r.change !== void 0 ? {
				id: r.change.id,
				status: r.change.status
			} : {},
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			...r.refresh !== void 0 && r.refresh !== null ? { refresh: r.refresh } : {},
			...r.build !== void 0 && r.build !== null ? { build: r.build } : {},
			...r.render !== void 0 && r.render !== null ? { render: r.render } : {},
			...r.revision !== void 0 ? { revision: r.revision } : {},
			...r.message !== void 0 ? { summary: r.message } : {},
			...r.hint !== void 0 ? { hint: r.hint } : {},
			...r.file !== void 0 ? { file: r.file } : {}
		};
	});
	register("normify_policy_get", {
		description: "读取项目的架构规则（policy.yml）；不存在时返回完整默认模板与规则参考，供设计阶段安装。",
		behavior: "read",
		parameters: params({ ...projectParams(true) })
	}, async (args) => {
		const r = await loadPolicyFile((await resolve(args)).dir);
		if (r.errors.length > 0) return {
			ok: false,
			errors: r.errors.map(fmtDiag)
		};
		const out = {
			ok: true,
			file: "policy.yml",
			exists: r.exists,
			policy: r.policy,
			rule_count: r.policy === null ? 0 : r.policy.rules.length,
			reference: policyReference()
		};
		if (!r.exists) out.template = defaultPolicyTemplate();
		return out;
	});
	register("normify_policy_upsert", {
		description: "写入/覆盖架构规则 policy.yml（完整规则集，写时校验规则字段；dry_run 只校验不落盘）。安装后 normify_validate / normify_check 即按规则强制。",
		behavior: "write",
		parameters: params({
			rules: objArrayParam("规则数组；类型与字段见 normify_policy_get 的 reference/template", true),
			dry_run: boolOpt("仅校验并返回规则数，不写磁盘"),
			...projectParams(true)
		}, ["rules"])
	}, async (args) => {
		const proj = await resolve(args, true);
		const r = l1ValidatePolicy({
			schema_version: 1,
			updated_at: (/* @__PURE__ */ new Date()).toISOString(),
			rules: args.rules
		}, "tool:policy_upsert");
		if (r.policy === null) return {
			ok: false,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			summary: r.errors.length + " error（未写入）"
		};
		if (args.dry_run === true) return {
			ok: true,
			dry_run: true,
			rule_count: r.policy.rules.length,
			policy: r.policy
		};
		return {
			ok: true,
			file: await writePolicyFile(proj.dir, r.policy),
			rule_count: r.policy.rules.length,
			hint: "架构规则已生效：后续 normify_validate / normify_build / normify_check 都会执行。"
		};
	});
	register("normify_check", {
		description: "设计/编码前预检（只读）：拟建模块与拟加依赖是否违反核心约束或架构规则 policy.yml；建议在动手前先跑。",
		behavior: "read",
		parameters: params({
			modules: objArrayParam("拟建/调整的模块 [{ id, parent?, state? }]"),
			deps: objArrayParam("拟新增依赖 [{ from, to, kind?, to_api? }]"),
			...projectParams(true)
		})
	}, async (args) => {
		const proj = await resolve(args);
		const modules = Array.isArray(args.modules) ? args.modules.map((m) => ({ ...m })) : void 0;
		const deps = Array.isArray(args.deps) ? args.deps.map((d) => ({ ...d })) : void 0;
		const r = await checkProposal(proj.dir, {
			modules,
			deps
		});
		return {
			ok: r.ok,
			errors: r.errors.map(fmtDiag),
			warnings: r.warnings.map(fmtDiag),
			summary: r.errors.length + " error / " + r.warnings.length + " warning",
			hint: r.ok ? "预检通过，可以动手实现；完成后用 normify_module_refresh / normify_change_close 收尾。" : "预检未通过：按 supportedFixes 调整设计后再试。"
		};
	});
	register("normify_help", {
		description: "规范速查（按主题）：fields 模块字段 / deps 箭头与 API 直连 / renders 渲染数据 / flow 伴随开发主流程 / tools 工具清单（含必填/可选）/ policy 架构规则 / errors 常见诊断码 / all 全部 / tool:<工具名> 单个工具的完整参数树。写模块或调工具前先查对应主题，不要靠猜参数名。",
		behavior: "read",
		parameters: params({ topic: strOpt("主题：" + HELP_TOPICS.join(" | ") + " | tool:<工具名>（默认 fields）") })
	}, async (args) => {
		const raw = typeof args.topic === "string" ? args.topic.trim() : "";
		const lower = raw.toLowerCase();
		if (lower.startsWith("tool:")) {
			const name = raw.slice(raw.indexOf(":") + 1).trim();
			const hit = toolCatalog.find((t) => t.name.toLowerCase() === name.toLowerCase());
			if (hit === void 0) return {
				ok: false,
				error: {
					code: "args/unknown-tool",
					message: "未知工具：" + name + "（先用 topic:\"tools\" 看全部 " + toolCatalog.length + " 个工具名）"
				}
			};
			const ref = toolReference(hit);
			return {
				ok: true,
				topic: "tool:" + hit.name,
				title: ref.title,
				reference: ref.text,
				topics: [...HELP_TOPICS, "tool:<name>"]
			};
		}
		const topic = lower === "" ? "fields" : lower;
		if (!HELP_TOPICS.includes(topic)) return {
			ok: false,
			error: {
				code: "args/invalid-topic",
				message: "未知主题：" + raw + "（可用：" + HELP_TOPICS.join(" | ") + " | tool:<工具名>）"
			}
		};
		const ref = topicReference(topic, toolCatalog);
		return {
			ok: true,
			topic,
			title: ref.title,
			reference: ref.text,
			topics: [...HELP_TOPICS, "tool:<name>"]
		};
	});
	return specs;
}
/** 默认工具环境：结构数据项目的父目录取当前工作目录，要求双语字段。 */
const DEFAULT_TOOL_ENV = {
	rootDir: process.cwd(),
	requireBilingual: true
};
/** 便捷入口：按默认环境构建工具注册表（每个宿主/每次调用都建议各自构建一份）。 */
function createToolRegistry(env = {}) {
	return buildToolRegistry({
		rootDir: env.rootDir ?? DEFAULT_TOOL_ENV.rootDir,
		requireBilingual: env.requireBilingual ?? DEFAULT_TOOL_ENV.requireBilingual
	});
}
//#endregion
//#region src/mcp.ts
const MCP_PROTOCOL_VERSION = "2025-06-18";
function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
function sendResult(id, result) {
	send({
		jsonrpc: "2.0",
		id: id ?? null,
		result
	});
}
function sendError(id, code, message, data) {
	send({
		jsonrpc: "2.0",
		id: id ?? null,
		error: {
			code,
			message,
			...data === void 0 ? {} : { data }
		}
	});
}
/** Renders a tool payload as MCP text content: strings stay verbatim, objects become JSON. */
function toText(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
/** True when the payload carries `ok: false` — surfaced to the model as a tool error. */
function isFailure(value) {
	return typeof value === "object" && value !== null && value.ok === false;
}
/** JSON-RPC 级错误：内部抛出、dispatch 处转成 `error` 响应。 */
var JsonRpcError = class extends Error {
	jsonRpc;
	constructor(code, message) {
		super(message);
		this.name = "JsonRpcError";
		this.jsonRpc = {
			code,
			message
		};
	}
};
function createMcpServer(options) {
	const { name, version, tools } = options;
	const handlers = new Map(tools.map((tool) => [tool.name, tool]));
	/** MCP `tools/list` entries: name, description and the compiled JSON Schema. */
	const list = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters ?? {
			type: "object",
			properties: {},
			additionalProperties: false
		}
	}));
	async function runTool(params) {
		const toolName = params?.name;
		const args = params?.arguments ?? {};
		if (typeof toolName !== "string") return {
			content: [{
				type: "text",
				text: "Missing tool name."
			}],
			isError: true
		};
		const tool = handlers.get(toolName);
		if (tool === void 0) return {
			content: [{
				type: "text",
				text: `Unknown tool: ${toolName}. Available tools: ${[...handlers.keys()].join(", ")}.`
			}],
			isError: true
		};
		try {
			const value = await tool.execute(args);
			return {
				content: [{
					type: "text",
					text: toText(value)
				}],
				...isFailure(value) ? { isError: true } : {}
			};
		} catch (error) {
			return {
				content: [{
					type: "text",
					text: `Tool "${toolName}" failed: ${error instanceof Error ? error.message : String(error)}`
				}],
				isError: true
			};
		}
	}
	async function handleRequest(message) {
		switch (message.method) {
			case "initialize": return {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: {
					name,
					version
				}
			};
			case "ping": return {};
			case "tools/list": return { tools: [...list] };
			case "tools/call": return runTool(message.params);
			default: throw new JsonRpcError(-32601, `Method not found: ${message.method}`);
		}
	}
	function listen() {
		const rl = createInterface({
			input: process.stdin,
			terminal: false
		});
		let queue = Promise.resolve();
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let message;
			try {
				message = JSON.parse(trimmed);
			} catch (error) {
				sendError(void 0, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			if (message.method?.startsWith("notifications/")) return;
			queue = queue.then(() => dispatch(message));
		});
		rl.on("close", () => {
			process.exit(0);
		});
	}
	async function dispatch(message) {
		const { id } = message;
		try {
			sendResult(id, await handleRequest(message));
		} catch (error) {
			if (error instanceof JsonRpcError) {
				sendError(id, error.jsonRpc.code, error.jsonRpc.message);
				return;
			}
			sendError(id, -32603, error instanceof Error ? error.message : String(error));
		}
	}
	return {
		tools,
		handleRequest,
		listen
	};
}
//#endregion
//#region src/plugin-bin.ts
createMcpServer({
	name: "normify",
	version: "0.5.4",
	tools: createToolRegistry({ rootDir: process.cwd() })
}).listen();
//#endregion
export {};
