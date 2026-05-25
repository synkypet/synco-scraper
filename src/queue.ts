import crypto from 'crypto';

let mlQueue = Promise.resolve();
const inFlight = new Map<string, Promise<any>>();

export function hashKey(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
}

export function enqueueMLJob<T>(rawUrl: string, job: () => Promise<T>): Promise<T> {
  const keyHash = hashKey(rawUrl);
  
  if (inFlight.has(keyHash)) {
    console.log(`[SCRAPER-ML-INFLIGHT] join keyHash=${keyHash}`);
    return inFlight.get(keyHash) as Promise<T>;
  }

  console.log(`[SCRAPER-ML-QUEUE] queued keyHash=${keyHash} size=${inFlight.size}`);
  
  const executionPromise = new Promise<T>((resolve, reject) => {
    const run = mlQueue.then(async () => {
      const start = Date.now();
      console.log(`[SCRAPER-ML-QUEUE] started keyHash=${keyHash}`);
      try {
        const result = await job();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        const durationMs = Date.now() - start;
        console.log(`[SCRAPER-ML-QUEUE] finished keyHash=${keyHash} durationMs=${durationMs}`);
        inFlight.delete(keyHash);
      }
    });
    
    // Keep the queue alive regardless of job failure
    mlQueue = run.catch(() => {});
  });

  inFlight.set(keyHash, executionPromise);
  return executionPromise;
}
