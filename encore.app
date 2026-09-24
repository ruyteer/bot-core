{
	"id": "orionbot-zzhi",
	"lang": "typescript",
	"global_cors": {
		"allow_origins_with_credentials": [
			"http://localhost:8080",
			"https://orionbot.io",
			"https://www.orionbot.io",
			"https://nova-ui-production-0a9c.up.railway.app",
			// UI antiga (bot-ui), ainda em producao: chama a API direto do
			// navegador com Authorization: Bearer (ui/src/lib/api.ts), servida
			// neste dominio Railway. Sai da lista quando essa UI for desligada
			// de vez — mesma logica do app.orionbot.io acima.
			"https://bot-ui-production.up.railway.app",
			"https://app.orionbot.io",
			"http://localhost:3100",
			"http://localhost:3000"
		],
		"allow_origins_without_credentials": ["*"]
	}
}
