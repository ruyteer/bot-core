export interface Payment {
  id:               string;
  userId:           string;
  botId:            string;
  leadId:           string | null;
  gatewayId:        string;
  offerId:          string | null;
  offerName:        string | null;
  offerExternalRef: string | null;
  amount:           number;
  finalAmount:      number | null;
  status:           string;
  saleType:         string | null;
  externalId:       string | null;
  pixCode:          string | null;
  paidAt:           Date | null;
  description:      string | null;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface PaymentWithMeta extends Payment {
  botName:         string | null;
  leadName:        string | null;
  leadUsername:    string | null;
  leadChatId:      string | null;
  provider:        string | null;
  gatewayLabel:    string | null;
}
