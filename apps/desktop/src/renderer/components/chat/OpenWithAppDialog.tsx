import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow } from 'lucide-react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';

export interface AppChoice {
  id: string;
  label: string;
  iconDataUrl?: string;
}

/** A one-time choice. It never writes a default association or starts discovery. */
export function OpenWithAppDialog({
  apps,
  onClose,
  onChoose,
  onRestoreFocus,
}: {
  apps: AppChoice[];
  onClose: () => void;
  onRestoreFocus: () => void;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const visible = apps.filter((app) =>
    app.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <ConfirmDialog
      presentation="standard"
      open
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onRestoreFocus();
      }}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('chat.markdownRenderer.appPicker.title')}
      description={t('chat.markdownRenderer.appPicker.description')}
      confirmText={t('chat.markdownRenderer.appPicker.open')}
      cancelText={t('chat.markdownRenderer.appPicker.cancel')}
      maxWidth={460}
      confirmDisabled={!visible.some((app) => app.id === selected)}
      onConfirm={() => {
        if (submitted.current || !visible.some((app) => app.id === selected)) return;
        submitted.current = true;
        onChoose(selected);
      }}
      content={
        <div className="flex flex-col gap-3">
          <Input
            inputRef={inputRef}
            aria-label={t('chat.markdownRenderer.appPicker.search')}
            placeholder={t('chat.markdownRenderer.appPicker.search')}
            value={search}
            onChange={setSearch}
          />
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="sr-only">{t('chat.markdownRenderer.appPicker.title')}</legend>
            {visible.map((app) => (
              <label
                key={app.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <input
                  type="radio"
                  name="open-with-app"
                  value={app.id}
                  checked={selected === app.id}
                  onChange={() => setSelected(app.id)}
                />
                {app.iconDataUrl ? (
                  <img src={app.iconDataUrl} className="h-4 w-4 shrink-0" alt="" />
                ) : (
                  <AppWindow className="h-4 w-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 break-words">{app.label}</span>
              </label>
            ))}
            {!visible.length && (
              <p className="text-13 text-[var(--text-secondary)]">
                {t(
                  apps.length
                    ? 'chat.markdownRenderer.appPicker.noMatch'
                    : 'chat.markdownRenderer.appPicker.empty',
                )}
              </p>
            )}
          </fieldset>
        </div>
      }
    />
  );
}
