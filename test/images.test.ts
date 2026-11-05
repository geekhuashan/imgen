import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageTool,
  buildRequest,
  generate,
  imageToDataUrl,
  extractImage,
  usageError,
  isRetryableFailure,
  maxAttemptsFromEnv,
  appendSseEventDiagnostic,
  summarizeSse,
  type GenOptions,
  type RequestContext,
  type SseEventDiagnosticRecord,
} from "../src/images.js";

const baseOpts: GenOptions = {
  prompt: "a fox",
  model: "gpt-5.4",
  reasoningEffort: "medium",
  size: "auto",
  quality: "auto",
  background: "auto",
};

test("imageTool: auto 时省略 size/quality/background", () => {
  const t = imageTool(baseOpts);
  assert.equal(t["type"], "image_generation");
  assert.equal("size" in t, false);
  assert.equal("quality" in t, false);
  assert.equal("background" in t, false);
});

test("imageTool: 非 auto 时带上参数", () => {
  const t = imageTool({
    ...baseOpts,
    imageModel: "gpt-image-2.5-sunburst",
    size: "3840x2160",
    quality: "max",
  });
  assert.equal(t["model"], "gpt-image-2.5-sunburst");
  assert.equal(t["size"], "3840x2160");
  assert.equal(t["quality"], "max");
  assert.equal("background" in t, false);
});

test("imageTool: Flare 图片模型可独立于编排模型选择", () => {
  const t = imageTool({ ...baseOpts, imageModel: "gpt-image-2.5-flare" });
  assert.equal(t["model"], "gpt-image-2.5-flare");
  assert.equal(baseOpts.model, "gpt-5.4");
});

test("buildRequest 文生图：input 含 prompt、tools 含 image_generation、无输入图", () => {
  const req = buildRequest(baseOpts, []);
  const input = req["input"] as Array<{ content: Array<{ type: string; text?: string }> }>;
  assert.equal(input[0]?.content[0]?.text, "a fox");
  assert.equal(input[0]?.content.length, 1);
  const tools = req["tools"] as Array<{ type: string }>;
  assert.equal(tools[0]?.type, "image_generation");
  assert.equal(req["stream"], true);
  assert.equal(req["parallel_tool_calls"], false);
  assert.equal(req["store"], false);
});

test("buildRequest 图生图：content 带 input_image", () => {
  const req = buildRequest(baseOpts, [{ type: "input_image", image_url: "data:image/png;base64,AA" }]);
  const input = req["input"] as Array<{ content: Array<{ type: string }> }>;
  assert.equal(input[0]?.content.length, 2);
  assert.equal(input[0]?.content[1]?.type, "input_image");
});

test("buildRequest 透传 reasoning effort", () => {
  const req = buildRequest({ ...baseOpts, model: "gpt-5.6-sol", reasoningEffort: "xhigh" }, []);
  assert.equal(req["model"], "gpt-5.6-sol");
  assert.deepEqual(req["reasoning"], { effort: "xhigh" });
});

test("imageToDataUrl 生成 data URL 并按扩展名判 mime", () => {
  const dir = mkdtempSync(join(tmpdir(), "imgen-img-"));
  try {
    const p = join(dir, "x.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.ok(imageToDataUrl(p).startsWith("data:image/png;base64,"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("imageToDataUrl 不存在文件抛 usageError(exitCode=2)", () => {
  try {
    imageToDataUrl("/no/such/file.png");
    assert.fail("应当抛错");
  } catch (error: unknown) {
    assert.equal((error as { exitCode?: number }).exitCode, 2);
  }
});

test("extractImage 从 output_item.done 取最终图 + size", () => {
  const b64 = Buffer.from([1, 2, 3, 4]).toString("base64").repeat(40);
  const sse =
    `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${b64}","size":"1024x1024"}}\n\n` +
    `data: {"type":"response.completed"}\n\n`;
  const r = extractImage(sse);
  assert.equal(r.b64, b64);
  assert.equal(r.size, "1024x1024");
});

test("extractImage 失败事件抛错", () => {
  const sse = `data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n`;
  assert.throws(() => extractImage(sse), /boom/);
});

test("summarizeSse 保存事件结构和图片长度但不泄露 Base64", () => {
  const partial = "P".repeat(256);
  const final = "F".repeat(512);
  const sse =
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${partial}"}\n\n` +
    `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${final}","size":"1024x1024"}}\n\n` +
    `data: {"type":"response.completed"}\n\n` +
    `data: not-json\n\n`;
  const summary = summarizeSse(sse);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.has_final_image, true);
  assert.deepEqual(summary.final_image_b64_lengths, [512]);
  assert.equal(summary.has_partial_image, true);
  assert.deepEqual(summary.partial_image_b64_lengths, [256]);
  assert.equal(summary.parse_error_count, 1);
  assert.equal(summary.event_type_counts["response.completed"], 1);
  assert.equal(serialized.includes(final), false);
  assert.equal(serialized.includes(partial), false);
});

test("appendSseEventDiagnostic 追加脱敏 JSONL 记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "imgen-sse-"));
  try {
    const path = join(dir, "slot.imgen-sse.jsonl");
    const summary = summarizeSse(
      `data: {"type":"response.failed","response":{"error":{"message":"temporary failure"}}}\n\n`,
    );
    const record: SseEventDiagnosticRecord = {
      schema_version: 1,
      recorded_at: "2026-07-24T00:00:00.000Z",
      invocation_id: "invocation-1",
      request_id: "request-1",
      internal_attempt: 1,
      outer_attempt: 7,
      duration_ms: 123,
      http_status: 200,
      transport_error: null,
      ...summary,
    };
    appendSseEventDiagnostic(path, record);
    appendSseEventDiagnostic(path, { ...record, outer_attempt: 8 });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] ?? "{}").outer_attempt, 7);
    assert.equal(JSON.parse(lines[1] ?? "{}").outer_attempt, 8);
    assert.equal(lines.join("").includes("temporary failure"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate 自动记录 HTTP SSE 摘要和 transport_error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imgen-request-sse-"));
  const path = join(dir, "slot.imgen-sse.jsonl");
  const final = "Z".repeat(512);
  const oldPath = process.env["IMGEN_SSE_EVENT_SUMMARY_PATH"];
  const oldOuterAttempt = process.env["IMGEN_OUTER_ATTEMPT"];
  const oldMaxAttempts = process.env["IMGEN_MAX_ATTEMPTS"];
  process.env["IMGEN_SSE_EVENT_SUMMARY_PATH"] = path;
  process.env["IMGEN_OUTER_ATTEMPT"] = "9";
  process.env["IMGEN_MAX_ATTEMPTS"] = "1";
  const context = (session: { post: () => Promise<{ status: number; text: string }> }) =>
    ({
      session,
      token: "test-token",
      accountId: "test-account",
      identity: {
        tls: { ja3: "auto", akamai: "auto", label: "test" },
        codexVersion: "0.0.0",
        installationId: "test-installation",
        osType: "darwin",
        osVersion: "test",
        arch: "arm64",
      },
      sessionId: "test-session",
      threadId: "test-thread",
    }) as unknown as RequestContext;

  try {
    const result = await generate(
      context({
        post: async () => ({
          status: 200,
          text:
            `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${final}","size":"1024x1024"}}\n\n` +
            `data: {"type":"response.completed"}\n\n`,
        }),
      }),
      baseOpts,
    );
    assert.equal(result.b64, final);

    await assert.rejects(
      generate(
        context({
          post: async () => {
            throw new Error("HTTP/2 socket framing failure");
          },
        }),
        baseOpts,
      ),
      /socket framing failure/,
    );

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const success = JSON.parse(lines[0] ?? "{}");
    const transport = JSON.parse(lines[1] ?? "{}");
    assert.equal(success.http_status, 200);
    assert.equal(success.outer_attempt, 9);
    assert.deepEqual(success.final_image_b64_lengths, [512]);
    assert.equal(transport.http_status, null);
    assert.equal(transport.transport_error, "HTTP/2 socket framing failure");
    assert.equal(lines.join("").includes(final), false);
  } finally {
    if (oldPath === undefined) delete process.env["IMGEN_SSE_EVENT_SUMMARY_PATH"];
    else process.env["IMGEN_SSE_EVENT_SUMMARY_PATH"] = oldPath;
    if (oldOuterAttempt === undefined) delete process.env["IMGEN_OUTER_ATTEMPT"];
    else process.env["IMGEN_OUTER_ATTEMPT"] = oldOuterAttempt;
    if (oldMaxAttempts === undefined) delete process.env["IMGEN_MAX_ATTEMPTS"];
    else process.env["IMGEN_MAX_ATTEMPTS"] = oldMaxAttempts;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate 的 OpenAI API 后端使用官方 Responses URL 和显式图片模型", async () => {
  const final = "A".repeat(512);
  let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  const context = {
    backend: "openai-api",
    session: {
      post: async (url: string, headers: Record<string, string>, rawBody: string) => {
        captured = { url, headers, body: JSON.parse(rawBody) as Record<string, unknown> };
        return {
          status: 200,
          text:
            `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${final}","size":"1024x1024"}}\n\n` +
            `data: {"type":"response.completed"}\n\n`,
        };
      },
    },
    token: "test-api-key",
    accountId: "",
    sessionId: "test-session",
    threadId: "test-thread",
  } as unknown as RequestContext;

  const result = await generate(context, {
    ...baseOpts,
    imageModel: "gpt-image-2.5-flare",
    quality: "xhigh",
  });
  assert.equal(result.b64, final);
  assert.ok(captured);
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.headers["Authorization"], "Bearer test-api-key");
  assert.equal("ChatGPT-Account-Id" in captured.headers, false);
  assert.equal("client_metadata" in captured.body, false);
  const tools = captured.body["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.["model"], "gpt-image-2.5-flare");
  assert.equal(tools[0]?.["quality"], "xhigh");
});

test("generate 的 CLIProxy 后端发到 <base>/responses，保留 Codex 请求体", async () => {
  const final = "B".repeat(512);
  let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  const context = {
    backend: "cliproxy",
    baseUrl: "https://proxy.example.test/v1/",
    session: {
      post: async (url: string, headers: Record<string, string>, rawBody: string) => {
        captured = { url, headers, body: JSON.parse(rawBody) as Record<string, unknown> };
        return {
          status: 200,
          text:
            `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${final}","size":"1024x1024"}}\n\n` +
            `data: {"type":"response.completed"}\n\n`,
        };
      },
    },
    token: "test-proxy-key",
    accountId: "",
    sessionId: "test-session",
    threadId: "test-thread",
  } as unknown as RequestContext;

  const result = await generate(context, baseOpts);
  assert.equal(result.b64, final);
  assert.ok(captured);
  assert.equal(captured.url, "https://proxy.example.test/v1/responses");
  assert.equal(captured.headers["Authorization"], "Bearer test-proxy-key");
  assert.equal("ChatGPT-Account-Id" in captured.headers, false);
  assert.equal("client_metadata" in captured.body, false);
  assert.equal(typeof captured.body["instructions"], "string");
  const tools = captured.body["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.["type"], "image_generation");
});

test("generate 只在 openai-api 后端下发 reasoning effort", async () => {
  const final = "C".repeat(512);
  const sent = async (backend: "chatgpt" | "cliproxy" | "openai-api") => {
    let captured: Record<string, unknown> | null = null;
    const context = {
      backend,
      baseUrl: "https://proxy.example.test/v1",
      session: {
        post: async (_url: string, _headers: Record<string, string>, rawBody: string) => {
          captured = JSON.parse(rawBody) as Record<string, unknown>;
          return {
            status: 200,
            text: `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${final}"}}\n\n`,
          };
        },
      },
      token: "test-token",
      accountId: "test-account",
      identity: {
        tls: { ja3: "auto", akamai: "auto", label: "test" },
        codexVersion: "0.0.0",
        installationId: "test-installation",
        osType: "darwin",
        osVersion: "test",
        arch: "arm64",
      },
      sessionId: "test-session",
      threadId: "test-thread",
    } as unknown as RequestContext;
    await generate(context, { ...baseOpts, reasoningEffort: "low" });
    assert.ok(captured);
    return captured as Record<string, unknown>;
  };

  assert.equal("reasoning" in (await sent("chatgpt")), false);
  assert.equal("reasoning" in (await sent("cliproxy")), false);
  assert.deepEqual((await sent("openai-api"))["reasoning"], { effort: "low" });
});

test("usageError 带 exitCode 2", () => {
  assert.equal((usageError("bad") as { exitCode?: number }).exitCode, 2);
});

test("isRetryableFailure：后端瞬时错误 / 空流 / 429 / 5xx / 网络 → 重试", () => {
  assert.equal(
    isRetryableFailure("图片生成失败：An error occurred while processing your request. ... request ID abc"),
    true,
  );
  assert.equal(isRetryableFailure("图片生成失败：后端未返回图片"), true);
  assert.equal(isRetryableFailure("撞限流 (429)：稍后再试。"), true);
  assert.equal(isRetryableFailure("后端返回 503。"), true);
  assert.equal(isRetryableFailure("request timed out"), true);
});

test("isRetryableFailure：认证 / 400 / 内容拒绝 → 不重试", () => {
  assert.equal(isRetryableFailure("认证/权限失败 (401)：账号可能是免费号。"), false);
  assert.equal(isRetryableFailure("请求被拒 (400)：bad size"), false);
  assert.equal(
    isRetryableFailure("Your request was rejected as a result of our safety system."),
    false,
  );
});

test("maxAttemptsFromEnv：默认 4，写真任务可锁为一次", () => {
  assert.equal(maxAttemptsFromEnv(undefined), 4);
  assert.equal(maxAttemptsFromEnv("1"), 1);
  assert.throws(() => maxAttemptsFromEnv("0"), /1 到 10/);
  assert.throws(() => maxAttemptsFromEnv("many"), /1 到 10/);
});
