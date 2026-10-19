'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CSRF_HEADER_NAME, shouldKeepPolling } from '@sgr-registry/domain';
import type { AttachmentCategory, AttachmentListResponse } from '@sgr-registry/contracts';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/command-api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const CATEGORY_LABELS: Record<string, string> = {
  ACT_DOCUMENT: 'Документ акта',
  ACT_SCAN: 'Скан акта',
  DEFECT_PHOTO: 'Фотография дефекта',
  CLAIM_DOCUMENT: 'Документ претензии',
  THIRD_PARTY_DOCUMENT: 'Документ третьей стороны',
  PROPOSAL_DOCUMENT: 'Документ предложения',
  OTHER: 'Прочее',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING_SCAN: 'Проверка',
  SCANNING: 'Проверка',
  READY: 'Готово',
  REJECTED: 'Отклонено',
  SCAN_FAILED: 'Не удалось проверить',
  ARCHIVED: 'В архиве',
  UPLOADING: 'Загрузка',
};

export function AttachmentsPanel({
  title,
  listPath,
  uploadPath,
  categories,
  canUpload,
  csrfToken,
  compact = false,
}: {
  title: string;
  listPath: string;
  uploadPath: string;
  categories: AttachmentCategory[];
  canUpload: boolean;
  csrfToken: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.attachments(listPath),
    queryFn: async () => {
      const response = await fetch(listPath, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('attachments');
      return (await response.json()) as AttachmentListResponse;
    },
  });
  const polling = shouldKeepPolling(query.data?.items.map((item) => item.status) ?? []);
  const previewUrl = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (previewUrl.current) {
        URL.revokeObjectURL(previewUrl.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void query.refetch();
    }, 2500);
    return () => clearInterval(timer);
  }, [polling, query]);

  const [open, setOpen] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string; mime: string } | null>(null);

  function closePreview() {
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
    setPreview(null);
  }

  async function openPreview(item: {
    id: string;
    safeDisplayName: string;
    detectedMimeType: string | null;
  }) {
    const response = await fetch(`/api/attachments/${item.id}/content`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      toast.error('Не удалось открыть файл');
      return;
    }
    const downloaded = await response.blob();
    const mime = item.detectedMimeType || downloaded.type || 'application/octet-stream';
    const blob = downloaded.type === mime ? downloaded : new Blob([downloaded], { type: mime });
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current);
    }
    const src = URL.createObjectURL(blob);
    previewUrl.current = src;
    setPreview({ src, name: item.safeDisplayName, mime });
  }

  const items = query.data?.items ?? [];

  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {title}{' '}
          <span className="text-muted-foreground">({query.data?.activeCount ?? items.length})</span>
        </h3>
        {canUpload ? (
          <Button type="button" size="sm" onClick={() => setOpen(true)}>
            Загрузить
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Файлов пока нет.</p>
      ) : (
        <ul className={cn('grid gap-2', compact && 'sm:grid-cols-1')}>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-all">{item.safeDisplayName}</span>
              <Badge variant="secondary">{STATUS_LABELS[item.status] ?? item.status}</Badge>
              <span className="text-muted-foreground">{formatSize(item.sizeBytes)}</span>
              {item.canPreview ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void openPreview(item)}
                >
                  Открыть
                </Button>
              ) : null}
              {item.canDownload ? (
                <Button type="button" size="sm" variant="outline" className="min-h-11" asChild>
                  <a href={`/api/attachments/${item.id}/content`} download={item.safeDisplayName}>
                    Скачать
                  </a>
                </Button>
              ) : null}
              {item.canArchive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => setArchiveId(item.id)}
                >
                  Архивировать
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <UploadSheet
        open={open}
        onOpenChange={setOpen}
        uploadPath={uploadPath}
        categories={categories}
        csrfToken={csrfToken}
        limits={query.data?.limits}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.attachments(listPath) });
        }}
      />
      <ArchiveDialog
        attachmentId={archiveId}
        csrfToken={csrfToken}
        onClose={() => setArchiveId(null)}
        onDone={() => {
          setArchiveId(null);
          void queryClient.invalidateQueries({ queryKey: queryKeys.attachments(listPath) });
        }}
      />
      <Dialog open={Boolean(preview)} onOpenChange={(next) => !next && closePreview()}>
        <DialogContent className="max-h-[90dvh] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="break-all">{preview?.name}</DialogTitle>
          </DialogHeader>
          {preview?.mime.startsWith('image/') ? (
            <img
              src={preview.src}
              alt={preview.name}
              className="max-h-[70dvh] w-full object-contain"
            />
          ) : preview ? (
            <iframe title={preview.name} src={preview.src} className="h-[70dvh] w-full" />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function UploadSheet({
  open,
  onOpenChange,
  uploadPath,
  categories,
  csrfToken,
  limits,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uploadPath: string;
  categories: AttachmentCategory[];
  csrfToken: string;
  limits?: AttachmentListResponse['limits'];
  onDone: () => void;
}) {
  const [category, setCategory] = useState<AttachmentCategory>(categories[0] ?? 'OTHER');
  const [progress, setProgress] = useState<number | null>(null);
  const [filename, setFilename] = useState<string>('');
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    setCategory(categories[0] ?? 'OTHER');
  }, [categories]);

  function uploadFile(file: File) {
    const office = /\.(pdf|docx?|xlsx?)$/i.test(file.name);
    const limit = office ? 10 * 1024 * 1024 : (limits?.maxBytes ?? 20 * 1024 * 1024);
    if (file.size > limit) {
      toast.error(office ? 'Размер файла не должен превышать 10 МиБ' : 'Файл больше 20 МиБ');
      return;
    }
    const form = new FormData();
    form.set('category', category);
    form.set('file', file);
    setFilename(file.name);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', uploadPath);
    xhr.withCredentials = true;
    xhr.setRequestHeader(CSRF_HEADER_NAME, csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status === 202) {
        toast.success('Загружено, выполняется проверка');
        onOpenChange(false);
        onDone();
      } else {
        toast.error(uploadErrorMessage(xhr.responseText));
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      toast.error('Не удалось загрузить файл');
    };
    xhr.send(form);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-[100dvh] flex-col">
        <SheetHeader>
          <SheetTitle>Загрузка файла</SheetTitle>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-auto px-4">
          <p className="text-sm text-muted-foreground">
            PDF, DOC, DOCX, XLS, XLSX, JPEG, PNG и WebP. Документы — до 10 МиБ, изображения — до{' '}
            {Math.round((limits?.maxBytes ?? 20971520) / 1024 / 1024)} МиБ.
          </p>
          <Label htmlFor="attachment-category">Категория</Label>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as AttachmentCategory)}
          >
            <SelectTrigger id="attachment-category" aria-label="Категория" className="min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {categories.map((item) => (
                <SelectItem key={item} value={item}>
                  {CATEGORY_LABELS[item] ?? item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label
            htmlFor="attachment-file"
            className="flex min-h-24 cursor-pointer items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) uploadFile(file);
            }}
          >
            Выберите файл или перетащите его сюда
          </Label>
          <Input
            id="attachment-file"
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadFile(file);
            }}
          />
          {progress !== null ? (
            <div className="grid gap-1">
              <p className="break-all text-sm">{filename}</p>
              <div
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 overflow-hidden rounded bg-muted"
              >
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
              <Button type="button" variant="outline" onClick={() => xhrRef.current?.abort()}>
                Отменить
              </Button>
            </div>
          ) : null}
        </div>
        <SheetFooter />
      </SheetContent>
    </Sheet>
  );
}

function ArchiveDialog({
  attachmentId,
  csrfToken,
  onClose,
  onDone,
}: {
  attachmentId: string | null;
  csrfToken: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      if (!attachmentId) return;
      const meta = await fetch(`/api/attachments/${attachmentId}`, { credentials: 'include' });
      const body = (await meta.json()) as { version: number };
      const response = await fetch(`/api/attachments/${attachmentId}/archive`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: csrfToken },
        body: JSON.stringify({ expectedVersion: body.version, reason }),
      });
      if (!response.ok) {
        throw new ApiError(response.status, 'Не удалось архивировать');
      }
    },
    onSuccess: () => {
      toast.success('Вложение архивировано');
      setReason('');
      onDone();
    },
    onError: () => toast.error('Не удалось архивировать'),
  });
  return (
    <Dialog open={Boolean(attachmentId)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Архивировать вложение</DialogTitle>
        </DialogHeader>
        <Label htmlFor="archive-reason">Причина</Label>
        <Input
          id="archive-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button type="button" disabled={!reason.trim()} onClick={() => mutation.mutate()}>
            Архивировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function uploadErrorMessage(responseText: string): string {
  try {
    const body = JSON.parse(responseText) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim().length > 0) {
      return body.message;
    }
  } catch {
    return 'Не удалось загрузить файл';
  }
  return 'Не удалось загрузить файл';
}

function formatSize(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
