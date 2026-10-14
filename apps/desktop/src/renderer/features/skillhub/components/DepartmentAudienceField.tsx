import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { SkillAudienceDepartment } from '../../../../shared/skillhubAudience';

type Props = {
  mode: 'all' | 'departments'; selected: string[]; disabled?: boolean;
  onChange: (mode: 'all' | 'departments', selected: string[]) => void;
  onValidityChange: (valid: boolean) => void;
};
export function departmentAncestors(id: string, parents: ReadonlyMap<string, string | null>): string[] {
  const result: string[] = [];
  let parent = parents.get(id);
  while (parent && parent !== id && !result.includes(parent)) {
    result.push(parent); parent = parents.get(parent);
  }
  return result;
}
export function DepartmentAudienceField({ mode, selected, disabled, onChange, onValidityChange }: Props) {
  const { t } = useTranslation();
  const radioName = useId();
  const [departments, setDepartments] = useState<SkillAudienceDepartment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    setStatus('loading');
    void window.electronAPI.skillhub.getMyDepts().then(result => {
      if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
      if (!result.success || !result.audienceSupported || !result.departments) { setStatus('error'); return; }
      setDepartments(result.departments); setStatus('ready');
    }).catch(() => { if (!cancelled && isDataOwnerGenerationCurrent(owner)) setStatus('error'); });
    return () => { cancelled = true; };
  }, [attempt]);
  const { byId, parents, childrenByParent } = useMemo(() => {
    const byId = new Map(departments.map(d => [d.id, d]));
    const parents = new Map(departments.map(d => [d.id, d.parentId]));
    const childrenByParent = new Map<string | null, SkillAudienceDepartment[]>();
    for (const d of departments) {
      const parent = d.parentId && byId.has(d.parentId) ? d.parentId : null;
      const children = childrenByParent.get(parent) ?? [];
      children.push(d); childrenByParent.set(parent, children);
    }
    return { byId, parents, childrenByParent };
  }, [departments]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const missing = selected.filter(id => !byId.has(id));
  useEffect(() => {
    onValidityChange(status === 'ready' && (mode === 'all' || (selected.length > 0 && selected.length <= 500 && missing.length === 0)));
  }, [status, mode, selected.length, missing.length, onValidityChange]);
  const rows = useMemo(() => {
    const visible = new Set<string>();
    if (query.trim()) {
      for (const d of departments.filter(d => d.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) {
        visible.add(d.id); for (const id of departmentAncestors(d.id, parents)) visible.add(id);
      }
    }
    const result: { department: SkillAudienceDepartment; depth: number; hasChildren: boolean }[] = [];
    const seen = new Set<string>();
    const visit = (d: SkillAudienceDepartment, depth: number) => {
      if (seen.has(d.id) || (query.trim() && !visible.has(d.id))) return;
      seen.add(d.id);
      const children = childrenByParent.get(d.id) ?? [];
      result.push({ department: d, depth, hasChildren: children.length > 0 });
      if (query.trim() || expanded.has(d.id)) children.forEach(child => visit(child, depth + 1));
    };
    (childrenByParent.get(null) ?? []).forEach(d => visit(d, 0));
    return result;
  }, [departments, expanded, query, parents, childrenByParent]);
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(value => value !== id)
      : [...selected.filter(value => !departmentAncestors(value, parents).includes(id)), id];
    onChange('departments', next);
  };
  return <fieldset disabled={disabled} className="flex flex-col gap-2 text-sm text-[var(--msg-assistant-text)]">
    <legend className="mb-2">{t('skillhub.audience.label')}</legend>
    <div className="rounded-xl border border-[var(--cmd-palette-border)] overflow-hidden">
      {(['all', 'departments'] as const).map(value => <div key={value} className={value === 'departments' ? 'border-t border-[var(--cmd-palette-border)]' : ''}>
        <label className="flex cursor-pointer items-center gap-2 p-3">
          <input type="radio" name={radioName} checked={mode === value} onChange={() => onChange(value, selected)} />
          {t(`skillhub.audience.${value}`)}
        </label>
        {value === 'departments' && mode === 'departments' && <div className="flex flex-col gap-2 pb-3 pl-8 pr-3">
          <input aria-label={t('skillhub.audience.search')} placeholder={t('skillhub.audience.search')}
            value={query} onChange={e => setQuery(e.target.value)}
            className="rounded-full border border-[var(--cmd-palette-border)] bg-transparent px-3 py-2" />
          <div className="flex flex-wrap gap-1">
            {selected.map(id => <Button key={id} variant="secondary" size="sm" type="button" onClick={() => toggle(id)}>
              {byId.get(id)?.name ?? t('skillhub.audience.unavailable')}
              <X size={12} aria-label={t('skillhub.audience.remove')} />
            </Button>)}
          </div>
          <div className="max-h-52 overflow-y-auto">
            {rows.map(({ department: d, depth, hasChildren }) => {
              const included = departmentAncestors(d.id, parents).some(id => selectedIds.has(id));
              return <div key={d.id} className="flex items-center gap-1 py-1" style={{ paddingInlineStart: depth * 16 }}>
                {hasChildren && <Tip text={t(expanded.has(d.id) ? 'skillhub.audience.collapse' : 'skillhub.audience.expand')}><Button variant="secondary" size="sm" type="button" aria-label={t(expanded.has(d.id) ? 'skillhub.audience.collapse' : 'skillhub.audience.expand')}
                  onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(d.id)) next.delete(d.id); else next.add(d.id); return next; })}>
                  {expanded.has(d.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </Button></Tip>}
                <label className="flex flex-1 items-center gap-2 cursor-pointer py-1">
                  <input type="checkbox" checked={included || selected.includes(d.id)} disabled={disabled || included} onChange={() => toggle(d.id)} />
                  {d.name}{included && <span className="text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.audience.included')}</span>}
                </label>
              </div>;
            })}
          </div>
          {selected.length > 500 && <p role="alert">{t('skillhub.audience.limit')}</p>}
          {status === 'ready' && (missing.length > 0 || selected.length === 0) && <p role="status">{t(missing.length ? 'skillhub.audience.invalid' : 'skillhub.audience.choose')}</p>}
        </div>}
      </div>)}
    </div>
    {status === 'loading' && <p role="status">{t('skillhub.audience.loading')}</p>}
    {status === 'error' && <div role="alert">{t('skillhub.audience.loadError')} <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('skillhub.audience.retry')}</Button></div>}
  </fieldset>;
}
