import {
  pgTable, pgEnum, uuid, text, boolean, timestamp,
  bigint, doublePrecision, jsonb, integer, primaryKey,
  uniqueIndex, unique, index,
} from "drizzle-orm/pg-core";

// ─── ENUMS ────────────────────────────────────────────────────────────────────

export const nodeTypeEnum = pgEnum("node_type", [
  "trigger", "message", "media", "audio", "buttons", "input",
  "delay", "condition", "random", "offer", "wait_response",
]);

// ─── IDENTITY ─────────────────────────────────────────────────────────────────

// id = Supabase auth UUID — no defaultRandom, provided on upsert
export const profiles = pgTable("profiles", {
  id:        uuid("id").primaryKey(),
  email:     text("email").notNull().default(""),
  name:      text("name").notNull().default(""),
  isBlocked: boolean("is_blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  role:   text("role").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.role] })]);

// ─── BOTS ─────────────────────────────────────────────────────────────────────

export const bots = pgTable("bots", {
  id:              uuid("id").defaultRandom().primaryKey(),
  userId:          uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  name:            text("name").notNull(),
  telegramToken:   text("telegram_token").notNull(),   // AES-256-GCM encrypted
  telegramUsername:text("telegram_username"),
  isActive:        boolean("is_active").notNull().default(true),
  protectContent:  boolean("protect_content").notNull().default(false),
  webhookSecret:   text("webhook_secret").notNull(),
  // Gateway PIX padrão deste bot (usado por broadcast/remarketing/ofertas e como
  // fallback no funil/oferta quando não há um gateway específico).
  defaultGatewayId: uuid("default_gateway_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => paymentGateways.id, { onDelete: "set null" }),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const botGroups = pgTable("bot_groups", {
  id:             uuid("id").defaultRandom().primaryKey(),
  botId:          uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  name:           text("name").notNull(),
  telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
  type:           text("type").notNull().default("group"),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const vipMembers = pgTable("vip_members", {
  id:             uuid("id").defaultRandom().primaryKey(),
  botId:          uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  groupId:        uuid("group_id").references(() => botGroups.id, { onDelete: "cascade" }),
  telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
  username:       text("username"),
  firstName:      text("first_name"),
  lastName:       text("last_name"),
  isBlocked:      boolean("is_blocked").notNull().default(false),
  joinedAt:       timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── LEADS ────────────────────────────────────────────────────────────────────

export const leads = pgTable("leads", {
  id:              uuid("id").defaultRandom().primaryKey(),
  botId:           uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  telegramChatId:  bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
  telegramUsername:text("telegram_username"),
  firstName:       text("first_name"),
  lastName:        text("last_name"),
  utmSource:       text("utm_source"),
  utmMedium:       text("utm_medium"),
  utmCampaign:     text("utm_campaign"),
  utmContent:      text("utm_content"),
  utmTerm:         text("utm_term"),
  fbclid:          text("fbclid"),
  fbp:             text("fbp"),
  fbc:             text("fbc"),
  ttclid:          text("ttclid"),
  externalId:      text("external_id"),
  clientIp:        text("client_ip"),
  clientUserAgent: text("client_user_agent"),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("leads_bot_telegram_unique").on(t.botId, t.telegramChatId)]);

export const leadVariables = pgTable("lead_variables", {
  id:           uuid("id").defaultRandom().primaryKey(),
  leadId:       uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  botId:        uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  variableName: text("variable_name").notNull(),
  value:        text("value").notNull().default(""),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Necessária para o upsert de setVar (ON CONFLICT lead_id, variable_name).
  unique("lead_variables_lead_id_variable_name_unique").on(t.leadId, t.variableName),
]);

export const leadMessages = pgTable("lead_messages", {
  id:               uuid("id").defaultRandom().primaryKey(),
  leadId:           uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  botId:            uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  direction:        text("direction").notNull(),                // 'inbound' | 'outbound'
  content:          jsonb("content").notNull().default({}),
  telegramMessageId:bigint("telegram_message_id", { mode: "bigint" }),
  isPaused:         boolean("is_paused").notNull().default(false),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── FUNNELS ──────────────────────────────────────────────────────────────────

export const funnels = pgTable("funnels", {
  id:               uuid("id").defaultRandom().primaryKey(),
  userId:           uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  botId:            uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
  name:             text("name").notNull(),
  kind:             text("kind").notNull().default("flow"),    // 'flow' | 'simplified'
  isActive:         boolean("is_active").notNull().default(false),
  simplifiedConfig: jsonb("simplified_config").notNull().default({}),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const funnelBots = pgTable("funnel_bots", {
  funnelId:  uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  botId:     uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.funnelId, t.botId] })]);

export const funnelNodes = pgTable("funnel_nodes", {
  id:        uuid("id").defaultRandom().primaryKey(),
  funnelId:  uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  type:      nodeTypeEnum("type").notNull(),
  content:   jsonb("content").notNull().default({}),
  positionX: doublePrecision("position_x").notNull().default(0),
  positionY: doublePrecision("position_y").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const nodeConnections = pgTable("node_connections", {
  id:           uuid("id").defaultRandom().primaryKey(),
  funnelId:     uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  sourceNodeId: uuid("source_node_id").notNull().references(() => funnelNodes.id, { onDelete: "cascade" }),
  sourceHandle: text("source_handle"),
  targetNodeId: uuid("target_node_id").notNull().references(() => funnelNodes.id, { onDelete: "cascade" }),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const funnelOffers = pgTable("funnel_offers", {
  id:              uuid("id").defaultRandom().primaryKey(),
  funnelId:        uuid("funnel_id").references(() => funnels.id, { onDelete: "set null" }),
  botId:           uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  nodeId:          uuid("node_id").references(() => funnelNodes.id, { onDelete: "set null" }),
  name:            text("name").notNull(),
  price:           integer("price").notNull().default(0),        // centavos
  productType:     text("product_type").notNull().default("digital"),
  scope:           text("scope").notNull().default("global"),
  accessDays:      integer("access_days").notNull().default(30),
  deliveryUrl:     text("delivery_url"),
  deliveryText:    text("delivery_text"),
  telegramGroupId: uuid("telegram_group_id").references(() => botGroups.id, { onDelete: "set null" }),
  externalRef:     text("external_ref"),
  isActive:        boolean("is_active").notNull().default(true),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── LEAD FLOW STATE ──────────────────────────────────────────────────────────

export const leadProgress = pgTable("lead_progress", {
  id:            uuid("id").defaultRandom().primaryKey(),
  leadId:        uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  funnelId:      uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  currentNodeId: uuid("current_node_id").references(() => funnelNodes.id, { onDelete: "set null" }),
  status:        text("status").notNull().default("active"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scheduledDelays = pgTable("scheduled_delays", {
  id:          uuid("id").defaultRandom().primaryKey(),
  botId:       uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  leadId:      uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  funnelId:    uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  progressId:  uuid("progress_id").notNull().references(() => leadProgress.id, { onDelete: "cascade" }),
  nextNodeId:  uuid("next_node_id").notNull().references(() => funnelNodes.id, { onDelete: "cascade" }),
  executeAt:   timestamp("execute_at", { withTimezone: true }).notNull(),
  status:      text("status").notNull().default("pending"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Tarefas agendadas do funil SIMPLIFICADO (upsell pós-compra, downsell pós-PIX
// sem pagamento). Processadas pelo tick de 60s do runner — não cabem em
// scheduled_delays (que exige um nó de fluxo).
export const simplifiedScheduledTasks = pgTable("simplified_scheduled_tasks", {
  id:        uuid("id").defaultRandom().primaryKey(),
  botId:     uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  leadId:    uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  funnelId:  uuid("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  kind:      text("kind").notNull(),               // "upsell" | "downsell"
  refId:     text("ref_id").notNull(),             // id do upsell/downsell no simplified_config
  paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
  executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
  status:    text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Idempotência no agendamento (retry não duplica).
  unique("simplified_scheduled_payment_kind_ref_unique").on(t.paymentId, t.kind, t.refId),
]);

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────

export const paymentGateways = pgTable("payment_gateways", {
  id:           uuid("id").defaultRandom().primaryKey(),
  userId:       uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  botId:        uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
  provider:     text("provider").notNull(),   // 'syncpay' | 'buckpay' | 'nexuspag' | 'wiinpay'
  label:        text("label").notNull().default(""),
  clientId:     text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),  // AES-256-GCM encrypted
  isActive:     boolean("is_active").notNull().default(true),
  metadata:     jsonb("metadata").notNull().default({}),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Ordem de fallback de gateways do bot: se a geração do PIX falhar no primeiro,
// o runner tenta o próximo (position asc). Substitui bots.default_gateway_id e a
// escolha de gateway por oferta/funil — a ordem do bot é a única fonte.
export const botPaymentGateways = pgTable("bot_payment_gateways", {
  id:        uuid("id").defaultRandom().primaryKey(),
  botId:     uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  gatewayId: uuid("gateway_id").notNull().references(() => paymentGateways.id, { onDelete: "cascade" }),
  position:  integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  botGatewayUnique: unique("bot_payment_gateways_bot_id_gateway_id_key").on(t.botId, t.gatewayId),
}));

export const payments = pgTable("payments", {
  id:               uuid("id").defaultRandom().primaryKey(),
  userId:           uuid("user_id").notNull().references(() => profiles.id),
  botId:            uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  leadId:           uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  gatewayId:        uuid("gateway_id").notNull().references(() => paymentGateways.id),
  offerId:          uuid("offer_id").references(() => funnelOffers.id, { onDelete: "set null" }),
  offerName:        text("offer_name"),
  offerExternalRef: text("offer_external_ref"),
  amount:           integer("amount").notNull(),   // centavos
  finalAmount:      integer("final_amount"),
  status:           text("status").notNull().default("pending"),
  saleType:         text("sale_type"),
  externalId:       text("external_id"),
  pixCode:          text("pix_code"),
  endToEnd:         text("end_to_end"),
  paidAt:           timestamp("paid_at", { withTimezone: true }),
  description:      text("description"),
  // Funnel resume context — let the "paid" webhook resume the funnel where it stopped
  funnelId:         uuid("funnel_id").references(() => funnels.id, { onDelete: "set null" }),
  progressId:       uuid("progress_id").references(() => leadProgress.id, { onDelete: "set null" }),
  nodeId:           uuid("node_id").references(() => funnelNodes.id, { onDelete: "set null" }),
  paidHandle:       text("paid_handle"),   // source_handle to follow when paid, e.g. "<callback>__paid"
  // Snapshot do contexto de entrega do funil SIMPLIFICADO (não tem nós/funnel_offers):
  // { kind: "plan"|"upsell"|"downsell", funnelId, planId?, items: [{name, delivery_type, ...}] }
  simplifiedCtx:    jsonb("simplified_ctx"),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const paymentWebhookLogs = pgTable("payment_webhook_logs", {
  id:              uuid("id").defaultRandom().primaryKey(),
  provider:        text("provider"),
  externalId:      text("external_id"),
  event:           text("event"),
  payload:         jsonb("payload").notNull().default({}),
  status:          text("status"),
  processed:       boolean("processed").notNull().default(false),
  sourceIp:        text("source_ip"),
  amount:          integer("amount"),
  matchedPaymentId:uuid("matched_payment_id").references(() => payments.id, { onDelete: "set null" }),
  errorMessage:    text("error_message"),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Idempotency table — (externalId, provider) must be unique
export const processedWebhooks = pgTable("processed_webhooks", {
  externalId:   text("external_id").notNull(),
  provider:     text("provider").notNull(),
  payloadHash:  text("payload_hash"),
  status:       text("status").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.externalId, t.provider] })]);

// ─── BROADCASTS ───────────────────────────────────────────────────────────────

export const scheduledMessages = pgTable("scheduled_messages", {
  id:                    uuid("id").defaultRandom().primaryKey(),
  userId:                uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  botId:                 uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  botIds:                jsonb("bot_ids").notNull().default([]),
  message:               text("message").notNull(),
  broadcastType:         text("broadcast_type").notNull().default("instant"),
  filterType:            text("filter_type").notNull().default("all"),
  targetType:            text("target_type").notNull().default("leads"),
  targetGroupIds:        jsonb("target_group_ids").notNull().default([]),
  funnelId:              uuid("funnel_id").references(() => funnels.id, { onDelete: "set null" }),
  advancedFilters:       jsonb("advanced_filters"),
  scheduledAt:           timestamp("scheduled_at", { withTimezone: true }).notNull(),
  sentAt:                timestamp("sent_at", { withTimezone: true }),
  status:                text("status").notNull().default("pending"),
  recurrenceRule:        jsonb("recurrence_rule"),
  recurrenceCount:       integer("recurrence_count").notNull().default(0),
  recurrenceMaxOccurrences: integer("recurrence_max_occurrences"),
  recurrenceEndAt:       timestamp("recurrence_end_at", { withTimezone: true }),
  parentScheduleId:      uuid("parent_schedule_id"),
  createdAt:             timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:             timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const broadcastRuns = pgTable("broadcast_runs", {
  id:               uuid("id").defaultRandom().primaryKey(),
  userId:           uuid("user_id").notNull().references(() => profiles.id),
  botId:            uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  botIds:           jsonb("bot_ids").notNull().default([]),
  campaignId:       uuid("campaign_id"),
  scheduledMessageId: uuid("scheduled_message_id").references(() => scheduledMessages.id, { onDelete: "set null" }),
  broadcastType:    text("broadcast_type"),
  filterType:       text("filter_type"),
  targetType:       text("target_type"),
  filterSnapshot:   jsonb("filter_snapshot").notNull().default({}),
  status:           text("status").notNull().default("pending"),
  totalTargets:     integer("total_targets").notNull().default(0),
  sentCount:        integer("sent_count").notNull().default(0),
  failedCount:      integer("failed_count").notNull().default(0),
  skippedCount:     integer("skipped_count").notNull().default(0),
  errors:           jsonb("errors").notNull().default([]),
  stages:           jsonb("stages").notNull().default([]),
  metadata:         jsonb("metadata").notNull().default({}),
  triggerKind:      text("trigger_kind").notNull().default("manual"),
  errorMessage:     text("error_message"),
  source:           text("source").notNull().default("manual"),
  startedAt:        timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt:       timestamp("finished_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── REMARKETING ──────────────────────────────────────────────────────────────

export const remarketingCampaigns = pgTable("remarketing_campaigns", {
  id:                  uuid("id").defaultRandom().primaryKey(),
  botId:               uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  botIds:              jsonb("bot_ids").notNull().default([]),
  name:                text("name").notNull(),
  triggerType:         text("trigger_type").notNull().default("manual"),
  triggerConfig:       jsonb("trigger_config").notNull().default({}),
  filterType:          text("filter_type").notNull().default("all"),
  advancedFilters:     jsonb("advanced_filters").notNull().default({}),
  targetGroupIds:      jsonb("target_group_ids").notNull().default([]),
  stopOnPurchase:      boolean("stop_on_purchase").notNull().default(true),
  stopOnReply:         boolean("stop_on_reply").notNull().default(false),
  maxCycles:           integer("max_cycles"),
  isActive:            boolean("is_active").notNull().default(false),
  totalEnrolled:       integer("total_enrolled").notNull().default(0),
  totalMessagesSent:   integer("total_messages_sent").notNull().default(0),
  createdAt:           timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const remarketingMessages = pgTable("remarketing_messages", {
  id:            uuid("id").defaultRandom().primaryKey(),
  campaignId:    uuid("campaign_id").notNull().references(() => remarketingCampaigns.id, { onDelete: "cascade" }),
  message:       text("message").notNull().default(""),
  media:         jsonb("media").notNull().default({}),
  inlineButtons: jsonb("inline_buttons").notNull().default([]),
  offerId:       uuid("offer_id").references(() => funnelOffers.id, { onDelete: "set null" }),
  delayValue:    integer("delay_value").notNull().default(0),
  delayUnit:     text("delay_unit").notNull().default("hours"),
  orderIndex:    integer("order_index").notNull().default(0),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const remarketingLeadState = pgTable("remarketing_lead_state", {
  id:                 uuid("id").defaultRandom().primaryKey(),
  leadId:             uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  campaignId:         uuid("campaign_id").notNull().references(() => remarketingCampaigns.id, { onDelete: "cascade" }),
  botId:              uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  status:             text("status").notNull().default("active"),
  nextSendAt:         timestamp("next_send_at", { withTimezone: true }).notNull(),
  lastSentAt:         timestamp("last_sent_at", { withTimezone: true }),
  nextMessageIndex:   integer("next_message_index").notNull().default(0),
  totalSent:          integer("total_sent").notNull().default(0),
  cyclesCompleted:    integer("cycles_completed").notNull().default(0),
  consecutiveErrors:  integer("consecutive_errors").notNull().default(0),
  lastError:          text("last_error"),
  pauseReason:        text("pause_reason"),
  createdAt:          timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── TRACKING ─────────────────────────────────────────────────────────────────

export const trackingPixels = pgTable("tracking_pixels", {
  id:          uuid("id").defaultRandom().primaryKey(),
  botId:       uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  provider:    text("provider").notNull(),   // 'facebook' | 'tiktok'
  pixelId:     text("pixel_id").notNull(),
  accessToken: text("access_token"),         // encrypted
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const conversionEvents = pgTable("conversion_events", {
  id:             uuid("id").defaultRandom().primaryKey(),
  botId:          uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  leadId:         uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  paymentId:      uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
  provider:       text("provider").notNull().default("facebook"),
  eventName:      text("event_name").notNull(),
  eventId:        text("event_id"),
  status:         text("status").notNull().default("pending"),
  requestPayload: jsonb("request_payload"),
  responseBody:   jsonb("response_body"),
  httpStatus:     integer("http_status"),
  errorMessage:   text("error_message"),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Eventos de topo de funil. Existe porque `leads` guarda UMA linha por
// (bot, chat) — dá para contar pessoas, não interações. Sem isto, "total de
// starts" era o número de leads criados, e "starts por lead" dava sempre 1,00.
export const leadEvents = pgTable("lead_events", {
  id:        uuid("id").defaultRandom().primaryKey(),
  botId:     uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  leadId:    uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  kind:      text("kind").notNull(),   // 'start'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  botKindCreatedIdx: index("lead_events_bot_id_kind_created_at_idx").on(t.botId, t.kind, t.createdAt),
}));

export const mediaCache = pgTable("media_cache", {
  id:             uuid("id").defaultRandom().primaryKey(),
  botId:          uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  urlHash:        text("url_hash").notNull(),
  telegramFileId: text("telegram_file_id").notNull(),
  mediaType:      text("media_type").notNull().default("photo"),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("media_cache_bot_hash_unique").on(t.botId, t.urlHash)]);

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

export const adminNotifications = pgTable("admin_notifications", {
  id:          uuid("id").defaultRandom().primaryKey(),
  title:       text("title").notNull(),
  body:        text("body").notNull(),
  audience:    text("audience").notNull().default("all"),
  displayMode: text("display_mode").notNull().default("banner"),
  imageUrl:    text("image_url"),
  isActive:    boolean("is_active").notNull().default(true),
  requireAck:  boolean("require_ack").notNull().default(false),
  sendPush:    boolean("send_push").notNull().default(false),
  createdBy:   uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const adminNotificationRecipients = pgTable("admin_notification_recipients", {
  notificationId: uuid("notification_id").notNull().references(() => adminNotifications.id, { onDelete: "cascade" }),
  userId:         uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  readAt:         timestamp("read_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  dismissedAt:    timestamp("dismissed_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.notificationId, t.userId] })]);

export const userNotificationPreferences = pgTable("user_notification_preferences", {
  userId:       uuid("user_id").primaryKey().references(() => profiles.id, { onDelete: "cascade" }),
  pushEnabled:  boolean("push_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  eventPrefs:   jsonb("event_prefs").notNull().default({}),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id:        uuid("id").defaultRandom().primaryKey(),
  userId:    uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  endpoint:  text("endpoint").notNull().unique(),
  p256dh:    text("p256dh").notNull(),
  auth:      text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── ADMIN / CONFIG ───────────────────────────────────────────────────────────

export const impersonationLog = pgTable("impersonation_log", {
  id:            uuid("id").defaultRandom().primaryKey(),
  adminUserId:   uuid("admin_user_id").notNull().references(() => profiles.id),
  targetUserId:  uuid("target_user_id").notNull().references(() => profiles.id),
  reason:        text("reason"),
  ip:            text("ip"),
  userAgent:     text("user_agent"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const platformConfig = pgTable("platform_config", {
  id:        uuid("id").defaultRandom().primaryKey(),
  key:       text("key").notNull().unique(),
  value:     text("value").notNull(),
  updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const paymentRevenueCredits = pgTable("payment_revenue_credits", {
  paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
  userId:    uuid("user_id").notNull().references(() => profiles.id),
  amount:    integer("amount").notNull(),    // centavos
  provider:  text("provider"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.paymentId, t.userId] })]);

// ─── TYPE EXPORTS ─────────────────────────────────────────────────────────────

export type Profile                       = typeof profiles.$inferSelect;
export type Bot                           = typeof bots.$inferSelect;
export type BotGroup                      = typeof botGroups.$inferSelect;
export type VipMember                     = typeof vipMembers.$inferSelect;
export type Lead                          = typeof leads.$inferSelect;
export type LeadVariable                  = typeof leadVariables.$inferSelect;
export type Funnel                        = typeof funnels.$inferSelect;
export type FunnelNode                    = typeof funnelNodes.$inferSelect;
export type NodeConnection                = typeof nodeConnections.$inferSelect;
export type FunnelOffer                   = typeof funnelOffers.$inferSelect;
export type LeadProgress                  = typeof leadProgress.$inferSelect;
export type ScheduledDelay                = typeof scheduledDelays.$inferSelect;
export type SimplifiedScheduledTask       = typeof simplifiedScheduledTasks.$inferSelect;
export type PaymentGateway                = typeof paymentGateways.$inferSelect;
export type Payment                       = typeof payments.$inferSelect;
export type ScheduledMessage              = typeof scheduledMessages.$inferSelect;
export type BroadcastRun                  = typeof broadcastRuns.$inferSelect;
export type RemarketingCampaign           = typeof remarketingCampaigns.$inferSelect;
export type RemarketingMessage            = typeof remarketingMessages.$inferSelect;
export type RemarketingLeadState          = typeof remarketingLeadState.$inferSelect;
export type TrackingPixel                 = typeof trackingPixels.$inferSelect;
export type ConversionEvent               = typeof conversionEvents.$inferSelect;
export type AdminNotification             = typeof adminNotifications.$inferSelect;
export type AdminNotificationRecipient    = typeof adminNotificationRecipients.$inferSelect;
export type UserNotificationPreferences   = typeof userNotificationPreferences.$inferSelect;
export type PlatformConfig                = typeof platformConfig.$inferSelect;
