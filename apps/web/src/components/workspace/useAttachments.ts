'use client';

/**
 * [INPUT]: The daemon attachment upload API and the clear-input-error callback.
 * [OUTPUT]: Attachment drafts, async upload, remove/clear, file picker and image preview state.
 * [POS]: Workspace attachment lifecycle hook; separate from message-sending orchestration.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingAttachment } from '@/components/chat/chat-types';
import { uploadAttachment } from '@/providers/daemon';
import { t } from '@/i18n';

const MAX_ATTACHMENTS = 12;

export function useAttachments(clearError: () => void) {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingRef = useRef<PendingAttachment[]>([]);
  const mountedRef = useRef(false);
  const previewUrlsRef = useRef(new Set<string>());
  const [armedAttachmentId, setArmedAttachmentId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updatePending = useCallback((update: (items: PendingAttachment[]) => PendingAttachment[]) => {
    const next = update(pendingRef.current);
    pendingRef.current = next;
    setPendingAttachments(next);
  }, []);

  const releasePreview = useCallback((item: PendingAttachment) => {
    if (!item.previewUrl) return;
    URL.revokeObjectURL(item.previewUrl);
    previewUrlsRef.current.delete(item.previewUrl);
    setLightboxImage((image) => image?.url === item.previewUrl ? null : image);
  }, []);

  const removePendingAttachment = useCallback((clientId: string) => {
    const target = pendingRef.current.find((item) => item.clientId === clientId);
    if (target) releasePreview(target);
    updatePending((items) => items.filter((item) => item.clientId !== clientId));
    setArmedAttachmentId((id) => id === clientId ? null : id);
  }, [releasePreview, updatePending]);

  const clearPendingAttachments = useCallback(() => {
    for (const item of pendingRef.current) releasePreview(item);
    updatePending(() => []);
    setArmedAttachmentId(null);
  }, [releasePreview, updatePending]);

  const handleAttachFiles = useCallback((files: File[]) => {
    // Reserve slots synchronously: rapid paste/drop events cannot exceed the limit.
    const incoming = files.slice(0, MAX_ATTACHMENTS - pendingRef.current.length);
    if (!incoming.length) return;
    clearError();
    setArmedAttachmentId(null);
    const created = incoming.map((file) => {
      const mimeType = file.type || 'application/octet-stream';
      const previewUrl = mimeType.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrlsRef.current.add(previewUrl);
      const entry: PendingAttachment = {
        clientId: crypto.randomUUID(),
        name: file.name || 'attachment',
        mimeType,
        size: file.size,
        previewUrl,
        uploading: true,
      };
      return { file, entry };
    });
    updatePending((items) => [...items, ...created.map(({ entry }) => entry)]);
    for (const { file, entry } of created) {
      void uploadAttachment(file).then((uploaded) => {
        if (!mountedRef.current) return;
        updatePending((items) => items.map((item) => item.clientId === entry.clientId
          ? { ...item, name: uploaded.name, uploading: false, uploaded }
          : item));
      }).catch((error: unknown) => {
        if (!mountedRef.current) return;
        updatePending((items) => items.map((item) => item.clientId === entry.clientId
          ? { ...item, uploading: false, error: error instanceof Error ? error.message : t('errors.uploadFailed') }
          : item));
      });
    }
  }, [clearError, updatePending]);

  useEffect(() => {
    mountedRef.current = true;
    const urls = previewUrlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return {
    pendingAttachments, armedAttachmentId, setArmedAttachmentId,
    removePendingAttachment, clearPendingAttachments, handleAttachFiles,
    fileInputRef, lightboxImage, setLightboxImage,
  };
}
