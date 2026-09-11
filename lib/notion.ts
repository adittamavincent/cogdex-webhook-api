import { Client, isNotionClientError, APIResponseError } from "@notionhq/client";
import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";
import { debug, warn, error } from "./logger";

// Instantiate the raw Notion Client with required configuration.
const rawClient = new Client({
  auth: process.env.NOTION_TOKEN!,
  notionVersion: "2026-03-11",
});

// Single shared limiter capping global Notion API concurrency to 3 concurrent calls
// (matching Notion's ~3 req/sec average rate limit). Unbounded Promise.all fan-outs across
// the codebase (e.g. reading memo entry contents, deleting blocks in chunks) will be automatically
// shaped into small concurrent batches of 3.
// Total retries are capped (4 retries max, ~500ms to ~8s backoff range) so that worst-case latency
// stays well within Vercel's 60-second maxDuration budget.
const limit = pLimit(3);

/**
 * Defensively extracts the Retry-After header duration in milliseconds if present.
 * Supports both standard web Headers objects (.get('retry-after')) and plain objects (['retry-after']).
 */
function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;

  const headers =
    (err as Record<string, any>).headers ||
    (err as Record<string, any>).response?.headers;

  if (!headers) return null;

  let val: string | null | undefined = null;
  if (typeof headers.get === "function") {
    val = headers.get("retry-after") ?? headers.get("Retry-After");
  } else if (typeof headers === "object") {
    val = headers["retry-after"] ?? headers["Retry-After"];
  }

  if (!val) return null;
  const seconds = parseFloat(val);
  if (!isNaN(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  return null;
}

/**
 * Creates a recursive Proxy wrapper around an object (e.g. Notion Client or nested namespace)
 * to intercept function calls and apply global concurrency limiting + retries.
 */
function createResilientClient(targetClient: Client): Client {
  function wrap<T extends object>(objToWrap: T, path: string = ""): T {
    const fnCache = new Map<string | symbol, any>();

    return new Proxy(objToWrap, {
      get(target, prop, receiver) {
        // Pass through internal JavaScript properties and symbols
        if (typeof prop === "symbol" || prop in Object.prototype) {
          return Reflect.get(target, prop, receiver);
        }

        const value = Reflect.get(target, prop, receiver);

        if (typeof value === "function") {
          if (fnCache.has(prop)) {
            return fnCache.get(prop);
          }

          const methodPath = path ? `${path}.${String(prop)}` : String(prop);

          const wrappedMethod = (...args: any[]) => {
            return limit(() =>
              pRetry(
                async () => {
                  try {
                    return await value.apply(target, args);
                  } catch (err: unknown) {
                    if (isNotionClientError(err)) {
                      const status = (err as APIResponseError).status;
                      // Abort immediately for 4xx errors other than 429 (e.g. 400, 401, 403, 404, 409).
                      if (
                        typeof status === "number" &&
                        status >= 400 &&
                        status < 500 &&
                        status !== 429
                      ) {
                        throw new AbortError(err as Error);
                      }
                    }
                    // Retriable: 429, status >= 500, or non-Notion network errors (fetch failure, ECONNRESET, etc.)
                    throw err;
                  }
                },
                {
                  retries: 4, // 4 retries = 5 attempts max
                  factor: 2,
                  minTimeout: 500,
                  maxTimeout: 8000,
                  onFailedAttempt: async (failedAttempt) => {
                    const underlyingError =
                      (failedAttempt as any).error ||
                      (failedAttempt as any).cause ||
                      failedAttempt;
                    const retriesLeft = failedAttempt.retriesLeft;
                    const attemptNumber = failedAttempt.attemptNumber;

                    warn(
                      `[Notion API] Call '${methodPath}' failed (attempt ${attemptNumber}, ${retriesLeft} retries left):`,
                      (underlyingError as Error)?.message || underlyingError
                    );

                    // If Retry-After header is present, pause for the requested duration
                    const retryAfterMs = getRetryAfterMs(underlyingError);
                    if (retryAfterMs && retryAfterMs > 0) {
                      debug(
                        `[Notion API] Respecting Retry-After header for '${methodPath}': waiting ${retryAfterMs}ms`
                      );
                      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
                    }
                  },
                }
              ).catch((err) => {
                const finalErr = err instanceof AbortError ? err.cause : err;
                error(`[Notion API] Call '${methodPath}' failed permanently:`, finalErr);
                throw finalErr;
              })
            );
          };

          fnCache.set(prop, wrappedMethod);
          return wrappedMethod;
        }

        if (value !== null && typeof value === "object") {
          if (fnCache.has(prop)) {
            return fnCache.get(prop);
          }
          const subPath = path ? `${path}.${String(prop)}` : String(prop);
          const wrappedObj = wrap(value, subPath);
          fnCache.set(prop, wrappedObj);
          return wrappedObj;
        }

        return value;
      },
    });
  }

  return wrap(targetClient);
}

export const notion = createResilientClient(rawClient);
