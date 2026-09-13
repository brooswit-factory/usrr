import { expect, test } from "bun:test";
import { conversationHandoff, HANDOFF_EVENT_LIMIT, HANDOFF_HISTORY_CHARS } from "../src/handoff";
import type { TranscriptEvent } from "../src/transcript";

test("handoff labels a fresh conversation and retains workspace and current message", () => {
  const prompt = conversationHandoff({ from: "agy", to: "codex", cwd: "/work/personal", history: [], message: "Continue my work" });
  expect(prompt).toContain("agy -> codex");
  expect(prompt).toContain("NEW conversation");
  expect(prompt).toContain('"/work/personal"');
  expect(prompt).toContain("has not migrated");
  expect(prompt).toEndWith("Current user message:\nContinue my work");
});

test("handoff bounds history while retaining newest events and labels truncation", () => {
  const history: TranscriptEvent[] = Array.from({ length: 50 }, (_, index) => ({
    version: 1, sequence: index + 1, timestamp: "now", role: "user", text: `event-${index + 1} ` + "x".repeat(1_000),
  }));
  const prompt = conversationHandoff({ from: "agy", to: "claude", cwd: "/work", history, message: "next" });
  const excerpt = prompt.split("<usrr-history>\n")[1]!.split("\n</usrr-history>")[0]!;
  expect(excerpt.length).toBeLessThanOrEqual(HANDOFF_HISTORY_CHARS);
  expect(excerpt).toContain("event-50");
  expect(excerpt).not.toContain("event-1 ");
  expect(excerpt).toContain("[truncated excerpt]");
  expect(excerpt.split("\n").length).toBeLessThanOrEqual(HANDOFF_EVENT_LIMIT);
});
