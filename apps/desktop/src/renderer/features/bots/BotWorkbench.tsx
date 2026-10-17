import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotGlance, GlanceRow } from '../../../shared/botAutonomy';
import { allowGlanceRow, canAllowGlanceRow, glanceSessionRoute, rebaseGlance, useBotGlance } from './botGlance';

/**
 * 伙伴工作台「一眼」（右侧栏的一个标签）。
 *
 * 只有两块 + 一行页脚，数据全部来自宿主的 glance 投影：
 * - 等你：一句问题（没有就用任务标题），一行「来源任务 · 电脑 · 等了多久」，下面是动作——
 *   带具体请求 id 的权限类「允许」直接回应那一条请求（别的电脑经 device-link 到那台）；回答类
 *   「回答」、出错类与没有请求 id 的确认类「看看」打开那件任务（别的电脑上的按设备打开）。
 * - 在做：标题 + 「电脑 · 做了多久」，最多先列 3 件；离线电脑上的变灰并写「离线」。
 * - 页脚：「刚看过一遍 · 今天做完 N 件 · X 离线」。两块都空时只说一句安静的话。
 * 负责所有任务的伙伴（scope = all）在顶部带「自动跟进所有任务」小标。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 「在做」先列几件，其余收进「还有 N 件」。 */
const WORKING_PREVIEW = 3;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function durationText(minutes: number, t: Translate): string {
  if (minutes < 1) return t('bots.workbench.glance.lessThanMinute');
  if (minutes < 60) return t('bots.workbench.glance.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('bots.workbench.glance.hours', { count: hours });
  return t('bots.workbench.glance.days', { count: Math.floor(hours / 24) });
}

function seenText(lastSweepAt: number, now: number, t: Translate): string {
  if (!Number.isFinite(lastSweepAt) || lastSweepAt <= 0) return t('bots.workbench.glance.notSeenYet');
  const minutes = Math.floor(Math.max(0, now - lastSweepAt) / 60_000);
  if (minutes < 1) return t('bots.workbench.glance.seenJust');
  if (minutes < 60) return t('bots.workbench.glance.seenMinutesAgo', { count: minutes });
  return t('bots.workbench.glance.seenHoursAgo', { count: Math.floor(minutes / 60) });
}

function listFormat(items: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'short', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

const join = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ');

interface RowContext {
  t: Translate;
  /** 自上次读到 glance 以来过去了几分钟，行上的时长按它往后推。 */
  elapsedMinutes: number;
  /** 有别的电脑上的任务时，每行都写电脑名。 */
  deviceLabel: (row: GlanceRow) => string | null;
  canNavigate: boolean;
  onOpen: (row: GlanceRow) => void;
}

export function BotWorkbench({
  botId,
  hostDeviceId = null,
}: {
  botId: string;
  sessionId?: string;
  /** 伙伴所在电脑；null = 这台。 */
  hostDeviceId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const devices = useDeviceLinkDeviceList();
  const self = devices?.find((device) => device.isSelf) ?? null;
  const hostDevice = hostDeviceId ? (devices?.find((device) => device.deviceId === hostDeviceId) ?? null) : null;
  const hostName = hostDevice?.name ?? null;
  const host = useMemo(
    () => ({ deviceId: hostDeviceId, deviceName: hostName, selfDeviceId: self?.deviceId ?? null }),
    [hostDeviceId, hostName, self?.deviceId],
  );
  const { glance: raw, failed, fetchedAt } = useBotGlance(botId, host);
  // 那台电脑不在设备清单里、离线、任一端关了远程控制，或最近一次读取失败：保留上一份内容，
  // 但经那台转来的行按离线显示（不能「允许」）。清单还没加载时只看读取结果。
  const hostControllable = devices === null
    || Boolean(hostDevice && hostDevice.online && hostDevice.remoteControlEnabled && hostDevice.controlEnabled);
  const hostOnline = !hostDeviceId || (hostControllable && !failed);
  const glance = useMemo<BotGlance | null>(
    () => (raw ? rebaseGlance(raw, { ...host, online: hostOnline }) : null),
    [raw, host, hostOnline],
  );
  const now = useNow(30_000);
  const canNavigate = !isSidebarWindow();

  const onOpen = useCallback(
    (row: GlanceRow) => {
      if (!canNavigate) return;
      const owner = getDataOwnerGeneration();
      void glanceSessionRoute(row)
        .then((route) => {
          if (isDataOwnerGenerationCurrent(owner)) navigate(route);
        })
        .catch(() => undefined);
    },
    [canNavigate, navigate],
  );

  if (!glance) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--surface)] px-5">
        {failed ? (
          <p role="status" className="text-center text-13 leading-[1.54] text-[var(--text-secondary)]">
            {t('bots.workbench.glance.loadFailed')}
          </p>
        ) : (
          <Spinner size={16} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
        )}
      </div>
    );
  }

  const rows = [...glance.waiting, ...glance.working];
  const showDevices = rows.some((row) => row.deviceId);
  const ctx: RowContext = {
    t,
    elapsedMinutes: fetchedAt > 0 ? Math.max(0, Math.floor((now - fetchedAt) / 60_000)) : 0,
    deviceLabel: (row) =>
      !showDevices ? null : row.deviceId ? row.deviceName : (self?.name ?? t('bots.workbench.glance.thisComputer')),
    canNavigate,
    onOpen,
  };
  const quiet = glance.waiting.length === 0 && glance.working.length === 0;
  const footer = [
    seenText(glance.lastSweepAt, now, t),
    glance.doneToday > 0 ? t('bots.workbench.glance.doneToday', { count: glance.doneToday }) : null,
    glance.offlineDevices.length > 0
      ? t('bots.workbench.glance.devicesOffline', { devices: listFormat(glance.offlineDevices, i18n.language) })
      : null,
  ];

  return (
    // 两块在中间滚动，页脚钉在面板底部：行再多也一直看得见「刚看过一遍 · 今天做完 N 件」。
    <section className="flex h-full min-h-0 flex-col bg-[var(--surface)]" aria-label={t('bots.workbench.title')}>
      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto overflow-x-hidden px-5 pb-6 pt-4">
        {glance.scope === 'all' ? (
          <p className="inline-flex h-6 items-center self-start rounded-full border border-[var(--border-default)] px-2.5 text-12 leading-4 text-[var(--text-secondary)]">
            {t('bots.autonomy.title')}
          </p>
        ) : null}
        {quiet ? (
          <p className="px-2 pt-8 text-center text-14 leading-[1.57] text-[var(--text-secondary)]">
            {t('bots.workbench.glance.quiet')}
          </p>
        ) : null}
        {glance.waiting.length > 0 ? <WaitingBlock rows={glance.waiting} ctx={ctx} /> : null}
        {glance.working.length > 0 ? <WorkingBlock rows={glance.working} ctx={ctx} /> : null}
      </div>
      <footer
        className={cn(
          'flex shrink-0 items-center gap-2 border-t border-[var(--border-default)] py-2.5 text-12 leading-[1.5] text-[var(--text-tertiary)]',
          quiet ? 'justify-center px-5' : 'pl-10 pr-5',
        )}
      >
        <span aria-hidden className="size-1 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
        <span className="min-w-0 truncate tabular-nums">{join(...footer)}</span>
      </footer>
    </section>
  );
}

function BlockHeading({ glyph, label, count }: { glyph: ReactNode; label: string; count: number }) {
  return (
    <h3 className="flex items-center gap-2 text-12 font-medium leading-4 text-[var(--text-secondary)]">
      <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">{glyph}</span>
      <span>{label}</span>
      <span className="font-normal tabular-nums text-[var(--text-tertiary)]">{count}</span>
    </h3>
  );
}

/** 行本体：标题 + 一行灰字；能跳转时整块可点（打开那件任务）。 */
function RowText({ row, title, meta, dim, ctx, titleId }: {
  row: GlanceRow;
  title: string;
  meta: string;
  dim?: boolean;
  ctx: RowContext;
  titleId?: string;
}) {
  const body = (
    <>
      <span
        id={titleId}
        className={cn(
          'line-clamp-2 text-15 leading-[1.47] [overflow-wrap:anywhere]',
          dim ? 'font-normal text-[var(--text-secondary)]' : 'font-medium text-[var(--text-primary)]',
        )}
      >
        {title}
      </span>
      {meta ? <span className="mt-0.5 block text-12 leading-[1.5] text-[var(--text-secondary)]">{meta}</span> : null}
    </>
  );
  if (!ctx.canNavigate) return <div className="px-2 py-1.5">{body}</div>;
  return (
    <button
      type="button"
      onClick={() => ctx.onOpen(row)}
      className="block w-full rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      {body}
    </button>
  );
}

function WaitingBlock({ rows, ctx }: { rows: GlanceRow[]; ctx: RowContext }) {
  return (
    <div className="flex flex-col gap-3">
      <BlockHeading
        glyph={<span className="size-2 rounded-full bg-[var(--card-status-awaiting)]" />}
        label={ctx.t('bots.workbench.glance.waiting')}
        count={rows.length}
      />
      <ul className="flex flex-col gap-3 pl-5">
        {rows.map((row) => <WaitingRow key={row.sessionId} row={row} ctx={ctx} />)}
      </ul>
    </div>
  );
}

function WaitingRow({ row, ctx }: { row: GlanceRow; ctx: RowContext }) {
  const { t } = ctx;
  const titleId = useId();
  const [allowing, setAllowing] = useState(false);
  const title = row.title || t('bots.workbench.untitled');
  const question = row.question?.trim() || title;
  const meta = join(
    question !== title ? title : null,
    ctx.deviceLabel(row),
    row.deviceId && !row.online ? t('bots.workbench.glance.offline') : null,
    t('bots.workbench.glance.waitedFor', { duration: durationText(row.minutes + ctx.elapsedMinutes, t) }),
  );
  const blocked = Boolean(row.deviceId) && !row.online;
  const allow = () => {
    if (allowing) return;
    setAllowing(true);
    void allowGlanceRow(row)
      .then((outcome) => {
        if (outcome === 'gone') ctx.onOpen(row);
        else if (outcome === 'blocked') toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
        else if (outcome === 'failed') toast.error(t('bots.workbench.glance.allowFailed'));
      })
      .catch(() => toast.error(t('bots.workbench.glance.allowFailed')))
      .finally(() => setAllowing(false));
  };
  return (
    <li className="-ml-2 flex flex-col">
      <RowText row={row} title={question} meta={meta} ctx={ctx} titleId={titleId} />
      <div className="mt-1 flex gap-2 pl-2">
        {canAllowGlanceRow(row) ? (
          <Button
            variant="secondary"
            size="xs"
            compact
            loading={allowing}
            disabled={blocked}
            aria-describedby={titleId}
            onClick={allow}
          >
            {t('bots.workbench.glance.allow')}
          </Button>
        ) : null}
        {ctx.canNavigate ? (
          <Button
            variant="secondary"
            size="xs"
            compact
            tone={row.waitingFor === 'answer' ? 'default' : 'quiet'}
            aria-describedby={titleId}
            onClick={() => ctx.onOpen(row)}
          >
            {t(row.waitingFor === 'answer' ? 'bots.workbench.glance.answer' : 'bots.workbench.glance.look')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function WorkingBlock({ rows, ctx }: { rows: GlanceRow[]; ctx: RowContext }) {
  const { t } = ctx;
  const [expanded, setExpanded] = useState(false);
  const hidden = rows.length - WORKING_PREVIEW;
  const visible = expanded || hidden <= 0 ? rows : rows.slice(0, WORKING_PREVIEW);
  return (
    <div className="flex flex-col gap-3">
      <BlockHeading
        glyph={<Spinner size={12} strokeWidth={2} className="text-[var(--text-tertiary)]" />}
        label={t('bots.workbench.glance.working')}
        count={rows.length}
      />
      <ul className="flex flex-col gap-2 pl-5">
        {visible.map((row) => {
          const offline = Boolean(row.deviceId) && !row.online;
          const meta = offline
            ? t('bots.workbench.glance.deviceOffline', { device: row.deviceName ?? '' })
            : join(ctx.deviceLabel(row), durationText(row.minutes + ctx.elapsedMinutes, t));
          return (
            <li key={row.sessionId} className="-ml-2">
              <RowText row={row} title={row.title || t('bots.workbench.untitled')} meta={meta} dim={offline} ctx={ctx} />
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <Button
          variant="secondary"
          size="xs"
          compact
          tone="quiet"
          className="ml-2 self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('bots.workbench.glance.less') : t('bots.workbench.glance.more', { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}
