const REDACTED = '<redacted>';

/** Deep enough for viem's error chains (action error → RPC error → HTTP error → fetch cause). */
const MAX_DEPTH = 10;

type Replacement = readonly [secret: string, replacement: string];

/** `decodeURIComponent`, but a malformed escape (`%zz`) returns the input instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The parts of the URL that can hold an API key: the path and query (`/v2/<key>`, `?apikey=`)
 * and the userinfo (`user:pass@`). The scheme, host and port stay readable, because they help
 * debugging and are not secret.
 */
function replacementsFor(url: string): Replacement[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: hide the whole value.
    return url === '' ? [] : [[url, REDACTED]];
  }
  const replacements: Replacement[] = [];
  // The parsed path and query, each alone, for text that shows only one of them.
  if (parsed.pathname !== '/') replacements.push([parsed.pathname, `/${REDACTED}`]);
  if (parsed.search !== '') replacements.push([parsed.search, `?${REDACTED}`]);
  // Everything after the authority, as typed. viem's messages show the URL as typed, and the
  // parser can change it (it percent-encodes characters such as `é` or a space).
  const rawRest = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(.*)$/is.exec(url)?.[1] ?? '';
  if (rawRest.length > 1) replacements.push([rawRest, `/${REDACTED}`]);
  for (const part of [parsed.password, parsed.username]) {
    if (part === '') continue;
    replacements.push([part, REDACTED]);
    const decoded = safeDecode(part);
    if (decoded !== part) replacements.push([decoded, REDACTED]);
  }
  // Longest first, so a secret that contains another one is replaced whole.
  return replacements.toSorted(([a], [b]) => b.length - a.length);
}

function redactString(value: string, replacements: readonly Replacement[]): string {
  let result = value;
  for (const [secret, replacement] of replacements) result = result.replaceAll(secret, replacement);
  return result;
}

function redactValue(
  value: unknown,
  replacements: readonly Replacement[],
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactString(value, replacements);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (depth > MAX_DEPTH) return REDACTED;

  if (value instanceof Error) {
    const copy = new Error(redactString(value.message, replacements));
    seen.set(value, copy);
    copy.name = value.name;
    copy.stack = value.stack === undefined ? undefined : redactString(value.stack, replacements);
    // Own enumerable fields: viem's `url`, `body`, `details`, `shortMessage`, `metaMessages`,
    // `status`; Node's `code`. `cause` and `AggregateError#errors` are not enumerable.
    for (const key of Object.keys(value)) {
      (copy as unknown as Record<string, unknown>)[key] = redactValue(
        (value as unknown as Record<string, unknown>)[key],
        replacements,
        seen,
        depth + 1,
      );
    }
    if ('cause' in value) copy.cause = redactValue(value.cause, replacements, seen, depth + 1);
    if (value instanceof AggregateError) {
      Object.defineProperty(copy, 'errors', {
        value: value.errors.map((item: unknown) =>
          redactValue(item, replacements, seen, depth + 1),
        ),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactValue(item, replacements, seen, depth + 1));
    return copy;
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[key] = redactValue(item, replacements, seen, depth + 1);
    }
    return copy;
  }

  // Other objects (for example the response `Headers`) carry no request URL.
  return value;
}

/**
 * Returns a copy of `err` with the secret parts of the RPC URL removed from every message, stack,
 * field and cause. viem puts the URL in its error messages and only strips `user:pass@` from it,
 * so a provider key in the path (`https://provider.example/v2/<key>`) reaches the logs. The
 * logger's `redact` option can't help: it matches field names, not text inside a message.
 *
 * Call this at the logging boundary only. The copies are plain `Error` objects (with the original
 * `name`), so classify an error (retryable or not) on the original before redacting it.
 */
export function redactRpcUrl(err: unknown, url: string): unknown {
  return redactValue(err, replacementsFor(url), new WeakMap(), 0);
}
