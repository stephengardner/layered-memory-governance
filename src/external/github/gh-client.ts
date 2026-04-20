/**
 * GhClient: the reusable GitHub access primitive.
 *
 * Shells out to `gh` (the GitHub CLI) for auth and transport. Any LAG
 * actor that touches GitHub depends on this client; pr-landing is the
 * first consumer but deploy-approver, issue-triage, release-notes will
 * follow. Keep it framework-agnostic.
 *
 * Two surfaces:
 *   - rest<T>(args): typed REST call via `gh api`
 *   - graphql<T>(query, vars): typed GraphQL call via `gh api graphql`
 *
 * Both surfaces parse JSON by default. Callers that need raw bytes can
 * use `raw(args)`.
 *
 * This file has no knowledge of reviews, issues, or any specific GitHub
 * concept; it's pure transport.
 */

import { execa } from 'execa';

export interface GhExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** A pluggable executor. Default is execa('gh', args); tests inject a stub. */
export type GhExecutor = (args: ReadonlyArray<string>, stdin?: string) => Promise<GhExecResult>;

export const defaultGhExecutor: GhExecutor = async (args, stdin) => {
  const options = stdin === undefined
    ? { reject: false as const }
    : { reject: false as const, input: stdin };
  const result = await execa('gh', [...args], options);
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: result.exitCode ?? 0,
  };
};

export class GhClientError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly args: ReadonlyArray<string>;
  constructor(message: string, args: ReadonlyArray<string>, result: GhExecResult) {
    super(`${message} (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
    this.name = 'GhClientError';
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
    this.args = args;
  }
}

export interface GhRestArgs {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  /** Typed field payload; serialized as repeated --field flags. */
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
  /** Query params appended to the path when method is GET. */
  readonly query?: Readonly<Record<string, string | number>>;
}

export interface GhClient {
  readonly executor: GhExecutor;
  /**
   * Typed REST call. Returns `undefined` when gh's stdout is empty
   * (happens for 204 No Content responses like DELETE). Callers that
   * expect a JSON body should check for undefined or use a method
   * like POST that always returns JSON.
   */
  rest<T>(args: GhRestArgs): Promise<T | undefined>;
  graphql<T>(query: string, variables?: Readonly<Record<string, unknown>>): Promise<T>;
  raw(args: ReadonlyArray<string>): Promise<GhExecResult>;
}

export interface GhClientOptions {
  readonly executor?: GhExecutor;
}

export function createGhClient(options: GhClientOptions = {}): GhClient {
  const executor = options.executor ?? defaultGhExecutor;

  async function raw(args: ReadonlyArray<string>): Promise<GhExecResult> {
    const result = await executor(args);
    if (result.exitCode !== 0) {
      throw new GhClientError('gh exited non-zero', args, result);
    }
    return result;
  }

  async function rest<T>(reqArgs: GhRestArgs): Promise<T | undefined> {
    const method = reqArgs.method ?? 'GET';
    const path = applyQueryString(reqArgs.path, reqArgs.query);
    const args: string[] = ['api', path, '--method', method];
    if (reqArgs.fields) {
      for (const [k, v] of Object.entries(reqArgs.fields)) {
        // `gh api --field` (-F) treats a leading '@' in the value as
        // "read from file", so a body like "@coderabbitai review"
        // would have gh try to open a file named "coderabbitai review"
        // and fail with ENOENT. String values use --raw-field (-f)
        // which is always literal; numbers/booleans keep --field so
        // gh still coerces the JSON type on the wire.
        if (typeof v === 'string') {
          args.push('--raw-field', `${k}=${v}`);
        } else {
          args.push('--field', `${k}=${String(v)}`);
        }
      }
    }
    const result = await raw(args);
    return parseJson<T>(result.stdout, args);
  }

  async function graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    // Variable typing in `gh api graphql` is sharp-edged:
    //   - --raw-field: value is sent as a JSON string literally.
    //   - -F (--field):  value is JSON-parsed (bare numbers / booleans /
    //     null become their JSON types; bareword strings would be sent
    //     with the surrounding JSON quotes, which GitHub's GraphQL
    //     parser rejects as a malformed literal).
    // For GraphQL variables we need types preserved. Strings route via
    // --raw-field (bare value becomes JSON string on the wire). Numbers /
    // booleans / null route via -F with bare literal (JSON-typed).
    const args: string[] = ['api', 'graphql', '--raw-field', `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      pushVariableArg(args, k, v);
    }
    const result = await raw(args);
    const parsed = parseJson<{ data: T; errors?: ReadonlyArray<{ message: string }> }>(result.stdout, args);
    if (!parsed) {
      throw new GhClientError(
        'gh graphql returned empty stdout; expected a JSON envelope',
        args,
        result,
      );
    }
    if (parsed.errors && parsed.errors.length > 0) {
      throw new GhClientError(
        `GraphQL returned errors: ${parsed.errors.map((e) => e.message).join('; ')}`,
        args,
        result,
      );
    }
    return parsed.data;
  }

  return { executor, rest, graphql, raw };
}

function applyQueryString(
  path: string,
  query: Readonly<Record<string, string | number>> | undefined,
): string {
  if (!query || Object.keys(query).length === 0) return path;
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs}`;
}

function pushVariableArg(args: string[], key: string, value: unknown): void {
  if (typeof value === 'string') {
    args.push('--raw-field', `${key}=${value}`);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    args.push('-F', `${key}=${String(value)}`);
    return;
  }
  if (value === null) {
    args.push('-F', `${key}=null`);
    return;
  }
  args.push('-F', `${key}=${JSON.stringify(value)}`);
}

function parseJson<T>(stdout: string, args: ReadonlyArray<string>): T | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new GhClientError(
      `gh returned non-JSON stdout: ${(err as Error).message}`,
      args,
      { stdout, stderr: '', exitCode: 0 },
    );
  }
}
