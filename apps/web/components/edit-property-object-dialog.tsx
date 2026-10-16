'use client';

import { useState } from 'react';
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
  const [engineerIds, setEngineerIds] = useState(target.responsibleEngineerIds ?? []);
  const [pending, setPending] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);

  async function save() {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      await updatePropertyObject(csrfToken, target.id, {
        expectedVersion: target.version,
        name,
        address: address.trim() ? address : null,
        active,
        responsibleEngineerIds: engineerIds,
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
        <DialogContent>
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
              <Button type="submit" disabled={pending || !name.trim()}>
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
