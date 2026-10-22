import { Alert } from 'react-native';
import type { TFunction } from 'i18next';
import { normalizeScheduleList } from '@/scheduler/scheduleModel';
import type { RemoteSchedule } from '@/scheduler/types';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { sessionMayHaveScheduleRuns } from '@/session/scheduleIndex';

/**
 * 归档前的自动化提醒:绑定到已归档任务的自动化在下次触发时会被电脑暂停(持续会话除外,
 * 它会换绑新任务继续跑),归档前先让用户知道。已知未绑定的普通任务直接放行,不额外请求;
 * 读取失败或超过等待上限按无绑定处理。
 */
/** 查询自动化列表的等待上限:超时按「无绑定」处理,不让归档卡在远程请求上(通道超时预算可达 40 秒)。 */
export const SCHEDULE_LOOKUP_WAIT_MS = 1500;

function withLookupDeadline<T>(lookup: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), SCHEDULE_LOOKUP_WAIT_MS);
    lookup.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * 只取绑定投影(不含 prompt / 脚本等大字段):完整列表可能超过 device-link 帧限制,
 * 失败后被当成「无绑定」就会漏掉提醒。旧被控端忽略该参数,返回完整列表,行为不变。
 */
function listBindingSchedules(deviceId: string, invoke: RemoteInvoke): Promise<unknown> {
  return invoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }]);
}

function stopsWhenTargetArchived(schedule: RemoteSchedule): boolean {
  return schedule.status === 'active' && !schedule.persistentSession && !!schedule.targetSessionId;
}

export interface BulkArchiveCandidate {
  id: string;
  source?: string | null;
}

/** 与单条路径同一个快路径:索引已确认无绑定的任务不必查询。 */
export function anyMayHaveBoundSchedules(
  deviceId: string,
  candidates: readonly BulkArchiveCandidate[],
): boolean {
  return candidates.some((c) => sessionMayHaveScheduleRuns(deviceId, c.id, c.source));
}

/** 批量归档:所选任务里归档后会停掉自动化的任务数(最多一次列表请求;全部已知无绑定则不请求;失败按 0)。 */
export async function countSessionsWithActiveBoundSchedules(
  deviceId: string,
  invoke: RemoteInvoke,
  candidates: readonly BulkArchiveCandidate[],
): Promise<number> {
  if (!anyMayHaveBoundSchedules(deviceId, candidates)) return 0;
  try {
    const ids = new Set(candidates.map((c) => c.id));
    const bound = new Set(
      normalizeScheduleList(await withLookupDeadline(listBindingSchedules(deviceId, invoke), []))
        .filter((schedule) => stopsWhenTargetArchived(schedule) && ids.has(schedule.targetSessionId!))
        .map((schedule) => schedule.targetSessionId),
    );
    return bound.size;
  } catch {
    return 0;
  }
}

export async function loadActiveBoundScheduleNames({
  deviceId,
  invoke,
  sessionId,
  source,
}: {
  deviceId: string;
  invoke: RemoteInvoke;
  sessionId: string;
  source?: string | null;
}): Promise<string[]> {
  if (!sessionMayHaveScheduleRuns(deviceId, sessionId, source)) return [];
  try {
    const schedules = normalizeScheduleList(
      await withLookupDeadline(listBindingSchedules(deviceId, invoke), []),
    );
    return schedules
      .filter((schedule) => schedule.targetSessionId === sessionId && stopsWhenTargetArchived(schedule))
      .map((schedule) => schedule.name || schedule.id);
  } catch {
    return [];
  }
}

/** 有会停掉的自动化时弹系统确认;没有直接返回 true。 */
export function confirmArchiveWithSchedules(t: TFunction, names: readonly string[]): Promise<boolean> {
  if (names.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      t('session.menu.archiveScheduleConfirmTitle'),
      t('session.menu.archiveScheduleConfirmBody', {
        count: names.length,
        names: names
          .map((name) => t('session.menu.archiveScheduleName', { name }))
          .join(t('session.menu.archiveScheduleNameSeparator')),
      }),
      [
        { style: 'cancel', text: t('devices.common.cancel'), onPress: () => resolve(false) },
        { text: t('session.menu.archive'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
