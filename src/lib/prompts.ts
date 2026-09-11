import type { ChatMessage, PageMeta, Settings } from "../platform/types";

export type ContextPage = { meta: PageMeta; body: string };

export type AskContext = {
  page: ContextPage;
  selection?: string;
  paragraph?: string;
  /** Other pages in the session, nearest first. */
  session: ContextPage[];
  /** Every other page in the folder. */
  folder: ContextPage[];
  settings: Settings;
  /** Prior question/answer pairs in an inline card. */
  thread?: { question: string; answer: string }[];
};

const BUDGET = 60_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…";
}

function contextBlock(ctx: AskContext): string {
  const parts: string[] = [];
  let used = 0;
  const push = (label: string, text: string, max: number) => {
    const t = clip(text.trim(), max);
    if (!t) return;
    if (used + t.length > BUDGET) return;
    used += t.length;
    parts.push(`${label}\n${t}`);
  };
  push(`Current page: ${ctx.page.meta.title}`, ctx.page.body, 12_000);
  if (ctx.settings.context.highlight && ctx.paragraph) push("Paragraph containing the highlight:", ctx.paragraph, 4_000);
  if (ctx.settings.context.highlight && ctx.selection) push("Highlighted text:", ctx.selection, 2_000);
  if (ctx.settings.context.session) {
    for (const p of ctx.session) push(`Session page: ${p.meta.title}`, p.body, 6_000);
  }
  if (ctx.settings.context.folder) {
    for (const p of ctx.folder) push(`Folder page: ${p.meta.title}`, p.body, 3_000);
  }
  return parts.join("\n\n");
}

const VOICE =
  "Write plainly and precisely, in the register of the page: short declarative sentences, no hype, no preamble, no closing summary. Do not mention that you are an AI.";

export function quickAnswerMessages(ctx: AskContext, question: string): { system: string; messages: ChatMessage[] } {
  const system = `You are the research assistant inside a markdown reader. Answer the reader's question about the highlighted text in two to four sentences. ${VOICE} Return plain prose, no headings, no lists.`;
  const messages: ChatMessage[] = [];
  const thread = ctx.thread ?? [];
  const base = contextBlock(ctx);
  if (thread.length === 0) {
    messages.push({ role: "user", content: `${base}\n\nQuestion: ${question || `Explain: ${ctx.selection ?? ctx.page.meta.title}`}` });
  } else {
    messages.push({ role: "user", content: `${base}\n\nQuestion: ${thread[0].question}` });
    messages.push({ role: "assistant", content: thread[0].answer });
    for (const t of thread.slice(1)) {
      messages.push({ role: "user", content: `Question: ${t.question}` });
      messages.push({ role: "assistant", content: t.answer });
    }
    messages.push({ role: "user", content: `Question: ${question}` });
  }
  return { system, messages };
}

export function newPageMessages(ctx: AskContext, question: string, deep: boolean): { system: string; messages: ChatMessage[] } {
  const length = deep ? "six to nine paragraphs, going deeper into mechanism, evidence and open questions" : "three to five paragraphs";
  const system = `You are the research assistant inside a markdown reader. Write a short wiki-style page in Markdown that answers the reader's question about the highlighted text. Start with a level-1 heading that restates the question as a short title, then ${length}. ${VOICE} Use plain paragraphs; a short list only if the content is genuinely a list. Return only the Markdown.`;
  const q = question || `Go deeper on: ${ctx.selection ?? ctx.page.meta.title}`;
  return { system, messages: [{ role: "user", content: `${contextBlock(ctx)}\n\nQuestion: ${q}` }] };
}

export type RefineScope = "selection" | "page" | "corpus";

export function refineMessages(
  ctx: AskContext,
  instruction: string,
  scope: RefineScope,
  text: string,
): { system: string; messages: ChatMessage[] } {
  const what =
    scope === "selection"
      ? "Rewrite only the passage below. It is a fragment of a paragraph; return the replacement fragment with no surrounding text."
      : "Rewrite the Markdown page below. Keep its structure, headings and links unless the instruction says otherwise.";
  const system = `You are editing a markdown page in a research reader. ${what} Change as little as the instruction requires and keep everything else word for word. ${VOICE} Return only the rewritten text, with no commentary, no code fences.`;
  const context = scope === "selection" ? contextBlock(ctx) : ctx.settings.context.session ? contextBlock({ ...ctx, page: { ...ctx.page, body: "" } }) : "";
  const user = `${context ? context + "\n\n" : ""}Instruction: ${instruction}\n\nText to rewrite:\n${text}`;
  return { system, messages: [{ role: "user", content: user }] };
}
