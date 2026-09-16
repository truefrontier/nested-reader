import type { ChatMessage, PageMeta, Settings } from "../platform/types";
import { queryTerms, rankByRelevance } from "./rank";
import { sessionMapForPrompt, type SummaryCache } from "./sessionmap";

export type ContextPage = { meta: PageMeta; body: string };

export type AskContext = {
  page: ContextPage;
  selection?: string;
  paragraph?: string;
  /** Other pages in the session, nearest first. */
  session: ContextPage[];
  /** Every other page in the folder. */
  folder: ContextPage[];
  /** Every page in the session, for the map; empty when the Context toggle is off. */
  mapPages?: PageMeta[];
  summaries?: SummaryCache;
  settings: Settings;
  /** Prior question/answer pairs in an inline card. */
  thread?: { question: string; answer: string }[];
};

const BUDGET = 60_000;
const PAGE_MAX = 12_000;
const SESSION_MAX = 6_000;
const FOLDER_MAX = 3_000;
/**
 * Held back for folder pages. Twelve session pages at their own limit come to more than the whole
 * budget, so without a reserve the session tier could take all of it and the folder — the tier that
 * is actually picked for relevance — would never be reached.
 */
const FOLDER_RESERVE = 15_000;
/**
 * What the session map may take. Small on purpose: it is a page-by-page index, not the pages, and
 * its job is to say what the model could go and read rather than to read it for them.
 */
const MAP_MAX = 6_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…";
}

/**
 * The pages that go to the model, in the order they earn their place.
 *
 * `query` is what the reader asked for. Folder pages are ranked against it and the ones sharing
 * no word with it are left out: there are no other signals about that tier, so without ranking
 * which pages were seen came down to the order they happened to be loaded in.
 *
 * Session pages keep their own order. Nearest-first says something ranking does not — how the
 * session was actually built — and overruling it with word counts would throw that away.
 */
function contextBlock(ctx: AskContext, query = ""): string {
  const parts: string[] = [];
  let used = 0;
  const push = (label: string, text: string, max: number, ceiling = BUDGET) => {
    const t = clip(text.trim(), max);
    if (!t) return;
    if (used + t.length > ceiling) return;
    used += t.length;
    // The map brings its own heading, so an empty label means "as written".
    parts.push(label ? `${label}\n${t}` : t);
  };
  push(`Current page: ${ctx.page.meta.title}`, ctx.page.body, PAGE_MAX);
  // Ahead of the other pages' bodies: knowing what exists is worth more than one more body.
  if (ctx.mapPages?.length) {
    push("", sessionMapForPrompt(ctx.mapPages, ctx.summaries ?? {}, query, MAP_MAX, ctx.page.meta.path), MAP_MAX);
  }
  if (ctx.settings.context.highlight && ctx.paragraph) push("Paragraph containing the highlight:", ctx.paragraph, 4_000);
  if (ctx.settings.context.highlight && ctx.selection) push("Highlighted text:", ctx.selection, 2_000);

  // Ranked on the part that would actually be sent, so a page cannot win on a passage past its limit.
  const folder = ctx.settings.context.folder
    ? rankByRelevance(queryTerms(query), ctx.folder, (p) => clip(p.body.trim(), FOLDER_MAX), (p) => p.meta.title)
    : [];
  const reserve = folder.length ? Math.max(0, Math.min(FOLDER_RESERVE, BUDGET - used)) : 0;

  if (ctx.settings.context.session) {
    for (const p of ctx.session) push(`Session page: ${p.meta.title}`, p.body, SESSION_MAX, BUDGET - reserve);
  }
  for (const p of folder) push(`Folder page: ${p.meta.title}`, p.body, FOLDER_MAX);
  return parts.join("\n\n");
}

const VOICE =
  "Write plainly and precisely, in the register of the page: short declarative sentences, no hype, no preamble, no closing summary. Do not mention that you are an AI.";

/** How the model should use the folder tools, when Settings lets it have them. */
const TOOLS =
  "You can list, read and search the pages in the session folder with the tools provided. Use them when the context given here is not enough to answer well, for instance to check a page that is only mentioned, and quote what you find. Do not narrate what you are looking up and do not write tool calls as text; call the tools, then answer.";

function tools(ctx: AskContext): string {
  return ctx.settings.tools ? ` ${TOOLS}` : "";
}

export function quickAnswerMessages(ctx: AskContext, question: string): { system: string; messages: ChatMessage[] } {
  const system = `You are the research assistant inside a markdown reader. Answer the reader's question about the highlighted text in two to four sentences. ${VOICE} Return plain prose, no headings, no lists.${tools(ctx)}`;
  const messages: ChatMessage[] = [];
  const thread = ctx.thread ?? [];
  const base = contextBlock(ctx, `${question} ${ctx.selection ?? ""}`);
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
  const system = `You are the research assistant inside a markdown reader. Write a short wiki-style page in Markdown that answers the reader's question about the highlighted text. Start with a level-1 heading that restates the question as a short title, then ${length}. ${VOICE} Use plain paragraphs; a short list only if the content is genuinely a list. Return only the Markdown.${tools(ctx)}`;
  const q = question || `Go deeper on: ${ctx.selection ?? ctx.page.meta.title}`;
  return { system, messages: [{ role: "user", content: `${contextBlock(ctx, `${q} ${ctx.selection ?? ""}`)}\n\nQuestion: ${q}` }] };
}

/**
 * A page started with ⌘N: no highlight, no source passage. The whole session is the
 * context, the reader's brief says what the page is for.
 */
export function newFileMessages(ctx: AskContext, brief: string, deep: boolean): { system: string; messages: ChatMessage[] } {
  const length = deep ? "six to nine paragraphs, going deeper into mechanism, evidence and open questions" : "three to five paragraphs";
  const system = `You are the research assistant inside a markdown reader. The reader is adding a new page to a research session and has described what it should cover. Write that page in Markdown, drawing on the session pages given as context and staying consistent with them. Start with a level-1 heading that gives the page a short title, then ${length}. ${VOICE} Use plain paragraphs; a short list only if the content is genuinely a list. Return only the Markdown.${tools(ctx)}`;
  const context = contextBlock({ ...ctx, selection: undefined, paragraph: undefined }, brief);
  return { system, messages: [{ role: "user", content: `${context}\n\nNew page: ${brief}` }] };
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
  const system = `You are editing a markdown page in a research reader. ${what} Change as little as the instruction requires and keep everything else word for word. ${VOICE} Return only the rewritten text, with no commentary, no code fences.${tools(ctx)}`;
  const query = `${instruction} ${scope === "selection" ? ctx.selection ?? "" : ctx.page.meta.title}`;
  const context = scope === "selection" ? contextBlock(ctx, query) : ctx.settings.context.session ? contextBlock({ ...ctx, page: { ...ctx.page, body: "" } }, query) : "";
  const user = `${context ? context + "\n\n" : ""}Instruction: ${instruction}\n\nText to rewrite:\n${text}`;
  return { system, messages: [{ role: "user", content: user }] };
}

/**
 * The one line the session map keeps for a page. Short, concrete, and about what the page says:
 * its only job is helping the model decide whether this is the page it wants.
 */
export function summaryMessages(title: string, body: string): { system: string; messages: ChatMessage[] } {
  const system =
    "You are indexing a folder of markdown notes. Reply with one sentence saying what this page argues or records \u2014 what someone would want to know before deciding whether to open it. Name the specifics rather than the topic: \u201cSharp-wave ripples replay waking sequences to cortex during sleep\u201d, not \u201cdiscusses memory\u201d. No preamble, no title, no quotation marks, one sentence.";
  return { system, messages: [{ role: "user", content: `Page: ${title}\n\n${body.slice(0, 4_000)}` }] };
}
