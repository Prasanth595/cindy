/**
 * One 代输入 step as standard form controls, in screen order. The draft lives
 * only here; the parent remounts this form for every new revision, and a
 * successful submit clears it immediately.
 */

import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  InputHandoffAction,
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  autoCompleteFor,
  initialDraft,
  inputModeFor,
  inputTypeFor,
  interactiveControls,
} from './inputHandoffModel';

/** Decisions the step footer can send; `picture` switches this step to its screenshot. */
export type InputHandoffStepDecision = 'done' | 'cancel' | 'refresh' | 'decline' | 'picture';

type ButtonControl = Extract<InputHandoffControl, { kind: 'button' }>;
type TextControl = Extract<InputHandoffControl, { kind: 'text' }>;

export interface InputHandoffStepFormProps {
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  onDecide: (action: InputHandoffStepDecision) => void;
  onSubmit: (draft: InputHandoffValues, action: InputHandoffAction) => Promise<boolean>;
  /** First edit on this screen: this device starts handling the handoff. */
  onStart?: () => void;
}

export function InputHandoffStepForm({
  snapshot,
  busy,
  inputBlocked,
  onDecide,
  onSubmit,
  onStart,
}: InputHandoffStepFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<InputHandoffValues>(() => initialDraft(snapshot));
  const started = useRef(false);
  const set = (id: string, value: string | boolean) => {
    if (!started.current) {
      started.current = true;
      onStart?.();
    }
    setDraft((d) => ({ ...d, [id]: value }));
  };
  const disabled = busy || inputBlocked;

  const interactive = interactiveControls(snapshot);
  const buttons = interactive.filter((c): c is ButtonControl => c.kind === 'button');
  const fields = interactive.filter((c) => c.kind !== 'button');
  const primary = buttons.find((b) => b.primary);
  // A terminal prompt (sudo / ssh / git) is one answer to one program: no
  // screen to re-read, fill without confirming, or hand back.
  const terminal = Boolean(snapshot.command);

  const run = async (action: InputHandoffAction) => {
    if (disabled) return;
    // Drop the typed values from memory as soon as the Host has them.
    if (await onSubmit(draft, action)) setDraft({});
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (primary) void run({ kind: 'press', controlId: primary.id });
    else if (fields.length > 0) void run({ kind: 'submit' });
  };

  return (
    <form onSubmit={onFormSubmit} autoComplete="on" noValidate>
      {inputBlocked && (
        <p className="mb-3 text-12 text-[var(--text-secondary)]">{t('inputHandoff.remoteUnavailable')}</p>
      )}
      <div className="flex flex-col gap-3">
        {snapshot.controls.map((control) => {
          switch (control.kind) {
            case 'note':
              return <StepNote key={control.id} control={control} />;
            case 'text':
              return (
                <InputHandoffTextField
                  key={control.id}
                  control={control}
                  value={typeof draft[control.id] === 'string' ? (draft[control.id] as string) : ''}
                  disabled={disabled}
                  onChange={(v) => set(control.id, v)}
                />
              );
            case 'choice':
              return (
                <FormField key={control.id} label={control.label || t('inputHandoff.unnamedChoice')}>
                  {(field) => (
                    <Select
                      id={field.id}
                      label={control.label || t('inputHandoff.unnamedChoice')}
                      value={typeof draft[control.id] === 'string' ? (draft[control.id] as string) : ''}
                      options={control.options.map((o) => ({ value: o.id, label: o.label }))}
                      disabled={disabled}
                      onValueChange={(v) => set(control.id, v)}
                    />
                  )}
                </FormField>
              );
            case 'toggle':
              return (
                <label key={control.id} className="flex items-center justify-between gap-3 text-13">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{control.label}</span>
                  <Switch
                    checked={draft[control.id] === true}
                    disabled={disabled}
                    aria-label={control.label}
                    onCheckedChange={(v) => set(control.id, v === true)}
                  />
                </label>
              );
            default:
              return null;
          }
        })}
      </div>
      {interactive.length === 0 && (
        <p className="text-13 text-[var(--text-secondary)]">{t('inputHandoff.nothingToFill')}</p>
      )}
      {buttons.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {!terminal && <p className="text-12 text-[var(--text-tertiary)]">{t('inputHandoff.screenActions')}</p>}
          <div className="flex flex-wrap gap-2">
            {buttons.map((button) => (
              <Button
                key={button.id}
                type="button"
                size="sm"
                variant={button.primary ? 'primary' : 'secondary'}
                tone={button.link ? 'quiet' : 'default'}
                disabled={disabled}
                className="max-w-full"
                onClick={() => void run({ kind: 'press', controlId: button.id })}
              >
                <span className="truncate">{button.label || t('inputHandoff.unnamedButton')}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      <StepFooter
        busy={busy}
        disabled={disabled}
        terminal={terminal}
        showFill={buttons.length === 0 && fields.length > 0}
        onDecide={onDecide}
        onFill={() => void run({ kind: 'fill' })}
      />
    </form>
  );
}

function StepFooter({
  busy,
  disabled,
  terminal,
  showFill,
  onDecide,
  onFill,
}: {
  busy: boolean;
  disabled: boolean;
  terminal: boolean;
  showFill: boolean;
  onDecide: (action: InputHandoffStepDecision) => void;
  onFill: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] pt-3">
      <Button type="button" size="sm" variant="secondary" tone="quiet" disabled={busy} onClick={() => onDecide('cancel')}>
        {t('inputHandoff.action.cancel')}
      </Button>
      <Button type="button" size="sm" variant="secondary" tone="quiet" disabled={busy} onClick={() => onDecide('decline')}>
        {t('inputHandoff.action.decline')}
      </Button>
      {!terminal && (
        <Button type="button" size="sm" variant="secondary" tone="quiet" disabled={busy} onClick={() => onDecide('refresh')}>
          {t('inputHandoff.action.refresh')}
        </Button>
      )}
      {!terminal && (
        <Button type="button" size="sm" variant="secondary" tone="quiet" disabled={busy} onClick={() => onDecide('picture')}>
          {t('inputHandoff.action.picture')}
        </Button>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
        {!terminal && (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onDecide('done')}>
            {t('inputHandoff.action.done')}
          </Button>
        )}
        {showFill && (
          <>
            {!terminal && (
              <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={onFill}>
                {t('inputHandoff.action.fill')}
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={disabled}>
              {t('inputHandoff.action.submit')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function StepNote({ control }: { control: Extract<InputHandoffControl, { kind: 'note' }> }) {
  return (
    <p
      role={control.tone === 'error' ? 'alert' : undefined}
      className={cn(
        '[overflow-wrap:anywhere]',
        control.tone === 'heading' && 'text-14 font-semibold text-[var(--text-primary)]',
        control.tone === 'error' && 'text-13 text-[var(--error-fg)]',
        control.tone === 'info' && 'text-13 text-[var(--text-secondary)]',
      )}
    >
      {control.text}
    </p>
  );
}

/** One standard platform text / password field; also used by the screenshot step. */
export function InputHandoffTextField({
  control,
  value,
  disabled,
  onChange,
}: {
  control: TextControl;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const label = control.label || t(
    control.contentType === 'password' ? 'inputHandoff.passwordField'
      : control.contentType === 'one-time-code' ? 'inputHandoff.codeField'
      : 'inputHandoff.unnamedField',
  );
  const suggestions = control.suggestions ?? [];
  const listId = suggestions.length > 0 ? `input-handoff-${control.id}-options` : undefined;
  return (
    <FormField label={label} hint={control.filled ? t('inputHandoff.filledHint') : undefined}>
      {(field) =>
        control.multiline ? (
          <Textarea
            id={field.id}
            aria-describedby={field['aria-describedby']}
            value={value}
            placeholder={control.placeholder}
            disabled={disabled}
            rows={3}
            onChange={onChange}
          />
        ) : (
          <>
            {/* Standard platform field: no custom reveal, autofill hints intact. */}
            <Input
              id={field.id}
              aria-describedby={field['aria-describedby']}
              size="md"
              type={inputTypeFor(control)}
              name={control.contentType === 'text' ? control.id : control.contentType}
              autoComplete={autoCompleteFor(control)}
              inputMode={inputModeFor(control)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              list={listId}
              value={value}
              placeholder={control.placeholder}
              disabled={disabled}
              onChange={onChange}
            />
            {listId && (
              <datalist id={listId}>
                {suggestions.map((o) => (
                  <option key={o.id} value={o.label} />
                ))}
              </datalist>
            )}
          </>
        )
      }
    </FormField>
  );
}
