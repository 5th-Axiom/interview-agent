import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import {
  streamWithFallback,
  streamProvider,
  ModelConfig,
} from "../server/model";
async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const config: ModelConfig = {
    base: `http://127.0.0.1:${port}`,
    key: "test-only",
    model: "fixture",
  };
  return {
    server,
    config,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
test("SSE split bytes become complete sentences and tool arguments remain separate", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const lines = [
      { choices: [{ delta: { content: "你好，" } }] },
      { choices: [{ delta: { content: "请介绍你的项目。" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    name: "complete_interview",
                    arguments: '{"reason":',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"完成"}' } }],
            },
          },
        ],
      },
    ];
    const bytes = Buffer.from(
      lines.map((l) => "data: " + JSON.stringify(l) + "\n\n").join("") +
        "data: [DONE]\n\n",
    );
    for (let i = 0; i < bytes.length; i += 7)
      res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  try {
    const parts = [];
    for await (const p of streamProvider(
      [{ role: "user", content: "test" }],
      AbortSignal.timeout(3000),
      f.config,
    ))
      parts.push(p);
    assert.deepEqual(parts, [
      { type: "text", text: "你好，请介绍你的项目。" },
      {
        type: "tool",
        name: "complete_interview",
        arguments: { reason: "完成" },
      },
    ]);
  } finally {
    await f.close();
  }
});
test("fallback uses identical context and tools with one shared retry budget", async () => {
  let attempts = 0;
  const payloads: any[] = [];
  const f = await fixture(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    payloads.push(JSON.parse(body));
    if (++attempts === 1) {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"继续。"}}]}\n\n');
  });
  try {
    const parts = [];
    for await (const p of streamWithFallback(
      [{ role: "user", content: "连续上下文" }],
      AbortSignal.timeout(3000),
      [f.config, { ...f.config, model: "backup" }],
    ))
      parts.push(p);
    assert.equal(attempts, 2);
    assert.deepEqual(payloads[0].messages, payloads[1].messages);
    assert.deepEqual(payloads[0].tools, payloads[1].tools);
    assert.equal(payloads[1].model, "backup");
    assert.equal(parts.length, 1);
  } finally {
    await f.close();
  }
});
test("provider failure after first sentence never replays already emitted speech", async () => {
  let attempts = 0;
  const f = await fixture((_req, res) => {
    attempts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"已经播放。"}}]}\n\ndata: invalid-json\n\n',
    );
  });
  try {
    const parts = [];
    await assert.rejects(async () => {
      for await (const p of streamWithFallback(
        [{ role: "user", content: "test" }],
        AbortSignal.timeout(3000),
        [f.config],
      ))
        parts.push(p);
    });
    assert.equal(parts.length, 1);
    assert.equal(attempts, 1);
  } finally {
    await f.close();
  }
});
test("user cancellation does not retry a provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    res.end();
  });
  try {
    await assert.rejects(async () => {
      for await (const _ of streamWithFallback(
        [{ role: "user", content: "test" }],
        controller.signal,
        [f.config],
      )) {
      }
    });
    assert.equal(requests, 0);
  } finally {
    await f.close();
  }
});
test("authentication errors are not retried as transient provider failures", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    res.writeHead(401);
    res.end();
  });
  try {
    await assert.rejects(async () => {
      for await (const _ of streamWithFallback(
        [{ role: "user", content: "test" }],
        AbortSignal.timeout(2000),
        [f.config],
      )) {
      }
    });
    assert.equal(requests, 1);
  } finally {
    await f.close();
  }
});
test("streaming TTS joins partial PCM samples across adjacent JSON and SSE objects", async () => {
  const { synthesizeStream } = await import("../server/tts");
  const expected = Buffer.alloc(48000);
  for (let i = 0; i < expected.length; i++) expected[i] = (i * 17 + 3) % 255;
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = [
      { code: 0, data: expected.subarray(0, 13001).toString("base64") },
      { code: 0, data: expected.subarray(13001).toString("base64") },
      { code: 20000000 },
    ]
      .map((v) => JSON.stringify(v))
      .join("");
    for (let i = 0; i < text.length; i += 113)
      res.write(text.slice(i, i + 113));
    res.end();
  });
  const prior = {
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    TOKENDANCE_API_KEY: process.env.TOKENDANCE_API_KEY,
    TOKENDANCE_TTS_URL: process.env.TOKENDANCE_TTS_URL,
  };
  Object.assign(process.env, {
    TTS_PROVIDER: "tokendance",
    TOKENDANCE_API_KEY: "fixture-only",
    TOKENDANCE_TTS_URL: f.config.base,
  });
  try {
    const parts: Buffer[] = [];
    for await (const bytes of synthesizeStream(
      "测试",
      AbortSignal.timeout(3000),
      false,
    ))
      parts.push(bytes);
    assert.equal(parts[0].length, 7680);
    assert(
      parts.slice(1).every((p) => p.length <= 14400 && p.length % 2 === 0),
    );
    assert.deepEqual(Buffer.concat(parts), expected);
  } finally {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  }
});
test("role resolution forces a dedicated nullable tool instead of pretending spoken text changed state", async () => {
  let payload: any;
  const f = await fixture(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    payload = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: "select_role",
                      arguments: JSON.stringify({
                        role_id: null,
                        message: "想了解哪个方向？",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  try {
    const parts = [];
    for await (const part of streamProvider(
      [{ role: "user", content: "尚未决定" }],
      AbortSignal.timeout(3000),
      f.config,
      false,
      { selection: true },
    ))
      parts.push(part);
    assert.equal(payload.tools.length, 1);
    assert.equal(payload.tool_choice.function.name, "select_role");
    assert.deepEqual(
      payload.tools[0].function.parameters.properties.role_id.type,
      ["string", "null"],
    );
    assert.equal((parts[0] as any).arguments.role_id, null);
  } finally {
    await f.close();
  }
});

test("formal interviews expose only supported controls and reject a stray selection tool", async () => {
  let payload: any;
  const f = await fixture(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    payload = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: "select_role",
                      arguments: '{"role_id":null}',
                    },
                  },
                ],
              },
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  try {
    await assert.rejects(async () => {
      for await (const _part of streamProvider(
        [{ role: "user", content: "已选岗，继续面试" }],
        AbortSignal.timeout(3000),
        f.config,
      )) {
        /* Drain the provider response. */
      }
    }, /当前阶段不可用/);
    assert.deepEqual(
      payload.tools.map((tool: any) => tool.function.name),
      ["complete_interview", "request_end_confirmation"],
    );
  } finally {
    await f.close();
  }
});

test("SSE accepts optional data whitespace, terminal EOF and ignores bytes after DONE", async () => {
  for (const suffix of [
    "\ndata:[DONE]\ndata:invalid",
    "\ndata:   [DONE]",
    "",
  ]) {
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data:{"choices":[{"delta":{"content":"有效回答。"}}]}' + suffix);
    });
    try {
      const parts = [];
      for await (const p of streamProvider(
        [{ role: "user", content: "test" }],
        AbortSignal.timeout(3000),
        f.config,
      ))
        parts.push(p);
      assert.deepEqual(parts, [{ type: "text", text: "有效回答。" }]);
    } finally {
      await f.close();
    }
  }
});
