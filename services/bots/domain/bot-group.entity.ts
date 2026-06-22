export interface BotGroup {
  id:             string;
  botId:          string;
  name:           string;
  telegramChatId: bigint;
  type:           string;
  createdAt:      Date;
  updatedAt:      Date;
}
