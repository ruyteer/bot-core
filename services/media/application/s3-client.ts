import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import {
  mediaS3Endpoint, mediaS3Region, mediaS3Bucket, mediaS3AccessKey, mediaS3SecretKey,
} from "../../config/secrets.js";

// Railway Bucket é S3-compatível, endereçamento virtual-host (bucket no
// subdomínio: https://{bucket}.{endpoint}/{key}) — é o padrão do SDK quando
// forcePathStyle não é forçado, então não precisa mexer nisso aqui.
let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint:    mediaS3Endpoint(),
      region:      mediaS3Region(),
      credentials: {
        accessKeyId:     mediaS3AccessKey(),
        secretAccessKey: mediaS3SecretKey(),
      },
    });
  }
  return client;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket:      mediaS3Bucket(),
    Key:         key,
    Body:        body,
    ContentType: contentType,
    // Mesma política de cache do upload antigo (Supabase `cacheControl: 31536000`)
    // — a chave inclui um uuid, então o conteúdo de uma chave nunca muda.
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

export interface StoredObject {
  body:          Readable;
  contentType:   string;
  contentLength?: number;
}

// Retorna null em NoSuchKey (404 esperado) em vez de deixar o erro do SDK
// vazar — quem chama só precisa decidir 404 vs stream.
export async function getObject(key: string): Promise<StoredObject | null> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: mediaS3Bucket(), Key: key }));
    return {
      body:          res.Body as unknown as Readable,
      contentType:   res.ContentType ?? "application/octet-stream",
      contentLength: res.ContentLength,
    };
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
