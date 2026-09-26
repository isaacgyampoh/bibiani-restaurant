import { type ApiClient, ApiError } from '@rp/client-core';
import type { HeartbeatCommand, HubBatchCommand, HubPinChangeCommand } from '@rp/contracts';
import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from '@rp/domain';
import type { CloudPinPort } from './pin-service';
import { type CloudPort, CloudRefusedError } from './sync-engine';

/**
 * The hub's connection to the MY FOOD cloud API, as the hub's own paired device login.
 * No answer (no internet, timeout) and server errors are "offline" and retried later; a clear
 * refusal (e.g. hub not attached, revoked) is reported as such and needs a person.
 */
export class HttpCloud implements CloudPort, CloudPinPort {
  constructor(private readonly api: ApiClient) {}

  snapshot(since: string | null) {
    return this.guard(() => this.api.hubSnapshot(since));
  }

  upload(batch: HubBatchCommand) {
    return this.guard(() => this.api.hubUpload(batch));
  }

  /** The hub's heartbeat to the cloud, with its health report for the back office. */
  report(cmd: HeartbeatCommand) {
    return this.api.heartbeat(cmd);
  }

  /** Throws when the PIN is wrong or the cloud is unreachable; the PIN service then checks locally. */
  verifyPin(pin: string) {
    return this.api.hubPinVerify(pin);
  }

  /** Errors are passed on as they are, so the till shows the cloud's message ("current PIN not correct"). */
  async changePin(cmd: HubPinChangeCommand) {
    try {
      return await this.api.hubPinChange(cmd);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500)
        throw new DomainError(
          (DOMAIN_ERROR_CODES as readonly string[]).includes(error.code)
            ? (error.code as DomainErrorCode)
            : 'VALIDATION_FAILED',
          error.message,
        );
      throw new DomainError(
        'UNAVAILABLE',
        'Changing a PIN needs the internet. Your current PIN still works.',
      );
    }
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        throw new CloudRefusedError(error.message, error.code);
      throw error;
    }
  }
}
