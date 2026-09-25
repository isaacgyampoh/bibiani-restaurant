import type {
  CustomerBoardView,
  HeartbeatCommand,
  OrderSummaryView,
  OrderView,
  StationBoardView,
} from '@rp/contracts';
import { DomainError } from '@rp/domain';
import { authorize, can, type RequestContext } from '../principal';
import { CommitLog, type Dependencies } from './shared';

export class GetOrder {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string): Promise<OrderView> {
    const view = await this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.order(orderId));
    if (!view) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
    authorize(ctx.principal, 'order.view', view.branchId);
    return view;
  }
}

export class ListActiveOrders {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<OrderSummaryView[]> {
    authorize(ctx.principal, 'order.view', branchId);
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.activeOrders(branchId));
  }
}

/** Everything a station's KDS needs, in one query. Used on load, on reconnect and by the safety poll. */
export class GetStationBoard {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, stationId: string): Promise<StationBoardView> {
    const { deviceKind, deviceStationId } = ctx.principal;
    if (deviceKind === 'kds' && deviceStationId && deviceStationId !== stationId) {
      throw new DomainError('FORBIDDEN', 'This screen belongs to another station');
    }
    const board = await this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.read.stationBoard(stationId),
    );
    if (!board) throw new DomainError('NOT_FOUND', 'Station not found', { stationId });
    const branchId = board.station.branchId;
    if (!can(ctx.principal, 'kitchen.operate', branchId)) authorize(ctx.principal, 'order.view', branchId);
    return board;
  }
}

export class GetCustomerBoard {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, branchId: string): Promise<CustomerBoardView> {
    if (!can(ctx.principal, 'display.view', branchId)) authorize(ctx.principal, 'order.view', branchId);
    const now = this.deps.clock.now();
    return this.deps.uow.run(ctx.principal.restaurantId, (tx) => tx.read.customerBoard(branchId, now));
  }
}

/** Device liveness. Printer health reported by print agents is stored alongside. */
export class RecordHeartbeat {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: HeartbeatCommand): Promise<{ ok: true }> {
    const deviceId = ctx.principal.kind === 'device' ? ctx.principal.deviceId : ctx.deviceId;
    if (!deviceId) throw new DomainError('VALIDATION_FAILED', 'Heartbeats come from a registered device');
    const now = this.deps.clock.now();
    const log = new CommitLog(ctx);
    await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const { previousHeartbeatAt } = await tx.devices.heartbeat(deviceId, cmd.appVersion ?? null, now);
      if (!previousHeartbeatAt || now.getTime() - previousHeartbeatAt.getTime() > 90_000) {
        await tx.devices.appendEvent(deviceId, 'heartbeat_resumed', {
          gapSeconds: previousHeartbeatAt
            ? Math.round((now.getTime() - previousHeartbeatAt.getTime()) / 1000)
            : null,
        });
        log.add('device.connected', { deviceId, previousHeartbeatAt });
      }
      if (cmd.printers.length > 0) {
        const own = new Set((await tx.printJobs.agentPrinters(deviceId)).map((p) => p.printerId));
        for (const p of cmd.printers) {
          if (!own.has(p.printerId)) continue; // an agent only reports on printers it drives
          await tx.printJobs.recordPrinterStatus(p.printerId, p.ok ? null : (p.error ?? 'unreachable'), now);
          if (!p.ok) log.add('printer.unhealthy', { printerId: p.printerId, error: p.error ?? null });
        }
      }
    });
    log.flush(this.deps.logger);
    return { ok: true };
  }
}
