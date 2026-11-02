'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CalendarDateField } from '@/components/calendar-date-field';
import { DirectoryCombobox } from '@/components/directory-combobox';
import { ApiError } from '@/lib/command-api';
import { personOption } from '@/lib/lookups';
import { updatePropertyObject } from '@/lib/objects-api';

export function EditPropertyObjectDialog({
  csrfToken,
  target,
  engineers = [],
  onClose,
  onSaved,
}: {
  csrfToken: string;
  target: {
    id: string;
    version: number;
    name: string;
    address: string | null;
    active: boolean;
    commissionedAt?: string | null;
    warrantyEndsAt?: string | null;
    responsibleEngineerIds?: string[];
  };
  engineers?: Array<{
    id: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
  }>;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(target.name);
  const [address, setAddress] = useState(target.address ?? '');
  const [active, setActive] = useState(target.active);
  const [commissionedAt, setCommissionedAt] = useState(target.commissionedAt ?? '');
  const [warrantyEndsAt, setWarrantyEndsAt] = useState(target.warrantyEndsAt ?? '');
  const [commissionedInvalid, setCommissionedInvalid] = useState(false);
  const [warrantyInvalid, setWarrantyInvalid] = useState(false);
  const commissionedRef = useRef(commissionedAt);
  const warrantyRef = useRef(warrantyEndsAt);
  const commissionedInvalidRef = useRef(false);
  const warrantyInvalidRef = useRef(false);
  const [engineerIds, setEngineerIds] = useState(target.responsibleEngineerIds ?? []);
  const [pending, setPending] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const originalCommissioned = target.commissionedAt ?? '';
  const originalWarranty = target.warrantyEndsAt ?? '';

  function dateOrderError(commissioned = commissionedAt, warranty = warrantyEndsAt): string | null {
    const datesChanged = commissioned !== originalCommissioned || warranty !== originalWarranty;
    if (datesChanged && commissioned && warranty && warranty < commissioned) {
      return 'Дата окончания гарантии не может быть раньше даты приёмки';
    }
    return null;
  }

  async function save() {
    if (pending) {
      return;
    }
    const commissioned = commissionedRef.current;
    const warranty = warrantyRef.current;
    if (commissionedInvalidRef.current || warrantyInvalidRef.current) {
      toast.error('Некорректная дата. Укажите её в формате ДД.ММ.ГГГГ.');
      return;
    }
    const orderError = dateOrderError(commissioned, warranty);
    if (orderError) {
      toast.error(orderError);
      return;
    }
    setPending(true);
    try {
      await updatePropertyObject(csrfToken, target.id, {
        expectedVersion: target.version,
        name,
        address: address.trim() ? address : null,
        active,
        commissionedAt: commissioned || null,
        warrantyEndsAt: warranty || null,
        ...(target.responsibleEngineerIds ? { responsibleEngineerIds: engineerIds } : {}),
      });
      toast.success('Объект сохранён');
      await onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось сохранить объект');
    } finally {
      setPending(false);
    }
  }

  function onSubmit() {
    if (active !== target.active) {
      setConfirmStatus(true);
      return;
    }
    void save();
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-md"
          onInteractOutside={(event) => {
            const targetNode = event.target;
            if (targetNode instanceof Element && targetNode.closest('[data-calendar-popover]')) {
              event.preventDefault();
            }
          }}
        >
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Редактировать объект</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-object-name">Название объекта</Label>
              <Input
                id="edit-object-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-object-address">Адрес</Label>
              <Input
                id="edit-object-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                className="min-h-11"
              />
            </div>
            <CalendarDateField
              id="edit-object-commissioned"
              label="Дата приёмки в эксплуатацию"
              value={commissionedAt}
              onChange={(value) => {
                commissionedRef.current = value;
                setCommissionedAt(value);
              }}
              onInvalidChange={(invalid) => {
                commissionedInvalidRef.current = invalid;
                setCommissionedInvalid(invalid);
              }}
              disabled={pending}
            />
            <CalendarDateField
              id="edit-object-warranty"
              label="Дата окончания гарантийного срока"
              value={warrantyEndsAt}
              onChange={(value) => {
                warrantyRef.current = value;
                setWarrantyEndsAt(value);
              }}
              onInvalidChange={(invalid) => {
                warrantyInvalidRef.current = invalid;
                setWarrantyInvalid(invalid);
              }}
              disabled={pending}
            />
            {dateOrderError() ? (
              <p className="text-sm text-destructive" role="alert">
                {dateOrderError()}
              </p>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="edit-object-status">Статус объекта</Label>
              <Select
                value={active ? 'ACTIVE' : 'ARCHIVED'}
                onValueChange={(value) => setActive(value === 'ACTIVE')}
              >
                <SelectTrigger id="edit-object-status" aria-label="Статус объекта">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Активен</SelectItem>
                  <SelectItem value="ARCHIVED">Архив</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DirectoryCombobox
              label="Ответственные инженеры"
              options={engineers.map((item) => personOption(item))}
              values={engineerIds}
              onValuesChange={setEngineerIds}
              emptyText="Нет активных ответственных инженеров"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                Отмена
              </Button>
              <Button
                type="submit"
                disabled={pending || !name.trim() || commissionedInvalid || warrantyInvalid}
              >
                {pending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmStatus} onOpenChange={setConfirmStatus}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {active ? 'Вернуть объект в работу?' : 'Архивировать объект?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {active
                ? 'Объект снова будет предлагаться при создании новых актов.'
                : 'Объект перестанет предлагаться при создании новых актов. Существующие акты сохранят ссылку на него.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmStatus(false);
                void save();
              }}
            >
              Подтвердить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
