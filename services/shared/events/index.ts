import { Topic } from "encore.dev/pubsub";

export interface TelegramMessageUpdate {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; last_name?: string; username?: string };
  text?: string;
  date: number;
  // Mensagens de serviço de migração grupo→supergrupo (o chat ganha um id novo).
  migrate_to_chat_id?:   number;
  migrate_from_chat_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name: string; username?: string };
  message?: TelegramMessageUpdate;
  data?: string;
}

// Disparado quando o status do PRÓPRIO bot muda num chat (ex.: virou admin de
// um grupo/canal, ou foi removido). Requer "my_chat_member" em allowed_updates.
export interface TelegramChatMemberUpdated {
  chat: { id: number; type: string; title?: string };
  from?: { id: number; first_name?: string; username?: string };
  new_chat_member?: { status: string; user?: { id: number; is_bot?: boolean } };
  old_chat_member?: { status: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessageUpdate;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
}

export interface TelegramUpdateEvent {
  botId:  string;
  update: TelegramUpdate;
}

export interface FlowStepExecutedEvent {
  sessionId:  string;
  nodeId:     string;
  nodeType:   string;
  nextNodeId: string | null;
}

// Publicado quando um pagamento é confirmado (webhook). O runner assina p/
// entregar o produto e retomar o funil pelo handle `__paid` da oferta.
export interface PaymentPaidEvent {
  paymentId: string;
}

export const telegramUpdateReceived = new Topic<TelegramUpdateEvent>(
  "telegram-update-received",
  { deliveryGuarantee: "at-least-once" },
);

export const flowStepExecuted = new Topic<FlowStepExecutedEvent>(
  "flow-step-executed",
  { deliveryGuarantee: "at-least-once" },
);

export const paymentPaid = new Topic<PaymentPaidEvent>(
  "payment-paid",
  { deliveryGuarantee: "at-least-once" },
);
