import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { platformConfig, referralCodes } from "../../shared/schema/index.js";
import { PLATFORM_SPLIT_CENTS } from "../../payments/application/gateway-clients.js";

// % padrão da comissão sobre a taxa da plataforma. Sobrescrevível globalmente
// via platform_config REFERRAL_COMMISSION_PERCENT e por indicador via
// referral_codes.commission_percent (a "comissão aumentada" de sellers específicos).
export const DEFAULT_REFERRAL_PERCENT = 20;

// Saque mínimo (centavos). Sobrescrevível via REFERRAL_MIN_WITHDRAWAL_CENTS.
export const DEFAULT_MIN_WITHDRAWAL_CENTS = 1000;

// Leitura crua (string) de uma chave de platform_config; null se não existir.
// Fonte compartilhada de leitura — reusada tanto pelas regras de indicação
// quanto pelo resolver de split efetivo dos gateways de pagamento
// (payments/application/split-config.ts), pra não duplicar esse parsing.
export async function configValue(key: string): Promise<string | null> {
  const [row] = await db.select({ value: platformConfig.value })
    .from(platformConfig).where(eq(platformConfig.key, key)).limit(1);
  return row ? row.value : null;
}

async function configNumber(key: string): Promise<number | null> {
  const v = await configValue(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Override individual de taxa (centavos) configurado pelo admin pro seller
// (USER_SPLIT_FEE_CENTS_<sellerUserId>). null = sem override — separado de
// platformFeeCentsFor pra permitir distinguir "sem override" de "override
// igual ao fallback", que o resolver de split efetivo precisa saber.
export async function userSplitFeeOverrideCents(sellerUserId: string): Promise<number | null> {
  return configNumber(`USER_SPLIT_FEE_CENTS_${sellerUserId}`);
}

/** Taxa da plataforma (centavos) cobrada nas vendas deste seller — base da comissão. */
export async function platformFeeCentsFor(sellerUserId: string): Promise<number> {
  const override = await userSplitFeeOverrideCents(sellerUserId);
  return override !== null && override >= 0 ? override : PLATFORM_SPLIT_CENTS;
}

/** % de comissão do indicador: override individual > config global > default. */
export async function commissionPercentFor(referrerUserId: string): Promise<number> {
  const [code] = await db.select({ commissionPercent: referralCodes.commissionPercent })
    .from(referralCodes).where(eq(referralCodes.userId, referrerUserId)).limit(1);
  if (code?.commissionPercent != null) return code.commissionPercent;
  const global = await configNumber("REFERRAL_COMMISSION_PERCENT");
  return global !== null && global > 0 ? global : DEFAULT_REFERRAL_PERCENT;
}

export async function minWithdrawalCents(): Promise<number> {
  const v = await configNumber("REFERRAL_MIN_WITHDRAWAL_CENTS");
  return v !== null && v > 0 ? v : DEFAULT_MIN_WITHDRAWAL_CENTS;
}

// Alfabeto sem caracteres ambíguos (0/o, 1/l/i) — o código vai em link e boca a boca.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

/** Garante que o usuário tem um código de indicação (cria na primeira visita). */
export async function ensureReferralCode(userId: string): Promise<string> {
  const [existing] = await db.select({ code: referralCodes.code })
    .from(referralCodes).where(eq(referralCodes.userId, userId)).limit(1);
  if (existing) return existing.code;

  // Retry para colisão do UNIQUE(code) — improvável (31^8), mas barato de tratar.
  for (let i = 0; i < 3; i++) {
    const code = generateCode();
    try {
      await db.insert(referralCodes).values({ userId, code });
      return code;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Corrida entre duas requests do mesmo usuário → a linha já existe.
      if (msg.includes("referral_codes_pkey") || msg.includes("duplicate key value") && msg.includes("user_id")) {
        const [row] = await db.select({ code: referralCodes.code })
          .from(referralCodes).where(eq(referralCodes.userId, userId)).limit(1);
        if (row) return row.code;
      }
      if (i === 2) throw err;
    }
  }
  throw new Error("não foi possível gerar código de indicação");
}
