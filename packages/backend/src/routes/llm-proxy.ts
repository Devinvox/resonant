import { Router, Request, Response } from 'express';

const router = Router();

// This endpoint receives all Anthropic API calls explicitly directed at this local proxy
router.post('/v1/messages', async (req: Request, res: Response) => {
    try {
        const body = req.body;
        const model = (body.model || '').toLowerCase();

        // Default: Anthropic
        let targetUrl = 'https://api.anthropic.com/v1/messages';

        // By default, the SDK passes whatever is in ANTHROPIC_API_KEY / global Auth Token as a header.
        // We intercept and rewrite it if routing to a third party.
        let targetKey = req.headers['x-api-key'] || req.headers['authorization'];
        if (Array.isArray(targetKey)) targetKey = targetKey[0];

        let isAnthropic = true;

        // Detect Zhipu AI GLM models
        if (model.includes('glm')) {
            targetUrl = 'https://api.z.ai/api/anthropic/v1/messages';
            targetKey = process.env.ZAI_API_KEY || ''; // Must be configured in .env
            isAnthropic = false;
            console.log(`[LLM Proxy] Routing model '${model}' to Zhipu AI (GLM)`);
        } else {
            console.log(`[LLM Proxy] Routing model '${model}' to original Anthropic`);
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': (req.headers['anthropic-version'] as string) || '2023-06-01',
        };

        if (isAnthropic && typeof req.headers['anthropic-dangerous-direct-browser-access'] === 'string') {
            headers['anthropic-dangerous-direct-browser-access'] = req.headers['anthropic-dangerous-direct-browser-access'];
        }

        if (targetKey) {
            // Z.ai and Anthropic both accept x-api-key in Anthropic API emulation mode
            headers['x-api-key'] = targetKey;
        }

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[LLM Proxy] Target API returned ${response.status}:`, errText);
            res.status(response.status).send(errText);
            return;
        }

        // Proxy the response headers back to the SDK
        response.headers.forEach((value, key) => {
            // Don't forward transfer-encoding to let Express handle chunking naturally
            if (key !== 'transfer-encoding' && key !== 'content-encoding') {
                res.setHeader(key, value);
            }
        });

        if (!response.body) {
            res.end();
            return;
        }

        // Manually pipe the Node Web Streams ReadableStream to Express's Writable stream
        if (typeof (response.body as any).pipe === 'function') {
            // Older Node / undici
            (response.body as any).pipe(res);
        } else {
            // Standard fetch ReadableStream
            const reader = response.body.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(Buffer.from(value));
                    if (typeof (res as any).flush === 'function') (res as any).flush();
                }
                res.end();
            };
            pump().catch(e => {
                console.error('[LLM Proxy] Stream pump error:', e);
                res.end();
            });
        }

    } catch (error) {
        console.error('[LLM Proxy] Internal error:', error);
        res.status(500).json({ error: 'LLM Proxy Failed to forward request' });
    }
});

export default router;
