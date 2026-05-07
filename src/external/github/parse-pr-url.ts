/**
 * GitHub PR HTML URL parser.
 *
 * Lives in the github external-system adapter (per D17 + the
 * substrate-purity discipline that keeps GitHub-specific URL shapes
 * out of `src/runtime/`). Callers in `src/runtime/` that need
 * (owner, repo, number) from a `prHtmlUrl` string import this module
 * and pass the resulting structured tuple to mechanism-only helpers.
 *
 * Hard-pins the canonical shape `https://github.com/<owner>/<repo>/pull/<number>`.
 * GitHub Enterprise Server (GHES) hosts and api.github.com subdomains
 * are rejected; a future GHES adapter writes a parallel parser rather
 * than overloading this one. The rest of the LAG repo's bot identities,
 * status checks, and review tooling all assume the canonical
 * github.com host, so the rejection makes drift loud rather than
 * silent.
 */

export interface ParsedPrUrl {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Parse a github.com PR HTML URL into structured (owner, repo, number).
 *
 * Throws a descriptive Error on:
 *   - non-string or empty input
 *   - unparseable URL (no scheme, malformed path)
 *   - non-https/http scheme
 *   - host that is not exactly github.com
 *   - missing `/pull/` segment
 *   - non-integer or non-positive PR number
 *
 * Fail-loud is the correct posture per inv-governance-before-autonomy:
 * a malformed URL means the upstream caller produced inconsistent
 * state, and silently writing a malformed atom would propagate the
 * corruption.
 */
export function parsePrHtmlUrl(prHtmlUrl: string): ParsedPrUrl {
  if (typeof prHtmlUrl !== 'string' || prHtmlUrl.length === 0) {
    throw new Error(`parsePrHtmlUrl: input must be a non-empty string, got ${typeof prHtmlUrl}`);
  }
  let url: URL;
  try {
    url = new URL(prHtmlUrl);
  } catch (err) {
    throw new Error(
      `parsePrHtmlUrl: input is not a valid URL: ${prHtmlUrl} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `parsePrHtmlUrl: scheme must be http(s), got ${url.protocol} in ${prHtmlUrl}`,
    );
  }
  if (url.hostname !== 'github.com') {
    throw new Error(
      `parsePrHtmlUrl: host must be github.com, got ${url.hostname} in ${prHtmlUrl}`,
    );
  }
  // Path shape: `/<owner>/<repo>/pull/<number>` (with optional trailing
  // `/`). `URL.pathname` always begins with `/`; split and discard the
  // leading empty segment.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 4) {
    throw new Error(
      `parsePrHtmlUrl: pathname has too few segments (need /<owner>/<repo>/pull/<number>): ${prHtmlUrl}`,
    );
  }
  const [owner, repo, segment, numberRaw] = segments;
  if (segment !== 'pull') {
    throw new Error(
      `parsePrHtmlUrl: path segment 3 must be 'pull', got '${segment ?? ''}' in ${prHtmlUrl}`,
    );
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error(`parsePrHtmlUrl: owner segment is empty: ${prHtmlUrl}`);
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`parsePrHtmlUrl: repo segment is empty: ${prHtmlUrl}`);
  }
  if (typeof numberRaw !== 'string' || numberRaw.length === 0) {
    throw new Error(`parsePrHtmlUrl: number segment is empty: ${prHtmlUrl}`);
  }
  const number = Number(numberRaw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `parsePrHtmlUrl: number segment is not a positive integer: '${numberRaw}' in ${prHtmlUrl}`,
    );
  }
  return { owner, repo, number };
}
