import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { PluginPublisherBadge } from './PluginPublisherBadge';
import { PluginSharedUsage } from './PluginSharedUsage';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronRight, Plus, RotateCw } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import type { GhostPluginListItem } from './lib/ghostPluginViewModel';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import { AccountSwitcherDialog } from '@/components/sidebar/AccountSwitcherDialog';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PluginVersionFacts } from './PluginVersionFacts';
import { useAuth } from '@/contexts/AuthContext';
import { usePluginReviewUpdates } from '@/contexts/PluginReviewUpdatesContext';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { contributionErrorKey, useContributionPreview } from './lib/useContributionPreview';
export { contributionErrorKey } from './lib/useContributionPreview';
import type {
  PluginContributionsApi,
  ContributionReleaseView,
  MyPluginDetailView,
  MyPluginFilter,
  MyPluginPageView,
  MyPluginReleasePageView,
  MyPluginView,
  PreparedPluginContribution,
} from '../../../shared/pluginContributions';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PLUGIN_MANAGEMENT_FRAME_CLASS, PluginManagementPage } from './PluginManagementLayout';
import { GhostPluginIcon } from './GhostPluginIcon';
import { usePluginMarketForegroundRefresh } from './lib/usePluginMarketForegroundRefresh';

const copy = 'settings.ghosts.contribution';
const releaseKey = (release: ContributionReleaseView) =>
  JSON.stringify([release.releaseId, release.revision, release.sha256, release.submissionId]);

export interface MyPluginsPageCache {
  ownerKey?: string;
  query?: string;
  filter?: MyPluginFilter;
  page?: MyPluginPageView | null;
  detail?: MyPluginDetailView | null;
  /** In-memory binding of this cached detail to the last Main association read. */
  installationRevision?: string;
  scroll?: number;
  selectedRelease?: { pluginId: string; key: string };
}

export interface PluginSubmitOptions {
  prepared?: PreparedPluginContribution;
  /** Closing/reopening the picker must not let an old completion navigate. */
  isCurrent?: () => boolean;
}

/** Kept independent of transport DTOs; the Host supplies an owner-fenced read projection. */
export function MyPluginsPage({
  reader,
  localPlugins,
  installedPluginCount,
  onSubmitUpdate,
  onPrepare,
  onViewLocal,
  cache,
  renderVersionFacts,
  onInstallPublished,
  onReadPublished,
  submitBusy = false,
  submissionRevision = 0,
  installedRevision,
}: {
  reader: PluginContributionsApi;
  localPlugins: readonly GhostPluginListItem[];
  installedPluginCount: number;
  cache: MyPluginsPageCache;
  onSubmitUpdate: (instanceId: string, options?: PluginSubmitOptions) => Promise<boolean>;
  onPrepare?: (instanceId: string) => Promise<PreparedPluginContribution>;
  renderVersionFacts?: (plugin: MyPluginView) => ReactNode;
  onInstallPublished?: (pluginId: string) => Promise<void>;
  onReadPublished?: (pluginId: string) => Promise<PluginMarketDetail>;
  submitBusy?: boolean;
  submissionRevision?: number;
  installedRevision?: string;
  onViewLocal: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { dataOwnerId, dataOwnerGeneration, user, mode } = useAuth();
  const ownerKey = JSON.stringify([dataOwnerId, dataOwnerGeneration, user?.id, mode]);
  const navigate = useNavigate();
  const location = useLocation();
  const signIn = useSignInToCindy(`${location.pathname}${location.search}`);
  const [pickerOwner, setPickerOwner] = useState<string | null>(null);
  const pickerStatusId = useId();
  const [pickerSelection, setPickerSelection] = useState<string | null>(null);
  const [pickerRefresh, setPickerRefresh] = useState(0);
  const [pickerPlugins, setPickerPlugins] = useState<{
    key: string; plugins: MyPluginView[]; failure?: string;
  } | null>(null);
  const [updateRefresh, setUpdateRefresh] = useState(0);
  const preparePreview = onPrepare ?? reader.prepare;
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const { confirm } = useConfirmDialog();
  const reviewUpdates = usePluginReviewUpdates();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [publishedContent, setPublishedContent] = useState<{
    key: string; value: PluginMarketDetail | null; loading: boolean;
  } | null>(null);
  const publishedRequest = useRef(0);
  const [historyOpenKey, setHistoryOpenKey] = useState<string | null>(null);
  const [cancelResult, setCancelResult] = useState<{
    owner: string;
    pluginId: string;
    releaseId: string;
    cancelled: boolean;
  } | null>(null);
  const cancelling = useRef<symbol | null>(null);
  const saved = cache.ownerKey === ownerKey ? cache : {};
  const [installationRead, setInstallationRead] = useState<{ owner: string; pluginId: string; revision?: string } | null>(() =>
    saved.detail && saved.installationRevision !== undefined
      ? { owner: ownerKey, pluginId: saved.detail.plugin.pluginId, revision: saved.installationRevision } : null);
  const [loadedOwner, setLoadedOwner] = useState(ownerKey);
  const ownerMatches = loadedOwner === ownerKey;
  const [storedSnapshots, setSnapshots] = useState<Record<string, ContributionReleaseView>>({});
  const [storedSnapshotLoading, setSnapshotLoading] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('contribution');
  const [selectedRelease, setSelectedRelease] = useState(saved.selectedRelease);
  const [versionPage, setVersionPage] = useState<
    (MyPluginReleasePageView & { pluginId: string }) | null
  >(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionFailure, setVersionFailure] = useState<string | null>(null);
  const versionRequest = useRef(0);
  const snapshotRequest = useRef(0);
  const selectedPlugin = useRef(selectedId);
  selectedPlugin.current = selectedId;
  const [storedQuery, setQuery] = useState(saved.query ?? '');
  const [storedFilter, setFilter] = useState<MyPluginFilter>(saved.filter ?? 'all');
  const [storedPage, setPage] = useState<MyPluginPageView | null>(saved.page ?? null);
  const [listInstallationRead, setListInstallationRead] = useState<string | null>(null);
  const [storedDetail, setDetail] = useState<MyPluginDetailView | null>(saved.detail ?? null);
  const [storedFailure, setFailure] = useState<string | null>(null);
  const [storedLoading, setLoading] = useState(false);
  // Cached history remains readable; write controls require a successful current
  // detail read in this mount/owner/install generation, never a cached grant.
  const [writeRead, setWriteRead] = useState<string | null>(null);
  const [localRead, setLocalRead] = useState<string | null>(null);
  const writeKey = JSON.stringify([ownerKey, selectedId, installedRevision]);
  const currentWriteKey = useRef(writeKey);
  currentWriteKey.current = writeKey;
  const historyOpen = historyOpenKey === JSON.stringify([ownerKey, selectedId]);
  const writeReady = writeRead === writeKey && navigator.onLine;
  const snapshots = ownerMatches ? storedSnapshots : {};
  const snapshotLoading = ownerMatches ? storedSnapshotLoading : null;
  const query = ownerMatches ? storedQuery : '';
  const filter = ownerMatches ? storedFilter : 'all';
  const page = ownerMatches ? storedPage : null;
  const detail = ownerMatches ? storedDetail : null;
  const failure = ownerMatches ? storedFailure : null;
  const loading = ownerMatches && storedLoading;
  const request = useRef(0);
  const mounted = useRef(true);
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const lastRefresh = useRef(0);
  const listScroll = useRef(saved.scroll ?? 0);
  const pageKey = useRef(JSON.stringify([query, filter]));
  const scrollFrame = useRef<HTMLElement>(null);
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const contributor = mode === 'cloud' && (user?.membershipKind === 'personal' || user?.membershipKind === 'org');
  const pickerOpen = contributor && ownerMatches && pickerOwner === ownerKey && !selectedId;
  const pickerReadKey = JSON.stringify([ownerKey, installedRevision, submissionRevision]);
  const pickerRead = pickerPlugins?.key === pickerReadKey ? pickerPlugins : null;
  const pickerReady = Boolean(pickerRead && !pickerRead.failure);
  const pickerItem = localPlugins.find(item => item.id === pickerSelection);
  const pickerVersion = pickerItem?.version;
  const pickerKey = JSON.stringify([ownerKey, location.key, pickerOpen, pickerSelection,
    pickerVersion, installedRevision, pickerRefresh]);
  const pickerContext = useRef({ key: pickerKey, token: {} });
  if (pickerContext.current.key !== pickerKey) pickerContext.current = { key: pickerKey, token: {} };
  const currentPickerDraft = useContributionPreview(pickerKey,
    pickerOpen && pickerVersion !== undefined ? pickerSelection ?? undefined : undefined,
    pickerVersion, preparePreview, reader.discard);
  const pickerBlocker = currentPickerDraft?.prepared?.preflight?.blockers[0];
  const pickerUnavailable = (local: GhostPluginListItem) => {
    const plugin = pickerRead?.plugins.find(item => item.localInstanceId === local.id);
    if (!plugin) return null;
    if (plugin.publisherKind === 'official') return `${copy}.unavailable.officialGithubRequired`;
    if (!plugin.actions.submitUpdate) return `${copy}.permissionDenied`;
    if (plugin.latestSubmission?.reviewStatus === 'pending' && plugin.latestSubmission.revisionState === 'current')
      return `${copy}.errors.PLUGIN_PENDING_RELEASE_EXISTS`;
    if (plugin.market.version === local.version || plugin.latestSubmission?.version === local.version)
      return `${copy}.errors.VERSION_ALREADY_SUBMITTED`;
    return null;
  };
  const selectedPickerUnavailable = pickerItem ? pickerUnavailable(pickerItem) : null;

  useEffect(() => {
    let disposed = false;
    setPickerPlugins(null);
    if (!pickerOpen || !localPlugins.length) return;
    // Read version facts once for this dialog, independently of the list's search
    // and pagination. Do not prepare packages just to render the choices.
    void (async () => {
      const plugins: MyPluginView[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await reader.list({ query: '', filter: 'all', cursor });
        if (disposed) return;
        plugins.push(...page.plugins);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated contribution cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      setPickerPlugins({ key: pickerReadKey, plugins });
    })().catch(error => {
      if (!disposed) setPickerPlugins({ key: pickerReadKey, plugins: [], failure: contributionErrorKey(error) });
    });
    return () => { disposed = true; };
  }, [pickerOpen, pickerReadKey, reader, localPlugins.length]);

  useEffect(() => { setPickerOwner(null); }, [selectedId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
      versionRequest.current++;
      snapshotRequest.current++;
      publishedRequest.current++;
    };
  }, []);
  useEffect(() => {
    if (!ownerMatches || (cache.ownerKey !== ownerKey && cache.ownerKey !== undefined)) {
      request.current++;
      setPage(null);
      setDetail(null);
      setInstallationRead(null);
      setFailure(null);
      setPickerOwner(null);
      setPublishedContent(null);
      setHistoryOpenKey(null);
      setSnapshots({});
      setVersionPage(null);
      setSelectedRelease(undefined);
      setVersionsLoading(false);
      setVersionFailure(null);
      cancelling.current = null;
      setCancelBusy(false);
      setCancelResult(null);
      versionRequest.current++;
      snapshotRequest.current++;
      setSnapshotLoading(null);
      setLoading(false);
      setQuery('');
      setFilter('all');
      listScroll.current = 0;
      Object.assign(cache, {
        query: '',
        filter: 'all',
        page: null,
        detail: null,
        installationRevision: undefined,
        scroll: 0,
        selectedRelease: undefined,
      });
    }
    cache.ownerKey = ownerKey;
    setLoadedOwner(ownerKey);
  }, [ownerKey, ownerMatches, cache]);
  useEffect(() => {
    if (ownerMatches && cache.ownerKey === ownerKey)
      Object.assign(cache, {
        query,
        filter,
        page,
        detail,
        installationRevision: installationRead?.owner === ownerKey && installationRead.pluginId === detail?.plugin.pluginId
          ? installationRead.revision : undefined,
        scroll: listScroll.current,
        selectedRelease,
      });
  }, [cache, ownerKey, ownerMatches, query, filter, page, detail, selectedRelease, installationRead]);

  const refresh = useCallback(
    async (cursor?: string) => {
      if (!contributor || !ownerMatches) return;
      const id = ++request.current;
      const owner = ownerKey;
      setLoading(true);
      setWriteRead(null);
      try {
        if (selectedId) {
          const result = await reader.detail(selectedId, cursor);
          if (!mounted.current || request.current !== id || currentOwner.current !== owner) return;
          setInstallationRead({ owner, pluginId: selectedId, revision: installedRevision });
          setWriteRead(JSON.stringify([owner, selectedId, installedRevision]));
          setLocalRead(JSON.stringify([owner, selectedId, installedRevision]));
          setDetail((previous) =>
            cursor && previous?.plugin.pluginId === selectedId
              ? {
                  ...result,
                  history: [...previous.history, ...result.history].filter(
                    (item, index, all) =>
                      all.findIndex((entry) => entry.eventId === item.eventId) === index,
                  ),
                }
              : result,
          );
        } else {
          const result = await reader.list({ query, filter, ...(cursor ? { cursor } : {}) });
          if (!mounted.current || request.current !== id || currentOwner.current !== owner) return;
          setListInstallationRead(JSON.stringify([owner, installedRevision]));
          setPage((previous) =>
            cursor && previous
              ? {
                  ...result,
                  plugins: [...previous.plugins, ...result.plugins].filter(
                    (item, index, all) =>
                      all.findIndex((entry) => entry.pluginId === item.pluginId) === index,
                  ),
                }
              : result,
          );
        }
        lastRefresh.current = Date.now();
        void reviewUpdates.refresh();
        setFailure(null);
      } catch (error) {
        if (mounted.current && request.current === id && currentOwner.current === owner) {
          setLocalRead(null);
          setListInstallationRead(null);
          setFailure(contributionErrorKey(error));
        }
      } finally {
        if (mounted.current && request.current === id && currentOwner.current === owner)
          setLoading(false);
      }
    },
    [reader, selectedId, query, filter, ownerKey, contributor, ownerMatches, reviewUpdates.refresh, installedRevision],
  );

  useEffect(() => {
    // Invalidate old requests immediately when the search changes; do not show a
    // previous query as if it were the result of the new server-side filter.
    request.current++;
    const nextKey = JSON.stringify([query, filter]);
    if (pageKey.current !== nextKey) {
      setPage(null);
      listScroll.current = 0;
      pageKey.current = nextKey;
    }
    if (!selectedId) {
      /* Retain this account's list while returning from a detail. */
    } else setDetail((current) => (current?.plugin.pluginId === selectedId ? current : null));
    const timer = window.setTimeout(() => void refresh(), query ? 200 : 0);
    return () => {
      window.clearTimeout(timer);
      request.current++;
    };
  }, [refresh, selectedId, query, filter, submissionRevision]);
  const loadVersions = useCallback(
    async (cursor?: string) => {
      if (!selectedId || !contributor || !ownerMatches) return;
      const sequence = ++versionRequest.current,
        owner = ownerKey,
        pluginId = selectedId;
      setVersionsLoading(true);
      try {
        const result = await reader.releases(pluginId, cursor);
        if (
          !mounted.current ||
          currentOwner.current !== owner ||
          selectedPlugin.current !== pluginId ||
          versionRequest.current !== sequence
        )
          return;
        setVersionPage((previous) => ({
          ...result,
          pluginId,
          releases: (cursor && previous?.pluginId === pluginId
            ? [...previous.releases, ...result.releases]
            : result.releases
          ).filter(
            (release, index, all) =>
              all.findIndex((candidate) => releaseKey(candidate) === releaseKey(release)) === index,
          ),
        }));
        setVersionFailure(null);
      } catch (error) {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          versionRequest.current === sequence
        )
          setVersionFailure(contributionErrorKey(error));
      } finally {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          versionRequest.current === sequence
        )
          setVersionsLoading(false);
      }
    },
    [selectedId, contributor, ownerMatches, ownerKey, reader],
  );
  useEffect(() => {
    setVersionFailure(null);
    setSnapshotLoading(null);
    void loadVersions();
    return () => {
      versionRequest.current++;
      snapshotRequest.current++;
    };
  }, [loadVersions, submissionRevision]);
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), loadVersions()]);
  }, [refresh, loadVersions]);
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  const reviewSignature = reviewUpdates.updates.map(item => item.key).sort().join('|');
  const lastReviewRefresh = useRef('');
  useEffect(() => {
    const signature = `${ownerKey}:${reviewSignature}`;
    if (!reviewSignature || lastReviewRefresh.current === signature) return;
    lastReviewRefresh.current = signature;
    void refreshAll();
  }, [ownerKey, reviewSignature, refreshAll]);
  useEffect(() => { setInstallBusy(false); }, [ownerKey, selectedId]);
  useEffect(() => { setHistoryOpenKey(null); }, [ownerKey, selectedId]);
  usePluginMarketForegroundRefresh(refreshAll, lastRefresh);
  useEffect(() => {
    const online = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('online', online);
    const offline = () => setWriteRead(null);
    window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [refreshAll]);
  useLayoutEffect(() => {
    if (!selectedId && scrollFrame.current)
      scrollFrame.current.scrollTop = listScroll.current;
  }, [selectedId, page]);

  const loadSnapshot = useCallback(
    async (submissionId: string) => {
      if (!selectedId) return;
      const owner = ownerKey,
        pluginId = selectedId,
        sequence = ++snapshotRequest.current;
      setSnapshotLoading(submissionId);
      try {
        const result = await reader.submission(selectedId, submissionId);
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          snapshotRequest.current === sequence
        )
          setSnapshots((previous) => ({ ...previous, [submissionId]: result }));
      } catch (error) {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          selectedPlugin.current === pluginId &&
          snapshotRequest.current === sequence
        )
          setFailure(contributionErrorKey(error));
      } finally {
        if (
          mounted.current &&
          currentOwner.current === owner &&
          snapshotRequest.current === sequence
        )
          setSnapshotLoading(null);
      }
    },
    [selectedId, ownerKey, reader],
  );

  const back = () => {
    if (selectedId) {
      const next = new URLSearchParams(params);
      next.delete('contribution');
      next.delete('contributionTransfer');
      setParams(next, { replace: true });
    } else onViewLocal();
  };
  const openDetail = (pluginId: string) => {
    if (scrollFrame.current) listScroll.current = scrollFrame.current.scrollTop;
    cache.scroll = listScroll.current;
    const next = new URLSearchParams(params);
    next.set('contribution', pluginId);
    next.delete('contributionTransfer');
    setParams(next);
  };
  const timestamp = selectedId ? detail?.queriedAt : page?.queriedAt;
  const formatDate = (value: string | null) =>
    value
      ? new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language)
      : t(`${copy}.timeUnavailable`);
  const status = (release: ContributionReleaseView, plugin?: MyPluginView) =>
    t(
      `${copy}.review.${
        release.reviewStatus === 'approved' &&
        plugin?.market.state === 'available' &&
        plugin.market.releaseId === release.releaseId
          ? 'published'
          : (release.reviewStatus ?? release.revisionState)
      }`,
    );

  const releaseContent = (release: ContributionReleaseView) => (
    <>
      {release.content ? (
        <div className="space-y-3 text-14 leading-6 text-[var(--text-primary)]">
          <div className="flex items-center gap-3">
            <GhostPluginIcon
              iconDataUrl={release.content.iconUrl ?? undefined}
              iconId={release.releaseId}
              iconName={release.content.name}
            />
            <p className="font-medium">{release.content.name}</p>
          </div>
          <p className="whitespace-pre-wrap break-words">{release.content.description}</p>
          {release.content.permissions.length > 0 ? (
            <ul className="list-inside list-disc">
              {release.content.permissions.map((permission) => (
                <li key={permission.key}>
                  {t(`settings.ghosts.perm.${permission.labelKey}`, permission.labelArgs)}
                  {permission.detailKey ? (
                    <p className="text-13 text-[var(--text-secondary)]">
                      {t(`settings.ghosts.perm.${permission.detailKey}`, permission.detailArgs)}
                    </p>
                  ) : null}
                  {permission.detail ? (
                    <p className="whitespace-pre-wrap text-13 text-[var(--text-secondary)]">
                      {permission.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="text-13 text-[var(--text-secondary)]">{t(`${copy}.snapshotUnavailable`)}</p>
      )}
      <p className="mt-3 text-12 text-[var(--text-secondary)]">
        {formatDate(release.submittedAt)}
        {release.source
          ? ` · ${t(`${copy}.source.${release.source}`, { defaultValue: t(`${copy}.source.unknown`) })}`
          : ''}
      </p>
      <details className="mt-3 text-12 text-[var(--text-secondary)]">
        <summary className="cursor-pointer select-none">{t(`${copy}.technicalDetails`)}</summary>
        <dl className="mt-2 space-y-1 break-all">
          <dt>{t(`${copy}.releaseSha`)}</dt>
          <dd>{release.sha256}</dd>
          {release.uploadedSha256 ? (
            <>
              <dt>{t(`${copy}.uploadedSha`)}</dt>
              <dd>{release.uploadedSha256}</dd>
            </>
          ) : null}
          <dt>{t(`${copy}.releaseId`)}</dt>
          <dd>{release.releaseId}</dd>
          <dt>{t(`${copy}.revision`)}</dt>
          <dd>{release.revision}</dd>
        </dl>
        {release.content ? (
          <pre className="mt-3 whitespace-pre-wrap break-words">
            {JSON.stringify(release.content.manifestView, null, 2)}
          </pre>
        ) : null}
      </details>
    </>
  );

  const currentDetail = detail?.plugin.pluginId === selectedId ? detail : null;
  const plugin = currentDetail?.plugin;
  // A cached author detail must not select a replacement installation before Main
  // has rechecked its exact source and approval in this installation generation.
  const installationIsCurrent = installedRevision === undefined ||
    (installationRead?.owner === ownerKey && installationRead.pluginId === selectedId &&
      installationRead.revision === installedRevision);
  const localInstallation = installationIsCurrent && localRead === writeKey && navigator.onLine
    ? plugin?.localInstallation : undefined;
  const installedLocal = localInstallation?.state === 'installed' ? localInstallation : null;
  const publishedKey = JSON.stringify([writeKey, plugin?.market.releaseId, plugin?.market.version]);
  useEffect(() => {
    const sequence = ++publishedRequest.current;
    if (!plugin || plugin.market.state !== 'available' || !plugin.market.releaseId || !onReadPublished) {
      setPublishedContent(null);
      return;
    }
    const key = publishedKey, expected = plugin.market, pluginId = plugin.pluginId, requestKey = writeKey;
    setPublishedContent(previous => ({ key, value: previous?.key === key ? previous.value : null, loading: true }));
    void onReadPublished(pluginId).then(value => {
      if (!mounted.current || publishedRequest.current !== sequence || currentWriteKey.current !== requestKey) return;
      const exact = value.pluginId === pluginId && value.releaseId === expected.releaseId &&
        value.version === expected.version && value.sourceType === 'server' && value.scope === 'public';
      setPublishedContent({ key, value: exact ? value : null, loading: false });
    }).catch(() => {
      if (mounted.current && publishedRequest.current === sequence && currentWriteKey.current === requestKey)
        setPublishedContent({ key, value: null, loading: false });
    });
    return () => { publishedRequest.current++; };
  }, [publishedKey, onReadPublished, plugin, currentDetail?.queriedAt, writeKey]);
  const candidates =
    ownerMatches && versionPage?.pluginId === selectedId ? versionPage.releases : [];
  const latest = plugin?.latestSubmission ? [plugin.latestSubmission] : [];
  const unreadReview = reviewUpdates.updates.find(item => item.pluginId === selectedId && item.unread);
  const unreadRelease = unreadReview && [...latest, ...candidates].find(item =>
    item.releaseId === unreadReview.releaseId && item.sha256 === unreadReview.sha256 && item.revision === unreadReview.revision);
  const detailIsNewer =
    !versionPage || Date.parse(currentDetail?.queriedAt ?? '') >= Date.parse(versionPage.queriedAt);
  const releases = (detailIsNewer ? [...latest, ...candidates] : [...candidates, ...latest]).filter(
    (release, index, all) =>
      all.findIndex((entry) => releaseKey(entry) === releaseKey(release)) === index,
  );
  const selectedSummary =
    (selectedRelease?.pluginId === selectedId
      ? releases.find((release) => releaseKey(release) === selectedRelease.key)
      : null) ??
    unreadRelease ??
    releases.find(
      (release) =>
        plugin?.latestSubmission && releaseKey(release) === releaseKey(plugin.latestSubmission),
    ) ??
    releases[0];
  const snapshot = selectedSummary?.submissionId ? snapshots[selectedSummary.submissionId] : null;
  const shownRelease =
    selectedSummary && snapshot && releaseKey(snapshot) === releaseKey(selectedSummary)
      ? { ...selectedSummary, content: snapshot.content }
      : selectedSummary &&
          plugin?.latestSubmission &&
          releaseKey(plugin.latestSubmission) === releaseKey(selectedSummary)
        ? { ...selectedSummary, content: plugin.latestSubmission.content }
        : selectedSummary;
  const selectedKey = selectedSummary ? releaseKey(selectedSummary) : null;
  const snapshotId = selectedSummary?.submissionId;
  const hasContent = Boolean(shownRelease?.content);
  const visibleRelease = historyOpen ? shownRelease : plugin?.latestSubmission;
  const visibleReview = unreadReview && visibleRelease && currentDetail &&
    visibleRelease.releaseId === unreadReview.releaseId && visibleRelease.sha256 === unreadReview.sha256 &&
    visibleRelease.revision === unreadReview.revision && visibleRelease.reviewStatus === unreadReview.status &&
    visibleRelease.reviewedAt === unreadReview.decidedAt ? unreadReview : null;
  const visibleReviewKey = visibleReview?.key;
  const visibleReviewPlugin = visibleReview?.pluginId;
  const visibleReleaseKey = visibleRelease ? releaseKey(visibleRelease) : null;
  useEffect(() => {
    if (!visibleReviewKey || !visibleReviewPlugin || !visibleReleaseKey || document.visibilityState !== 'visible') return;
    // Keep the exact result selected after acknowledging it; do not jump to a newer pending version.
    setSelectedRelease(previous => previous?.pluginId === visibleReviewPlugin && previous.key === visibleReleaseKey
      ? previous : { pluginId: visibleReviewPlugin, key: visibleReleaseKey });
    void reviewUpdates.markRead(visibleReviewPlugin, visibleReviewKey);
  }, [visibleReviewKey, visibleReviewPlugin, visibleReleaseKey, reviewUpdates.markRead]);
  const openUnreadResult = async () => {
    if (!unreadReview) return;
    const target = unreadReview, owner = ownerKey, sequence = ++versionRequest.current;
    setVersionsLoading(true);
    try {
      const collected: ContributionReleaseView[] = [];
      let cursor: string | undefined;
      for (;;) {
        const result = await reader.releases(target.pluginId, cursor);
        if (!mounted.current || currentOwner.current !== owner || selectedPlugin.current !== target.pluginId ||
          versionRequest.current !== sequence) return;
        collected.push(...result.releases);
        const match = collected.find(item => item.releaseId === target.releaseId && item.sha256 === target.sha256 &&
          item.revision === target.revision);
        if (match || !result.nextCursor) {
          setVersionPage({ ...result, pluginId: target.pluginId, releases: collected });
          if (match) {
            setSelectedRelease({ pluginId: target.pluginId, key: releaseKey(match) });
            setHistoryOpenKey(JSON.stringify([owner, target.pluginId]));
            setVersionFailure(null);
          } else setVersionFailure(`${copy}.loadFailed`);
          return;
        }
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (mounted.current && currentOwner.current === owner && versionRequest.current === sequence)
        setVersionFailure(contributionErrorKey(error));
    } finally {
      if (mounted.current && currentOwner.current === owner && versionRequest.current === sequence)
        setVersionsLoading(false);
    }
  };
  const latestSnapshot = plugin?.latestSubmission?.submissionId ? snapshots[plugin.latestSubmission.submissionId] : null;
  const currentSubmission = plugin?.latestSubmission && latestSnapshot && releaseKey(latestSnapshot) === releaseKey(plugin.latestSubmission)
    ? { ...plugin.latestSubmission, content: latestSnapshot.content } : plugin?.latestSubmission;
  const visibleSnapshotId = historyOpen ? snapshotId : currentSubmission?.submissionId;
  const visibleHasContent = historyOpen ? hasContent : Boolean(currentSubmission?.content);
  useEffect(() => {
    snapshotRequest.current++;
    setSnapshotLoading(null);
    if (visibleSnapshotId && !visibleHasContent) void loadSnapshot(visibleSnapshotId);
  }, [selectedKey, visibleSnapshotId, visibleHasContent, loadSnapshot, historyOpen]);
  const isDetail = Boolean(selectedId);
  const listEmpty = page?.plugins.length === 0;
  const rowAction = (
    <span className="my-plugins-chevron inline-flex items-center justify-end gap-1 text-13 text-[var(--text-secondary)]">
      {t(`${copy}.versionManagement`)}
      <ChevronRight size={16} className="shrink-0" aria-hidden="true" />
    </span>
  );
  const cancelReview = async (plugin: MyPluginView, release: ContributionReleaseView) => {
    if (cancelling.current || !writeReady || !plugin.actions.submitUpdate || !release.canCancelReview || !navigator.onLine) return;
    const owner = ownerKey;
    const cancellation = Symbol('cancel-review');
    cancelling.current = cancellation;
    setCancelBusy(true);
    try {
      const accepted = await confirm({
        title: t(`${copy}.cancelReviewTitle`, { name: plugin.name, version: release.version }),
        description: t(`${copy}.cancelReviewDescription`, { version: release.version }),
        confirmText: t(`${copy}.cancelReview`),
        cancelText: t(`${copy}.keepReview`),
      });
      if (
        !accepted ||
        !mounted.current ||
        currentOwner.current !== owner ||
        selectedPlugin.current !== plugin.pluginId
      )
        return;
      const result = await reader.cancelReview(plugin.pluginId, {
        releaseId: release.releaseId,
        sha256: release.sha256,
        revision: release.revision,
      });
      if (!mounted.current || currentOwner.current !== owner) return;
      setCancelResult({
        owner,
        pluginId: plugin.pluginId,
        releaseId: result.releaseId,
        cancelled: result.reviewStatus === 'cancelled',
      });
      // Keep the selected version; the subsequent read supplies its actual final decision.
      setVersionPage((previous) =>
        previous?.pluginId === plugin.pluginId
          ? {
              ...previous,
              releases: previous.releases.map((entry) =>
                entry.releaseId === result.releaseId
                  ? { ...result, content: entry.content }
                  : entry,
              ),
            }
          : previous,
      );
      await refreshAllRef.current();
    } catch (error) {
      if (mounted.current && currentOwner.current === owner)
        setFailure(contributionErrorKey(error));
    } finally {
      if (cancelling.current === cancellation) {
        cancelling.current = null;
        if (mounted.current && currentOwner.current === owner) setCancelBusy(false);
      }
    }
  };
  const chooseRelease = (key: string) => {
    if (!selectedId) return;
    const release = releases.find((entry) => releaseKey(entry) === key);
    if (!release) return;
    setSelectedRelease({ pluginId: selectedId, key });
  };
  const reviewTimes = (release: ContributionReleaseView) => (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-12 leading-5 text-[var(--text-tertiary)]">
      <div className="flex flex-wrap gap-x-2">
        <dt>{t(`${copy}.submittedAt`)}</dt>
        <dd>{formatDate(release.submittedAt)}</dd>
      </div>
      {release.reviewStatus === 'approved' ? (
        <div className="flex flex-wrap gap-x-2">
          <dt>{t(`${copy}.approvedAt`)}</dt>
          <dd>{release.approvedAt ? formatDate(release.approvedAt) : t(`${copy}.timeUnavailable`)}</dd>
        </div>
      ) : null}
      {release.cancelledAt ? (
        <div className="flex flex-wrap gap-x-2">
          <dt>{t(`${copy}.cancelledAt`)}</dt>
          <dd>{formatDate(release.cancelledAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
  const refreshButton = (
    <Tip text={t(`${copy}.${isDetail ? 'refreshDetail' : 'refreshList'}`)}>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        className="size-7 p-0"
        aria-label={t(`${copy}.${isDetail ? 'refreshDetail' : 'refreshList'}`)}
        loading={loading || versionsLoading}
        disabled={!contributor}
        onClick={() => void refreshAll()}
      >
        <RotateCw size={16} />
      </Button>
    </Tip>
  );
  const notes = shownRelease?.content?.manifestView.releaseNotes;

  const factsPlugin = plugin ? { ...plugin, localInstallation: localInstallation ?? { state: 'unavailable' as const } } : null;
  const versions = factsPlugin ? renderVersionFacts?.(factsPlugin) ?? <PluginVersionFacts plugin={factsPlugin} /> : null;
  const knownPublishBlocker = installedLocal && (
    plugin?.latestSubmission?.reviewStatus === 'pending' && plugin.latestSubmission.revisionState === 'current'
      ? 'PLUGIN_PENDING_RELEASE_EXISTS'
      : releases.some(release => release.version === installedLocal.version) ? 'VERSION_ALREADY_SUBMITTED' : null
  );
  const localCanSubmit = installedLocal && localPlugins.some(item => item.id === installedLocal.instanceId && item.version === installedLocal.version);
  const updateUnavailable = plugin?.publisherKind === 'official' ? t(`${copy}.unavailable.officialGithubRequired`)
    : knownPublishBlocker ? t(`${copy}.errors.${knownPublishBlocker}`) : undefined;
  const canPrepareUpdate = Boolean(installedLocal && localCanSubmit && plugin?.actions.submitUpdate && writeReady && !updateUnavailable);
  const updateInstanceId = installedLocal?.instanceId;
  const updateVersion = installedLocal?.version;
  const updateKey = JSON.stringify([ownerKey, location.key, selectedId, installedRevision, submissionRevision,
    installedLocal?.instanceId, installedLocal?.version, canPrepareUpdate, updateRefresh]);
  const updateContext = useRef({ key: updateKey, token: {} });
  if (updateContext.current.key !== updateKey) updateContext.current = { key: updateKey, token: {} };
  const currentUpdateDraft = useContributionPreview(updateKey,
    canPrepareUpdate ? updateInstanceId : undefined, updateVersion, preparePreview, reader.discard);
  const updateBlocker = currentUpdateDraft?.prepared?.preflight?.blockers[0];
  const published = publishedContent?.key === publishedKey ? publishedContent : null;
  const listedDetail = plugin?.market.state === 'available' ? published?.value : null;
  const currentNotes = currentSubmission?.content?.manifestView.releaseNotes;
  const publishingContent = currentDetail && plugin ? (
    <div className="space-y-6 pb-8">
      <section aria-label={t(`${copy}.localVersion`)} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-16 font-medium leading-6 text-[var(--text-primary)]">{t(`${copy}.localVersion`)}</h2>
            <p className="text-14 leading-6 text-[var(--text-secondary)]">
              {installedLocal ? `${installedLocal.version} · ${t(`settings.ghosts.page.origin.${installedLocal.origin}`)} · ${t(`${copy}.${installedLocal.enabled ? 'localEnabled' : 'localDisabled'}`)}`
                : t(`${copy}.localState.${localInstallation?.state ?? 'unavailable'}`)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {installedLocal && canPrepareUpdate && currentUpdateDraft?.prepared?.preflight?.actions.canSubmit && !updateBlocker ? (
              <Button variant="cta" size="sm" loading={submitBusy} disabled={submitBusy}
                onClick={() => {
                  const token = updateContext.current.token;
                  void onSubmitUpdate(installedLocal.instanceId, {
                    prepared: currentUpdateDraft.prepared,
                    isCurrent: () => mounted.current && updateContext.current.token === token,
                  }).catch(error => {
                    if (mounted.current && updateContext.current.token === token) setFailure(contributionErrorKey(error));
                  }).finally(() => {
                    if (mounted.current && updateContext.current.token === token) setUpdateRefresh(value => value + 1);
                  });
                }}>{t(`${copy}.submitVersion`, { version: installedLocal.version })}</Button>
            ) : null}
            {localInstallation?.state === 'missing' && plugin.market.state === 'available' && onInstallPublished && writeReady ? (
              <Button variant="secondary" size="sm" loading={installBusy} disabled={installBusy}
                onClick={() => {
                  const key = writeKey, owner = ownerKey, pluginId = plugin.pluginId;
                  setInstallBusy(true);
                  void onInstallPublished(plugin.pluginId).then(() => {
                    if (mounted.current && currentOwner.current === owner && selectedPlugin.current === pluginId) void refreshAllRef.current();
                  }).catch(error => {
                    if (mounted.current && currentWriteKey.current === key) setFailure(contributionErrorKey(error));
                  }).finally(() => {
                    if (mounted.current && currentOwner.current === owner && selectedPlugin.current === pluginId) setInstallBusy(false);
                  });
                }}>{t(`${copy}.installPublished`)}</Button>
            ) : null}
          </div>
        </div>
        {updateUnavailable && (installedLocal || plugin.publisherKind === 'official') ? <p role="status" className="text-12 leading-5 text-[var(--text-tertiary)]">{updateUnavailable}</p> : null}
        {canPrepareUpdate ? currentUpdateDraft?.prepared ? <>
          <p className="text-13 font-medium leading-5 text-[var(--text-primary)]">{currentUpdateDraft.prepared.name} · {currentUpdateDraft.prepared.version}</p>
          <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-secondary)]">{currentUpdateDraft.prepared.description}</p>
          <h3 className="text-13 font-medium leading-5 text-[var(--text-secondary)]">{t(`${copy}.releaseNotes`)}</h3>
          <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">{currentUpdateDraft.prepared.releaseNotes?.trim() || t(`${copy}.notesMissing`)}</p>
          {updateBlocker ? <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">{updateBlocker.message}</p> : null}
        </> : <p role={currentUpdateDraft?.error ? 'alert' : 'status'} className="text-13 leading-5 text-[var(--text-secondary)]">{t(currentUpdateDraft?.error ?? `${copy}.preparing`)}</p> : null}
      </section>
      <section aria-label={t(`${copy}.listedVersion`)} className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <h2 className="text-16 font-medium leading-6 text-[var(--text-primary)]">
          {t(`${copy}.listedVersion`)}{plugin.market.state === 'available' ? ` · ${plugin.market.version}` : ''}
        </h2>
        {plugin.market.state !== 'available' ? <p className="text-14 leading-6 text-[var(--text-secondary)]">{t(`${copy}.market.${plugin.market.state}`)}</p>
          : published?.value ? <>
            <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">{published.value.description || published.value.manifest.description}</p>
            <h3 className="text-13 font-medium leading-5 text-[var(--text-secondary)]">{t(`${copy}.releaseNotes`)}</h3>
            <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">{published.value.manifest.releaseNotes?.trim() || t(`${copy}.notesMissing`)}</p>
          </> : <p role="status" className="text-14 leading-6 text-[var(--text-secondary)]">{t(`${copy}.${published?.loading ? 'loading' : 'publishedContentUnavailable'}`)}</p>}
        {plugin.market.reason ? <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-secondary)]">{plugin.market.reason}</p> : null}
      </section>
      <section aria-label={t(`${copy}.currentSubmission`)} className="space-y-3 border-t border-[var(--border-default)] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-16 font-medium leading-6 text-[var(--text-primary)]">{t(`${copy}.currentSubmission`)}</h2>
          {currentSubmission?.canCancelReview && plugin.actions.submitUpdate && writeReady ? (
            <Button variant="secondary" size="sm" loading={cancelBusy} disabled={cancelBusy}
              onClick={() => void cancelReview(plugin, currentSubmission)}>{t(`${copy}.cancelReview`)}</Button>
          ) : null}
        </div>
        {currentSubmission ? <>
          <p className="flex flex-wrap gap-x-2 text-14 leading-6 text-[var(--text-primary)]"><span>{currentSubmission.version}</span><span aria-hidden="true">·</span><span>{status(currentSubmission, plugin)}</span></p>
          {reviewTimes(currentSubmission)}
          {cancelResult?.owner === ownerKey && cancelResult.pluginId === plugin.pluginId && cancelResult.releaseId === currentSubmission.releaseId ? (
            <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">{t(`${copy}.${cancelResult.cancelled ? 'cancelReviewCompleted' : 'cancelReviewAlreadyFinal'}`)}</p>
          ) : null}
          {currentSubmission.reason ? <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">{currentSubmission.reason}</p> : null}
          <h3 className="text-13 font-medium leading-5 text-[var(--text-secondary)]">{t(`${copy}.releaseNotes`)}</h3>
          <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">
            {typeof currentNotes === 'string' && currentNotes.trim() ? currentNotes : t(`${copy}.${currentSubmission.content ? 'notesMissing' : 'snapshotUnavailable'}`)}
          </p>
          <details className="group/current">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-13 font-medium leading-5 text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 group-open/current:rotate-90" />{t(`${copy}.submittedContent`)}
            </summary>
            <div className="pt-3">{releaseContent(currentSubmission)}</div>
          </details>
        </> : <p className="text-14 leading-6 text-[var(--text-secondary)]">{t(`${copy}.noSubmission`)}</p>}
      </section>
      {unreadReview && !visibleReview ? (
        <Button variant="secondary" size="sm" loading={versionsLoading}
          disabled={versionsLoading || !navigator.onLine} onClick={() => void openUnreadResult()}>
          <AttentionDot tone={unreadReview.status === 'rejected' ? 'error' : 'done'} />
          {t(`${copy}.viewReviewResult`, { version: unreadReview.version })}
        </Button>
      ) : null}
      {versionFailure ? (
        <p role="alert" className="text-13 text-[var(--text-secondary)]">
          {t(versionFailure, { defaultValue: t(`${copy}.loadFailed`) })}
        </p>
      ) : null}
      <details key={JSON.stringify([ownerKey, selectedId])} open={historyOpen}
        onToggle={event => setHistoryOpenKey(event.currentTarget.open ? JSON.stringify([ownerKey, selectedId]) : null)}
        className="group/history border-t border-[var(--border-default)] pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-13 font-medium leading-5 text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 group-open/history:rotate-90" />
          {t(`${copy}.history`)}
        </summary>
        {historyOpen ? <div className="space-y-4 pt-4">
      {shownRelease ? (
        <section className="space-y-4" aria-label={t(`${copy}.versionContent`)}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-14 text-[var(--text-primary)]">
                {t(`${copy}.version`)}
              </span>
              {releases.length > 1 ? (
                <Select
                  label={t(`${copy}.chooseVersion`)}
                  value={releaseKey(shownRelease)}
                  options={releases.map((release) => ({
                    value: releaseKey(release),
                    label: release.version,
                    title: release.version,
                    endAdornment: (
                      <span className="text-12 text-[var(--text-tertiary)]">
                        {status(release, plugin)}
                      </span>
                    ),
                  }))}
                  onValueChange={chooseRelease}
                  truncateOptions
                  className="h-8 w-28 min-w-0 gap-3 font-normal"
                  contentClassName="min-w-[240px] max-w-[calc(100vw-16px)]"
                  aria-describedby="my-plugin-version-status"
                />
              ) : (
                <span className="min-w-0 break-words text-14 text-[var(--text-primary)]">
                  {shownRelease.version}
                </span>
              )}
              <span
                id="my-plugin-version-status"
                className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-12 text-[var(--text-primary)]"
              >
                {status(shownRelease, plugin)}
              </span>
            </div>
          </div>
          {reviewTimes(shownRelease)}
          {shownRelease.reason ? (
            <section className="space-y-2">
              <h3 className="text-13 font-medium text-[var(--text-primary)]">
                {t(`${copy}.reason`)}
              </h3>
              <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">
                {shownRelease.reason}
              </p>
            </section>
          ) : null}
          {snapshotLoading === shownRelease.submissionId && snapshotLoading && !shownRelease.content ? (
            <p role="status" className="text-13 text-[var(--text-tertiary)]">
              {t(`${copy}.loading`)}
            </p>
          ) : (
            <>
              <section className="space-y-3 pt-2">
                <div className="space-y-1">
                  <h3 className="text-14 font-medium leading-5 text-[var(--text-primary)]">
                    {t(`${copy}.releaseNotes`)}
                  </h3>
                </div>
                <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">
                  {typeof notes === 'string' && notes.trim()
                    ? notes
                    : t(
                        `${copy}.${shownRelease.content ? 'notesMissing' : 'snapshotUnavailable'}`,
                      )}
                </p>
              </section>
              <details className="group/version border-t border-[var(--border-default)] pt-4">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-13 font-medium leading-5 text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={14} aria-hidden="true" className="shrink-0 group-open/version:rotate-90" />
                  {t(`${copy}.versionContent`)}
                </summary>
                <div className="pt-4">{releaseContent(shownRelease)}</div>
              </details>
            </>
          )}
        </section>
      ) : (
        <p className="text-14 text-[var(--text-tertiary)]">
          {t(`${copy}.noSubmission`)}
        </p>
      )}
      {versionPage?.pluginId === selectedId && versionPage.nextCursor ? (
        <Button
          variant="secondary"
          size="sm"
          compact
          loading={versionsLoading}
          onClick={() => void loadVersions(versionPage.nextCursor!)}
        >
          {t(`${copy}.loadMoreVersions`)}
        </Button>
      ) : null}
          {currentDetail.history.map((event) => (
            <article
              key={event.eventId}
              className="space-y-2 border-b border-[var(--border-default)] pb-4"
            >
              <p className="break-words text-14 text-[var(--text-primary)]">
                {event.version ? `${event.version} · ` : ''}
                {t(`${copy}.event.${event.type}`)}
              </p>
              <p className="text-12 text-[var(--text-tertiary)]">
                {formatDate(event.at)}
              </p>
              {event.reason ? (
                <p className="select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-primary)]">
                  {event.reason}
                </p>
              ) : null}
              {event.submissionId ? (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    loading={snapshotLoading === event.submissionId}
                    onClick={() => void loadSnapshot(event.submissionId!)}
                  >
                    {t(`${copy}.submittedContent`)}
                  </Button>
                  {snapshots[event.submissionId] ? (
                    <div className="mt-3">
                      {releaseContent(snapshots[event.submissionId])}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {event.revision ? (
                <details className="text-12 text-[var(--text-tertiary)]">
                  <summary className="cursor-pointer select-none">
                    {t(`${copy}.technicalDetails`)}
                  </summary>
                  <p className="mt-2 break-all">
                    {event.revision.releaseId}
                    <br />
                    {event.revision.sha256}
                    <br />
                    {event.revision.displayUpdatedAt}
                  </p>
                </details>
              ) : null}
            </article>
          ))}
          {currentDetail.nextCursor ? (
            <Button
              variant="secondary"
              loading={loading}
              onClick={() => void refresh(currentDetail.nextCursor!)}
            >
              {t(`${copy}.loadMoreHistory`)}
            </Button>
          ) : null}
        </div> : null}
      </details>
    </div>
  ) : null;
  const publishing = <section aria-label={t(`${copy}.versionManagement`)}>
    {currentSubmission?.content?.description ? <p className="mb-6 select-text whitespace-pre-wrap break-words text-14 leading-6 text-[var(--text-secondary)]">{currentSubmission.content.description}</p> : null}
    {versions ? <div className="mb-6">{versions}</div> : null}
    {publishingContent}
  </section>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <main
        ref={scrollFrame}
        className="app-wallpaper-surface min-h-0 flex-1 overflow-y-auto bg-[var(--surface)]"
        onScroll={(event) => {
          onScroll(event);
          if (!isDetail) listScroll.current = event.currentTarget.scrollTop;
          cache.scroll = listScroll.current;
        }}
      >
        <PluginDetailTopBar
          label={isDetail ? t(`${copy}.myPlugins`) : t('settings.ghosts.title')}
          onBack={back}
          scrolled={scrolled}
          frameClassName={PLUGIN_MANAGEMENT_FRAME_CLASS}
        />
        <PluginManagementPage className={isDetail ? 'pt-6' : undefined}>
          <header className={`flex min-w-0 flex-wrap justify-between gap-4 ${isDetail ? 'mb-6 items-start' : 'mb-5 items-center'}`}>
            <div className={`flex min-w-0 flex-1 gap-4 ${isDetail ? 'items-start' : 'items-center'}`}>
              {isDetail && plugin ? (
                <GhostPluginIcon
                  iconDataUrl={plugin?.iconUrl ?? undefined}
                  iconId={plugin.pluginId}
                  iconName={plugin.name}
                  size="detail"
                />
              ) : null}
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <h1 className={`min-w-0 break-words font-medium text-[var(--text-primary)] [overflow-wrap:anywhere] ${isDetail ? 'text-20 leading-7' : 'text-24 leading-8'}`}>
                    {isDetail
                      ? (plugin?.name ?? t(`${copy}.myPlugins`))
                      : t(`${copy}.myPlugins`)}
                  </h1>
                </div>
                {isDetail && plugin?.publisherKind === 'official' ? <div className="mt-1"><PluginPublisherBadge kind={plugin.publisherKind} /></div> : null}
                {isDetail && (plugin?.displayAuthor || listedDetail) ? (
                  <div className="plugin-detail-metadata mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-13 leading-5 text-[var(--text-tertiary)]">
                    {plugin?.displayAuthor ? <span className="min-w-0 break-words">{plugin.displayAuthor}</span> : null}
                    {listedDetail ? <>
                      {plugin?.displayAuthor ? <span aria-hidden="true">·</span> : null}
                      <span>v{listedDetail.version}</span>
                      <PluginSharedUsage detail={listedDetail} />
                    </> : null}
                  </div>
                ) : null}
                {!isDetail ? (
                  <p className="mt-1 text-14 leading-6 text-[var(--text-tertiary)]">
                    {t(`${copy}.intro`)}
                  </p>
                ) : null}
              </div>
            </div>
            {!isDetail ? (
              <Button
                variant="cta"
                disabled={!contributor || !ownerMatches}
                onClick={() => { setPickerPlugins(null); setPickerSelection(null); setPickerOwner(ownerKey); }}
              >
                <Plus size={16} />
                {t(`${copy}.publishPlugin`)}
              </Button>
            ) : (
              refreshButton
            )}
          </header>
          {!contributor ? (
            <div className="space-y-4">
              <p role="status" className="text-14 leading-6 text-[var(--text-secondary)]">
                {t(`${copy}.signInRequired`)}
              </p>
              <Button
                ref={accountTrigger}
                variant="secondary"
                onClick={() => (mode === 'cloud' ? setAccountSwitcherOpen(true) : void signIn())}
              >
                {t(mode === 'cloud' ? 'sidebar.accountSwitcher.title' : 'login.signIn')}
              </Button>
              <AccountSwitcherDialog
                open={accountSwitcherOpen}
                onOpenChange={setAccountSwitcherOpen}
                triggerRef={accountTrigger}
                onAddAccount={() =>
                  navigate('/add-account', {
                    state: { returnTo: `${location.pathname}${location.search}` },
                  })
                }
              />
            </div>
          ) : (
            <>
              {failure ? (
                <p
                  role="alert"
                  className="mb-4 whitespace-pre-wrap text-14 leading-6 text-[var(--text-secondary)]"
                >
                  {t(failure, { defaultValue: t(`${copy}.loadFailed`) })}
                  {timestamp ? ` · ${t(`${copy}.cachedResult`)}` : ''}
                </p>
              ) : null}
              {!isDetail ? (
                <>
                  {!listEmpty || query || filter !== 'all' ? (
                    <div className="mb-5 flex flex-wrap items-center gap-3">
                      <Input
                        size="sm"
                        value={query}
                        onChange={setQuery}
                        placeholder={t(`${copy}.search`)}
                        aria-label={t(`${copy}.search`)}
                        className="min-w-0 max-w-xs"
                      />
                      <div className="flex flex-wrap gap-1" aria-label={t(`${copy}.filterLabel`)}>
                        {(['all', 'pending', 'needs_action', 'published'] as const).map((value) => (
                          <Button
                            key={value}
                            variant={filter === value ? 'primary' : 'secondary'}
                            tone={filter === value ? 'default' : 'quiet'}
                            size="sm"
                            compact
                            aria-pressed={filter === value}
                            onClick={() => setFilter(value)}
                          >
                            {t(`${copy}.filter.${value}`)}
                          </Button>
                        ))}
                      </div>
                      <span className="ml-auto">{refreshButton}</span>
                    </div>
                  ) : null}
                  {loading && !page ? (
                    <p role="status" className="text-14 text-[var(--text-secondary)]">
                      {t(`${copy}.loading`)}
                    </p>
                  ) : null}
                  {listEmpty ? (
                    <div className="flex min-h-72 flex-col items-center justify-center gap-4 py-8 text-center text-14 leading-6 text-[var(--text-tertiary)]">
                      <p>{t(`${copy}.${query || filter !== 'all' ? 'noMatches' : 'empty'}`)}</p>
                      {!query && filter === 'all' ? (
                        <Button variant="secondary" onClick={onViewLocal}>
                          {t(`${copy}.viewLocal`)}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {page?.plugins.length ? (
                    <div className="my-plugins-table">
                      <div
                        className="my-plugins-columns border-b border-[var(--border-default)] pb-3 text-12 text-[var(--text-tertiary)]"
                        aria-hidden="true"
                      >
                        <span>{t(`${copy}.pluginColumn`)}</span>
                        <span>{t(`${copy}.localVersion`)}</span>
                        <span>{t(`${copy}.currentMarket`)}</span>
                        <span>{t(`${copy}.latestState`)}</span>
                        <span />
                      </div>
                      {page?.plugins.map((entry) => {
                        const local = listInstallationRead === JSON.stringify([ownerKey, installedRevision]) && navigator.onLine
                          ? entry.localInstallation : undefined;
                        const review = reviewUpdates.updates.find(item => item.pluginId === entry.pluginId && item.unread);
                        return (
                          <button
                            type="button"
                            key={entry.pluginId}
                            className="my-plugins-row w-full border-b border-[var(--border-default)] py-5 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                            onClick={() => openDetail(entry.pluginId)}
                          >
                            <span className="my-plugins-identity flex min-w-0 items-center gap-3">
                              <GhostPluginIcon
                                iconDataUrl={entry.iconUrl ?? undefined}
                                iconId={entry.pluginId}
                                iconName={entry.name}
                              />
                              <span className="min-w-0">
                                <span className="block break-words text-16 font-medium leading-6 text-[var(--text-primary)]">{entry.name}</span>
                                <PluginPublisherBadge kind={entry.publisherKind} />
                                {entry.displayAuthor ? <span className="block break-words text-13 leading-5 text-[var(--text-tertiary)]">{entry.displayAuthor}</span> : null}
                              </span>
                              {review ? <span role="img" className="inline-flex" aria-label={t(`${copy}.unreadReview`)}><AttentionDot tone={review.status === 'rejected' ? 'error' : 'done'} /></span> : null}
                            </span>
                            <span className="my-plugins-local min-w-0 break-words text-13 leading-5 text-[var(--text-primary)]">
                              <span className="my-plugins-mobile-label">{t(`${copy}.localVersion`)} ·{' '}</span>
                              {local?.state === 'installed' ? local.version : t(`${copy}.localState.${local?.state ?? 'unavailable'}`)}
                            </span>
                            <span className="my-plugins-market min-w-0 break-words text-13 leading-5 text-[var(--text-tertiary)]">
                              <span className="my-plugins-mobile-label">
                                {t(`${copy}.currentMarket`)} ·{' '}
                              </span>
                              {entry.market.state === 'available'
                                ? entry.market.version
                                : t(`${copy}.market.${entry.market.state}`)}
                            </span>
                            <span className="my-plugins-latest min-w-0 break-words text-13 leading-5 text-[var(--text-primary)]">
                              <span className="my-plugins-mobile-label">
                                {t(`${copy}.latestState`)} ·{' '}
                              </span>
                              {entry.latestSubmission
                                ? `${entry.latestSubmission.version} · ${status(entry.latestSubmission, entry)}`
                                : t(`${copy}.noSubmission`)}
                            </span>
                            {rowAction}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {page?.nextCursor ? (
                    <Button
                      variant="secondary"
                      loading={loading}
                      onClick={() => void refresh(page.nextCursor!)}
                    >
                      {t(`${copy}.loadMore`)}
                    </Button>
                  ) : null}
                </>
              ) : currentDetail && plugin ? (
                <>
                  {publishing}
                </>
              ) : loading ? (
                <p role="status" className="text-14 text-[var(--text-tertiary)]">
                  {t(`${copy}.loading`)}
                </p>
              ) : null}
              <footer
                className="mt-6 flex items-center justify-between gap-3 pb-4 text-12 text-[var(--text-tertiary)]"
                aria-live="polite"
              >
                <span>
                  {timestamp
                    ? t(`${copy}.lastRefreshed`, { time: formatDate(timestamp) })
                    : loading
                      ? t(`${copy}.loading`)
                      : ''}
                </span>
                {!isDetail && listEmpty && !query && filter === 'all' ? refreshButton : null}
              </footer>
            </>
          )}
        </PluginManagementPage>
      </main>
      <Dialog.Root
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!open) setPickerOwner(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
          <Dialog.Content onInteractOutside={event => event.preventDefault()} className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
            <Dialog.Title className="text-18 font-medium text-[var(--text-primary)]">
              {t(`${copy}.publishPlugin`)}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">
              {t(`${copy}.chooseLocal`)}
            </Dialog.Description>
            <div className="my-4 min-h-0 overflow-y-auto p-1">
              {pickerOwner === ownerKey && ownerMatches
                ? localPlugins.map((local) => {
                  const unavailable = pickerUnavailable(local);
                  return (
                    <button
                      type="button"
                      key={local.id}
                      className={`flex w-full min-w-0 items-center gap-3 rounded-lg border px-2 py-3 text-left enabled:hover:bg-[var(--surface-hover)] disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] ${submitBusy || !pickerReady ? 'opacity-60' : ''} ${pickerSelection === local.id ? 'border-[var(--border-default)] bg-[var(--surface-hover)]' : 'border-transparent'}`}
                      aria-label={`${local.name} · ${local.version} · ${local.id}`}
                      aria-describedby={unavailable ? `${pickerStatusId}-${local.id}` : undefined}
                      aria-pressed={pickerSelection === local.id}
                      disabled={submitBusy || !pickerReady || Boolean(unavailable)}
                      onClick={() => setPickerSelection(local.id)}
                    >
                      <GhostPluginIcon
                        iconDataUrl={local.iconDataUrl}
                        iconId={local.id}
                        iconName={local.name}
                      />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        <span className={`block text-14 font-medium leading-5 ${unavailable ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
                          {local.name}
                        </span>
                        <span className="mt-1 block text-12 leading-4 text-[var(--text-tertiary)]">
                          {local.version}
                        </span>
                        <span className="mt-1 block text-12 leading-4 text-[var(--text-tertiary)]">
                          {local.id}
                        </span>
                        {unavailable ? <span id={`${pickerStatusId}-${local.id}`} className="mt-1 block text-13 leading-5 text-[var(--text-secondary)]">
                          {t(unavailable)}
                        </span> : null}
                      </span>
                      {pickerSelection === local.id ? <Check size={16} aria-hidden="true" className="shrink-0 text-[var(--text-primary)]" /> : null}
                    </button>
                  );
                })
                : null}
              {localPlugins.length === 0 ? (
                <p className="text-14 leading-6 text-[var(--text-secondary)]">
                  {t(
                    `${copy}.${installedPluginCount === 0 ? 'noLocalPlugins' : 'noPublishablePlugins'}`,
                  )}
                </p>
              ) : null}
            </div>
            {pickerSelection && pickerItem ? (
              <section aria-label={t(`${copy}.publishingVersion`, { version: pickerItem.version })}
                className="mb-4 max-h-52 space-y-2 overflow-y-auto border-t border-[var(--border-default)] pt-3 text-13 leading-5 text-[var(--text-secondary)]">
                <p className="font-medium text-[var(--text-primary)]">{pickerItem.name} · {pickerItem.version}</p>
                {currentPickerDraft?.prepared ? <>
                  <p className="whitespace-pre-wrap break-words">{currentPickerDraft.prepared.description}</p>
                  {currentPickerDraft.prepared.releaseNotes?.trim() ? <>
                    <h3 className="font-medium">{t(`${copy}.releaseNotes`)}</h3>
                    <p className="whitespace-pre-wrap break-words">{currentPickerDraft.prepared.releaseNotes}</p>
                  </> : null}
                  <p>{t(`${copy}.confirmPublic`)}</p>
                </> : !currentPickerDraft?.error ? <p role="status">{t(`${copy}.preparing`)}</p> : null}
              </section>
            ) : null}
            {localPlugins.length > 0 && !pickerRead ? <p role="status" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-secondary)]">{t(`${copy}.loading`)}</p> : null}
            {pickerRead?.failure || currentPickerDraft?.error ? (
              <p role="alert" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-secondary)]">
                {t((pickerRead?.failure ?? currentPickerDraft?.error)!, { defaultValue: t(`${copy}.loadFailed`) })}
              </p>
            ) : pickerBlocker || selectedPickerUnavailable ? (
              <p role="status" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-primary)]">
                {selectedPickerUnavailable ? t(selectedPickerUnavailable) : pickerBlocker?.message}
              </p>
            ) : null}
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="secondary">{t('settings.ghosts.detail.closeDialog')}</Button>
              </Dialog.Close>
              {pickerReady && !selectedPickerUnavailable && pickerItem && currentPickerDraft?.prepared?.preflight?.actions.canSubmit ? (
                <Button variant="cta" loading={submitBusy} disabled={submitBusy || !navigator.onLine}
                  onClick={() => {
                    const prepared = currentPickerDraft.prepared!;
                    const token = pickerContext.current.token;
                    const isCurrent = () => mounted.current && pickerContext.current.token === token;
                    void onSubmitUpdate(pickerItem.id, { prepared, isCurrent }).then(submitted => {
                      if (!isCurrent()) return;
                      if (submitted) setPickerOwner(null);
                      else setPickerRefresh(value => value + 1);
                    });
                  }}>{t(`${copy}.submitVersion`, { version: currentPickerDraft.prepared.version })}</Button>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
