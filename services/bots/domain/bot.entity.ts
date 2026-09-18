// Limite de bots por conta. Antes só a UI antiga impunha isto (client-side);
// a API aceitava criar sem limite. Ver BotDrizzleRepository.create — a checagem
// roda dentro de uma transação com advisory lock por usuário, para que dois
// POST /bots simultâneos no 20º bot não criem os dois um 21º.
export const MAX_BOTS_PER_USER = 20;

export interface Bot {
  id:               string;
  userId:           string;
  name:             string;
  telegramUsername: string | null;
  isActive:         boolean;
  protectContent:   boolean;
  defaultGatewayId: string | null;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface BotWithStats extends Bot {
  leadsCount: number;
  salesCount: number;
}

// Token only available for internal use — never returned to clients
export interface BotInternal extends Bot {
  telegramToken:  string;   // encrypted in DB, decrypted in memory
  webhookSecret:  string;
}

export interface CreateBotInput {
  userId:        string;
  name:          string;
  telegramToken: string;
}

export interface UpdateBotInput {
  defaultGatewayId?: string | null;
  name?:          string;
  isActive?:      boolean;
  protectContent?:boolean;
  /** Token JÁ CRIPTOGRAFADO (a criptografia acontece no use case). */
  telegramToken?: string;
}
