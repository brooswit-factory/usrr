import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { mcpConfigPath } from "../src/paths";

const repoRoot = dirname(import.meta.dir);
const defaultPath = `${repoRoot}/.mcp.json`;

describe("mcpConfigPath", () => {
  const original = process.env["USRR_MCP_CONFIG"];
  afterEach(() => {
    if (original === undefined) delete process.env["USRR_MCP_CONFIG"];
    else process.env["USRR_MCP_CONFIG"] = original;
  });

  test("defaults to .mcp.json at the repo root, not the daemon's working directory", () => {
    delete process.env["USRR_MCP_CONFIG"];
    expect(mcpConfigPath()).toBe(defaultPath);
  });

  test("USRR_MCP_CONFIG overrides the default", () => {
    process.env["USRR_MCP_CONFIG"] = "/custom/path/.mcp.json";
    expect(mcpConfigPath()).toBe("/custom/path/.mcp.json");
  });

  test("an empty USRR_MCP_CONFIG is treated as unset", () => {
    process.env["USRR_MCP_CONFIG"] = "";
    expect(mcpConfigPath()).toBe(defaultPath);
  });
});
