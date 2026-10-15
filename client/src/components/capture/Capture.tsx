import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, DatabaseZap, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import type {
  CompanyProfile,
  MatchResult,
  OpportunityData,
  OpportunityRecord,
  ProfileRecord,
  SourceData,
} from "@shared/capture";
import {
  opportunitySchema,
  profileSchema,
  sourceSchema,
} from "@shared/capture";
import type { Requirement, ResponseSection, WorkspaceData } from "@shared/bid";
import { Discovery } from "./Discovery";
import { Pipeline } from "./Pipeline";
import { Profiles } from "./Profiles";
import { Sources } from "./Sources";
import {
  createSampleCaptureState,
  sourceCatalogLocal,
  type CaptureJob,
  type CaptureRun,
  type PipelinePolicy,
  type PipelineSettings,
  type SourceRecord,
} from "./sample";
import "./capture.css";

export type CapturePage = "profiles" | "discovery" | "sources" | "pipeline";

export type CatalogItem = {
  kind: SourceData["kind"] | null;
  name: string;
  access: string;
  url: string;
  note: string;
  configured?: boolean;
};
export const captureClient = trpc;

export type OpportunityAnalysis = {
  opportunityId: string;
  opportunityVersion: number;
  requirements: Requirement[];
  sections: ResponseSection[];
  strategy: WorkspaceData["strategy"];
  deadlines: { dueDate: string; milestones: WorkspaceData["milestones"] };
  issues: WorkspaceData["quality"];
};

const asMessage = (value: unknown, fallback: string) =>
  value instanceof Error ? value.message : fallback;
const localId = (prefix: string) =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}`;
const now = () => new Date().toISOString();

export type CaptureModel = {
  demo: boolean;
  profiles: ProfileRecord[];
  sources: SourceRecord[];
  catalog: CatalogItem[];
  opportunities: OpportunityRecord[];
  totalOpportunities: number;
  hasMoreOpportunities: boolean;
  loadingMoreOpportunities: boolean;
  loadMoreOpportunities: () => Promise<void>;
  settings: PipelineSettings;
  jobs: CaptureJob[];
  runs: CaptureRun[];
  pending: boolean;
  errors: string[];
  notice: string;
  clearNotice: () => void;
  saveProfile: (input: {
    id?: string;
    version?: number;
    data: CompanyProfile;
  }) => Promise<ProfileRecord>;
  importProfileDocument: (input: {
    profileId: string;
    version: number;
    name: string;
    mime: string;
    base64: string;
  }) => Promise<ProfileRecord>;
  saveSource: (input: {
    id?: string;
    version?: number;
    data: SourceData;
  }) => Promise<SourceRecord>;
  syncSource: (sourceId: string) => Promise<void>;
  importOpportunities: (input: {
    sourceId: string;
    opportunities: OpportunityData[];
  }) => Promise<void>;
  attachOpportunityDocument: (input: {
    opportunityId: string;
    version: number;
    name: string;
    mime: string;
    base64: string;
  }) => Promise<OpportunityRecord>;
  importLinkedAttachment: (input: {
    opportunityId: string;
    version: number;
    attachmentName: string;
  }) => Promise<OpportunityRecord>;
  analyzeOpportunity: (
    opportunityId: string
  ) => Promise<OpportunityAnalysis | null>;
  eligibilityReview: (input: {
    opportunityId: string;
    version: number;
    requiredStatuses: string[];
    requiredCertifications: string[];
    eligibilityNotes: string;
    dueDate: string;
    value: string | null;
    currency: OpportunityData["currency"];
    geographies: string[];
    capabilities: string[];
  }) => Promise<OpportunityRecord>;
  matchAll: () => Promise<void>;
  queueResponse: (opportunityId: string, profileId: string) => Promise<void>;
  savePolicy: (policy: PipelinePolicy) => Promise<void>;
  enablePipeline: () => Promise<void>;
  pausePipeline: () => Promise<void>;
  processQueue: () => Promise<void>;
  retryJob: (id: string) => Promise<void>;
};

export default function Capture({
  page,
  demo,
  onOpenWorkspace,
}: {
  page: CapturePage;
  demo: boolean;
  onOpenWorkspace: (id: string) => void;
}) {
  const [local, setLocal] = useState(createSampleCaptureState);
  const [notice, setNotice] = useState("");
  const profilesQuery = captureClient.capture.listProfiles.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const sourcesQuery = captureClient.capture.sources.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const catalogQuery = captureClient.capture.sourceCatalog.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const opportunitiesQuery =
    captureClient.capture.opportunitiesPage.useInfiniteQuery(
      { limit: 100 },
      {
        enabled: !demo,
        retry: false,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      }
    );
  const utils = captureClient.useUtils();
  const remoteOpportunities = useMemo(
    () => opportunitiesQuery.data?.pages.flatMap(page => page.items) ?? [],
    [opportunitiesQuery.data]
  );
  const settingsQuery = captureClient.capture.settings.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const jobsQuery = captureClient.capture.jobs.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const runsQuery = captureClient.capture.runs.useQuery(undefined, {
    enabled: !demo,
    retry: false,
  });
  const saveProfileMutation = captureClient.capture.saveProfile.useMutation();
  const importProfileMutation =
    captureClient.capture.importProfileDocument.useMutation();
  const saveSourceMutation = captureClient.capture.saveSource.useMutation();
  const syncSourceMutation = captureClient.capture.syncSource.useMutation();
  const importOpportunitiesMutation =
    captureClient.capture.importOpportunities.useMutation();
  const attachOpportunityMutation =
    captureClient.capture.attachOpportunityDocument.useMutation();
  const importLinkedAttachmentMutation =
    captureClient.capture.importLinkedAttachment.useMutation();
  const analyzeOpportunityMutation =
    captureClient.capture.analyzeOpportunity.useMutation();
  const reviewMutation = captureClient.capture.eligibilityReview.useMutation();
  const matchAllMutation = captureClient.capture.matchAll.useMutation();
  const queueMutation = captureClient.capture.queueResponse.useMutation();
  const savePolicyMutation = captureClient.capture.savePolicy.useMutation();
  const enableMutation = captureClient.capture.enablePipeline.useMutation();
  const pauseMutation = captureClient.capture.pausePipeline.useMutation();
  const processMutation = captureClient.capture.processQueue.useMutation();
  const retryMutation = captureClient.capture.retryJob.useMutation();

  const refresh = useCallback(async () => {
    await Promise.all([
      profilesQuery.refetch(),
      sourcesQuery.refetch(),
      opportunitiesQuery.refetch(),
      settingsQuery.refetch(),
      jobsQuery.refetch(),
      runsQuery.refetch(),
    ]);
    await utils.capture.matches.invalidate();
  }, [
    jobsQuery,
    opportunitiesQuery,
    profilesQuery,
    runsQuery,
    settingsQuery,
    sourcesQuery,
    utils,
  ]);

  const loadMoreOpportunities = useCallback(async () => {
    if (
      demo ||
      !opportunitiesQuery.hasNextPage ||
      opportunitiesQuery.isFetchingNextPage
    )
      return;
    await opportunitiesQuery.fetchNextPage();
  }, [demo, opportunitiesQuery]);

  const saveProfile = useCallback(
    async (input: { id?: string; version?: number; data: CompanyProfile }) => {
      if (!demo) {
        const row = await saveProfileMutation.mutateAsync(input);
        await refresh();
        setNotice("Company profile saved.");
        return row;
      }
      const data = profileSchema.parse(input.data);
      const existing = input.id
        ? local.profiles.find(row => row.id === input.id)
        : undefined;
      if (existing && input.version !== existing.version)
        throw new Error("Profile changed. Reload before saving.");
      const row: ProfileRecord = {
        id: existing?.id ?? localId("local-profile"),
        version: (existing?.version ?? 0) + 1,
        data,
        updatedAt: now(),
      };
      setLocal(state => ({
        ...state,
        profiles: existing
          ? state.profiles.map(item => (item.id === row.id ? row : item))
          : [row, ...state.profiles],
      }));
      setNotice(
        "Sample/local profile saved in this browser session only. No database write occurred."
      );
      return row;
    },
    [demo, local.profiles, refresh, saveProfileMutation]
  );

  const importProfileDocument = useCallback(
    async (input: {
      profileId: string;
      version: number;
      name: string;
      mime: string;
      base64: string;
    }) => {
      if (!demo) {
        const row = await importProfileMutation.mutateAsync(input);
        await refresh();
        setNotice("Evidence document imported and is awaiting your review.");
        return row;
      }
      const current = local.profiles.find(row => row.id === input.profileId);
      if (!current) throw new Error("Local profile is no longer available.");
      if (current.version !== input.version)
        throw new Error("Profile changed. Reload before importing.");
      const row: ProfileRecord = {
        ...current,
        version: current.version + 1,
        updatedAt: now(),
        data: profileSchema.parse({
          ...current.data,
          evidence: [
            ...current.data.evidence,
            {
              id: localId("local-evidence"),
              name: input.name,
              category: "Imported evidence",
              uploadedAt: new Date().toISOString().slice(0, 10),
              approved: false,
              text: `Local file staged (${input.mime}). Its contents were not sent to a server or parsed.`,
            },
          ],
        }),
      };
      setLocal(state => ({
        ...state,
        profiles: state.profiles.map(item => (item.id === row.id ? row : item)),
      }));
      setNotice(
        "Sample/local evidence was staged only and cannot be approved as proof because it was not parsed."
      );
      return row;
    },
    [demo, importProfileMutation, local.profiles, refresh]
  );

  const saveSource = useCallback(
    async (input: { id?: string; version?: number; data: SourceData }) => {
      if (!demo) {
        const row = await saveSourceMutation.mutateAsync(input);
        await refresh();
        setNotice("Source settings saved.");
        return row;
      }
      const data = sourceSchema.parse(input.data);
      const existing = input.id
        ? local.sources.find(row => row.id === input.id)
        : undefined;
      if (existing && input.version !== existing.version)
        throw new Error("Source changed. Reload before saving.");
      const row: SourceRecord = {
        id: existing?.id ?? localId("local-source"),
        version: (existing?.version ?? 0) + 1,
        data,
        lastSyncAt: existing?.lastSyncAt ?? null,
        lastError: null,
        nextCursor: existing?.nextCursor ?? null,
      };
      setLocal(state => ({
        ...state,
        sources: existing
          ? state.sources.map(item => (item.id === row.id ? row : item))
          : [row, ...state.sources],
      }));
      setNotice(
        "Sample/local source settings changed locally only; no external feed was contacted."
      );
      return row;
    },
    [demo, local.sources, refresh, saveSourceMutation]
  );

  const syncSource = useCallback(
    async (sourceId: string) => {
      if (demo) {
        const source = local.sources.find(item => item.id === sourceId);
        setNotice(
          `Sample/local: ${source?.data.name ?? "this source"} was not synchronized. No live feed or credential is used.`
        );
        return;
      }
      await syncSourceMutation.mutateAsync({ sourceId });
      await refresh();
      setNotice("Source sync was queued. The feed has not been processed yet.");
    },
    [demo, local.sources, refresh, syncSourceMutation]
  );

  const importOpportunities = useCallback(
    async (input: { sourceId: string; opportunities: OpportunityData[] }) => {
      if (!demo) {
        await importOpportunitiesMutation.mutateAsync(input);
        await refresh();
        setNotice(
          `${input.opportunities.length} opportunity notice(s) imported. Eligibility review is still required before drafting.`
        );
        return;
      }
      const source = local.sources.find(item => item.id === input.sourceId);
      if (!source) throw new Error("Select a local source first.");
      const opportunities = opportunitySchema
        .array()
        .min(1)
        .max(100)
        .parse(input.opportunities);
      const records = opportunities.map(data => ({
        id: localId("local-opportunity"),
        sourceId: source.id,
        sourceName: source.data.name,
        version: 1,
        data: { ...data, eligibilityReviewed: false },
        updatedAt: now(),
      }));
      setLocal(state => ({
        ...state,
        opportunities: [...records, ...state.opportunities],
      }));
      setNotice(
        `${records.length} opportunity notice(s) imported to sample/local state. Eligibility remains unreviewed.`
      );
    },
    [demo, importOpportunitiesMutation, local.sources, refresh]
  );

  const attachOpportunityDocument = useCallback(
    async (input: {
      opportunityId: string;
      version: number;
      name: string;
      mime: string;
      base64: string;
    }) => {
      if (!demo) {
        const row = await attachOpportunityMutation.mutateAsync(input);
        await refresh();
        setNotice(
          "Solicitation document imported. Eligibility review must be repeated before drafting."
        );
        return row;
      }
      const current = local.opportunities.find(
        row => row.id === input.opportunityId
      );
      if (!current)
        throw new Error("Local opportunity is no longer available.");
      if (current.version !== input.version)
        throw new Error("Opportunity changed. Reload before importing.");
      const row: OpportunityRecord = {
        ...current,
        version: current.version + 1,
        updatedAt: now(),
        data: opportunitySchema.parse({
          ...current.data,
          documents: [
            ...current.data.documents,
            {
              id: localId("local-document"),
              name: input.name,
              category: "Solicitation",
              uploadedAt: new Date().toISOString().slice(0, 10),
              approved: false,
              text: `Local attachment staged (${input.mime}). Contents were not parsed or persisted.`,
            },
          ],
        }),
      };
      setLocal(state => ({
        ...state,
        opportunities: state.opportunities.map(item =>
          item.id === row.id ? row : item
        ),
      }));
      setNotice(
        "Sample/local attachment staged only; no document extraction was run."
      );
      return row;
    },
    [attachOpportunityMutation, demo, local.opportunities, refresh]
  );

  const importLinkedAttachment = useCallback(
    async (input: {
      opportunityId: string;
      version: number;
      attachmentName: string;
    }) => {
      if (demo)
        throw new Error(
          "Sample/local mode cannot download linked attachments. Import an authorized local file instead."
        );
      const row = await importLinkedAttachmentMutation.mutateAsync(input);
      await refresh();
      setNotice(
        "Listed attachment imported. Eligibility review must be repeated before drafting."
      );
      return row;
    },
    [demo, importLinkedAttachmentMutation, refresh]
  );

  const analyzeOpportunity = useCallback(
    async (opportunityId: string): Promise<OpportunityAnalysis | null> => {
      if (demo) {
        setNotice(
          "Sample/local: requirements analysis was not run. No AI request or analysis was created."
        );
        return null;
      }
      const analysis = await analyzeOpportunityMutation.mutateAsync({
        opportunityId,
      });
      setNotice(
        "Requirements analysis is shown for review only. It did not approve evidence, create a response, or submit anything."
      );
      return analysis;
    },
    [analyzeOpportunityMutation, demo]
  );

  const eligibilityReview = useCallback(
    async (input: {
      opportunityId: string;
      version: number;
      requiredStatuses: string[];
      requiredCertifications: string[];
      eligibilityNotes: string;
      dueDate: string;
      value: string | null;
      currency: OpportunityData["currency"];
      geographies: string[];
      capabilities: string[];
    }) => {
      if (!demo) {
        const row = await reviewMutation.mutateAsync(input);
        await refresh();
        setNotice(
          "Eligibility review saved. Drafting still depends on the resulting match and policy."
        );
        return row;
      }
      const current = local.opportunities.find(
        row => row.id === input.opportunityId
      );
      if (!current)
        throw new Error("Local opportunity is no longer available.");
      const row: OpportunityRecord = {
        ...current,
        version: current.version + 1,
        updatedAt: now(),
        data: opportunitySchema.parse({
          ...current.data,
          requiredStatuses: input.requiredStatuses,
          requiredCertifications: input.requiredCertifications,
          eligibilityNotes: input.eligibilityNotes,
          dueDate: input.dueDate,
          value: input.value,
          currency: input.currency,
          geographies: input.geographies,
          capabilities: input.capabilities,
          eligibilityReviewed: true,
        }),
      };
      setLocal(state => ({
        ...state,
        opportunities: state.opportunities.map(item =>
          item.id === row.id ? row : item
        ),
      }));
      setNotice(
        "Sample/local eligibility review saved for comparison only; no notice data was published."
      );
      return row;
    },
    [demo, local.opportunities, refresh, reviewMutation]
  );

  const noLiveWork = useCallback((message: string) => {
    setNotice(message);
    return Promise.resolve();
  }, []);
  const matchAll = useCallback(async () => {
    if (demo)
      return noLiveWork(
        "Sample/local comparisons use the shared deterministic matcher. No matching job was created."
      );
    const result = await matchAllMutation.mutateAsync({});
    await refresh();
    const matchingBatch: {
      count: number;
      hasMore?: boolean;
      nextCursor?: string | null;
    } = result;
    setNotice(
      matchingBatch.hasMore
        ? `${matchingBatch.count} profile-opportunity comparison(s) were recalculated. More matching work remains in the next batch.`
        : `${matchingBatch.count} profile-opportunity comparison(s) were recalculated.`
    );
  }, [demo, matchAllMutation, noLiveWork, refresh]);
  const queueResponse = useCallback(
    async (opportunityId: string, profileId: string) => {
      if (demo)
        return noLiveWork(
          "Sample/local: no AI draft, response job, database record, or workspace was created."
        );
      await queueMutation.mutateAsync({ opportunityId, profileId });
      await refresh();
      setNotice(
        "Response drafting was queued. No draft has been generated, approved, or submitted yet."
      );
    },
    [demo, noLiveWork, queueMutation, refresh]
  );
  const savePolicy = useCallback(
    async (policy: PipelinePolicy) => {
      if (demo) {
        setLocal(state => ({
          ...state,
          settings: { ...state.settings, policy },
        }));
        return noLiveWork(
          "Sample/local policy saved for this session only; no task was registered."
        );
      }
      await savePolicyMutation.mutateAsync({ policy });
      await refresh();
      setNotice("Pipeline policy saved. This did not start a processing run.");
    },
    [demo, noLiveWork, refresh, savePolicyMutation]
  );
  const enablePipeline = useCallback(async () => {
    if (demo)
      return noLiveWork(
        "Sample/local: pipeline remains unpublished. No schedule, AI work, or response job was enabled."
      );
    await enableMutation.mutateAsync({});
    await refresh();
    setNotice(
      "Pipeline schedule enabled. Future runs remain subject to the saved policy; no work is confirmed complete."
    );
  }, [demo, enableMutation, noLiveWork, refresh]);
  const pausePipeline = useCallback(async () => {
    if (demo)
      return noLiveWork(
        "Sample/local: there is no published pipeline to pause."
      );
    await pauseMutation.mutateAsync({});
    await refresh();
    setNotice("Pipeline schedule paused. Existing records were not changed.");
  }, [demo, noLiveWork, pauseMutation, refresh]);
  const processQueue = useCallback(async () => {
    if (demo)
      return noLiveWork(
        "Sample/local: manual processing is unavailable because no queue, AI, or database is present."
      );
    await processMutation.mutateAsync({});
    await refresh();
    setNotice(
      "Manual queue processing finished. Review runs and jobs for results; no response was approved or submitted."
    );
  }, [demo, noLiveWork, processMutation, refresh]);
  const retryJob = useCallback(
    async (id: string) => {
      if (demo)
        return noLiveWork(
          "Sample/local: jobs are not fabricated, so there is nothing to retry."
        );
      await retryMutation.mutateAsync({ id });
      await refresh();
      setNotice("Job retry was queued. It has not completed yet.");
    },
    [demo, noLiveWork, refresh, retryMutation]
  );

  const errors = [
    profilesQuery.error,
    sourcesQuery.error,
    catalogQuery.error,
    opportunitiesQuery.error,
    settingsQuery.error,
    jobsQuery.error,
    runsQuery.error,
    saveProfileMutation.error,
    importProfileMutation.error,
    saveSourceMutation.error,
    syncSourceMutation.error,
    importOpportunitiesMutation.error,
    attachOpportunityMutation.error,
    importLinkedAttachmentMutation.error,
    analyzeOpportunityMutation.error,
    reviewMutation.error,
    matchAllMutation.error,
    queueMutation.error,
    savePolicyMutation.error,
    enableMutation.error,
    pauseMutation.error,
    processMutation.error,
    retryMutation.error,
  ]
    .filter(Boolean)
    .map(error => asMessage(error, "Capture Room request failed."));
  const pending = [
    saveProfileMutation,
    importProfileMutation,
    saveSourceMutation,
    syncSourceMutation,
    importOpportunitiesMutation,
    attachOpportunityMutation,
    importLinkedAttachmentMutation,
    analyzeOpportunityMutation,
    reviewMutation,
    matchAllMutation,
    queueMutation,
    savePolicyMutation,
    enableMutation,
    pauseMutation,
    processMutation,
    retryMutation,
  ].some(mutation => mutation.isPending);
  const model = useMemo<CaptureModel>(
    () => ({
      demo,
      profiles: demo ? local.profiles : (profilesQuery.data ?? []),
      sources: demo ? local.sources : (sourcesQuery.data ?? []),
      catalog: demo ? sourceCatalogLocal : (catalogQuery.data ?? []),
      opportunities: demo ? local.opportunities : remoteOpportunities,
      totalOpportunities: demo
        ? local.opportunities.length
        : (opportunitiesQuery.data?.pages[0]?.total ?? 0),
      hasMoreOpportunities: demo ? false : opportunitiesQuery.hasNextPage,
      loadingMoreOpportunities: demo
        ? false
        : opportunitiesQuery.isFetchingNextPage,
      loadMoreOpportunities,
      settings: demo
        ? local.settings
        : (settingsQuery.data ?? {
            policy: local.settings.policy,
            active: false,
            taskUid: null,
            lastRunAt: null,
          }),
      jobs: demo ? local.jobs : (jobsQuery.data ?? []),
      runs: demo ? local.runs : (runsQuery.data ?? []),
      pending,
      errors,
      notice,
      clearNotice: () => setNotice(""),
      saveProfile,
      importProfileDocument,
      saveSource,
      syncSource,
      importOpportunities,
      attachOpportunityDocument,
      importLinkedAttachment,
      analyzeOpportunity,
      eligibilityReview,
      matchAll,
      queueResponse,
      savePolicy,
      enablePipeline,
      pausePipeline,
      processQueue,
      retryJob,
    }),
    [
      attachOpportunityDocument,
      analyzeOpportunity,
      analyzeOpportunityMutation,
      catalogQuery.data,
      demo,
      eligibilityReview,
      enablePipeline,
      errors,
      importOpportunities,
      importProfileDocument,
      importLinkedAttachment,
      importLinkedAttachmentMutation,
      jobsQuery.data,
      local,
      loadMoreOpportunities,
      matchAll,
      notice,
      opportunitiesQuery.data,
      opportunitiesQuery.hasNextPage,
      opportunitiesQuery.isFetchingNextPage,
      pausePipeline,
      pending,
      processQueue,
      profilesQuery.data,
      queueResponse,
      retryJob,
      runsQuery.data,
      savePolicy,
      saveProfile,
      saveSource,
      settingsQuery.data,
      sourcesQuery.data,
      syncSource,
      remoteOpportunities,
    ]
  );

  const titles: Record<CapturePage, [string, string]> = {
    profiles: [
      "Company profiles",
      "Source facts that govern evidence-led capture decisions.",
    ],
    discovery: [
      "Opportunity discovery",
      "Review notice facts before an eligibility decision or any draft response.",
    ],
    sources: [
      "Authorized sources",
      "Connect permitted feeds or import notices you are allowed to use.",
    ],
    pipeline: [
      "Response pipeline",
      "Published automation stays bounded, reviewable, and opt-in.",
    ],
  };
  const [title, subtitle] = titles[page];

  return (
    <section className="capture-room">
      <header className="capture-header">
        <div>
          <p className="eyebrow">
            CAPTURE ROOM {demo ? "· SAMPLE / LOCAL" : "· AUTHENTICATED"}
          </p>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="capture-trust">
          <ShieldCheck size={16} /> Evidence first
          {pending && (
            <span className="capture-pending">
              <DatabaseZap size={14} /> Saving
            </span>
          )}
        </div>
      </header>
      {demo && (
        <div className="capture-banner sample">
          <DatabaseZap size={16} />
          <span>
            <strong>Sample / local mode.</strong> State lives only in this
            browser session. It does not sync feeds, create jobs, call AI, or
            write a database.
          </span>
        </div>
      )}
      {!demo && errors[0] && (
        <div className="capture-banner error">
          <AlertTriangle size={16} />
          <span>
            <strong>Request needs attention.</strong> {errors[0]}
          </span>
        </div>
      )}
      {notice && (
        <button className="capture-banner notice" onClick={() => setNotice("")}>
          <span>{notice}</span>
          <span aria-hidden="true">×</span>
        </button>
      )}
      {page === "profiles" && <Profiles model={model} />}
      {page === "sources" && <Sources model={model} />}
      {page === "discovery" && (
        <Discovery model={model} onOpenWorkspace={onOpenWorkspace} />
      )}
      {page === "pipeline" && <Pipeline model={model} />}
    </section>
  );
}
