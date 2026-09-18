import { APIError } from "encore.dev/api";
import type { BotRepository } from "../../domain/bot.repository.js";
import { DeregisterWebhookUseCase } from "./deregister-webhook.use-case.js";

export class DeleteBotUseCase {
  constructor(
    private readonly repo: BotRepository,
    private readonly deregisterWebhook: DeregisterWebhookUseCase = new DeregisterWebhookUseCase(repo),
  ) {}

  async execute(id: string, userId: string): Promise<void> {
    const belongs = await this.repo.belongsToUser(id, userId);
    if (!belongs) throw APIError.notFound("bot not found");

    // Desativa o webhook no Telegram ANTES de apagar, senão o Telegram continua
    // mandando update pra um bot que não existe mais aqui. Best-effort: token já
    // revogado, bot já apagado no BotFather, ou qualquer outra falha do Telegram
    // não pode travar a exclusão — o usuário quer o bot fora da conta dele,
    // ponto. `deleteWebhook` já é chamado pela UI antiga antes deste endpoint;
    // reaproveitar aqui só torna essa segunda chamada redundante e inofensiva.
    try {
      await this.deregisterWebhook.execute(id, userId);
    } catch (err) {
      console.warn(`[bots] deleteWebhook falhou ao excluir bot ${id} — excluindo mesmo assim`, err);
    }

    await this.repo.delete(id, userId);
  }
}
