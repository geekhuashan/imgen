import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { detectTerminal, platformSandboxTag } from "./fingerprint.js";
import { BASE_INSTRUCTIONS } from "./instructions.js";
const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const REQUEST_TIMEOUT_S = 600;
const MAX_EDIT_IMAGES = 5;
const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};
function createTurnContext(sessionId, threadId) {
    return {
        turnId: randomUUID(),
        timestampMs: Date.now(),
        sessionId,
        threadId,
        windowId: `${threadId}:0`,
    };
}
function turnMetadataJson(ctx) {
    return JSON.stringify({
        turn_id: ctx.turnId,
        turn_started_at_unix_ms: ctx.timestampMs,
        session_id: ctx.sessionId,
        thread_id: ctx.threadId,
        sandbox: platformSandboxTag(),
        request_kind: "turn",
        window_id: ctx.windowId,
        workspace_kind: "local",
        has_changes: false,
    });
}
// ---------------------------------------------------------------------------
// User-Agent  (matches codex_cli_rs format exactly)
// ---------------------------------------------------------------------------
function buildUserAgent(identity) {
    const base = `codex_cli_rs/${identity.codexVersion} (${identity.osType} ${identity.osVersion}; ${identity.arch})`;
    const terminal = detectTerminal();
    return terminal ? `${base} ${terminal}` : base;
}
// ---------------------------------------------------------------------------
// Headers — full Codex CLI header set
// ---------------------------------------------------------------------------
function buildHeaders(token, accountId, identity, turn) {
    const metadataStr = turnMetadataJson(turn);
    return {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        originator: "codex_cli_rs",
        "User-Agent": buildUserAgent(identity),
        "OAI-Product-Sku": "codex",
        "x-codex-installation-id": identity.installationId,
        "x-codex-window-id": turn.windowId,
        "x-responses": "api-include-timing-metrics",
        "session-id": turn.sessionId,
        "thread-id": turn.threadId,
        "x-client-request-id": turn.turnId,
        "x-codex-turn-metadata": metadataStr,
    };
}
function buildOpenAiApiHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
    };
}
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Validation/usage error → CLI exit code 2. */
export function usageError(message) {
    return Object.assign(new Error(message), { exitCode: 2 });
}
// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
/** Read an input image and return a base64 data URL. Throws usageError on problems. */
export function imageToDataUrl(path) {
    if (!existsSync(path))
        throw usageError(`输入图不存在: ${path}`);
    const ext = extname(path).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
        throw usageError(`不支持的图片类型: ${ext || "(无扩展名)"}（支持 png/jpg/jpeg/webp/gif）`);
    }
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}
/** image_generation tool config. */
export function imageTool(o) {
    const tool = { type: "image_generation" };
    if (o.imageModel && o.imageModel !== "auto")
        tool["model"] = o.imageModel;
    if (o.size && o.size !== "auto")
        tool["size"] = o.size;
    if (o.quality && o.quality !== "auto")
        tool["quality"] = o.quality;
    if (o.background && o.background !== "auto")
        tool["background"] = o.background;
    return tool;
}
// ---------------------------------------------------------------------------
// Request body builder  (pure — no identity dependency, testable)
// ---------------------------------------------------------------------------
export function buildRequest(o, imageParts) {
    const content = [
        { type: "input_text", text: o.prompt },
        ...imageParts,
    ];
    return {
        model: o.model,
        instructions: BASE_INSTRUCTIONS,
        input: [{ type: "message", role: "user", content }],
        tools: [imageTool(o)],
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        store: false,
        reasoning: { effort: o.reasoningEffort },
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
    };
}
function parseSseWithStats(text) {
    const events = [];
    const lines = text.split(/\r?\n/);
    let dataLineCount = 0;
    let parseErrorCount = 0;
    for (const line of lines) {
        if (!line.startsWith("data:"))
            continue;
        dataLineCount += 1;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]")
            continue;
        try {
            events.push(JSON.parse(data));
        }
        catch {
            parseErrorCount += 1;
        }
    }
    return {
        events,
        lineCount: lines.length,
        dataLineCount,
        parseErrorCount,
    };
}
function parseSse(text) {
    return parseSseWithStats(text).events;
}
function asLongB64(value) {
    return typeof value === "string" && value.length > 100 ? value : null;
}
function redactDiagnosticText(value) {
    return value
        .replace(/data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+/gi, "<redacted-image-data>")
        .replace(/[A-Za-z0-9+/=]{200,}/g, "<redacted-long-token>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000);
}
/** Summarize SSE structure without persisting image Base64 bodies. */
export function summarizeSse(text) {
    const parsed = parseSseWithStats(text);
    const eventTypeCounts = {};
    const finalImageLengths = [];
    const partialImageLengths = [];
    const failureMessages = [];
    const eventTypes = [];
    for (const event of parsed.events) {
        const eventType = typeof event.type === "string" && event.type.trim() ? event.type : "<missing>";
        eventTypes.push(eventType);
        eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
        const item = event.item;
        if (event.type === "response.output_item.done" &&
            item &&
            item["type"] === "image_generation_call" &&
            typeof item["result"] === "string") {
            finalImageLengths.push(item["result"].length);
        }
        if (typeof event.type === "string" && event.type.includes("partial_image")) {
            const partial = typeof event["partial_image_b64"] === "string"
                ? event["partial_image_b64"]
                : event["result"];
            if (typeof partial === "string")
                partialImageLengths.push(partial.length);
        }
        if (event.type === "response.failed" || event.type === "error") {
            const message = describeFailure(event);
            if (message)
                failureMessages.push(redactDiagnosticText(message));
        }
    }
    return {
        response_bytes: Buffer.byteLength(text, "utf8"),
        line_count: parsed.lineCount,
        data_line_count: parsed.dataLineCount,
        parsed_event_count: parsed.events.length,
        parse_error_count: parsed.parseErrorCount,
        event_type_counts: eventTypeCounts,
        last_event_types: eventTypes.slice(-12),
        has_final_image: finalImageLengths.length > 0,
        final_image_b64_lengths: finalImageLengths,
        has_partial_image: partialImageLengths.length > 0,
        partial_image_b64_lengths: partialImageLengths,
        has_failure: failureMessages.length > 0,
        failure_messages: failureMessages,
    };
}
/** Append one JSONL diagnostic record. Failures here must never fail image generation. */
export function appendSseEventDiagnostic(path, record) {
    if (!path.trim())
        return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`warning: 无法写入 imgen SSE 摘要：${redactDiagnosticText(message)}\n`);
    }
}
/** Pull the generated image out of the SSE event stream. */
export function extractImage(text) {
    const events = parseSse(text);
    let finalB64 = null;
    let partialB64 = null;
    let size = "";
    for (const e of events) {
        const item = e.item;
        if (e.type === "response.output_item.done" && item && item["type"] === "image_generation_call") {
            const b = asLongB64(item["result"]);
            if (b) {
                finalB64 = b;
                if (typeof item["size"] === "string")
                    size = item["size"];
            }
        }
        else if (typeof e.type === "string" && e.type.includes("partial_image")) {
            const b = asLongB64(e["partial_image_b64"]) ?? asLongB64(e["result"]);
            if (b)
                partialB64 = b;
        }
    }
    const b64 = finalB64 ?? partialB64;
    if (!b64) {
        const fail = events.find((e) => e.type === "response.failed" || e.type === "error");
        throw new Error(`图片生成失败：${describeFailure(fail) ?? "后端未返回图片"}`);
    }
    return { b64, size };
}
function describeFailure(event) {
    if (!event)
        return null;
    const resp = event["response"];
    const err = event["error"] ??
        resp?.["error"];
    return err?.["message"] ?? null;
}
// ---------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------
function mapHttpError(status, text, backend) {
    const detail = extractMessage(text);
    if (status === 401 || status === 403) {
        if (backend === "openai-api") {
            return new Error(`OpenAI API 认证/权限失败 (${status})：请检查 API Key、项目权限及模型访问。${detail}`);
        }
        if (backend === "cliproxy") {
            return new Error(`CLIProxy 认证失败 (${status})：请检查 CLIPROXY_API_KEY。${detail}`);
        }
        return new Error(`认证/权限失败 (${status})：账号可能是免费号，图片生成需 Plus/Pro。${detail}`);
    }
    if (status === 429)
        return new Error(`撞限流 (429)：稍后再试。${detail}`);
    if (status === 400)
        return new Error(`请求被拒 (400)：${detail}`);
    return new Error(`后端返回 ${status}。${detail}`);
}
function extractMessage(text) {
    if (!text)
        return "";
    try {
        const j = JSON.parse(text);
        return j.error?.message ?? j.message ?? j.detail ?? text.slice(0, 300);
    }
    catch {
        return text.slice(0, 300);
    }
}
// ---------------------------------------------------------------------------
// Core request runner
// ---------------------------------------------------------------------------
// 瞬时失败重试配置：后端常吐 "An error occurred while processing your request"
// （200 流里的 response.failed）、429、5xx —— 这些 OpenAI 自己说 "You can retry"。
const DEFAULT_MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [2000, 6000, 15000]; // 第 2/3/4 次尝试前的等待
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Keep the default retry policy, while allowing one-shot automation via env. */
export function maxAttemptsFromEnv(raw = process.env["IMGEN_MAX_ATTEMPTS"]) {
    if (raw === undefined || raw.trim() === "")
        return DEFAULT_MAX_ATTEMPTS;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
        throw usageError("IMGEN_MAX_ATTEMPTS 必须是 1 到 10 的整数");
    }
    return parsed;
}
/** 仅对瞬时/服务端类错误重试；认证、400、输入校验等永久错误立即放弃。 */
export function isRetryableFailure(message) {
    const m = message.toLowerCase();
    return (m.includes("an error occurred while processing your request") || // 后端瞬时内部错误
        m.includes("后端未返回图片") || // SSE 空流，瞬时
        message.includes("撞限流 (429)") || // 限流
        /后端返回 5\d\d/.test(message) || // 5xx
        m.includes("timeout") ||
        m.includes("timed out") ||
        m.includes("econnreset") ||
        m.includes("socket") ||
        m.includes("network"));
}
async function runRequestOnce(ctx, request, invocationId, internalAttempt) {
    const backend = ctx.backend ?? "chatgpt";
    const turn = createTurnContext(ctx.sessionId, ctx.threadId);
    const startedAt = Date.now();
    const diagnosticPath = process.env["IMGEN_SSE_EVENT_SUMMARY_PATH"]?.trim() ?? "";
    const outerAttemptRaw = process.env["IMGEN_OUTER_ATTEMPT"]?.trim() ?? "";
    const outerAttemptNumber = Number(outerAttemptRaw);
    const outerAttempt = outerAttemptRaw && Number.isInteger(outerAttemptNumber) && outerAttemptNumber > 0
        ? outerAttemptNumber
        : null;
    let url;
    let hdrs;
    let body;
    if (backend === "openai-api") {
        url = OPENAI_RESPONSES_URL;
        hdrs = buildOpenAiApiHeaders(ctx.token);
        const { instructions: _instructions, include: _include, ...apiRequest } = request;
        body = apiRequest;
    }
    else if (backend === "cliproxy") {
        if (!ctx.baseUrl)
            throw new Error("CLIProxy 后端缺少地址");
        url = `${ctx.baseUrl.replace(/\/+$/, "")}/responses`;
        hdrs = buildOpenAiApiHeaders(ctx.token);
        // The proxy picks the Codex account and supplies its own client identity; the body stays Codex-shaped.
        body = request;
    }
    else {
        if (!ctx.identity)
            throw new Error("ChatGPT 后端缺少 Codex 客户端身份");
        url = CHATGPT_RESPONSES_URL;
        hdrs = buildHeaders(ctx.token, ctx.accountId, ctx.identity, turn);
        // Enrich body with client_metadata (matches real Codex)
        body = {
            ...request,
            prompt_cache_key: ctx.threadId,
            client_metadata: {
                "x-codex-installation-id": ctx.identity.installationId,
            },
        };
    }
    let res;
    try {
        res = await ctx.session.post(url, hdrs, JSON.stringify(body));
    }
    catch (error) {
        const transportError = redactDiagnosticText(error instanceof Error ? error.message : String(error));
        appendSseEventDiagnostic(diagnosticPath, {
            schema_version: 1,
            recorded_at: new Date().toISOString(),
            invocation_id: invocationId,
            request_id: turn.turnId,
            internal_attempt: internalAttempt,
            outer_attempt: outerAttempt,
            duration_ms: Date.now() - startedAt,
            http_status: null,
            transport_error: transportError,
            ...summarizeSse(""),
        });
        throw error;
    }
    appendSseEventDiagnostic(diagnosticPath, {
        schema_version: 1,
        recorded_at: new Date().toISOString(),
        invocation_id: invocationId,
        request_id: turn.turnId,
        internal_attempt: internalAttempt,
        outer_attempt: outerAttempt,
        duration_ms: Date.now() - startedAt,
        http_status: res.status,
        transport_error: null,
        ...summarizeSse(res.text),
    });
    if (res.status !== 200)
        throw mapHttpError(res.status, res.text, backend);
    return extractImage(res.text);
}
async function runRequest(ctx, request) {
    let lastErr;
    const maxAttempts = maxAttemptsFromEnv();
    const invocationId = randomUUID();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // 每次尝试都用全新的 turn（runRequestOnce 内部新建 turnId）
            return await runRequestOnce(ctx, request, invocationId, attempt);
        }
        catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const isUsage = err.exitCode === 2;
            if (isUsage || attempt >= maxAttempts || !isRetryableFailure(msg))
                throw err;
            const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 15000;
            process.stderr.write(`第 ${attempt}/${maxAttempts} 次失败，${Math.round(wait / 1000)}s 后重试：${msg}\n`);
            await sleep(wait);
        }
    }
    throw lastErr;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function generate(ctx, o) {
    return runRequest(ctx, buildRequest(o, []));
}
export async function edit(ctx, o) {
    if (o.imagePaths.length < 1 || o.imagePaths.length > MAX_EDIT_IMAGES) {
        throw usageError(`图生图需要 1~${MAX_EDIT_IMAGES} 张输入图，收到 ${o.imagePaths.length} 张`);
    }
    const parts = o.imagePaths.map((p) => ({ type: "input_image", image_url: imageToDataUrl(p) }));
    return runRequest(ctx, buildRequest(o, parts));
}
