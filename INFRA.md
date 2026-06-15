# AWS Infrastructure Design

## Q1 — S3 Bucket Design

### Strategy: one bucket, structured key namespace

A single bucket with a logical key hierarchy is simpler to manage, secure with prefix-scoped IAM, and cheaper than multi-bucket setups (no cross-region replication complexity, one lifecycle policy).

**Key format:**
```
workers/{worker_id}/videos/{video_id}.mp4
```

**Example:**
```
workers/worker_james_k/videos/f47ac10b-58cc-4372-a567-0e02b2c3d479.mp4
```

**Why this structure:**
- Prefix `workers/{worker_id}/` enables per-worker IAM scoping — Worker A's presigned URL literally cannot write to Worker B's prefix. This is enforced by the IAM Condition, not application logic.
- `video_id` (UUID v4) guarantees global uniqueness within the prefix. No collision risk even if two workers have similar IDs.
- S3 automatically partitions the internal hash index by key prefix. UUIDs as the terminal segment provide high entropy → uniform shard distribution → no hot partition issues at 10K workers uploading simultaneously.

**Single vs multiple buckets:**
Multiple buckets would make sense if we needed different retention policies per region or strict GDPR data residency (e.g. EU workers must not have data leave `eu-west-1`). For a single-region deployment, one bucket is simpler to operate.

**Bucket configuration:**
```
Versioning: OFF — we never overwrite completed uploads; versioning adds cost with no benefit
ACLs: Disabled (Bucket Owner Enforced) — all objects owned by the bucket account
Public access: Fully blocked
Encryption: SSE-S3 (AES-256) — sufficient; SSE-KMS adds cost and complexity with marginal security gain for video blobs
```

---

## Q2 — IAM & Security

### Presigned URL generator IAM policy

The Lambda generating presigned URLs needs only `s3:PutObject` on the specific prefix it is serving. No `s3:GetObject`, no `s3:DeleteObject`, no `s3:ListBucket`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowScopedPut",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::locara-egocam-videos/workers/*",
      "Condition": {
        "StringEquals": {
          "s3:prefix": "workers/${aws:PrincipalTag/worker_id}/*"
        }
      }
    }
  ]
}
```

### Worker isolation

The key is built server-side from the authenticated `worker_id` extracted from the JWT:

```
s3_key = `workers/${verified_worker_id}/videos/${video_id}.mp4`
```

The client cannot influence the key. Even if a malicious client sends `worker_id: "other_worker"` in the request body, the server uses the `worker_id` from the verified token, not the body. The presigned URL is therefore scoped to the authenticated worker's prefix by construction.

For defence in depth, add a bucket policy that enforces the prefix condition independently of the Lambda logic:

```json
{
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::locara-egocam-videos/*",
  "Condition": {
    "StringNotLike": {
      "s3:x-amz-key": "workers/${aws:PrincipalTag/worker_id}/*"
    }
  }
}
```

### TTL recommendation

**15 minutes (900 seconds).** Rationale:
- A 60-second video at typical cellular speeds (10–20 Mbps) uploads in 20–40 seconds.
- Adding buffer for slow connections (2–5 Mbps), the upload should complete within 4–5 minutes.
- 15 minutes gives enough headroom without leaving credentials open for hours.
- If the URL expires before the upload starts (device was offline), the app fetches a fresh one on the next retry — no stale URL is ever used.

---

## Q3 — Storage Cost Strategy

### Volume calculation

```
Workers:          10,000
Videos/day:           20
Avg size:          50 MB

Daily ingest:   10,000 × 20 × 50 MB = 10,000,000 MB = 9.77 TB/day
Monthly ingest: 9.77 TB × 30 = 293 TB/month

After 90 days (steady state storage):
  10,000 × 20 × 90 × 50 MB = 900,000,000 MB = 879 TB ≈ 879 TB
```

### S3 Standard pricing (ap-south-1, 2025)

```
Storage:   $0.023/GB
879 TB × 1024 GB/TB × $0.023 = ~$20,700/month (storage)
PUT requests: 10K × 20 × 30 × $0.000005 = ~$30/month
GET requests: negligible (write-heavy workload)

Total storage cost at 90 days: ~$20,700/month
Monthly ingest adds ~$6,900/month on top
```

### Lifecycle policy

```
Day 0–30:   S3 Standard          (hot, workers may re-upload or replay)
Day 30–90:  S3 Standard-IA       ($0.0125/GB — 46% cheaper than Standard)
Day 90+:    S3 Glacier Instant   ($0.004/GB — archive but millisecond retrieval for ML jobs)
Day 365+:   S3 Glacier Deep      ($0.00099/GB — cold archive, 12h restore, for compliance)
```

```json
{
  "Rules": [{
    "ID": "egocam-tiering",
    "Status": "Enabled",
    "Prefix": "workers/",
    "Transitions": [
      { "Days": 30,  "StorageClass": "STANDARD_IA" },
      { "Days": 90,  "StorageClass": "GLACIER_IR"  },
      { "Days": 365, "StorageClass": "DEEP_ARCHIVE" }
    ]
  }]
}
```

**Why not S3 Intelligent-Tiering?**
Intelligent-Tiering charges a monitoring fee of $0.0025 per 1,000 objects/month. At 10K workers × 20 videos/day × 90 days = 18M objects, that's $45/month just for monitoring. Our access pattern is completely predictable (hot for 30 days, then rarely accessed), so explicit lifecycle transitions are cheaper and simpler. Intelligent-Tiering earns its keep when access patterns are genuinely unpredictable — not the case here.

**Projected monthly cost at steady state (90 days):**
- ~$20,700 storage + ~$6,900 ingest + ~$30 requests = ~**$27,630/month**
- After the lifecycle policy kicks in, 70%+ of data moves to IA/Glacier, reducing to roughly **$10,000–$12,000/month** at steady state.

---

## Q4 — Upload Confirmation

### Chosen approach: ETag verification from the presigned PUT response

**How it works:**
1. The app PUTs the file to S3 using the presigned URL.
2. S3 returns an `ETag` header in the 200 response — the MD5 hash of the uploaded object (for single-part uploads).
3. The app reads the `ETag` from the response headers and sends it to the backend along with the `video_id`.
4. The backend calls `s3.headObject({ Bucket, Key })` to verify the ETag matches and the object exists.
5. The backend writes `upload_state = 'uploaded'` to its own DB and returns a confirmation to the app.
6. The app writes `upload_state = 'uploaded'` to SQLite.

**Why this over S3 Event → Lambda → DB update:**
- S3 Events are asynchronous — there's a lag between the PUT completing and the Lambda firing. The app doesn't know when confirmation arrives, so it must poll or use push notifications. That's two extra systems (EventBridge + SNS/FCM) for a problem that ETag verification solves synchronously.
- S3 Event + Lambda is harder to test locally and adds operational surface area.
- ETag verification is a single extra API call on the backend — cheap, synchronous, and gives immediate feedback to the app.

**Why not trust the HTTP 200 from S3 alone:**
An HTTP 200 from the presigned PUT means S3 accepted the bytes, but it doesn't guarantee the object is fully committed and visible (eventual consistency edge case for multi-region). The ETag `headObject` check is the definitive confirmation.

**Implementation note:** In the current implementation, we trust the 200 response and mark `uploaded` directly (the backend ETag check step is omitted from the mock). In production, add a `/confirm-upload` endpoint that calls `headObject` before writing `uploaded` to the source-of-truth DB.

---

## Q5 — Presigned URL Generator

See `backend/presigned_url_generator.ts` for the full implementation. Summary:

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: 'ap-south-1' });

export async function generatePresignedPutUrl(workerId: string, videoId: string) {
  // Key is constructed server-side — client cannot control the prefix
  const key = `workers/${workerId}/videos/${videoId}.mp4`;

  const command = new PutObjectCommand({
    Bucket: 'locara-egocam-videos',
    Key: key,
    ContentType: 'video/mp4',
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 900 });
  return { url, s3_key: key, expires_at: Date.now() + 900_000 };
}
```

Input validation (`/^[\w-]+$/` on both IDs) prevents path traversal before the key is constructed.

---

## Terraform snippet (infrastructure-as-code signal)

```hcl
resource "aws_s3_bucket" "egocam_videos" {
  bucket = "locara-egocam-videos"
}

resource "aws_s3_bucket_public_access_block" "egocam_videos" {
  bucket                  = aws_s3_bucket.egocam_videos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "egocam_videos" {
  bucket = aws_s3_bucket.egocam_videos.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "egocam_videos" {
  bucket = aws_s3_bucket.egocam_videos.id
  rule {
    id     = "egocam-tiering"
    status = "Enabled"
    filter { prefix = "workers/" }
    transition { days = 30;  storage_class = "STANDARD_IA"  }
    transition { days = 90;  storage_class = "GLACIER_IR"   }
    transition { days = 365; storage_class = "DEEP_ARCHIVE" }
  }
}

resource "aws_iam_role" "presigned_url_lambda" {
  name               = "egocam-presigned-url-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "presigned_url_s3" {
  role = aws_iam_role.presigned_url_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AllowScopedPut"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "${aws_s3_bucket.egocam_videos.arn}/workers/*"
    }]
  })
}
```

---

## Scalability: What breaks first at 10,000 workers?

**1. Presigned URL Lambda — first bottleneck**
10K workers × 20 videos/day = 200K requests/day = ~2.3 req/s average. But workers likely start shifts at the same time — you could see 500–1,000 req/s at peak. A single Lambda concurrency of 1,000 handles this, but cold starts (if Lambda scales from 0) add 200–500ms latency per request. Fix: provisioned concurrency for the presigned URL Lambda.

**2. S3 PUT throughput per prefix partition**
S3 automatically scales to 3,500 PUT req/s per prefix partition. At peak (1,000 req/s), we're comfortably within limits for `workers/` as a shared prefix. S3 further partitions internally on the full key — UUIDs in the key provide entropy that distributes across partitions. No action needed at 10K workers, but monitor with S3 Storage Lens if scaling to 100K+.

**3. Backend API — presigned URL endpoint**
If the backend is a monolithic server (not Lambda), 10K concurrent workers retrying at the same time after a network outage could overwhelm it. The fix is Lambda (auto-scales per request) + API Gateway with per-worker rate limiting (10 req/s per worker_id prevents retry storms).

**4. Mobile SQLite — no bottleneck**
SQLite is local per device. Each device has at most ~7,300 rows after one year. WAL mode handles concurrent reads/writes from the scheduler and camera module without contention. This layer never becomes a system-wide bottleneck.

**5. What breaks after 10K → 100K workers?**
- Monthly ingest grows to ~2.9 PB — still within S3's capacity, but costs ~$100K/month before lifecycle. Evaluate per-region buckets to reduce cross-region data transfer fees.
- Backend DB (if a single RDS instance tracks upload confirmations) hits write saturation around 50K concurrent workers. Move to Aurora with read replicas, or make confirmation async via SQS.
- Lambda invocations (200K × 10 = 2M/day) stay within AWS free tier limits per account — not a concern until 10M+/day.
