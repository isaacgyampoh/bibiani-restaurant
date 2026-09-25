import type { Repositories, UnitOfWork } from '@rp/application';
import type { Database, Sql } from '../db/sql';
import { createRepositories } from './repositories';
import { isRetryableInPlace, translatePgError } from './util';

export type RepositoryDecorator = (repos: Repositories, sql: Sql) => Repositories;

/**
 * One transaction per use case, executed as the non-privileged `app_api` role
 * with the tenant fixed for the whole transaction. Postgres RLS therefore
 * enforces tenant isolation on every statement the repositories run.
 * Deadlocks/serialization failures are retried: every command is idempotent.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly options: {
      maxAttempts?: number;
      statementTimeoutMs?: number;
      lockTimeoutMs?: number;
      /** Test hook: wrap repositories (e.g. fault injection). Never set in production wiring. */
      decorate?: RepositoryDecorator;
    } = {},
  ) {}

  async run<T>(restaurantId: string, fn: (tx: Repositories) => Promise<T>): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (sql) => {
          // One round trip: tenant context, timeouts, and the switch to the RLS-bound role (== SET LOCAL ROLE).
          await sql.query(
            `select set_config('app.restaurant_id', $1, true),
                    set_config('statement_timeout', $2, true),
                    set_config('lock_timeout', $3, true),
                    set_config('role', 'app_api', true)`,
            [
              restaurantId,
              String(this.options.statementTimeoutMs ?? 8000),
              String(this.options.lockTimeoutMs ?? 4000),
            ],
          );
          const repos = createRepositories(sql);
          return fn(this.options.decorate ? this.options.decorate(repos, sql) : repos);
        });
      } catch (error) {
        if (attempt < maxAttempts && isRetryableInPlace(error)) continue;
        throw translatePgError(error);
      }
    }
  }
}
