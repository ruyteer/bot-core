export interface Bot {
  id:               string;
  userId:           string;
  name:             string;
  telegramUsername: string | null;
  isActive:         boolean;
  protectContent:   boolean;
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
  name?:          string;
  isActive?:      boolean;
  protectContent?:boolean;
}
