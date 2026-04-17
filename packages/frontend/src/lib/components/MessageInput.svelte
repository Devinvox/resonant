<script lang="ts">
  import type { Message, CommandRegistryEntry } from '@resonant/shared';
  import { tick } from 'svelte';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import VoiceModeToggle from './VoiceModeToggle.svelte';
  import { getCompanionName } from '$lib/stores/settings.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { getCommandRegistry, sendCommand } from '$lib/stores/websocket.svelte';

  let companionName = $derived(getCompanionName());

  interface FileUploadResult {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentType: 'image' | 'audio' | 'file';
    url: string;
  }

  let {
    replyTo = null,
    isStreaming = false,
    activeThreadId = null,
    editDraft = { text: '', ts: 0 },
    onbatchsend,
    oncancelreply,
    onstop,
  } = $props<{
    replyTo?: Message | null;
    isStreaming?: boolean;
    activeThreadId?: string | null;
    editDraft?: { text: string; ts: number };
    onbatchsend?: (text: string, files: FileUploadResult[], prosody?: Record<string, number>) => void;
    oncancelreply?: () => void;
    onstop?: () => void;
  }>();

  let textarea: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;
  let content = $state('');
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);
  let pendingAttachments = $state<FileUploadResult[]>([]);
  let pendingProsody = $state<Record<string, number> | null>(null);

  // When editDraft changes from parent, fill textarea
  $effect(() => {
    if (editDraft && typeof editDraft === 'object' && editDraft.text && editDraft.ts > 0) {
      const text = String(editDraft.text);
      if (text !== '[object Object]') {
        content = text;
        tick().then(() => { 
          textarea?.focus();
          autoResize();
        });
      }
    }
  });

  // Command palette state
  let showCommandPalette = $state(false);
  let commandFilter = $state('');
  let paletteRef: CommandPalette;
  let commandRegistry = $derived(getCommandRegistry());

  // Can send if there's text or pending attachments
  let canSend = $derived(content.trim().length > 0 || pendingAttachments.length > 0);

  // Auto-resize textarea
  function autoResize() {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }

  // Detect slash commands on input
  function handleInput() {
    autoResize();
    // Show command palette when content starts with / and is a single line
    if (content.startsWith('/') && !content.includes('\n')) {
      showCommandPalette = true;
      commandFilter = content.slice(1).split(' ')[0]; // filter on command name only
    } else {
      showCommandPalette = false;
      commandFilter = '';
    }
  }

  // Handle command selection from palette
  function handleCommandSelect(command: CommandRegistryEntry) {
    showCommandPalette = false;

    if (command.clientOnly) {
      executeClientCommand(command.name);
      resetInput();
      return;
    }

    if (command.args) {
      // Command takes arguments — fill prefix and let user type
      content = `/${command.name} `;
      textarea?.focus();
      return;
    }

    // No-arg server command — execute immediately
    sendCommand(command.name, undefined, activeThreadId ?? undefined);
    resetInput();
  }

  // Client-side command execution
  function executeClientCommand(name: string) {
    switch (name) {
      case 'help':
        // Show full palette with no filter
        showCommandPalette = true;
        commandFilter = '';
        content = '/';
        return; // Don't reset — keep palette open
      case 'stop':
        onstop?.();
        break;
    }
  }

  // Handle send — check for slash commands first
  function handleSend() {
    if (!canSend) return;

    const trimmed = content.trim();

    // Check if this is a slash command
    if (trimmed.startsWith('/')) {
      const spaceIndex = trimmed.indexOf(' ');
      const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
      const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim() || undefined;

      const cmd = commandRegistry.find(c => c.name === name);
      if (cmd) {
        if (cmd.clientOnly) {
          executeClientCommand(name);
        } else {
          sendCommand(name, args, activeThreadId ?? undefined);
        }
        resetInput();
        return;
      }
      // Not a recognized command — fall through to send as regular message
    }

    const files = [...pendingAttachments];
    onbatchsend?.(trimmed, files, pendingProsody ?? undefined);
    resetInput();
  }

  function resetInput() {
    pendingAttachments = [];
    content = '';
    pendingProsody = null;
    showCommandPalette = false;
    commandFilter = '';
    if (textarea) textarea.style.height = 'auto';
  }

  // Remove a pending attachment
  function removeAttachment(index: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
  }

  // Handle keyboard — route to palette when open
  function handleKeydown(e: KeyboardEvent) {
    if (showCommandPalette && paletteRef) {
      const handled = paletteRef.handleKey(e);
      if (handled) return;
    }

    if (e.key === 'Enter') {
      const isMobile = typeof window !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      
      if (isMobile) {
        if (e.shiftKey) {
          // Mobile Shift+Enter: Send
          e.preventDefault();
          handleSend();
        }
        // Mobile Enter (no shift): newline (default)
        return;
      }

      if (e.shiftKey) {
        // Desktop Shift+Enter: newline (default)
        return;
      }

      // Desktop Enter (no shift): Send message
      e.preventDefault();
      handleSend();
    }
  }

  // Upload a file to the server — queues as pending, doesn't send
  async function uploadFile(file: File) {
    uploading = true;
    uploadError = null;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/files', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || `Upload failed (${response.status})`);
      }

      const result: FileUploadResult = await response.json();
      pendingAttachments = [...pendingAttachments, result];
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      uploadError = msg;
      setTimeout(() => { uploadError = null; }, 5000);
    } finally {
      uploading = false;
    }
  }

  // Handle file input change — supports multiple files
  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      for (const file of files) {
        uploadFile(file);
      }
    }
    input.value = '';
  }

  // Handle paste — detect images, queue as pending
  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadFile(file);
        return;
      }
    }
  }

  // Handle voice transcript — populate textarea, hold prosody
  function handleTranscript(text: string, prosody?: Record<string, number> | null) {
    content = text;
    pendingProsody = prosody ?? null;
    textarea?.focus();
  }

  // Cancel reply
  function handleCancelReply() {
    oncancelreply?.();
  }

  // Watch content for auto-resize + discard prosody if textarea fully cleared
  $effect(() => {
    if (content === '' && pendingProsody) {
      pendingProsody = null;
    }
    autoResize();
  });
</script>

<div class="message-input-container">
  {#if replyTo}
    <div class="reply-indicator">
      <div class="reply-bar"></div>
      <div class="reply-info">
        <span class="replying-to">Replying to {replyTo.role === 'companion' ? companionName : 'You'}</span>
        <span class="reply-preview">{replyTo.content.substring(0, 100)}</span>
      </div>
      <button class="cancel-reply" onclick={handleCancelReply} aria-label="Cancel reply">
        ✕
      </button>
    </div>
  {/if}

  {#if uploadError}
    <div class="upload-error">{uploadError}</div>
  {/if}

  {#if pendingAttachments.length > 0}
    <div class="attachment-strip">
      {#each pendingAttachments as attachment, i}
        <div class="attachment-preview">
          {#if attachment.contentType === 'image'}
            <img src={attachment.url} alt={attachment.filename} class="attachment-thumb" />
          {:else}
            <div class="attachment-file-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <span class="attachment-name">{attachment.filename}</span>
            </div>
          {/if}
          <button class="attachment-remove" onclick={() => removeAttachment(i)} aria-label="Remove attachment">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if showCommandPalette}
    <CommandPalette
      bind:this={paletteRef}
      filter={commandFilter}
      commands={commandRegistry}
      onselect={handleCommandSelect}
      onclose={() => { showCommandPalette = false; }}
    />
  {/if}

  <div class="input-card">
    <textarea
      bind:this={textarea}
      bind:value={content}
      oninput={handleInput}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      placeholder="Message Resonant..."
      rows="1"
      aria-label="Message input"
    ></textarea>

    <div class="input-actions">
      <div class="actions-left">
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*,audio/*,.pdf,.txt,.md,.json"
          multiple
          onchange={handleFileSelect}
          hidden
          aria-hidden="true"
        />

        <button
          class="icon-button"
          onclick={() => fileInput?.click()}
          disabled={uploading}
          aria-label="Attach file"
          title="Attach file"
        >
          {#if uploading}
            <span class="upload-spinner"></span>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          {/if}
        </button>

        <VoiceRecorder ontranscript={handleTranscript} />
        <VoiceModeToggle />
      </div>

      <div class="actions-right">
        {#if isStreaming}
          <button
            class="send-button stop-active"
            onclick={() => onstop?.()}
            aria-label="Stop generation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
            </svg>
          </button>
        {:else}
          <button
            class="send-button"
            onclick={handleSend}
            disabled={!canSend}
            aria-label="Send message"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </button>
        {/if}
      </div>
    </div>
  </div>

  <div class="composer-hint">
    <span>/ for commands</span>
    {#if typeof window !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)}
      <span>Enter for newline</span>
      <span>Shift+Enter to send</span>
    {:else}
      <span>Enter to send</span>
      <span>Shift+Enter for newline</span>
    {/if}
  </div>
</div>

<style>
  .message-input-container {
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg-primary) 72%, transparent));
    backdrop-filter: blur(16px);
    max-width: 54rem;
    margin: 0 auto;
    padding: 0 1rem 1.35rem;
    position: relative;
    width: 100%;
  }

  .reply-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 1rem 1rem 0 0;
  }

  .reply-bar {
    width: 2px;
    height: 2rem;
    background: var(--accent);
    border-radius: 1px;
    flex-shrink: 0;
  }

  .reply-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow: hidden;
  }

  .replying-to {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent);
    font-family: var(--font-heading);
    letter-spacing: 0.03em;
  }

  .reply-preview {
    font-size: 0.875rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cancel-reply {
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition-fast);
  }

  .cancel-reply:hover {
    color: var(--text-secondary);
  }

  .upload-error {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    color: var(--error, #ef4444);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-bottom: none;
  }

  .attachment-strip {
    display: flex;
    gap: 0.5rem;
    padding: 0.85rem 1rem 0.35rem;
    overflow-x: auto;
    flex-wrap: wrap;
  }

  .attachment-preview {
    position: relative;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    overflow: hidden;
    background: var(--bg-surface);
  }

  .attachment-thumb {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    display: block;
  }

  .attachment-file-icon {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    max-width: 8rem;
  }

  .attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.7);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-fast);
  }

  .attachment-remove:hover {
    background: rgba(239, 68, 68, 0.8);
  }

  .input-card {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: none;
    border-radius: 1.125rem;
    box-shadow: none;
    padding: 0.5rem 0.625rem 0.5rem;
    gap: 0.35rem;
    transition: all var(--transition);
  }

  .input-card:focus-within {
    box-shadow: none !important;
    border: none !important;
    outline: none !important;
  }

  textarea:focus, textarea:focus-visible {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }

  textarea {
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0.4rem 0.25rem;
    color: var(--text-primary);
    font-size: 1rem;
    line-height: 1.6;
    resize: none;
    max-height: 300px;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  .input-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .actions-left {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .actions-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .icon-button {
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    color: var(--text-muted);
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all var(--transition);
  }

  .icon-button:hover:not(:disabled) {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .upload-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--text-muted);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .send-button {
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    background: var(--text-primary);
    color: var(--bg-primary);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    flex-shrink: 0;
  }

  .send-button:hover:not(:disabled) {
    background: var(--accent);
    color: white;
  }

  .send-button:disabled {
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: not-allowed;
  }

  .send-button.stop-active {
    background: var(--status-error, #ef4444);
    color: white;
  }

  .send-button.stop-active:hover {
    background: #dc2626;
  }

  .composer-hint {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    justify-content: center;
    padding-top: 0.6rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
  }

  @media (max-width: 768px) {
    .input-card {
      padding: 0.375rem 0.5rem 0.375rem;
    }
    textarea {
      padding: 0.5rem 0.25rem;
    }
    .composer-hint {
      justify-content: flex-start;
      gap: 0.35rem 0.75rem;
    }
  }
</style>
