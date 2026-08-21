export interface Lead {
  id:               string;
  botId:            string;
  telegramChatId:   bigint;
  telegramUsername: string | null;
  firstName:        string | null;
  lastName:         string | null;
  utmSource:        string | null;
  utmMedium:        string | null;
  utmCampaign:      string | null;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface LeadProgress {
  id:            string;
  leadId:        string;
  funnelId:      string;
  funnelName:    string | null;
  currentNodeId: string | null;
  nodeSummary:   string | null;
  status:        string;
}

export interface LeadWithStats extends Lead {
  progress:        LeadProgress | null;
  conversionTimeMs: number | null;
  botName:         string | null;
  botUsername:     string | null;
}

export interface LeadMessage {
  id:        string;
  direction: string;
  content:   Record<string, unknown>;
  createdAt: Date;
}

export interface UpsertLeadInput {
  botId:            string;
  telegramChatId:   bigint;
  telegramUsername: string | null;
  firstName:        string | null;
  lastName:         string | null;
  utmSource?:       string | null;
  utmCampaign?:     string | null;
}
