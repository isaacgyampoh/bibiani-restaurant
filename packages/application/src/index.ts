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
import {
  ApproveStockCount,
  CancelStockCount,
  GetRecipe,
  GetStockCount,
  ListInventory,
  ListStockCounts,
  ListStockMovements,
  RecordCountLine,
  RecordStockMovement,
  SaveInventoryItem,
  SaveRecipe,
  StartStockCount,
  SubmitStockCount,
} from './use-cases/inventory';
import { FulfilOrder, MarkOrderReady, TransitionTicket } from './use-cases/kitchen';
import { GetDashboard, GetExpoBoard, GetSalesReport } from './use-cases/operations';
import { CancelOrder, GetReceipt, PrintReceipt, VoidItems } from './use-cases/order-corrections';
import { SendOrderToKitchen, SubmitOrder } from './use-cases/orders';
import { RecordPayment, RefundPayment, VoidPayment } from './use-cases/payments';
import { AssignStaffPin, ChangeOwnPin, PinSignIn, RequestPinRecovery } from './use-cases/pins';
import {
  ClaimPrintJobs,
  GetAgentConfig,
  GetPrintQueue,
  ReportPrintJobResult,
  RetryPrintJob,
} from './use-cases/printing';
import {
  ApplyManualDiscount,
  ListPromotions,
  PreviewPromotion,
  RemoveManualDiscount,
  SavePromotion,
  SetPromotionStatus,
} from './use-cases/promotions';
import {
  GetCustomerBoard,
  GetOrder,
  GetStationBoard,
  ListActiveOrders,
  ListRecentClosedOrders,
  RecordHeartbeat,
} from './use-cases/queries';
import { GetFloor, GetMe, GetMenu, GetOperationsStatus, SetTableStatus } from './use-cases/session';
import type { Dependencies } from './use-cases/shared';
import { MergeOrders, SetOrderPriority, TransferOrder } from './use-cases/table-ops';

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
    listRecentClosedOrders: new ListRecentClosedOrders(deps),
    getDashboard: new GetDashboard(deps),
    getExpoBoard: new GetExpoBoard(deps),
    getSalesReport: new GetSalesReport(deps),
    transferOrder: new TransferOrder(deps),
    mergeOrders: new MergeOrders(deps),
    setOrderPriority: new SetOrderPriority(deps),
    pinSignIn: new PinSignIn(deps),
    changeOwnPin: new ChangeOwnPin(deps),
    assignStaffPin: new AssignStaffPin(deps),
    requestPinRecovery: new RequestPinRecovery(deps),
    listInventory: new ListInventory(deps),
    listStockMovements: new ListStockMovements(deps),
    saveInventoryItem: new SaveInventoryItem(deps),
    recordStockMovement: new RecordStockMovement(deps),
    listStockCounts: new ListStockCounts(deps),
    getStockCount: new GetStockCount(deps),
    startStockCount: new StartStockCount(deps),
    recordCountLine: new RecordCountLine(deps),
    submitStockCount: new SubmitStockCount(deps),
    approveStockCount: new ApproveStockCount(deps),
    cancelStockCount: new CancelStockCount(deps),
    getRecipe: new GetRecipe(deps),
    saveRecipe: new SaveRecipe(deps),
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
    listPromotions: new ListPromotions(deps),
    previewPromotion: new PreviewPromotion(deps),
    savePromotion: new SavePromotion(deps),
    setPromotionStatus: new SetPromotionStatus(deps),
    applyManualDiscount: new ApplyManualDiscount(deps),
    removeManualDiscount: new RemoveManualDiscount(deps),
  };
}
export type Application = ReturnType<typeof createApplication>;
