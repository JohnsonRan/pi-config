import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  openAIResponsesApi,
  registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type ProviderModel = {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  context_window?: unknown;
  contextWindow?: unknown;
  max_tokens?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  input?: unknown;
  modalities?: { input?: unknown };
  cost?: unknown;
  pricing?: unknown;
  thinkingLevelMap?: unknown;
  compat?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  base_url?: unknown;
  headers?: unknown;
};

type ModelsResponse = {
  data?: ProviderModel[];
  models?: ProviderModel[];
};

type ModelCost = ProviderModelConfig["cost"];
type ModelCompat = NonNullable<ProviderModelConfig["compat"]>;
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;
type ModelApi = NonNullable<ProviderModelConfig["api"]>;

type CostConfig = Partial<
  Pick<ModelCost, "input" | "output" | "cacheRead" | "cacheWrite">
> & {
  tiers?: unknown;
};

type ModelMetadata = {
  enabled?: boolean;
  name?: string;
  api?: ModelApi;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: Array<"text" | "image">;
  cost?: CostConfig;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ModelCompat;
};

type ProviderMetadata = {
  name?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  /** Opt in only when the gateway really exposes each model's native API. */
  useCatalogApi?: boolean;
};

type MetadataConfig = {
  provider?: ProviderMetadata;
  defaults?: ModelMetadata;
  models?: Record<string, ModelMetadata>;
};

type CatalogCost = {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tiers?: unknown;
};

/** Subset of a models.dev entry that maps onto pi's model metadata. */
type CatalogEntry = {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  reasoning_options?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  temperature?: unknown;
  interleaved?: unknown;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: CatalogCost;
};

type CatalogCandidate = {
  providerId: string;
  id: string;
  entry: CatalogEntry;
};

type CatalogIndex = Map<string, CatalogCandidate[]>;

/**
 * A pi.dev catalog entry. Unlike models.dev this is already in pi's own model
 * shape, and it is the most authoritative source for thinkingLevelMap/compat.
 */
type PiCatalogEntry = Partial<ProviderModelConfig> & {
  id?: string;
  api?: ModelApi;
  cost?: ModelCost;
};

const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10000;

const PI_CATALOG_BASE_URL = "https://pi.dev/api/models/providers";
/** Add more with PI_THIRD_PARTY_PI_CATALOG_PROVIDERS when needed. */
const PI_CATALOG_PROVIDERS = ["anthropic", "openai", "google", "zai", "xai"];
const PI_CATALOG_TIMEOUT_MS = 8000;

const DEFAULT_COMPAT: ModelCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
};

const CANONICAL_CATALOG_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "xai",
  "x-ai",
  "zai",
  "zhipuai",
  "deepseek",
  "qwen",
  "alibaba",
  "moonshotai",
  "moonshotai-cn",
  "mistral",
  "minimax",
  "cohere",
  "groq",
  "cerebras",
  "nvidia",
  "together",
  "fireworks-ai",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function supportedInput(
  value: unknown,
  fallback: Array<"text" | "image">,
): Array<"text" | "image"> {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const input = value.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return input.length > 0 ? [...new Set(input)] : fallback;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeRecords<T extends object>(
  ...records: Array<T | undefined>
): T | undefined {
  const present = records.filter((record): record is T => record !== undefined);
  return present.length > 0 ? Object.assign({}, ...present) : undefined;
}

function bareModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function loadMetadataConfig(): Promise<MetadataConfig> {
  const metadataPath =
    process.env.PI_THIRD_PARTY_MODELS_FILE ||
    join(agentDir(), "third-party-models.json");

  try {
    return JSON.parse(await readFile(metadataPath, "utf8")) as MetadataConfig;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new Error(`Failed to load model metadata from ${metadataPath}`, {
      cause: error,
    });
  }
}

function addCatalogCandidate(
  index: CatalogIndex,
  key: string,
  candidate: CatalogCandidate,
): void {
  if (!key) return;
  const existing = index.get(key);
  if (existing) existing.push(candidate);
  else index.set(key, [candidate]);
}

/** Keep all candidates; provider-aware scoring later avoids random gateway prices. */
function indexCatalog(raw: unknown): CatalogIndex {
  const index: CatalogIndex = new Map();
  const root = asRecord(raw);
  if (!root) return index;

  for (const [providerId, providerValue] of Object.entries(root)) {
    const models = asRecord(asRecord(providerValue)?.models);
    if (!models) continue;
    for (const [id, entryValue] of Object.entries(models)) {
      const entry = asRecord(entryValue) as CatalogEntry | undefined;
      if (!entry) continue;
      const candidate = { providerId, id, entry };
      addCatalogCandidate(index, id, candidate);
      const bareId = bareModelId(id);
      if (bareId !== id) addCatalogCandidate(index, bareId, candidate);
    }
  }
  return index;
}

function inferredProviderIds(id: string): string[] {
  const value = id.toLowerCase();
  if (/(^|\/)claude[-/]/.test(value)) return ["anthropic"];
  if (/(^|\/)(gpt|o[1345])[-/.]/.test(value)) return ["openai"];
  if (/(^|\/)gemini[-/]/.test(value)) return ["google"];
  if (/(^|\/)grok[-/]/.test(value)) return ["xai", "x-ai"];
  if (/(^|\/)(glm|zai|z-ai)[-/]/.test(value)) return ["zai", "zhipuai"];
  if (/(^|\/)deepseek[-/]/.test(value)) return ["deepseek"];
  if (/(^|\/)qwen[-/]/.test(value)) return ["qwen", "alibaba", "alibaba-cn"];
  if (/(^|\/)(kimi|moonshot)[-/]/.test(value)) {
    return ["moonshotai", "moonshotai-cn"];
  }
  if (/(^|\/)mistral[-/]/.test(value)) return ["mistral"];
  if (/(^|\/)minimax[-/]/.test(value)) return ["minimax"];
  return [];
}

function normalizedHint(value: unknown): string | undefined {
  const text = nonEmptyString(value)?.toLowerCase();
  return text?.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function findCatalogEntry(
  index: CatalogIndex,
  id: string,
  owner?: unknown,
): CatalogEntry | undefined {
  const bareId = bareModelId(id);
  const candidates = [...(index.get(id) ?? []), ...(index.get(bareId) ?? [])];
  if (candidates.length === 0) return undefined;

  const ownerHint = normalizedHint(owner);
  const inferred = inferredProviderIds(id);
  const unique = [...new Map(candidates.map((item) => [`${item.providerId}\0${item.id}`, item])).values()];

  unique.sort((a, b) => {
    const score = (candidate: CatalogCandidate): number => {
      let value = 0;
      const provider = candidate.providerId.toLowerCase();
      if (ownerHint && provider === ownerHint) value += 200;
      if (inferred.includes(provider)) value += 150;
      if (candidate.id === id) value += 40;
      if (candidate.id === bareId) value += 30;
      if (CANONICAL_CATALOG_PROVIDERS.has(provider)) value += 25;
      if (/coding-plan|token-plan|copilot|opencode|free/.test(provider)) value -= 20;
      return value;
    };
    return score(b) - score(a);
  });

  return unique[0]?.entry;
}

async function loadCatalog(): Promise<CatalogIndex> {
  if (process.env.PI_THIRD_PARTY_CATALOG === "off") return new Map();

  const cachePath =
    process.env.PI_THIRD_PARTY_CATALOG_FILE ||
    join(agentDir(), "cache", "models-dev-catalog.json");

  let cached: { fetchedAt?: number; data?: unknown } | undefined;
  try {
    cached = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    // No usable cache; fall through to a network fetch.
  }

  if (cached?.data && Date.now() - (cached.fetchedAt ?? 0) < CATALOG_TTL_MS) {
    return indexCatalog(cached.data);
  }

  try {
    const response = await fetch(CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({ fetchedAt: Date.now(), data }),
        "utf8",
      );
    } catch {
      // A read-only cache dir is not fatal; we still have the fresh data.
    }
    return indexCatalog(data);
  } catch {
    return indexCatalog(cached?.data);
  }
}

async function loadPiCatalog(): Promise<Map<string, PiCatalogEntry>> {
  if (process.env.PI_THIRD_PARTY_PI_CATALOG === "off") return new Map();

  const providers = (
    process.env.PI_THIRD_PARTY_PI_CATALOG_PROVIDERS?.split(",") ??
    PI_CATALOG_PROVIDERS
  )
    .map((id) => id.trim())
    .filter(Boolean);

  const cachePath =
    process.env.PI_THIRD_PARTY_PI_CATALOG_FILE ||
    join(agentDir(), "cache", "pi-dev-catalog.json");

  type PiCache = Record<
    string,
    { fetchedAt: number; models: Record<string, PiCatalogEntry> }
  >;
  let cached: PiCache = {};
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    if (typeof parsed?.providers === "object" && parsed.providers !== null) {
      cached = parsed.providers;
    }
  } catch {
    // No usable cache; every provider is fetched fresh.
  }

  const now = Date.now();
  const fetched = await Promise.all(
    providers.map(async (providerId) => {
      const entry = cached[providerId];
      if (entry && now - entry.fetchedAt < CATALOG_TTL_MS) return undefined;
      try {
        const response = await fetch(
          `${PI_CATALOG_BASE_URL}/${encodeURIComponent(providerId)}`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(PI_CATALOG_TIMEOUT_MS),
          },
        );
        if (!response.ok) return undefined;
        const data = await response.json();
        const record = asRecord(data);
        if (!record) return undefined;
        const models = Object.fromEntries(
          Object.entries(record).filter(([, value]) => {
            const item = asRecord(value);
            return item !== undefined && "id" in item;
          }),
        ) as Record<string, PiCatalogEntry>;
        return Object.keys(models).length > 0
          ? ([providerId, models] as const)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );

  let changed = false;
  for (const result of fetched) {
    if (!result) continue;
    cached[result[0]] = { fetchedAt: now, models: result[1] };
    changed = true;
  }

  if (changed) {
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({ providers: cached }),
        "utf8",
      );
    } catch {
      // A read-only cache dir is not fatal.
    }
  }

  const index = new Map<string, PiCatalogEntry>();
  for (const providerId of providers) {
    for (const [id, entry] of Object.entries(cached[providerId]?.models ?? {})) {
      if (!index.has(id)) index.set(id, entry);
    }
  }
  return index;
}

function getModels(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelsResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = parsedUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          Connection: "close",
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new Error(
                `Failed to fetch ${url}: ${status} ${response.statusMessage ?? ""} ${body.slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body) as ModelsResponse);
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url}`, { cause: error }));
          }
        });
      },
    );

    const onAbort = () => req.destroy(new Error(`Aborted fetching ${url}`));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timed out fetching ${url}`));
    });
    req.on("error", reject);
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
}

function extractSourceModels(payload: ModelsResponse): ProviderModel[] {
  return Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
}

function costConfig(value: unknown): CostConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    input: optionalNonNegativeNumber(record.input),
    output: optionalNonNegativeNumber(record.output),
    cacheRead: optionalNonNegativeNumber(record.cacheRead ?? record.cache_read),
    cacheWrite: optionalNonNegativeNumber(record.cacheWrite ?? record.cache_write),
    ...(Object.hasOwn(record, "tiers") ? { tiers: record.tiers } : {}),
  };
}

function normalizeTiers(
  value: unknown,
  base: Pick<ModelCost, "input" | "output" | "cacheRead" | "cacheWrite">,
): ModelCost["tiers"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers = value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const tierInfo = asRecord(record.tier);
    const threshold = optionalNonNegativeNumber(
      record.inputTokensAbove ??
        (tierInfo?.type === "context" ? tierInfo.size : undefined),
    );
    if (threshold === undefined) return [];
    return [
      {
        inputTokensAbove: threshold,
        input: optionalNonNegativeNumber(record.input) ?? base.input,
        output: optionalNonNegativeNumber(record.output) ?? base.output,
        cacheRead:
          optionalNonNegativeNumber(record.cacheRead ?? record.cache_read) ??
          base.cacheRead,
        cacheWrite:
          optionalNonNegativeNumber(record.cacheWrite ?? record.cache_write) ??
          base.cacheWrite,
      },
    ];
  });

  const deduped = [
    ...new Map(tiers.map((tier) => [tier.inputTokensAbove, tier])).values(),
  ].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  return deduped;
}

function normalizeCost(
  value: unknown,
  snakeCase = false,
): ModelCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const base = {
    input: optionalNonNegativeNumber(record.input) ?? 0,
    output: optionalNonNegativeNumber(record.output) ?? 0,
    cacheRead:
      optionalNonNegativeNumber(
        snakeCase ? record.cache_read : record.cacheRead ?? record.cache_read,
      ) ?? 0,
    cacheWrite:
      optionalNonNegativeNumber(
        snakeCase ? record.cache_write : record.cacheWrite ?? record.cache_write,
      ) ?? 0,
  };
  const tiers = normalizeTiers(record.tiers, base);
  return { ...base, ...(tiers ? { tiers } : {}) };
}

function pricedCost(cost: ModelCost | undefined): ModelCost | undefined {
  if (!cost) return undefined;
  const base = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  const tierValues = (cost.tiers ?? []).flatMap((tier) => [
    tier.input,
    tier.output,
    tier.cacheRead,
    tier.cacheWrite,
  ]);
  return [...base, ...tierValues].some((value) => value > 0) ? cost : undefined;
}

function mergeCost(
  explicitValue: unknown,
  sourceValue: unknown,
  piValue: unknown,
  catalogValue: unknown,
  defaultValue: unknown,
): ModelCost {
  const explicit = costConfig(explicitValue);
  const source = costConfig(sourceValue);
  const piCost = pricedCost(normalizeCost(piValue));
  const catalogCost = normalizeCost(catalogValue, true);
  const defaults = normalizeCost(defaultValue) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  const base = {
    input:
      explicit?.input ??
      source?.input ??
      piCost?.input ??
      catalogCost?.input ??
      defaults.input,
    output:
      explicit?.output ??
      source?.output ??
      piCost?.output ??
      catalogCost?.output ??
      defaults.output,
    cacheRead:
      explicit?.cacheRead ??
      source?.cacheRead ??
      piCost?.cacheRead ??
      catalogCost?.cacheRead ??
      defaults.cacheRead,
    cacheWrite:
      explicit?.cacheWrite ??
      source?.cacheWrite ??
      piCost?.cacheWrite ??
      catalogCost?.cacheWrite ??
      defaults.cacheWrite,
  };

  const tierSource =
    explicit && Object.hasOwn(explicit, "tiers")
      ? explicit.tiers
      : source && Object.hasOwn(source, "tiers")
        ? source.tiers
        : piCost?.tiers ?? catalogCost?.tiers ?? defaults.tiers;
  const tiers = normalizeTiers(tierSource, base);
  return { ...base, ...(tiers ? { tiers } : {}) };
}

function thinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: ThinkingLevelMap = {};
  for (const level of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    const mapped = record[level];
    if (mapped === null || typeof mapped === "string") result[level] = mapped;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function catalogThinkingLevelMap(entry: CatalogEntry | undefined): ThinkingLevelMap | undefined {
  if (!Array.isArray(entry?.reasoning_options)) return undefined;
  const effort = entry.reasoning_options
    .map(asRecord)
    .find((option) => option?.type === "effort");
  if (!effort || !Array.isArray(effort.values)) return undefined;
  const values = new Set(effort.values.filter((item): item is string => typeof item === "string"));
  const result: ThinkingLevelMap = {};
  if (values.has("none")) result.off = "none";
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    result[level] = values.has(level) ? level : null;
  }
  return result;
}

function catalogCompat(
  entry: CatalogEntry | undefined,
  modelId: string,
  api: ModelApi,
): ModelCompat | undefined {
  if (!entry) return undefined;
  const compat: Record<string, unknown> = {};
  const hasTools = optionalBoolean(entry.tool_call);
  const structured = optionalBoolean(entry.structured_output);

  if (api === "openai-completions") {
    if (structured !== undefined && hasTools !== false) {
      compat.supportsStrictMode = structured;
    } else if (hasTools === false) {
      compat.supportsStrictMode = false;
    }

    const options = Array.isArray(entry.reasoning_options)
      ? entry.reasoning_options.map(asRecord).filter(Boolean)
      : [];
    if (options.some((option) => option?.type === "effort")) {
      compat.supportsReasoningEffort = true;
    }
    if (asRecord(entry.interleaved)?.field === "reasoning_content") {
      compat.requiresReasoningContentOnAssistantMessages = true;
    }

    const lowerId = modelId.toLowerCase();
    if (/(^|\/)(glm|zai|z-ai)[-/]/.test(lowerId)) {
      compat.thinkingFormat = "zai";
    } else if (/(^|\/)deepseek[-/]/.test(lowerId)) {
      compat.thinkingFormat = "deepseek";
    } else if (/(^|\/)qwen[-/]/.test(lowerId)) {
      compat.thinkingFormat = "qwen";
    }
    if (/(^|\/)(kimi|moonshot)[-/]/.test(lowerId)) {
      compat.deferredToolsMode = "kimi";
    }
  } else if (api === "anthropic-messages") {
    if (entry.temperature === false) compat.supportsTemperature = false;
    if (structured !== undefined && hasTools !== false) {
      compat.supportsStrictTools = structured;
    }
  } else if (
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses"
  ) {
    if (structured !== undefined && hasTools !== false) {
      compat.supportsStrictMode = structured;
    }
  } else if (api === "bedrock-converse-stream" && structured !== undefined) {
    compat.supportsStrictMode = structured && hasTools !== false;
  }

  return Object.keys(compat).length > 0 ? (compat as ModelCompat) : undefined;
}

function sourceMetadata(model: ProviderModel): ModelMetadata {
  return {
    name: nonEmptyString(model.name),
    api: nonEmptyString(model.api) as ModelApi | undefined,
    baseUrl: nonEmptyString(model.baseUrl ?? model.base_url),
    reasoning: optionalBoolean(model.reasoning),
    thinkingLevelMap: thinkingLevelMap(model.thinkingLevelMap),
    input: supportedInput(model.input ?? model.modalities?.input, []),
    cost: costConfig(model.cost ?? model.pricing),
    contextWindow: optionalNonNegativeNumber(
      model.contextWindow ?? model.context_window,
    ),
    maxTokens: optionalNonNegativeNumber(model.maxTokens ?? model.max_tokens),
    headers: stringRecord(model.headers),
    compat: asRecord(model.compat) as ModelCompat | undefined,
  };
}

function configuredMetadata(config: MetadataConfig, id: string): ModelMetadata {
  const bareId = bareModelId(id);
  const bare = config.models?.[bareId];
  const exact = config.models?.[id];
  return {
    ...bare,
    ...exact,
    cost: mergeRecords(bare?.cost, exact?.cost),
    headers: mergeRecords(bare?.headers, exact?.headers),
    compat: mergeRecords(bare?.compat, exact?.compat),
    thinkingLevelMap: mergeRecords(
      bare?.thinkingLevelMap,
      exact?.thinkingLevelMap,
    ),
  };
}

function buildModels(
  sourceModels: ProviderModel[],
  metadataConfig: MetadataConfig,
  catalog: CatalogIndex,
  piCatalog: Map<string, PiCatalogEntry>,
  baseUrl: string,
): ProviderModelConfig[] {
  const defaults = metadataConfig.defaults ?? {};
  const defaultContextWindow = positiveInteger(
    defaults.contextWindow,
    positiveInteger(process.env.PI_THIRD_PARTY_CONTEXT_WINDOW, 128000),
  );
  const defaultMaxTokens = positiveInteger(
    defaults.maxTokens,
    positiveInteger(process.env.PI_THIRD_PARTY_MAX_TOKENS, 16384),
  );
  const defaultInput = supportedInput(defaults.input, ["text"]);
  const providerApi =
    metadataConfig.provider?.api ??
    (nonEmptyString(process.env.PI_THIRD_PARTY_API) as ModelApi | undefined) ??
    "openai-responses";
  const useCatalogApi = metadataConfig.provider?.useCatalogApi === true;

  return sourceModels
    .filter((model): model is ProviderModel & { id: string } =>
      typeof model.id === "string" && model.id.length > 0,
    )
    .map((model) => {
      const source = sourceMetadata(model);
      const explicit = configuredMetadata(metadataConfig, model.id);
      if (explicit.enabled === false) return undefined;

      const bareId = bareModelId(model.id);
      const catalogEntry = findCatalogEntry(catalog, model.id, model.owned_by);
      const piEntry = piCatalog.get(model.id) ?? piCatalog.get(bareId);
      const api =
        explicit.api ??
        source.api ??
        defaults.api ??
        (useCatalogApi ? piEntry?.api : undefined) ??
        providerApi;
      const matchingPiCompat = piEntry?.api === api ? piEntry.compat : undefined;
      const matchingPiMap = piEntry?.thinkingLevelMap;
      // Provider-wide conservative defaults only describe our actual default
      // OpenAI-compatible transport. Other APIs have different compat shapes.
      const transportDefaults =
        api === "openai-completions" ? DEFAULT_COMPAT : undefined;
      const compat = mergeRecords(
        transportDefaults,
        defaults.compat,
        catalogCompat(catalogEntry, model.id, api),
        matchingPiCompat,
        source.compat,
        explicit.compat,
      );
      const headers = mergeRecords(
        defaults.headers,
        source.headers,
        explicit.headers,
      );
      const map = mergeRecords(
        defaults.thinkingLevelMap,
        catalogThinkingLevelMap(catalogEntry),
        matchingPiMap,
        source.thinkingLevelMap,
        explicit.thinkingLevelMap,
      );

      const result: ProviderModelConfig = {
        id: model.id,
        name:
          explicit.name ??
          source.name ??
          piEntry?.name ??
          nonEmptyString(catalogEntry?.name) ??
          model.id,
        api,
        baseUrl: explicit.baseUrl ?? source.baseUrl ?? defaults.baseUrl ?? baseUrl,
        reasoning:
          explicit.reasoning ??
          source.reasoning ??
          piEntry?.reasoning ??
          optionalBoolean(catalogEntry?.reasoning) ??
          defaults.reasoning ??
          false,
        input: supportedInput(
          explicit.input,
          supportedInput(
            source.input,
            supportedInput(
              piEntry?.input,
              supportedInput(catalogEntry?.modalities?.input, defaultInput),
            ),
          ),
        ),
        cost: mergeCost(
          explicit.cost,
          source.cost,
          piEntry?.cost,
          catalogEntry?.cost,
          defaults.cost,
        ),
        contextWindow: positiveInteger(
          explicit.contextWindow,
          positiveInteger(
            source.contextWindow,
            positiveInteger(
              piEntry?.contextWindow,
              positiveInteger(catalogEntry?.limit?.context, defaultContextWindow),
            ),
          ),
        ),
        maxTokens: positiveInteger(
          explicit.maxTokens,
          positiveInteger(
            source.maxTokens,
            positiveInteger(
              piEntry?.maxTokens,
              positiveInteger(catalogEntry?.limit?.output, defaultMaxTokens),
            ),
          ),
        ),
        ...(map ? { thinkingLevelMap: map } : {}),
        ...(headers ? { headers } : {}),
        ...(compat ? { compat } : {}),
      };
      return result;
    })
    .filter((model): model is ProviderModelConfig => model !== undefined);
}

async function discoverModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{
  models: ProviderModelConfig[];
  metadataConfig: MetadataConfig;
}> {
  const [payload, metadataConfig, catalog, piCatalog] = await Promise.all([
    getModels(`${baseUrl}/models`, apiKey, signal),
    loadMetadataConfig(),
    loadCatalog(),
    loadPiCatalog(),
  ]);
  const models = buildModels(
    extractSourceModels(payload),
    metadataConfig,
    catalog,
    piCatalog,
    baseUrl,
  );
  if (models.length === 0) {
    throw new Error(`${baseUrl}/models did not return any enabled model IDs`);
  }
  return { models, metadataConfig };
}

type CLIProxyTransport = "sse" | "auto" | "websocket" | "websocket-cached";

type ResponsesHelpers = {
  createGrammarToolInputProperties: (...args: any[]) => ReadonlyMap<string, string>;
  convertResponsesMessages: (...args: any[]) => any[];
  convertResponsesTools: (...args: any[]) => any[];
  processResponsesStream: (...args: any[]) => Promise<void>;
  buildBaseOptions: (...args: any[]) => any;
};

let responsesHelpersPromise: Promise<ResponsesHelpers> | undefined;

function importableModuleUrl(value: string): string {
  return value.startsWith("file:") ? value : pathToFileURL(value).href;
}

async function loadResponsesHelpers(): Promise<ResponsesHelpers> {
  if (responsesHelpersPromise) return responsesHelpersPromise;
  responsesHelpersPromise = (async () => {
    // Pi aliases the pi-ai package root to compat.js for extensions. Resolve
    // that supported root first, then load sibling implementation modules by
    // absolute URL so Jiti does not append subpaths to compat.js.
    const compatResolved = import.meta.resolve("@earendil-works/pi-ai/compat");
    const compatUrl = importableModuleUrl(compatResolved);
    const [constrained, shared, simple] = await Promise.all([
      import(new URL("./api/constrained-sampling.js", compatUrl).href),
      import(new URL("./api/openai-responses-shared.js", compatUrl).href),
      import(new URL("./api/simple-options.js", compatUrl).href),
    ]);
    return {
      createGrammarToolInputProperties: constrained.createGrammarToolInputProperties,
      convertResponsesMessages: shared.convertResponsesMessages,
      convertResponsesTools: shared.convertResponsesTools,
      processResponsesStream: shared.processResponsesStream,
      buildBaseOptions: simple.buildBaseOptions,
    };
  })();
  return responsesHelpersPromise;
}

type WebSocketLike = {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};

type WebSocketContinuation = {
  lastRequestBody: Record<string, unknown>;
  lastResponseId: string;
  lastResponseItems: unknown[];
};

type WebSocketSession = {
  socket: WebSocketLike;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: WebSocketContinuation;
};

const CLIPROXY_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CLIPROXY_WEBSOCKET_CONNECT_TIMEOUT_MS = 15000;
const CLIPROXY_WEBSOCKET_IDLE_TTL_MS = 5 * 60 * 1000;
const CLIPROXY_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const cliProxyWebSocketSessions = new Map<string, WebSocketSession>();

function closeCLIProxyWebSocketSessions(): void {
  for (const entry of cliProxyWebSocketSessions.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    closeWebSocket(entry.socket, "session_cleanup");
  }
  cliProxyWebSocketSessions.clear();
}

registerSessionResourceCleanup(closeCLIProxyWebSocketSessions);

function cliProxyResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/responses")
    ? normalized
    : `${normalized}/responses`;
}

function cliProxyWebSocketUrl(baseUrl: string): string {
  const url = new URL(cliProxyResponsesUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error(`Unsupported CLIProxyAPI URL scheme: ${url.protocol}`);
  return url.toString();
}

function closeWebSocket(socket: WebSocketLike, reason = "done"): void {
  try {
    socket.close(1000, reason);
  } catch {
    // Best-effort cleanup.
  }
}

function reusableWebSocket(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function expireWebSocketSession(sessionKey: string, entry: WebSocketSession): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy || cliProxyWebSocketSessions.get(sessionKey) !== entry) return;
    closeWebSocket(entry.socket, "idle_timeout");
    cliProxyWebSocketSessions.delete(sessionKey);
  }, CLIPROXY_WEBSOCKET_IDLE_TTL_MS);
}

async function connectCLIProxyWebSocket(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = CLIPROXY_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<WebSocketLike> {
  const WebSocketCtor = globalThis.WebSocket as
    | (new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike)
    | undefined;
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is unavailable in this runtime");
  }

  return await new Promise<WebSocketLike>((resolve, reject) => {
    let socket: WebSocketLike;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      socket = new WebSocketCtor(url, { headers });
    } catch (error) {
      reject(error);
      return;
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error, reason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) closeWebSocket(socket, reason);
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: any) =>
      fail(event?.error instanceof Error ? event.error : new Error(event?.message || "WebSocket error"));
    const onClose = (event: any) =>
      fail(new Error(`WebSocket closed before opening${event?.code ? ` (${event.code})` : ""}`));
    const onAbort = () => fail(new Error("Request was aborted"), "aborted");

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`), "connect_timeout"),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
  });
}

async function acquireCLIProxyWebSocket(
  url: string,
  headers: Record<string, string>,
  sessionKey: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{
  socket: WebSocketLike;
  entry?: WebSocketSession;
  release(keep: boolean): void;
}> {
  if (!sessionKey) {
    const socket = await connectCLIProxyWebSocket(url, headers, signal, timeoutMs);
    return { socket, release: () => closeWebSocket(socket) };
  }

  const cached = cliProxyWebSocketSessions.get(sessionKey);
  const cachedWasBusy = cached?.busy === true;
  if (cached) {
    if (cached.idleTimer) clearTimeout(cached.idleTimer);
    const expired = Date.now() - cached.createdAt >= CLIPROXY_WEBSOCKET_MAX_AGE_MS;
    if (!cached.busy && !expired && reusableWebSocket(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        release(keep) {
          if (!keep || !reusableWebSocket(cached.socket)) {
            closeWebSocket(cached.socket);
            if (cliProxyWebSocketSessions.get(sessionKey) === cached) {
              cliProxyWebSocketSessions.delete(sessionKey);
            }
          } else {
            cached.busy = false;
            expireWebSocketSession(sessionKey, cached);
          }
        },
      };
    }
    if (!cached.busy) {
      closeWebSocket(cached.socket, expired ? "connection_age_limit" : "closed");
      if (cliProxyWebSocketSessions.get(sessionKey) === cached) {
        cliProxyWebSocketSessions.delete(sessionKey);
      }
    }
  }

  const socket = await connectCLIProxyWebSocket(url, headers, signal, timeoutMs);
  if (cachedWasBusy) return { socket, release: () => closeWebSocket(socket) };
  const entry: WebSocketSession = { socket, busy: true, createdAt: Date.now() };
  cliProxyWebSocketSessions.set(sessionKey, entry);
  return {
    socket,
    entry,
    release(keep) {
      if (!keep || !reusableWebSocket(socket)) {
        closeWebSocket(socket);
        if (cliProxyWebSocketSessions.get(sessionKey) === entry) {
          cliProxyWebSocketSessions.delete(sessionKey);
        }
      } else {
        entry.busy = false;
        expireWebSocketSession(sessionKey, entry);
      }
    },
  };
}

async function decodeWebSocketMessage(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    return new TextDecoder().decode(await (data as Blob).arrayBuffer());
  }
  return undefined;
}

async function* parseCLIProxyWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<any> {
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let error: Error | undefined;
  let completed = false;

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const onMessage = (event: any) => {
    void (async () => {
      try {
        const text = await decodeWebSocketMessage(event?.data);
        if (!text) return;
        const payload = JSON.parse(text);
        queue.push(payload);
        if (["response.completed", "response.incomplete", "response.failed"].includes(payload?.type)) {
          completed = true;
          done = true;
        }
        notify();
      } catch (cause) {
        error = new Error(`Invalid CLIProxyAPI WebSocket event: ${String(cause)}`);
        done = true;
        notify();
      }
    })();
  };
  const onError = (event: any) => {
    error = event?.error instanceof Error ? event.error : new Error(event?.message || "WebSocket error");
    done = true;
    notify();
  };
  const onClose = (event: any) => {
    if (!completed) {
      error = new Error(`WebSocket closed before response.completed${event?.code ? ` (${event.code})` : ""}`);
    }
    done = true;
    notify();
  };
  const onAbort = () => {
    error = new Error("Request was aborted");
    done = true;
    closeWebSocket(socket, "aborted");
    notify();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (idleTimeoutMs && idleTimeoutMs > 0) {
          const timeout = setTimeout(
            () => reject(new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`)),
            idleTimeoutMs,
          );
          const originalWake = wake;
          wake = () => {
            clearTimeout(timeout);
            originalWake();
          };
        }
      });
    }
    if (error) throw error;
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function requestBodyWithoutInput(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return rest;
}

function incrementalRequestBody(
  entry: WebSocketSession | undefined,
  body: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  const continuation = entry?.continuation;
  if (!enabled || !continuation) return body;
  if (JSON.stringify(requestBodyWithoutInput(body)) !== JSON.stringify(requestBodyWithoutInput(continuation.lastRequestBody))) {
    entry.continuation = undefined;
    return body;
  }
  const current = Array.isArray(body.input) ? body.input : [];
  const baseline = [
    ...(Array.isArray(continuation.lastRequestBody.input) ? continuation.lastRequestBody.input : []),
    ...continuation.lastResponseItems,
  ];
  if (current.length < baseline.length || JSON.stringify(current.slice(0, baseline.length)) !== JSON.stringify(baseline)) {
    entry.continuation = undefined;
    return body;
  }
  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: current.slice(baseline.length),
  };
}

async function buildCLIProxyResponsesBody(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions,
): Promise<{
  body: Record<string, unknown>;
  grammarToolInputProperties: ReadonlyMap<string, string>;
  helpers: ResponsesHelpers;
}> {
  const helpers = await loadResponsesHelpers();
  const base = helpers.buildBaseOptions(model, context, options, options.apiKey);
  const reasoning = options.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const grammarToolInputProperties = helpers.createGrammarToolInputProperties(
    context.tools,
    model.compat?.supportsOpenAIGrammarTools ?? false,
  );
  const body: Record<string, unknown> = {
    model: model.id,
    input: helpers.convertResponsesMessages(
      model,
      context,
      new Set([model.provider, "openai", "openai-codex", "opencode"]),
      { grammarToolInputProperties },
    ),
    stream: true,
    store: false,
  };
  if (base.maxTokens) body.max_output_tokens = Math.max(base.maxTokens, 16);
  if (base.temperature !== undefined) body.temperature = base.temperature;
  if (context.tools?.length) {
    body.tools = helpers.convertResponsesTools(context.tools, {
      supportsStrictMode: model.compat?.supportsStrictMode ?? false,
      supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    });
  }
  if (model.reasoning) {
    if (reasoning && reasoning !== "off") {
      body.reasoning = {
        effort: model.thinkingLevelMap?.[reasoning] ?? reasoning,
        summary: "auto",
      };
      body.include = ["reasoning.encrypted_content"];
    } else if (model.thinkingLevelMap?.off !== null) {
      body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
  }
  return { body, grammarToolInputProperties, helpers };
}

async function pipeAssistantEvents(
  source: AsyncIterable<AssistantMessageEvent>,
  target: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  for await (const event of source) target.push(event);
  target.end();
}

function cleanStreamingScratch(output: AssistantMessage): void {
  for (const block of output.content) {
    delete (block as any).index;
    delete (block as any).partialJson;
    delete (block as any).customInput;
  }
}

function createCLIProxyStream() {
  return (model: Model<any>, context: Context, options: SimpleStreamOptions = {}) => {
    const requested = options.transport ?? "sse";
  if (requested === "sse") {
      return openAIResponsesApi().streamSimple(model, context, options);
    }

    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      let emitted = false;
      let sendAttempted = false;
      let release: ((keep: boolean) => void) | undefined;
      try {
        if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
        const built = await buildCLIProxyResponsesBody(model, context, options);
        let body = built.body;
        const replaced = await options.onPayload?.(body, model);
        if (replaced !== undefined) body = replaced as Record<string, unknown>;
        const sessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
        const headers: Record<string, string> = {
          ...model.headers,
          ...Object.fromEntries(
            Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
          ),
          Authorization: `Bearer ${options.apiKey}`,
          "OpenAI-Beta": CLIPROXY_WEBSOCKET_BETA,
        };
        if (sessionId) {
          headers["session-id"] = sessionId;
          headers["x-client-request-id"] = sessionId;
        }
        const websocketUrl = cliProxyWebSocketUrl(model.baseUrl);
        const sessionKey = sessionId
          ? `${sessionId}\0${websocketUrl}\0${options.apiKey}\0${JSON.stringify(headers)}`
          : undefined;
        const acquired = await acquireCLIProxyWebSocket(
          websocketUrl,
          headers,
          sessionKey,
          options.signal,
          options.websocketConnectTimeoutMs ?? CLIPROXY_WEBSOCKET_CONNECT_TIMEOUT_MS,
        );
        release = acquired.release;
        const useIncremental = requested === "auto" || requested === "websocket-cached";
        const requestBody = incrementalRequestBody(acquired.entry, body, useIncremental);
        sendAttempted = true;
        acquired.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));

        let completedResponse: any;
        async function* events() {
          for await (const event of parseCLIProxyWebSocket(acquired.socket, options.signal, options.timeoutMs)) {
            if (!emitted) {
              emitted = true;
              stream.push({ type: "start", partial: output });
            }
            if (event?.type === "response.completed") completedResponse = event.response;
            yield event;
          }
        }
        await built.helpers.processResponsesStream(events(), output, stream, model, {
          grammarToolInputProperties: built.grammarToolInputProperties,
        });
        if (acquired.entry && useIncremental && completedResponse?.id) {
          const responseItems = built.helpers.convertResponsesMessages(
            model,
            { messages: [output], tools: [] },
            new Set([model.provider, "openai", "openai-codex", "opencode"]),
            { includeSystemPrompt: false },
          ).filter((item: any) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
          acquired.entry.continuation = {
            lastRequestBody: body,
            lastResponseId: completedResponse.id,
            lastResponseItems: responseItems,
          };
        }
        release(true);
        release = undefined;
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        release?.(false);
        cleanStreamingScratch(output);
        if (!sendAttempted && !emitted && requested === "auto" && !options.signal?.aborted) {
          try {
            await pipeAssistantEvents(
              openAIResponsesApi().streamSimple(model, context, options),
              stream,
            );
          } catch (fallbackError) {
            output.stopReason = "error";
            output.errorMessage = fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
          }
          return;
        }
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}

export default async function (pi: ExtensionAPI) {
  const baseUrl = process.env.PI_THIRD_PARTY_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.THIRD_PARTY_API_KEY;
  const providerId = process.env.PI_THIRD_PARTY_PROVIDER_ID || "third-party";

  if (!baseUrl) throw new Error("PI_THIRD_PARTY_BASE_URL is not set");
  if (!apiKey) throw new Error("THIRD_PARTY_API_KEY is not set");

  const initial = await discoverModels(baseUrl, apiKey);
  const providerConfig = initial.metadataConfig.provider ?? {};
  const providerApi =
    providerConfig.api ??
    (nonEmptyString(process.env.PI_THIRD_PARTY_API) as ModelApi | undefined) ??
    "openai-responses";

  pi.registerProvider(providerId, {
    name:
      providerConfig.name ??
      process.env.PI_THIRD_PARTY_PROVIDER_NAME ??
      "Third-party API",
    baseUrl,
    apiKey: "$THIRD_PARTY_API_KEY",
    api: providerApi,
    ...(providerConfig.headers ? { headers: providerConfig.headers } : {}),
    ...(providerConfig.authHeader !== undefined
      ? { authHeader: providerConfig.authHeader }
      : {}),
    ...(providerApi === "openai-responses"
      ? { streamSimple: createCLIProxyStream() }
      : {}),
    models: initial.models,
    async refreshModels({ signal }) {
      return (await discoverModels(baseUrl, apiKey, signal)).models;
    },
  });
}
