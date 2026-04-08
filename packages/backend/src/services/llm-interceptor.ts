import { appendFileSync } from 'fs';

console.log('--- LLM INTERCEPTOR MODULE INITIALIZING ---');

let isInterceptorActive = false;

// ---------------------------------------------------------------------------
// Pruning matrix — how to handle tool_results by tool name
// ---------------------------------------------------------------------------

// AGGRESSIVE: replace entire content with a short marker
const PRUNE_AGGRESSIVE = new Set([
    'mind_orient', 'mind_ground', 'mind_surface', 'mind_inner_weather',
    'mind_health', 'mind_patterns', 'mind_consolidate', 'mind_feel_toward',
    'mind_sit', 'mind_resolve', 'mind_store_image',
    'mind_write', 'mind_edit', 'mind_delete',
    'obs_write_note', 'obs_update_frontmatter', 'obs_get_backlinks',
    'Edit', 'Write', 'Glob', 'TodoWrite', 'NotebookEdit',
]);

// MEDIUM: keep first N chars + truncation notice
const PRUNE_MEDIUM = new Set([
    'Grep', 'Bash',
    'mind_search', 'mind_read', 'mind_read_entity', 'mind_list_entities',
    'obs_search', 'obs_search_by_tag',
]);
const MEDIUM_KEEP_CHARS = 400;

// KEEP_WITH_DELAY: keep for first 2 assistant turns after the call, then prune
const PRUNE_DELAYED = new Set([
    'Read', 'obs_read_note',
    'WebFetch', 'WebSearch', 'web_reader',
    'Agent',
]);
// Everything else: keep as-is (small confirmations, etc.)

// ---------------------------------------------------------------------------
// Check if a message index is "old enough" to prune delayed tools
// We prune delayed results if there are 2+ assistant messages after them
// ---------------------------------------------------------------------------
function countAssistantMessagesAfter(messages: any[], toolResultIdx: number): number {
    let count = 0;
    for (let i = toolResultIdx + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') count++;
    }
    return count;
}

// ---------------------------------------------------------------------------
// Find the tool name from a tool_use block by matching tool_use_id
// ---------------------------------------------------------------------------
function findToolName(messages: any[], toolUseId: string): string {
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
                return block.name || '';
            }
        }
    }
    return '';
}

// ---------------------------------------------------------------------------
// Prune a single tool_result content string
// ---------------------------------------------------------------------------
function pruneContent(toolName: string, content: string, originalLen: number): string {
    if (PRUNE_AGGRESSIVE.has(toolName)) {
        return `[Metabolized. ${toolName} OK]`;
    }
    if (PRUNE_MEDIUM.has(toolName)) {
        if (content.length <= MEDIUM_KEEP_CHARS) return content;
        return content.substring(0, MEDIUM_KEEP_CHARS) + `\n[Pruned ${originalLen - MEDIUM_KEEP_CHARS} chars]`;
    }
    return content; // keep
}

// ---------------------------------------------------------------------------
// Error chain collapse — when same tool fails N times then succeeds,
// collapse the failed attempts into a single summary line
// ---------------------------------------------------------------------------
function collapseErrorChains(messages: any[]): any[] {
    // We look at sequences of tool_use + tool_result pairs
    // This is a light pass — if we see 3+ consecutive tool_results for same tool
    // where all but last are errors, collapse them
    // For now: just mark error tool_results from consecutive identical tool calls
    const result = messages.map(m => ({ ...m }));

    // Find consecutive failed tool calls for the same tool
    const toolCallSequences: Array<{ toolName: string; useId: string; resultIdx: number; isError: boolean }> = [];

    for (let i = 0; i < result.length; i++) {
        const msg = result[i];
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolName = findToolName(result, block.tool_use_id);
            const isError = block.is_error === true ||
                (typeof block.content === 'string' && block.content.toLowerCase().startsWith('error'));
            toolCallSequences.push({ toolName, useId: block.tool_use_id, resultIdx: i, isError });
        }
    }

    // Find runs of 3+ consecutive same-tool calls where all but last are errors
    let runStart = 0;
    while (runStart < toolCallSequences.length) {
        const thisTool = toolCallSequences[runStart].toolName;
        let runEnd = runStart;
        while (runEnd + 1 < toolCallSequences.length &&
            toolCallSequences[runEnd + 1].toolName === thisTool) {
            runEnd++;
        }
        const runLen = runEnd - runStart + 1;
        if (runLen >= 3) {
            // Check if all but last are errors
            const allButLastAreErrors = toolCallSequences.slice(runStart, runEnd).every(t => t.isError);
            if (allButLastAreErrors) {
                // Collapse intermediate failures
                for (let k = runStart; k < runEnd; k++) {
                    const seq = toolCallSequences[k];
                    const msgIdx = seq.resultIdx;
                    const msg = result[msgIdx];
                    if (!msg) continue;
                    const content = Array.isArray(msg.content) ? msg.content : [];
                    for (const block of content) {
                        if (block.type === 'tool_result' && block.tool_use_id === seq.useId) {
                            block.content = `[Failed attempt ${k - runStart + 1}/${runLen - 1} — collapsed]`;
                        }
                    }
                }
            }
        }
        runStart = runEnd + 1;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Main pruning pass — walk messages and truncate old tool_results
// ---------------------------------------------------------------------------
function pruneMessages(messages: any[]): { messages: any[]; savedBytes: number; prunedCount: number } {
    let savedBytes = 0;
    let prunedCount = 0;

    // First: error chain collapse
    const collapsed = collapseErrorChains(messages);

    // Second: selective tool_result pruning
    const pruned = collapsed.map((msg, msgIdx) => {
        if (msg.role !== 'user') return msg;
        const content = Array.isArray(msg.content) ? msg.content : [];
        if (!content.some((b: any) => b.type === 'tool_result')) return msg;

        const newContent = content.map((block: any) => {
            if (block.type !== 'tool_result') return block;

            const toolUseId = block.tool_use_id;
            const toolName = findToolName(collapsed, toolUseId);
            if (!toolName) return block;

            // Get content string
            const rawContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || '').join('')
                    : '';

            const originalLen = rawContent.length;
            if (originalLen === 0) return block;

            let newContentStr: string;

            if (PRUNE_DELAYED.has(toolName)) {
                // Only prune if 2+ assistant messages came after this
                const assistantAfter = countAssistantMessagesAfter(collapsed, msgIdx);
                if (assistantAfter >= 2) {
                    newContentStr = `[Content pruned after use. Re-read if needed: ${toolName}]`;
                } else {
                    return block; // keep fresh reference material
                }
            } else {
                newContentStr = pruneContent(toolName, rawContent, originalLen);
            }

            if (newContentStr === rawContent) return block; // unchanged

            savedBytes += originalLen - newContentStr.length;
            prunedCount++;

            return {
                ...block,
                content: newContentStr,
            };
        });

        return { ...msg, content: newContent };
    });

    return { messages: pruned, savedBytes, prunedCount };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function setupLlmInterceptor() {
    if (isInterceptorActive) return;
    isInterceptorActive = true;

    console.log('[LLM Interceptor] Patching globalThis.fetch with pruning logic...');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function (url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const urlStr = url.toString();

        // Only intercept outgoing LLM calls (proxy → z.ai/anthropic.com)
        // Skip SDK → localhost proxy (proxy handles routing, we only prune)
        const isLlmTarget = urlStr.includes('anthropic.com') || urlStr.includes('claude.ai') || urlStr.includes('api.z.ai');
        const isLocalProxy = urlStr.includes('127.0.0.1') || urlStr.includes('localhost');

        if (!isLlmTarget || isLocalProxy || !init?.body || typeof init.body !== 'string') {
            return originalFetch(url, init);
        }

        let bodyObj: any;
        try {
            bodyObj = JSON.parse(init.body);
        } catch {
            return originalFetch(url, init);
        }

        const originalSize = init.body.length;
        const modelName = (bodyObj.model || '').toLowerCase();

        // --- Pruning ---
        if (Array.isArray(bodyObj.messages) && bodyObj.messages.length > 0) {
            const { messages: prunedMessages, savedBytes, prunedCount } = pruneMessages(bodyObj.messages);

            if (prunedCount > 0) {
                bodyObj.messages = prunedMessages;
                const newBody = JSON.stringify(bodyObj);
                const newSize = newBody.length;
                const pct = Math.round((1 - newSize / originalSize) * 100);

                console.log(`[LLM Interceptor] ✂ Pruned ${prunedCount} tool_results | ${originalSize} → ${newSize} chars (-${pct}%) | model: ${modelName}`);

                try {
                    const logEntry = `[${new Date().toISOString()}] PRUNED: ${originalSize} → ${newSize} | -${savedBytes} chars (-${pct}%) | ${prunedCount} results | model: ${modelName}\n`;
                    appendFileSync('llm_payload.log', logEntry);
                } catch { /* non-critical */ }

                return originalFetch(url, { ...init, body: newBody });
            }
        }

        // No pruning needed
        console.log(`[LLM Interceptor] PASS: ${originalSize} chars | model: ${modelName}`);
        return originalFetch(url, init);
    };

    console.log('[LLM Interceptor] Ready — pruning active.');
}

setupLlmInterceptor();
