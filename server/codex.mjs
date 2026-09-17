import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function readAuth() {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    return { authPath, auth: JSON.parse(fs.readFileSync(authPath, 'utf8')) };
  } catch {
    return { authPath, auth: null };
  }
}

function hasCodexBinary() {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['codex'], { encoding: 'utf8' }).trim();
    return Boolean(out.split(/\r?\n/).filter(Boolean)[0]);
  } catch {
    return false;
  }
}

/** Extract an API key Codex stored locally. ChatGPT OAuth tokens are not API keys. */
export function extractCodexApiKey(auth) {
  if (!auth || typeof auth !== 'object') return '';
  const candidates = [
    auth.OPENAI_API_KEY,
    auth.api_key,
    auth.apiKey,
    auth.tokens?.api_key,
    auth.tokens?.apiKey,
    auth.tokens?.openai_api_key,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().startsWith('sk-') && value.trim().length < 300) {
      return value.trim();
    }
  }
  return '';
}

export function probeCodex() {
  const binary = hasCodexBinary();
  const { authPath, auth } = readAuth();
  const apiKey = extractCodexApiKey(auth);
  const hasTokens = Boolean(auth?.tokens?.access_token || auth?.tokens?.id_token);
  const chatgptOnly = hasTokens && !apiKey;
  return {
    binary,
    authFile: Boolean(auth),
    authPath: auth ? authPath : null,
    apiKeyPresent: Boolean(apiKey),
    chatgptSubscriptionSession: chatgptOnly,
    canImport: Boolean(apiKey),
    message: apiKey
      ? 'Local Codex has an API key Nested can import for this session.'
      : chatgptOnly
        ? 'Codex is signed in with ChatGPT, but Nested still needs an OpenAI API key. ChatGPT subscription login does not grant Responses API access for GPT-6 Astra.'
        : binary
          ? 'Codex CLI is installed. Sign in with an API key (`codex login --with-api-key`) or paste a key below.'
          : 'Codex CLI was not found. Paste an OpenAI API key to use GPT-6 Astra.',
  };
}

export function importCodexApiKey() {
  const probe = probeCodex();
  const { auth } = readAuth();
  const key = extractCodexApiKey(auth);
  if (!key) {
    const error = new Error(probe.message);
    error.status = 400;
    throw error;
  }
  return { key, message: 'Imported API key from local Codex for this session. ChatGPT subscription login was not used as an API credential.' };
}
