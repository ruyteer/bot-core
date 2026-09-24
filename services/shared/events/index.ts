import { Topic } from "encore.dev/pubsub";

// Tipos de anexo que o Telegram manda em `message.*` — o JSON bruto do update
// SEMPRE os inclui quando aplicável; só não estavam tipados aqui, então o
// runner nunca sequer olhava pra eles (ver `inboundContentFromMessage` em
// `execute-flow-step.use-case.ts`).
export interface TelegramPhotoSize {
  file_id: string;
  width?:  number;
  height?: number;
}

export interface TelegramVideo   { file_id: string; duration?: number; }
export interface TelegramVoice   { file_id: string; duration?: number; }
export interface TelegramAudio   { file_id: string; duration?: number; title?: string; performer?: string; }
export interface TelegramDocument { file_id: string; file_name?: string; }
export interface TelegramSticker  { file_id: string; emoji?: string; }
export interface TelegramContact  { phone_number: string; first_name: string; last_name?: string; user_id?: number; }
export interface TelegramLocation { latitude: number; longitude: number; }

export interface TelegramMessageUpdate {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; last_name?: string; username?: string };
  text?: string;
  date: number;
  // Mensagens de serviço de migração grupo→supergrupo (o chat ganha um id novo).
  migrate_to_chat_id?:   number;
  migrate_from_chat_id?: number;
  // Anexos que o LEAD pode mandar — só um deles vem preenchido por mensagem
  // (Telegram nunca manda dois no mesmo update). `caption` acompanha qualquer
  // um dos tipos de mídia abaixo (exceto contact/location, que não têm legenda).
  photo?:    TelegramPhotoSize[];
  video?:    TelegramVideo;
  voice?:    TelegramVoice;
  audio?:    TelegramAudio;
  document?: TelegramDocument;
  sticker?:  TelegramSticker;
  contact?:  TelegramContact;
  location?: TelegramLocation;
  caption?:  string;
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
