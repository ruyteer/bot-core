// Pina o serviço na imagem imutável do commit e dispara o deploy no Railway.
// Rodado pelo GitHub Actions ao final do build:
//   node script.js <RAILWAY_API_TOKEN> <IMAGE_REF>
// IMAGE_REF ex: ghcr.io/ruyteer/bot-core:sha-abc123def456
//
// Por que pinar a tag :sha-* em vez de :latest: o redeploy logo após o
// `docker push :latest` pode resolver um digest antigo do :latest (race) e
// subir a imagem errada. Tags por commit são únicas/imutáveis e eliminam isso.
//
// IDs: ENVIRONMENT_ID e SERVICE_ID vêm da URL do serviço no dashboard do Railway.
const [TOKEN, IMAGE] = process.argv.slice(2)
const ENVIRONMENT_ID = "e57ff124-8dc9-4b67-8c3f-6ecfe27871c1"
const SERVICE_ID = "5cc6e290-1064-4631-b0d2-21ce12b7358f"

async function railway(query) {
  const resp = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Project Token do Railway usa este header. (Account/Team token usaria "Authorization: Bearer".)
      "Project-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query }),
  })
  const data = await resp.json()
  if (data.errors) {
    console.error(data.errors)
    throw new Error("Railway API error")
  }
  return data
}

// 1. Aponta o serviço para a imagem imutável deste commit.
if (IMAGE) {
  await railway(`mutation {
    serviceInstanceUpdate(
      environmentId: "${ENVIRONMENT_ID}"
      serviceId: "${SERVICE_ID}"
      input: { source: { image: "${IMAGE}" } }
    )
  }`)
  console.log("imagem do serviço atualizada para", IMAGE)
}

// 2. Dispara o deploy.
// PRECISA ser serviceInstanceDeploy, não serviceInstanceRedeploy: o redeploy
// repete o SNAPSHOT do último deployment e ignora a imagem que o passo 1 acabou
// de configurar. Enquanto o serviço apontava para :latest isso passava
// despercebido (redeployar :latest repuxava a imagem nova), mas depois que
// passamos a pinar :sha-* a tag ficou imutável e o serviço congelou em
// sha-c0728da64be0 (2026-07-17): builds verdes, deploys "SUCCESS", e nenhuma
// linha de código nova em produção por dias.
const out = await railway(`mutation {
  serviceInstanceDeploy(
    environmentId: "${ENVIRONMENT_ID}"
    serviceId: "${SERVICE_ID}"
  )
}`)
console.log(out)
