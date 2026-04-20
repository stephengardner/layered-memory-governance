/**
 * Public surface for the lifecycle primitive.
 *
 * Usage from consumers (including LAG itself):
 *
 *   import { ensureServiceRunning, getServiceStatus, stopService }
 *     from 'layered-autonomous-governance/lifecycle';
 *
 * The primitive knows nothing about LAG. It is shipped as a subpath
 * export so a future extraction to a separate package is mechanical.
 */

export {
  ensureServiceRunning,
  getServiceStatus,
  stopService,
} from './ensure-service-running.js';
export type {
  EnsureServiceOptions,
  EnsureServiceResult,
  GetStatusOptions,
  ServiceStatus,
  StopServiceOptions,
  StopServiceResult,
} from './ensure-service-running.js';
