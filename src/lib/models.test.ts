import { test } from "node:test";
import assert from "node:assert/strict";
import { authFor, chatModels, modelSlot, pageRewriteTokens, pickDefaultModel, webSearchFor } from "./models";

const auth = { openai: "key", anthropic: "subscription" } as const;

test("authFor and modelSlot only give OpenAI and Anthropic a plan slot", () => {
  assert.equal(authFor({ auth }, "anthropic"), "subscription");
  assert.equal(authFor({ auth }, "ollama"), undefined);
  assert.equal(modelSlot("anthropic", "subscription"), "anthropic-subscription");
  assert.equal(modelSlot("openai", "key"), "openai");
  assert.equal(modelSlot("ollama", "subscription"), "ollama");
});

test("webSearchFor is on for Anthropic either way and for OpenAI only on a plan", () => {
  assert.deepEqual(
    [webSearchFor("anthropic", "key"), webSearchFor("openai", "subscription"), webSearchFor("openai", "key"), webSearchFor("custom", undefined)],
    [true, true, false, false],
  );
});

test("chatModels keeps OpenAI chat models, sorted, and drops dated snapshots and non-chat models", () => {
  const list = ["whisper-1", "gpt-5", "gpt-4o-2024-08-06", "o3", "text-embedding-3", "gpt-4o-mini-tts", "chatgpt-4o-latest", "gpt-4.1-mini"];
  assert.deepEqual(chatModels("openai", "key", list), ["chatgpt-4o-latest", "gpt-4.1-mini", "gpt-5", "o3"]);
  assert.deepEqual(chatModels("anthropic", "key", ["claude-opus-5-5", "other"]), ["claude-opus-5-5"]);
  assert.deepEqual(chatModels("openai", "subscription", ["anything"]), ["anything"]);
});

test("pickDefaultModel starts on the cheapest tier it recognises, else the first listed", () => {
  assert.equal(pickDefaultModel("anthropic", "key", ["claude-opus-5-5", "claude-haiku-5-5"]), "claude-haiku-5-5");
  assert.equal(pickDefaultModel("openai", "key", ["gpt-5", "gpt-5-mini", "gpt-5-nano"]), "gpt-5-nano");
  assert.equal(pickDefaultModel("ollama", undefined, ["llama3:8b", "llama3:70b"]), "llama3:8b");
  assert.equal(pickDefaultModel("openai", "key", []), undefined);
});

test("pageRewriteTokens scales with the page, never under 4000, and stops at the model's cap", () => {
  assert.equal(pageRewriteTokens(100, { provider: "anthropic", auth: "key", model: "claude-opus-5-5" }), 4000);
  assert.equal(pageRewriteTokens(40_000, { provider: "anthropic", auth: "key", model: "claude-opus-5-5" }), 15_000);
  assert.equal(pageRewriteTokens(400_000, { provider: "anthropic", auth: "key", model: "claude-opus-5-5" }), 32_000);
  assert.equal(pageRewriteTokens(400_000, { provider: "openai", auth: "key", model: "gpt-4o" }), 16_384);
  assert.equal(pageRewriteTokens(400_000, { provider: "openai", auth: "key", model: "gpt-5" }), 32_000);
  assert.equal(pageRewriteTokens(400_000, { provider: "ollama", model: "llama3" }), 8192);
  assert.equal(pageRewriteTokens(400_000, { provider: "anthropic", auth: "subscription", model: "opus" }), 150_000);
});
