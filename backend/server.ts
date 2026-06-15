// Local mock server for development.
// In production this is replaced by an API Gateway + Lambda function.
// Run with: npx ts-node backend/server.ts

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { generatePresignedPutUrl } from './presigned_url_generator';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Mock JWT validation — in production, verify the JWT signature against
// your auth provider and extract worker_id from the claims.
function extractWorkerId(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  // Mock: token format is `mock_token_{worker_id}_{timestamp}`
  const match = token.match(/^mock_token_(.+)_\d+$/);
  return match ? match[1] : null;
}

app.post('/presigned-url', async (req, res) => {
  const workerId = extractWorkerId(req.headers.authorization);
  if (!workerId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { video_id, worker_id: requestedWorkerId } = req.body as {
    video_id?: string;
    worker_id?: string;
  };

  if (!video_id || !requestedWorkerId) {
    res.status(400).json({ error: 'video_id and worker_id required' });
    return;
  }

  // Prevent worker A from generating a URL scoped to worker B's prefix.
  // The key is always built from the authenticated worker_id, never the
  // client-supplied worker_id.
  if (requestedWorkerId !== workerId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    const result = await generatePresignedPutUrl(workerId, video_id);
    res.json(result);
  } catch (err) {
    console.error('Presigned URL generation failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => console.log(`Mock presigned URL server on :${PORT}`));
