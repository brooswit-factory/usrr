import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelSourceOptions, InboxMessage } from "@brooswit/drovr";
import { startMcpAndInbox } from "../src/inbox";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function fakeUsrr(respond: (body: unknown) => Response = () => Response.json({ ok: true, result: { accepted: true } })) {
  const dir = await tempDir("usrr-inbox-socket-");
  const socketPath = join(dir, "api.sock");
  const bodies: unknown[] = [];
  const server = Bun.serve({ unix: socketPath, fetch: async request => { const body = await request.json(); bodies.push(body); return respond(body); } });
  return { socketPath, bodies, stop: () => server.stop(true) };
}

describe("startMcpAndInbox", () => {
  test("a missing MCP config starts the daemon normally, doing nothing", async () => {
    const home = await tempDir("usrr-inbox-home-");
    const handle = await startMcpAndInbox({
      configPath: join(home, "does-not-exist.mcp.json"),
      agentCwd: home,
      home,
      socketPath: "/nonexistent/usrr.sock",
    });
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(readFile(join(home, ".gemini/config/mcp_config.json"))).rejects.toThrow();
  });

  test("an unparseable MCP config starts the daemon normally, doing nothing", async () => {
    const home = await tempDir("usrr-inbox-home-");
    const configPath = join(home, ".mcp.json");
    await writeFile(configPath, "{ not json");
    const handle = await startMcpAndInbox({ configPath, agentCwd: home, home, socketPath: "/nonexistent/usrr.sock" });
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(readFile(join(home, ".gemini/config/mcp_config.json"))).rejects.toThrow();
  });

  test("a definition drovr refuses starts the daemon normally, doing nothing", async () => {
    const home = await tempDir("usrr-inbox-home-");
    const configPath = join(home, ".mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { rocketr: { type: "sse", url: "http://h/sse" } } }));
    const handle = await startMcpAndInbox({ configPath, agentCwd: home, home, socketPath: "/nonexistent/usrr.sock" });
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(readFile(join(home, ".gemini/config/mcp_config.json"))).rejects.toThrow();
  });

  test("a config naming no rocketr server still provisions agy, and runs without a relay", async () => {
    const home = await tempDir("usrr-inbox-home-");
    const configPath = join(home, ".mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { butchr: { type: "http", url: "http://127.0.0.1:9/mcp" } } }));
    const handle = await startMcpAndInbox({ configPath, agentCwd: home, home, socketPath: "/nonexistent/usrr.sock" });
    const written = JSON.parse(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8"));
    expect(written.mcpServers.butchr).toEqual({ serverUrl: "http://127.0.0.1:9/mcp", disabled: false });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  test("provisions agy from the config, and relays rocketr messages into usrr turns", async () => {
    const home = await tempDir("usrr-inbox-home-");
    const usrr = await fakeUsrr();
    const configPath = join(home, ".mcp.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        rocketr: { type: "http", url: "http://127.0.0.1:8790/mcp", headers: { "x-rocketr-account": "usrr-kchb-thinkpad" } },
      },
    }));

    let captured: ChannelSourceOptions | undefined;
    let closed = false;
    const handle = await startMcpAndInbox({
      configPath,
      agentCwd: home,
      home,
      socketPath: usrr.socketPath,
      connect: async options => {
        captured = options;
        return { close: async () => { closed = true; } };
      },
    });

    const written = JSON.parse(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8"));
    expect(written.mcpServers.rocketr).toEqual({
      serverUrl: "http://127.0.0.1:8790/mcp",
      headers: { "x-rocketr-account": "usrr-kchb-thinkpad" },
      disabled: false,
    });
    const permissions = JSON.parse(await readFile(join(home, ".gemini/antigravity-cli/settings.json"), "utf8"));
    expect(permissions.permissions.allow).toEqual(["mcp(rocketr/*)"]);

    expect(captured).toBeDefined();
    const message: InboxMessage = { source: "rocketr", content: "hi from rocket.chat", meta: { room: "general" } };
    captured!.onMessage(message);
    // The relay drains asynchronously; wait for it to reach the fake usrr socket.
    await Bun.sleep(10);
    expect(usrr.bodies).toEqual([{ text: expect.stringContaining("hi from rocket.chat"), wait: false }]);

    // stop() stops both the channel source and the relay.
    await handle.stop();
    expect(closed).toBe(true);
    captured!.onMessage({ source: "rocketr", content: "after stop", meta: {} });
    await Bun.sleep(10);
    expect(usrr.bodies).toHaveLength(1);

    usrr.stop();
  });
});
