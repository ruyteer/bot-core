-- Botão colorido no remarketing: os botões inline de disparo/remarketing já
-- suportam "style" por viverem em jsonb (inline_buttons), sem precisar de
-- migration. A exceção é o botão da oferta do remarketing, cujo label é
-- hardcoded e cujo vínculo (offer_id) é coluna normal, não jsonb — não havia
-- onde guardar a cor escolhida para esse botão específico. Coluna nullable,
-- sem default: null mantém o comportamento atual (sem cor).
ALTER TABLE "remarketing_messages" ADD COLUMN "offer_style" text;
