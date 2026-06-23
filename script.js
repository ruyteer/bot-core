// Dispara um redeploy do serviço no Railway via GraphQL API.
// Rodado pelo GitHub Actions ao final do build: `node script.js <RAILWAY_API_TOKEN>`
//
// COMO PEGAR OS IDS (preencha os dois abaixo antes do primeiro deploy):
//   1. Abra o projeto/serviço do orionbot no dashboard do Railway.
//   2. ENVIRONMENT_ID: na URL do ambiente (.../environments/<ESTE_ID>) ou em Settings.
//   3. SERVICE_ID: na URL do serviço (.../service/<ESTE_ID>) ou em Settings do serviço.
const TOKEN = process.argv.slice(2)[0]
const ENVIRONMENT_ID = "e57ff124-8dc9-4b67-8c3f-6ecfe27871c1"
const SERVICE_ID = "5cc6e290-1064-4631-b0d2-21ce12b7358f"

const resp = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({
    query: `
      mutation ServiceInstanceRedeploy {
          serviceInstanceRedeploy(
              environmentId: "${ENVIRONMENT_ID}"
              serviceId: "${SERVICE_ID}"
          )
      }`,
  }),
})

const data = await resp.json()

if (data.errors) {
  console.error(data.errors)
  throw new Error("Failed to redeploy service")
}

console.log(data)
