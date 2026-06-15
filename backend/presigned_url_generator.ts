import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = process.env.AWS_REGION ?? 'ap-south-1';
const BUCKET = process.env.AWS_S3_BUCKET ?? 'locara-egocam-videos';

// TTL for the presigned URL. A 60-second video at 50 Mbps takes ~8 seconds
// on a fast connection; on cellular it can take several minutes.
// 15 minutes gives reasonable headroom without leaving credentials open too long.
const URL_TTL_SECONDS = 900;

const s3 = new S3Client({ region: REGION });

interface PresignResult {
  url: string;
  s3_key: string;
  expires_at: number;
}

// Key format: workers/{worker_id}/videos/{video_id}.mp4
//
// Scoping by worker_id means:
//  - S3 resource policy can restrict each worker to their own prefix
//  - Listing a worker's files requires only a prefix scan, not a full table scan
//  - video_id (UUID v4) in the key provides global uniqueness within the prefix
//
// The presigned PUT URL is scoped to this exact key — a worker cannot
// overwrite another worker's video because the key is constructed server-side
// from the authenticated worker_id, not from any client-supplied value.
export async function generatePresignedPutUrl(
  workerId: string,
  videoId: string,
): Promise<PresignResult> {
  // Validate to prevent path traversal. The worker_id and video_id come from
  // a trusted JWT in production, but an extra check costs nothing.
  if (!/^[\w-]+$/.test(workerId) || !/^[\w-]+$/.test(videoId)) {
    throw new Error('Invalid workerId or videoId format');
  }

  const s3_key = `workers/${workerId}/videos/${videoId}.mp4`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3_key,
    ContentType: 'video/mp4',
    // Prevent the uploader from overriding metadata or ACLs via request headers.
    // The PUT URL only permits Content-Type and Content-Length.
  });

  const url = await getSignedUrl(s3, command, { expiresIn: URL_TTL_SECONDS });

  return {
    url,
    s3_key,
    expires_at: Date.now() + URL_TTL_SECONDS * 1000,
  };
}
