import { APIError } from "encore.dev/api";

/**
 * Campos mínimos para checar se uma oferta está "completa" — usado tanto na
 * tabela `funnel_offers` (createOffer/createOffersBulk) quanto, no futuro, em
 * qualquer outro lugar que persista os mesmos 3 conceitos (nome, preço,
 * entrega) sob nomes diferentes.
 */
export interface OfferValidationInput {
  name:             string | undefined | null;
  price:            number | undefined | null;
  deliveryUrl?:     string | null;
  deliveryText?:    string | null;
  telegramGroupId?: string | null;
}

/**
 * Uma oferta só pode ser salva com nome, preço (> 0) e alguma entrega
 * configurada — `deliveryUrl`, `deliveryText` ou `telegramGroupId`, qualquer
 * um dos três. `accessDays` NÃO conta como entrega: é só a duração de acesso
 * a um grupo, e tem default próprio no schema.
 *
 * Lança `APIError.invalidArgument` (mesma convenção usada no resto do serviço
 * — ver `funnels.api.ts`/`create-bot.use-case.ts`) com a primeira violação
 * encontrada. `label` identifica a oferta na mensagem quando há mais de uma
 * no mesmo request (ex.: `createOffersBulk`).
 */
function assertNameAndPrice(name: string | undefined | null, price: number | undefined | null, label: string): void {
  const trimmedName = (name ?? "").trim();
  if (!trimmedName) {
    throw APIError.invalidArgument(`${label} precisa de um nome`);
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw APIError.invalidArgument(`${label} precisa de um preço maior que zero`);
  }
}

export function assertOfferComplete(input: OfferValidationInput, label = "a oferta"): void {
  assertNameAndPrice(input.name, input.price, label);

  const hasDelivery = Boolean(
    input.deliveryUrl?.trim() || input.deliveryText?.trim() || input.telegramGroupId?.trim(),
  );
  if (!hasDelivery) {
    throw APIError.invalidArgument(`${label} precisa de uma entrega configurada (link, texto ou grupo do Telegram)`);
  }
}

/**
 * Shape snake_case de uma oferta "crua" dentro de um node de funil flow
 * (`content.offers` / `content.blocks[].offers`) — o mesmo shape que
 * `collectNodeOffers` em
 * `services/runner/application/execute-flow-step.use-case.ts` já sabe extrair
 * dos nodes `offer` e dos blocos de oferta dentro de nodes `message`.
 */
export interface RawNodeOffer {
  product_name?:      unknown;
  price?:             unknown;
  product_type?:      unknown;
  delivery_url?:      unknown;
  delivery_text?:     unknown;
  telegram_group_id?: unknown;
}

/**
 * Espelha `isOfferStarted` do frontend: nome OU preço preenchidos já
 * caracteriza a oferta como "iniciada" — só a partir daí a validação de
 * completude vale. Enquanto os dois estão vazios é rascunho legítimo (nó
 * ainda sendo editado) e não deve bloquear o autosave.
 */
export function isRawOfferStarted(offer: RawNodeOffer): boolean {
  const hasName  = typeof offer.product_name === "string" && offer.product_name.trim().length > 0;
  const hasPrice = typeof offer.price === "number" && Number.isFinite(offer.price) && offer.price > 0;
  return hasName || hasPrice;
}

/**
 * Valida uma oferta "crua" de node de funil flow (`RawNodeOffer`) apenas se
 * ela estiver "iniciada" (ver `isRawOfferStarted`) — uma oferta totalmente
 * vazia é rascunho legítimo e passa despercebida.
 *
 * Diferente de `assertOfferComplete` (que aceita QUALQUER um dos 3 campos de
 * entrega — seguro para `funnel_offers`, cuja entrega em runtime,
 * `deliverFunnelOffer`, tem fallback gracioso entre os campos mesmo se não
 * baterem com o tipo declarado), aqui a checagem é SENSÍVEL AO TIPO
 * (`product_type`), espelhando exatamente `validateOffer` do frontend e o
 * runtime real que entrega essa oferta embutida (`deliverOffer` em
 * `execute-flow-step.use-case.ts`): esse runtime não tem fallback entre
 * campos — se o tipo é `vip_group` ele só olha `telegram_group_id`, senão só
 * olha `delivery_url` (não existe caminho de `delivery_text` para oferta
 * embutida em node). Validar "qualquer campo preenchido" aqui deixaria
 * passar, por exemplo, `product_type: "vip_group"` com só `delivery_url`
 * preenchido — o backend aceitaria, mas na entrega real nada seria enviado
 * (ver achado da revisão de segurança: "pago sem entrega, silenciosamente").
 */
export function assertRawOfferComplete(offer: RawNodeOffer, label = "a oferta"): void {
  if (!isRawOfferStarted(offer)) return;

  assertNameAndPrice(
    typeof offer.product_name === "string" ? offer.product_name : null,
    typeof offer.price === "number" ? offer.price : null,
    label,
  );

  const type = typeof offer.product_type === "string" ? offer.product_type : "content";
  if (type === "vip_group") {
    const groupId = typeof offer.telegram_group_id === "string" ? offer.telegram_group_id.trim() : "";
    if (!groupId) {
      throw APIError.invalidArgument(`${label} precisa de um grupo VIP do Telegram selecionado`);
    }
  } else {
    const url = typeof offer.delivery_url === "string" ? offer.delivery_url.trim() : "";
    if (!url) {
      throw APIError.invalidArgument(`${label} precisa de uma URL de entrega`);
    }
  }
}

/**
 * Shape de um item de oferta do funil simplificado (`plans`/`upsells`/
 * `downsells`/`order_bumps` dentro de `funnels.simplified_config`) — ver
 * `DeliveryConfig`/`PlanItem`/`UpsellItem`/... em `src/types/simpleFunnel.ts`
 * no repo `ui`. Mesmos 3 conceitos de `RawNodeOffer` (nome, preço, entrega),
 * mas com nomes de campo diferentes (`name`/`price` direto, sem prefixo
 * `product_`) e um terceiro tipo de entrega (`delivery_type: "text"`, via
 * `delivery_text`) que o funil flow não tem.
 */
export interface RawSimplifiedOfferItem {
  name?:          unknown;
  price?:         unknown;
  delivery_type?: unknown;
  delivery_url?:  unknown;
  delivery_text?: unknown;
  vip_group_id?:  unknown;
}

/** Espelha `isOfferStarted` do frontend para o shape do funil simplificado. */
export function isSimplifiedOfferStarted(item: RawSimplifiedOfferItem): boolean {
  const hasName  = typeof item.name === "string" && item.name.trim().length > 0;
  const hasPrice = typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0;
  return hasName || hasPrice;
}

/**
 * Espelha `validateOfferListItem` do frontend (`src/lib/offerValidation.ts`
 * no repo `ui`): só valida quando o item está "iniciado" (ver
 * `isSimplifiedOfferStarted`), e `delivery_type` decide qual campo de entrega
 * é obrigatório (`vip_group` → `vip_group_id`, `text` → `delivery_text`,
 * `content`/default → `delivery_url`).
 */
export function assertSimplifiedOfferComplete(item: RawSimplifiedOfferItem, label = "a oferta"): void {
  if (!isSimplifiedOfferStarted(item)) return;

  assertNameAndPrice(
    typeof item.name === "string" ? item.name : null,
    typeof item.price === "number" ? item.price : null,
    label,
  );

  // Espelha `deliveryTypeOf` em `execute-simplified-funnel.use-case.ts` — bit a
  // bit, não só a intenção: QUALQUER `delivery_type` truthy vence e cai pra
  // "content" se não for "vip_group"/"text" reconhecido; só cai pra inferir de
  // `vip_group_id` quando `delivery_type` é falsy (ausente/""/0/null). Uma
  // versão anterior daqui exigia `typeof === "string"` antes de aceitar
  // `delivery_type`, o que divergia do runtime pra um `delivery_type` truthy
  // não-string (ex.: `1`): a validação inferia "vip_group" via `vip_group_id`
  // e liberava a ativação, mas em produção o runtime calculava "content" e
  // `deliverItem` não entregava nada — silenciosamente. Ver achado de revisão.
  const dt = (item.delivery_type as unknown) || (item.vip_group_id ? "vip_group" : "content");
  const type = dt === "vip_group" ? "vip_group" : dt === "text" ? "text" : "content";
  if (type === "vip_group") {
    const groupId = typeof item.vip_group_id === "string" ? item.vip_group_id.trim() : "";
    if (!groupId) {
      throw APIError.invalidArgument(`${label} precisa de um grupo VIP do Telegram selecionado`);
    }
  } else if (type === "text") {
    const text = typeof item.delivery_text === "string" ? item.delivery_text.trim() : "";
    if (!text) {
      throw APIError.invalidArgument(`${label} precisa de um texto de entrega`);
    }
  } else {
    const url = typeof item.delivery_url === "string" ? item.delivery_url.trim() : "";
    if (!url) {
      throw APIError.invalidArgument(`${label} precisa de uma URL de entrega`);
    }
  }
}
