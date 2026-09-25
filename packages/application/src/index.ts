import {
  CreatePairingCode,
  CreateStaff,
  DeleteConfig,
  GetConfiguration,
  PairDevice,
  RevokeDevice,
  SaveConfig,
  UpdateStaff,
} from './use-cases/administration';
import { FulfilOrder, MarkOrderReady, TransitionTicket } from './use-cases/kitchen';
import { CancelOrder, GetReceipt, PrintReceipt, VoidItems } from './use-cases/order-corrections';
import { SendOrderToKitchen, SubmitOrder } from './use-cases/orders';
import { RecordPayment, RefundPayment, VoidPayment } from './use-cases/payments';
import {
  ClaimPrintJobs,
  GetAgentConfig,
  GetPrintQueue,
  ReportPrintJobResult,
  RetryPrintJob,
} from './use-cases/printing';
import {
  GetCustomerBoard,
  GetOrder,
  GetStationBoard,
  ListActiveOrders,
  RecordHeartbeat,
} from './use-cases/queries';
import { GetFloor, GetMe, GetMenu, GetOperationsStatus, SetTableStatus } from './use-cases/session';
import type { Dependencies } from './use-cases/shared';

export * from './ports';
export * from './principal';
export type { Dependencies } from './use-cases/shared';

export function createApplication(deps: Dependencies) {
  return {
    submitOrder: new SubmitOrder(deps),
    sendOrderToKitchen: new SendOrderToKitchen(deps),
    transitionTicket: new TransitionTicket(deps),
    fulfilOrder: new FulfilOrder(deps),
    recordPayment: new RecordPayment(deps),
    voidPayment: new VoidPayment(deps),
    refundPayment: new RefundPayment(deps),
    getAgentConfig: new GetAgentConfig(deps),
    claimPrintJobs: new ClaimPrintJobs(deps),
    reportPrintJobResult: new ReportPrintJobResult(deps),
    retryPrintJob: new RetryPrintJob(deps),
    getPrintQueue: new GetPrintQueue(deps),
    getOrder: new GetOrder(deps),
    listActiveOrders: new ListActiveOrders(deps),
    getStationBoard: new GetStationBoard(deps),
    getCustomerBoard: new GetCustomerBoard(deps),
    recordHeartbeat: new RecordHeartbeat(deps),
    markOrderReady: new MarkOrderReady(deps),
    cancelOrder: new CancelOrder(deps),
    voidItems: new VoidItems(deps),
    getReceipt: new GetReceipt(deps),
    printReceipt: new PrintReceipt(deps),
    getMe: new GetMe(deps),
    getMenu: new GetMenu(deps),
    getFloor: new GetFloor(deps),
    setTableStatus: new SetTableStatus(deps),
    getOperationsStatus: new GetOperationsStatus(deps),
    getConfiguration: new GetConfiguration(deps),
    saveConfig: new SaveConfig(deps),
    deleteConfig: new DeleteConfig(deps),
    createStaff: new CreateStaff(deps),
    updateStaff: new UpdateStaff(deps),
    createPairingCode: new CreatePairingCode(deps),
    pairDevice: new PairDevice(deps),
    revokeDevice: new RevokeDevice(deps),
  };
}
export type Application = ReturnType<typeof createApplication>;
