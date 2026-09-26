import type { ActivityCategory, ActivityView } from '@rp/contracts';
import type { RequestContext } from '../principal';
import { authorizeRestaurantWide } from './administration';
import type { Dependencies } from './shared';

const PAGE = 60;
/** Fields that must never be shown, even if a future change ever wrote one into the audit log. */
const SECRET = /pin|password|secret|token|code_hash|lookup/i;

function scrub(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !SECRET.test(k) || k === 'pinAssigned')
      .map(([k, x]) => [k, x && typeof x === 'object' && !Array.isArray(x) ? scrub(x) : x]),
  );
}

/** The restaurant's audit history in plain terms: who changed what, when, and why. Owners and managers only. */
export class ListActivity {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    filter: { category?: ActivityCategory | null; search?: string | null; before?: number | null },
  ): Promise<ActivityView> {
    authorizeRestaurantWide(ctx, 'audit.view');
    const search = filter.search?.trim().slice(0, 80) || null;
    const rows = await this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.read.activity({
        category: filter.category ?? null,
        search,
        before: filter.before ?? null,
        limit: PAGE + 1,
      }),
    );
    const entries = rows
      .slice(0, PAGE)
      .map((e) => ({ ...e, before: scrub(e.before), after: scrub(e.after) }));
    return { entries, nextBefore: rows.length > PAGE ? entries[entries.length - 1]!.id : null };
  }
}
