import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

export const infra = {
  s3: process.env.INFRA_S3_ENDPOINT,
  bucket: process.env.INFRA_S3_BUCKET ?? 'uk-infra-test',
  clam: process.env.INFRA_CLAMAV_HOST,
  clamPort: Number(process.env.INFRA_CLAMAV_PORT ?? 3310),
};

let made = false;
export async function ensureBucket() {
  if (made || !infra.s3) return;
  const c = new S3Client({ region: 'eu-west-2', endpoint: infra.s3, forcePathStyle: true });
  try { await c.send(new CreateBucketCommand({ Bucket: infra.bucket, CreateBucketConfiguration: { LocationConstraint: 'eu-west-2' } })); } catch (e) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e))) throw e;
  }
  made = true;
}
