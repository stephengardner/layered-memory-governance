/**
 * Typed error hierarchy for the host interface.
 *
 * Adapters throw these. LAG logic catches specific subclasses to decide
 * retry / surface / abort. Callers distinguish transient (retry-eligible)
 * from permanent (do not retry).
 */

export class HostError extends Error {
  /** Machine-readable kind, used for logging and programmatic handling. */
  readonly kind: string;

  constructor(kind: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.name = new.target.name;
    // Ensure instanceof works across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('not_found', message, options);
  }
}

export class ConflictError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('conflict', message, options);
  }
}

export class TimeoutError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('timeout', message, options);
  }
}

export class PermissionError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('permission', message, options);
  }
}

export class ValidationError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('validation', message, options);
  }
}

/** Caller may retry; network blip, rate limit, etc. */
export class TransientError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('transient', message, options);
  }
}

/** Capability not supported by this adapter. */
export class UnsupportedError extends HostError {
  constructor(message: string, options?: ErrorOptions) {
    super('unsupported', message, options);
  }
}
