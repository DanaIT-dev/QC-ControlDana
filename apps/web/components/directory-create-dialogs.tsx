'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, commandFetch } from '@/lib/command-api';
import { createPropertyObject } from '@/lib/objects-api';
import { queryKeys } from '@/lib/query-keys';
import type { OrganizationRole } from '@sgr-registry/contracts';
import { organizationCreateToast } from '@sgr-registry/domain';

export type DirectoryKind =
  'property-objects' | 'organizations' | 'work-types' | 'defect-types' | 'responsible-engineer';

export type DirectoryQuickCreateRequest =
  | { kind: 'property-objects'; query: string; field?: 'name' | 'address' }
  | { kind: 'organizations'; query: string; role: OrganizationRole }
  | { kind: 'work-types'; query: string }
  | { kind: 'defect-types'; query: string }
  | { kind: 'responsible-engineer'; query: string };

export function DirectoryCreateDialogs({
  csrfToken,
  request,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  request: DirectoryQuickCreateRequest | null;
  onClose: () => void;
  onCreated: (
    kind: DirectoryKind,
    created: { id: string; label: string; address?: string | null },
  ) => void;
}) {
  if (!request) {
    return null;
  }
  if (request.kind === 'organizations') {
    return (
      <OrganizationQuickCreateDialog
        csrfToken={csrfToken}
        role={request.role}
        initialName={request.query}
        onClose={onClose}
        onCreated={(created) => onCreated('organizations', created)}
      />
    );
  }
  if (request.kind === 'property-objects') {
    return (
      <ObjectQuickCreateDialog
        csrfToken={csrfToken}
        initialName={request.field === 'address' ? '' : request.query}
        initialAddress={request.field === 'address' ? request.query : ''}
        onClose={onClose}
        onCreated={(created) => onCreated('property-objects', created)}
      />
    );
  }
  if (request.kind === 'work-types') {
    return (
      <NamedQuickCreateDialog
        csrfToken={csrfToken}
        title="Добавить вид работ"
        nameLabel="Название"
        initialName={request.query}
        path="/api/reference-data/work-types"
        successText="Вид работ добавлен"
        onClose={onClose}
        onCreated={(created) => onCreated('work-types', created)}
      />
    );
  }
  if (request.kind === 'defect-types') {
    return (
      <NamedQuickCreateDialog
        csrfToken={csrfToken}
        title="Добавить вид дефекта"
        nameLabel="Название"
        initialName={request.query}
        path="/api/reference-data/defect-types"
        successText="Вид дефекта добавлен"
        onClose={onClose}
        onCreated={(created) => onCreated('defect-types', created)}
      />
    );
  }
  return (
    <RegisterEngineerDialog
      csrfToken={csrfToken}
      initialName={request.query}
      onClose={onClose}
      onCreated={(created) => onCreated('responsible-engineer', created)}
    />
  );
}

function OrganizationQuickCreateDialog({
  csrfToken,
  role,
  initialName,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  role?: OrganizationRole;
  initialName: string;
  onClose: () => void;
  onCreated: (created: { id: string; label: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [officialName, setOfficialName] = useState(initialName);
  const [unp, setUnp] = useState('');
  const [postalAddress, setPostalAddress] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [pending, setPending] = useState(false);
  const [existing, setExisting] = useState<{ id: string; label: string } | null>(null);

  async function submit() {
    if (pending) {
      return;
    }
    setPending(true);
    setExisting(null);
    try {
      const created = await commandFetch<{
        id: string;
        officialName: string;
        unp: string | null;
        postalAddress: string | null;
        email: string | null;
        phone: string | null;
        contactPerson: string | null;
      }>('/api/reference-data/organizations', {
        method: 'POST',
        csrfToken,
        body: {
          officialName,
          unp: unp.trim() ? unp : null,
          postalAddress: postalAddress.trim() ? postalAddress : null,
          email: email.trim() ? email : null,
          phone: phone.trim() ? phone : null,
          contactPerson: contactPerson.trim() ? contactPerson : null,
          roles: role ? [role] : undefined,
        },
      });
      const incomplete =
        !created.unp ||
        !created.postalAddress ||
        !created.email ||
        !created.phone ||
        !created.contactPerson;
      toast.success(organizationCreateToast(incomplete));
      await queryClient.invalidateQueries({ queryKey: queryKeys.lookups });
      onCreated({ id: created.id, label: created.officialName });
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.existing) {
        setExisting(error.existing);
        toast.error(error.message);
      } else {
        toast.error(error instanceof ApiError ? error.message : 'Не удалось создать организацию');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="max-h-[min(100dvh,40rem)] overflow-y-auto sm:max-w-lg">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Добавить организацию</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-name">Название организации</Label>
            <Input
              id="quick-org-name"
              value={officialName}
              onChange={(event) => setOfficialName(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-unp">УНП</Label>
            <Input
              id="quick-org-unp"
              value={unp}
              onChange={(event) => setUnp(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-address">Адрес</Label>
            <Input
              id="quick-org-address"
              value={postalAddress}
              onChange={(event) => setPostalAddress(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-email">Электронная почта</Label>
            <Input
              id="quick-org-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-phone">Телефон</Label>
            <Input
              id="quick-org-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-org-contact">Контактное лицо</Label>
            <Input
              id="quick-org-contact"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              className="min-h-11"
            />
          </div>
          {existing ? (
            <div className="grid gap-2 rounded-lg border p-3">
              <p className="text-sm">Уже есть организация «{existing.label}».</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onCreated(existing);
                  onClose();
                }}
              >
                Выбрать существующую
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !officialName.trim()}>
              {pending ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ObjectQuickCreateDialog({
  csrfToken,
  initialName,
  initialAddress,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  initialName: string;
  initialAddress: string;
  onClose: () => void;
  onCreated: (created: { id: string; label: string; address?: string | null }) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);
  const [pending, setPending] = useState(false);
  const [existing, setExisting] = useState<{
    id: string;
    label: string;
    address?: string | null;
  } | null>(null);

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) {
              return;
            }
            setPending(true);
            void (async () => {
              try {
                const created = await createPropertyObject(csrfToken, {
                  name,
                  address: address.trim() ? address : null,
                });
                toast.success('Объект добавлен');
                await queryClient.invalidateQueries({ queryKey: queryKeys.lookups });
                onCreated({ id: created.id, label: created.name, address: created.address });
                onClose();
              } catch (error) {
                if (error instanceof ApiError && error.status === 409 && error.existing) {
                  setExisting(error.existing);
                }
                toast.error(
                  error instanceof ApiError ? error.message : 'Не удалось создать объект',
                );
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>Добавить объект</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-object-name">Название объекта</Label>
            <Input
              id="quick-object-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-object-address">Адрес</Label>
            <Input
              id="quick-object-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="min-h-11"
            />
          </div>
          {existing ? (
            <div className="grid gap-2 rounded-lg border p-3">
              <p className="text-sm">Уже есть объект «{existing.label}».</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onCreated(existing);
                  onClose();
                }}
              >
                Выбрать существующий
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NamedQuickCreateDialog({
  csrfToken,
  title,
  nameLabel,
  initialName,
  path,
  successText,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  title: string;
  nameLabel: string;
  initialName: string;
  path: string;
  successText: string;
  onClose: () => void;
  onCreated: (created: { id: string; label: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [existing, setExisting] = useState<{ id: string; label: string } | null>(null);

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) {
              return;
            }
            setPending(true);
            void (async () => {
              try {
                const created = await commandFetch<{ id: string; name: string }>(path, {
                  method: 'POST',
                  csrfToken,
                  body: { name: name.trim() },
                });
                toast.success(successText);
                await queryClient.invalidateQueries({ queryKey: queryKeys.lookups });
                onCreated({ id: created.id, label: created.name });
                onClose();
              } catch (error) {
                if (error instanceof ApiError && error.status === 409 && error.existing) {
                  setExisting(error.existing);
                }
                toast.error(
                  error instanceof ApiError ? error.message : 'Не удалось создать запись',
                );
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-named">{nameLabel}</Label>
            <Input
              id="quick-named"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          {existing ? (
            <div className="grid gap-2 rounded-lg border p-3">
              <p className="text-sm">Уже есть запись «{existing.label}».</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onCreated(existing);
                  onClose();
                }}
              >
                Выбрать существующую
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RegisterEngineerDialog({
  csrfToken,
  initialName,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  initialName: string;
  onClose: () => void;
  onCreated: (created: { id: string; label: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState(initialName);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null);

  async function submit() {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      const response = await commandFetch<{
        user: { id: string; fullName: string };
        temporaryPassword: string;
      }>('/api/users', {
        method: 'POST',
        csrfToken,
        body: {
          fullName,
          email,
          role: 'RESPONSIBLE_ENGINEER',
        },
      });
      toast.success('Ответственный инженер зарегистрирован');
      await queryClient.invalidateQueries({ queryKey: queryKeys.lookups });
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
      setCreated({ id: response.user.id, label: response.user.fullName });
      setTemporaryPassword(response.temporaryPassword);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Не удалось зарегистрировать пользователя',
      );
    } finally {
      setPending(false);
    }
  }

  if (temporaryPassword && created) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            onCreated(created);
            onClose();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Временный пароль</DialogTitle>
            <DialogDescription>
              Временный пароль показывается один раз. Повторно показать пароль нельзя.
            </DialogDescription>
          </DialogHeader>
          <p className="temp-password rounded-lg bg-accent px-3 py-2 font-mono text-sm break-all">
            {temporaryPassword}
          </p>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                onCreated(created);
                onClose();
              }}
            >
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Зарегистрировать ответственного инженера</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-engineer-name">ФИО</Label>
            <Input
              id="quick-engineer-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quick-engineer-email">Электронная почта</Label>
            <Input
              id="quick-engineer-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !fullName.trim() || !email.trim()}>
              {pending ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
