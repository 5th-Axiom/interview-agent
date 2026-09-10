import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "",
  },
});
const Bucket = process.env.S3_BUCKET!;
export async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (e) {
    if (
      (e as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode !== 404
    )
      throw e;
    await client.send(new CreateBucketCommand({ Bucket }));
  }
}
export async function putObject(Key: string, Body: Buffer, type = "audio/wav") {
  await client.send(
    new PutObjectCommand({ Bucket, Key, Body, ContentType: type }),
  );
}
export async function getObject(Key: string, Range?: string) {
  return client.send(new GetObjectCommand({ Bucket, Key, Range }));
}
export async function headObject(Key: string) {
  return client.send(new HeadObjectCommand({ Bucket, Key }));
}
export function wav(pcm: Buffer, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
