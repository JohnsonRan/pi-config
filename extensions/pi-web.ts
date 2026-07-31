import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
const TAVILY_API_URL = "https://api.tavily.com";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const SEARCH_TOOL = "web_search";
const FETCH_TOOL = "web_fetch";
const FIRECRAWL_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 65_000;

export type ProviderName = "Firecrawl" | "Tavily" | "Exa";
export type ProviderOperation = "search" | "fetch";
export type ProviderFailureKind = "unavailable" | "invalid_request" | "cancelled";

export type SearchInput = {
  query: string;
  numResults?: number;
};

export type FetchInput = {
  urls: string[];
  maxCharacters?: number;
};

export type ProviderErrorOptions = {
  provider: ProviderName;
  operation: ProviderOperation;
  kind: ProviderFailureKind;
  message: string;
  status?: number;
  disableProvider?: boolean;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly operation: ProviderOperation;
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly disableProvider: boolean;

  constructor({ provider, operation, kind, message, status, disableProvider = false, cause }: ProviderErrorOptions) {
    super(message, { cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.operation = operation;
    this.kind = kind;
    this.status = status;
    this.disableProvider = disableProvider;
  }
}

export type WebProvider = {
  name: ProviderName;
  isConfigured: () => boolean;
  search: (input: SearchInput, signal?: AbortSignal) => Promise<string>;
  fetch: (input: FetchInput, signal?: AbortSignal) => Promise<string>;
};

export type ProviderChainResult = {
  text: string;
  provider: ProviderName;
  attempts: string[];
};

const disabledProviders = new WeakMap<WebProvider, string>();

type ExaTool = typeof SEARCH_TOOL | typeof FETCH_TOOL;

type McpResponse = {
  id?: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

type FirecrawlSearchResponse = {
  success?: boolean;
  data?: {
    web?: Array<{
      title?: string;
      description?: string;
      url?: string;
      markdown?: string;
    }>;
  };
  warning?: string | null;
  error?: string;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
    };
  };
  error?: string;
};

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
  detail?: { error?: string } | string;
  error?: string;
};

type TavilyExtractResponse = {
  results?: Array<{
    url?: string;
    raw_content?: string;
  }>;
  failed_results?: Array<{
    url?: string;
    error?: string;
  }>;
  detail?: { error?: string } | string;
  error?: string;
};

let anonymousExaQueue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function combineSignals(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function waitForQueue(queue: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return queue;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    queue.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function parseJson(body: string): unknown {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function responseDetail(body: string, payload: unknown): string {
  if (isRecord(payload)) {
    const direct = cleanText(payload.error) || cleanText(payload.message);
    if (direct) return direct;

    const detail = payload.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (isRecord(detail)) {
      const nested = cleanText(detail.error) || cleanText(detail.message);
      if (nested) return nested;
    }
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

function requestError(
  provider: ProviderName,
  operation: ProviderOperation,
  error: unknown,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError({
      provider,
      operation,
      kind: "cancelled",
      message: error.message || `${provider} ${operation} cancelled`,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ProviderError({
      provider,
      operation,
      kind: "unavailable",
      message: `${provider} ${operation} timed out`,
      cause: error,
    });
  }
  return new ProviderError({
    provider,
    operation,
    kind: "unavailable",
    message: `${provider} ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

function httpProviderError(
  provider: ProviderName,
  operation: ProviderOperation,
  response: Response,
  body: string,
  payload: unknown,
): ProviderError {
  const detail = responseDetail(body, payload);
  const status = response.status;
  const unavailableStatuses = provider === "Firecrawl"
    ? new Set([401, 402, 403, 408, 429])
    : new Set([401, 403, 408, 429, 432, 433]);
  const kind: ProviderFailureKind =
    unavailableStatuses.has(status) || status >= 500 ? "unavailable" : "invalid_request";
  const permanentlyUnavailableStatuses = provider === "Firecrawl"
    ? new Set([401, 402, 403])
    : new Set([401, 403, 432, 433]);
  return new ProviderError({
    provider,
    operation,
    kind,
    status,
    disableProvider: permanentlyUnavailableStatuses.has(status),
    message:
      `${provider} ${operation} request failed (${status} ${response.statusText})` +
      (detail ? `: ${detail}` : ""),
  });
}

function validateWebUrl(rawUrl: string): string {
  const url = URL.parse(rawUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("web_fetch requires a valid HTTP(S) URL");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch does not accept URLs with embedded credentials");
  }
  return url.href;
}

function sourceHost(url: string): string {
  return URL.parse(url)?.hostname.replace(/^www\./, "") || url;
}

function getText(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseMcpResponse(body: string): McpResponse {
  const events = body.split(/\r?\n\r?\n/).map((event) =>
    event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );

  for (const payload of [body, ...events]) {
    try {
      const message = JSON.parse(payload) as McpResponse;
      if (message.id === 1 && (message.result || message.error)) return message;
    } catch {
      continue;
    }
  }
  throw new Error("Exa MCP returned an invalid response");
}

function formatSearchResults(
  results: Array<{ title?: string; url?: string; snippet?: string }>,
): string {
  return results
    .filter((result) => result.url || result.title || result.snippet)
    .map((result, index) => {
      const title = result.title?.trim() || result.url?.trim() || `Result ${index + 1}`;
      const lines = [`Title: ${title}`];
      if (result.url?.trim()) lines.push(`URL: ${result.url.trim()}`);
      if (result.snippet?.trim()) lines.push(`Text: ${result.snippet.trim()}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatFetchedPage(input: {
  url: string;
  title?: string;
  description?: string;
  content: string;
}): string {
  const title = input.title?.trim() || sourceHost(input.url) || "Fetched page";
  const lines = [`# ${title}`, `URL: ${input.url}`];
  if (input.description?.trim()) lines.push(`Description: ${input.description.trim()}`);
  lines.push("", input.content.trim());
  return lines.join("\n");
}

async function callFirecrawl<T>(
  path: "/search" | "/scrape",
  body: Record<string, unknown>,
  operation: ProviderOperation,
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderError({
      provider: "Firecrawl",
      operation,
      kind: "unavailable",
      message: "FIRECRAWL_API_KEY is not set",
    });
  }

  try {
    const response = await fetch(`${FIRECRAWL_API_URL}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: combineSignals(signal),
    });
    const responseBody = await response.text();
    const payload = parseJson(responseBody);
    if (!response.ok) throw httpProviderError("Firecrawl", operation, response, responseBody, payload);
    if (!isRecord(payload)) {
      throw new ProviderError({
        provider: "Firecrawl",
        operation,
        kind: "unavailable",
        message: "Firecrawl returned an invalid JSON response",
      });
    }
    if (payload.success === false || cleanText(payload.error)) {
      throw new ProviderError({
        provider: "Firecrawl",
        operation,
        kind: "unavailable",
        message: `Firecrawl ${operation} failed: ${responseDetail(responseBody, payload) || "unknown error"}`,
      });
    }
    return payload as T;
  } catch (error) {
    throw requestError("Firecrawl", operation, error);
  }
}

async function callTavily<T>(
  path: "/search" | "/extract",
  body: Record<string, unknown>,
  operation: ProviderOperation,
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderError({
      provider: "Tavily",
      operation,
      kind: "unavailable",
      message: "TAVILY_API_KEY is not set",
    });
  }

  try {
    const response = await fetch(`${TAVILY_API_URL}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: combineSignals(signal),
    });
    const responseBody = await response.text();
    const payload = parseJson(responseBody);
    if (!response.ok) throw httpProviderError("Tavily", operation, response, responseBody, payload);
    if (!isRecord(payload)) {
      throw new ProviderError({
        provider: "Tavily",
        operation,
        kind: "unavailable",
        message: "Tavily returned an invalid JSON response",
      });
    }
    const detail = responseDetail(responseBody, payload);
    if (cleanText(payload.error) || payload.detail) {
      throw new ProviderError({
        provider: "Tavily",
        operation,
        kind: "unavailable",
        message: `Tavily ${operation} failed: ${detail || "unknown error"}`,
      });
    }
    return payload as T;
  } catch (error) {
    throw requestError("Tavily", operation, error);
  }
}

async function callExa(
  tool: ExaTool,
  args: Record<string, unknown>,
  operation: ProviderOperation,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  const request = async () => {
    try {
      const response = await fetch(EXA_MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: combineSignals(signal),
      });

      const body = await response.text();
      if (!response.ok) {
        const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
        const hint = response.status === 429 && !apiKey
          ? " Set EXA_API_KEY to avoid the shared rate limit."
          : "";
        throw new ProviderError({
          provider: "Exa",
          operation,
          kind: response.status === 400 ? "invalid_request" : "unavailable",
          status: response.status,
          message:
            `Exa MCP request failed (${response.status} ${response.statusText})` +
            `${detail ? `: ${detail}` : ""}${hint}`,
        });
      }

      const message = parseMcpResponse(body);
      const text = getText(message.result?.content ?? []);
      if (message.error?.message || message.result?.isError) {
        throw new ProviderError({
          provider: "Exa",
          operation,
          kind: "unavailable",
          message: message.error?.message ?? (text || "Exa MCP tool failed"),
        });
      }
      if (!text) {
        throw new ProviderError({
          provider: "Exa",
          operation,
          kind: "unavailable",
          message: "Exa MCP returned no content",
        });
      }
      return text;
    } catch (error) {
      throw requestError("Exa", operation, error);
    }
  };

  if (apiKey) return request();

  const previous = anonymousExaQueue;
  const result = waitForQueue(previous, signal).then(request);
  anonymousExaQueue = previous.then(
    () => result.then(() => undefined, () => undefined),
    () => result.then(() => undefined, () => undefined),
  );
  return result;
}

function createFirecrawlProvider(): WebProvider {
  return {
    name: "Firecrawl",
    isConfigured: () => Boolean(process.env.FIRECRAWL_API_KEY?.trim()),
    async search(input, signal) {
      const limit = Math.min(input.numResults ?? 10, 100);
      const response = await callFirecrawl<FirecrawlSearchResponse>(
        "/search",
        { query: input.query, limit, sources: ["web"], timeout: FIRECRAWL_TIMEOUT_MS },
        "search",
        signal,
      );
      const text = formatSearchResults(
        (response.data?.web ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.description || result.markdown,
        })),
      );
      if (!text) {
        throw new ProviderError({
          provider: "Firecrawl",
          operation: "search",
          kind: "unavailable",
          message: response.warning?.trim() || "Firecrawl returned no search results",
        });
      }
      return text;
    },
    async fetch(input, signal) {
      const pages: string[] = [];
      const failures: string[] = [];
      let unavailableError: ProviderError | undefined;

      for (const url of input.urls) {
        if (signal?.aborted) {
          throw new ProviderError({
            provider: "Firecrawl",
            operation: "fetch",
            kind: "cancelled",
            message: "Firecrawl fetch cancelled",
          });
        }
        try {
          const response = await callFirecrawl<FirecrawlScrapeResponse>(
            "/scrape",
            { url, formats: ["markdown"], parsers: [], timeout: FIRECRAWL_TIMEOUT_MS },
            "fetch",
            signal,
          );
          const content = response.data?.markdown?.trim();
          if (!content) {
            failures.push(`${url}: Firecrawl returned no markdown content`);
            continue;
          }
          const metadata = response.data?.metadata;
          pages.push(formatFetchedPage({
            url: metadata?.sourceURL || metadata?.url || url,
            title: metadata?.title,
            description: metadata?.description,
            content: input.maxCharacters ? content.slice(0, input.maxCharacters) : content,
          }));
        } catch (error) {
          const providerError = requestError("Firecrawl", "fetch", error);
          if (providerError.kind === "cancelled") throw providerError;
          if (providerError.kind === "invalid_request") throw providerError;
          unavailableError = providerError;
          break;
        }
      }

      if (unavailableError) throw unavailableError;
      if (!pages.length) {
        throw new ProviderError({
          provider: "Firecrawl",
          operation: "fetch",
          kind: "unavailable",
          message: failures.length
            ? `Firecrawl could not fetch any requested page: ${failures.join("; ")}`
            : "Firecrawl returned no page content",
        });
      }
      return [...pages, ...(failures.length ? [`## Failed URLs\n${failures.map((item) => `- ${item}`).join("\n")}`] : [])]
        .join("\n\n---\n\n");
    },
  };
}

function createTavilyProvider(): WebProvider {
  return {
    name: "Tavily",
    isConfigured: () => Boolean(process.env.TAVILY_API_KEY?.trim()),
    async search(input, signal) {
      const maxResults = Math.min(input.numResults ?? 10, 20);
      const response = await callTavily<TavilySearchResponse>(
        "/search",
        { query: input.query, max_results: maxResults, search_depth: "basic" },
        "search",
        signal,
      );
      const text = formatSearchResults(
        (response.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.content,
        })),
      );
      if (!text) {
        throw new ProviderError({
          provider: "Tavily",
          operation: "search",
          kind: "unavailable",
          message: "Tavily returned no search results",
        });
      }
      return text;
    },
    async fetch(input, signal) {
      const results: Array<{ url?: string; raw_content?: string }> = [];
      const failures: string[] = [];

      for (let index = 0; index < input.urls.length; index += 20) {
        const urls = input.urls.slice(index, index + 20);
        const response = await callTavily<TavilyExtractResponse>(
          "/extract",
          { urls, extract_depth: "basic", format: "markdown", timeout: 60 },
          "fetch",
          signal,
        );
        results.push(...(response.results ?? []));
        failures.push(
          ...(response.failed_results ?? []).map(
            (result) => `${result.url || "unknown URL"}: ${result.error || "extraction failed"}`,
          ),
        );
      }

      const pagesByUrl = new Map<string, string>();
      for (const result of results) {
        const content = result.raw_content?.trim();
        if (!content || !result.url) continue;
        const resultUrl = URL.parse(result.url)?.href || result.url;
        pagesByUrl.set(
          resultUrl,
          formatFetchedPage({
            url: resultUrl,
            content: input.maxCharacters ? content.slice(0, input.maxCharacters) : content,
          }),
        );
      }
      const failureByUrl = new Map<string, string>();
      for (const failure of failures) {
        const separator = failure.indexOf(": ");
        if (separator > 0) {
          const failedUrl = failure.slice(0, separator);
          failureByUrl.set(URL.parse(failedUrl)?.href || failedUrl, failure);
        }
      }
      const pages = input.urls.flatMap((url) => {
        const page = pagesByUrl.get(url);
        return page ? [page] : [];
      });
      const orderedFailures = input.urls.flatMap((url) => {
        const failure = failureByUrl.get(url);
        return failure ? [failure] : [];
      });
      if (!pages.length) {
        throw new ProviderError({
          provider: "Tavily",
          operation: "fetch",
          kind: "unavailable",
          message: orderedFailures.length
            ? `Tavily could not extract any requested page: ${orderedFailures.join("; ")}`
            : "Tavily returned no page content",
        });
      }
      return [...pages, ...(orderedFailures.length ? [`## Failed URLs\n${orderedFailures.map((item) => `- ${item}`).join("\n")}`] : [])]
        .join("\n\n---\n\n");
    },
  };
}

function createExaProvider(): WebProvider {
  return {
    name: "Exa",
    isConfigured: () => true,
    search: (input, signal) => callExa(
      SEARCH_TOOL,
      { query: input.query, numResults: input.numResults },
      "search",
      signal,
    ),
    fetch: (input, signal) => callExa(
      FETCH_TOOL,
      { urls: input.urls, maxCharacters: input.maxCharacters },
      "fetch",
      signal,
    ),
  };
}

export function createDefaultProviders(): WebProvider[] {
  return [createFirecrawlProvider(), createTavilyProvider(), createExaProvider()];
}

export async function runProviderChain(
  providers: WebProvider[],
  operation: ProviderOperation,
  input: SearchInput | FetchInput,
  signal?: AbortSignal,
  onAttempt?: (provider: ProviderName) => void,
): Promise<ProviderChainResult> {
  const attempts: string[] = [];

  for (const provider of providers) {
    const disabledReason = disabledProviders.get(provider);
    if (disabledReason) {
      attempts.push(`${provider.name}: skipped for this extension load (${disabledReason})`);
      continue;
    }
    if (!provider.isConfigured()) {
      attempts.push(`${provider.name}: skipped (API key not configured)`);
      continue;
    }

    onAttempt?.(provider.name);
    try {
      const text = operation === "search"
        ? await provider.search(input as SearchInput, signal)
        : await provider.fetch(input as FetchInput, signal);
      return { text, provider: provider.name, attempts };
    } catch (error) {
      const providerError = requestError(provider.name, operation, error);
      if (providerError.kind === "cancelled" || signal?.aborted) throw providerError;
      if (providerError.kind === "invalid_request") throw providerError;
      if (providerError.disableProvider) {
        disabledProviders.set(provider, providerError.message);
      }
      attempts.push(`${provider.name}: ${providerError.message}`);
    }
  }

  throw new Error(
    `All web providers failed for ${operation}.` +
      (attempts.length ? ` ${attempts.join(" | ")}` : " No provider is configured."),
  );
}

async function truncateOutput(text: string): Promise<string> {
  const output = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!output.truncated) return output.content;

  const outputDir = await mkdtemp(join(tmpdir(), "pi-web-"));
  const outputPath = join(outputDir, "output.md");
  await writeFile(outputPath, text, "utf8");
  return (
    `${output.content}\n\n[Output truncated: showing ${output.outputLines} of ${output.totalLines} lines ` +
    `(${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)}). ` +
    `Full output saved to: ${outputPath}]`
  );
}

export default function registerWebTools(pi: ExtensionAPI): void {
  const providers = createDefaultProviders();

  pi.registerTool({
    name: SEARCH_TOOL,
    label: "Web Search",
    description: `Search the web for any topic and get clean, ready-to-use content.

Providers are tried automatically in this order: Firecrawl, Tavily, then Exa. If a provider is not configured, out of credits, rate-limited, or unavailable, the tool falls back to the next provider.

Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
Returns: Clean text content from top search results.

Query tips:
describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
Treat returned snippets as sufficient when they answer the question. Avoid equivalent searches.
When full text is needed, collect all relevant URLs first and make one web_fetch call. Do not fetch results one at a time.`,
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            "Natural language search query. Should be a semantically rich description of the ideal page, not just keywords.",
        }),
        numResults: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description:
              "Number of search results to return (default: 10). Tavily supports at most 20; larger requests are capped only while using Tavily.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate) {
      const query = params.query.trim();
      if (!query) throw new Error("web_search query must not be empty");

      const result = await runProviderChain(
        providers,
        "search",
        { query, numResults: params.numResults },
        signal,
        (provider) => {
          onUpdate?.({
            content: [{ type: "text", text: `Searching ${provider}...` }],
            details: { provider },
          });
        },
      );
      return {
        content: [{ type: "text", text: await truncateOutput(result.text) }],
        details: { provider: result.provider, fallbacks: result.attempts },
      };
    },
    renderCall(args, theme) {
      const query = args.query.replace(/\s+/g, " ").trim();
      const count = args.numResults === undefined ? "" : theme.fg("dim", ` (${args.numResults})`);
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("accent", JSON.stringify(query)) +
          count,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", getText(result.content) || "Searching..."), 0, 0);

      const text = getText(result.content);
      if (context.isError) return new Text(theme.fg("error", text || "Web search failed"), 0, 0);
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

      const details = result.details as { provider?: string } | undefined;
      const resultCount = (text.match(/^Title:\s+/gm) ?? []).length;
      const provider = details?.provider ? ` via ${details.provider}` : "";
      const status = resultCount
        ? `${resultCount} results${provider}`
        : `${text.split("\n", 1)[0] || "Search complete"}${provider}`;
      return new Text(
        `${theme.fg("success", status)}\n${theme.fg("dim", `${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: FETCH_TOOL,
    label: "Web Fetch",
    description: `Read webpages as clean markdown. Use after web_search when snippets are insufficient or to read known URLs.

Providers are tried automatically in this order: Firecrawl, Tavily, then Exa. If a provider is not configured, out of credits, rate-limited, or unavailable, the tool falls back to the next provider.

Best for: Extracting full content from known URLs.
Do not search for a URL the user already provided. Do not fetch pages whose search snippets already answer the question.
Before calling, collect all relevant URLs and send them together. Do not fetch one URL at a time.
Call again only for newly discovered URLs, failed pages, or when the previous extraction was insufficient.
Returns: Clean markdown content and metadata from the page(s).`,
    parameters: Type.Object(
      {
        urls: Type.Array(
          Type.String({ minLength: 1 }),
          {
            minItems: 1,
            description:
              "URLs to read. Collect all URLs needed for the current step and batch them in one call.",
          },
        ),
        maxCharacters: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50_000,
            description: "Maximum characters to extract per page (default: provider output limit)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate) {
      const urls = [...new Set(params.urls.map(validateWebUrl))];
      const result = await runProviderChain(
        providers,
        "fetch",
        { urls, maxCharacters: params.maxCharacters },
        signal,
        (provider) => {
          onUpdate?.({
            content: [{ type: "text", text: `Fetching with ${provider}...` }],
            details: { provider },
          });
        },
      );
      return {
        content: [{ type: "text", text: await truncateOutput(result.text) }],
        details: { provider: result.provider, fallbacks: result.attempts },
      };
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", getText(result.content) || "Fetching..."), 0, 0);

      const text = getText(result.content);
      if (context.isError) return new Text(theme.fg("error", text || "Web fetch failed"), 0, 0);
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

      const details = result.details as { provider?: string } | undefined;
      const fetchedUrls = [...text.matchAll(/^URL:\s+(\S+)/gm)].map((match) => match[1] ?? "");
      const requestedUrls = Array.isArray(context.args.urls) ? context.args.urls : [];
      const urls = fetchedUrls.length ? fetchedUrls : requestedUrls;
      const pageCount = Math.max((text.match(/^#\s+/gm) ?? []).length, urls.length, 1);
      const title =
        pageCount === 1 ? text.match(/^#\s+(.+)$/m)?.[1] ?? "Page fetched" : `${pageCount} pages fetched`;
      const sources = [...new Set(urls.map(sourceHost))];
      const hidden = Math.max(sources.length - 3, 0);
      const source = sources.slice(0, 3).join(", ") || details?.provider || "Web";
      const provider = details?.provider ? ` via ${details.provider}` : "";
      const stats = `${source}${hidden ? ` +${hidden} more` : ""}${provider} | ${text.length.toLocaleString()} chars | ${text.split("\n").length.toLocaleString()} lines`;
      return new Text(
        `${theme.fg("success", title)}\n${theme.fg("dim", `${stats} | ${keyHint("app.tools.expand", "to expand")}`)}`,
        0,
        0,
      );
    },
  });
}
