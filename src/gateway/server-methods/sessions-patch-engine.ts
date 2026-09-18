import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import {
  applySessionEntryCanonicalReplacements,
  type SessionEntryCanonicalReplacement,
} from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { resolveCreatorSandbox } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveCanonicalGatewaySessionStoreKey } from "../session-utils.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import * as sessionUnreadAck from "./session-unread-ack.js";
import {
  applyAcpSessionPatch,
  prepareAcpSessionPatch,
  isAcpModelSelectionPatch,
  type PreparedAcpSessionPatch,
} from "./sessions-patch-acp.js";
import {
  prepareSessionPatchArchive,
  prepareSessionPatchArchiveTransition,
  releaseSessionPatchArchive,
} from "./sessions-patch-archive.js";
import {
  createSessionPatchCatalogPreparation,
  type SessionPatchCatalogResult,
} from "./sessions-patch-catalog-preparation.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import { sessionChangedError, unexpectedPatchError } from "./sessions-patch-errors.js";
import {
  prepareSessionPatchRuntimeSelection,
  refreshSessionPatchQueuedSelection,
} from "./sessions-patch-model-selection.js";
import {
  prepareSessionPatchTargets,
  resolveSessionPatchProjectionError,
} from "./sessions-patch-preflight.js";
import type {
  GroupAdmissionResult,
  GroupMutationOperation,
  MutationCoreResult,
  MutationOutcome,
  MutationTarget,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { preparePersonalModelSelection } from "./users-model-account-access.js";

type PatchTargetIdentity = sessionUnreadAck.SessionPatchTargetIdentity;
const { resolveSessionUnreadAck } = sessionUnreadAck;

type ArchiveTransition = Awaited<ReturnType<typeof prepareSessionPatchArchiveTransition>>;

export async function executeSessionPatchMutations(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  diagnostics?: SessionPatchDiagnostics;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  targets: readonly MutationTarget[];
}): Promise<MutationCoreResult> {
  const { client } = params;
  const timing = params.diagnostics?.scope("preflight");
  const cfg = params.context.getRuntimeConfig();
  const operatorCreation = resolveOperatorSessionCreation(client);
  const sandbox = resolveCreatorSandbox(cfg, operatorCreation);
  const creation = { ...operatorCreation, ...(sandbox ? { sandbox } : {}) };
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const callerCanManageCron = client === null || callerScopes.includes(ADMIN_SCOPE);
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  let personalModelSelection: UserModelAccountSelection | undefined;
  try {
    personalModelSelection = preparePersonalModelSelection(params, params.patch.model);
  } catch (error) {
    return { ok: false, error: unexpectedPatchError(params.targets[0]?.key ?? "", error) };
  }
  const permissionRuntime =
    "permissionMode" in params.patch
      ? await import("./sessions-patch-permissions.runtime.js")
      : undefined;
  const preflight = prepareSessionPatchTargets({ ...params, cfg });
  if (!preflight.ok) {
    return preflight;
  }
  const { prepared, preparedByIndex, outcomes } = preflight;
  const applicationErrors = new Map<number, ErrorShape>();

  const catalogs = createSessionPatchCatalogPreparation(
    (agentId) => params.context.loadGatewayModelCatalogSnapshot({ agentId }),
    params.diagnostics,
  );

  if (prepared.length > 0) {
    const releaseArchiveDrains = async () =>
      prepared.forEach((target) => releaseSessionPatchArchive(target.archivePreparation));
    try {
      // Cloud reclaim precedes every mutation mutex; an earlier Move may need one.
      timing?.mark("archive");
      await Promise.all(
        prepared
          .filter((target) => target.fullPatch.archived === true)
          .map(async (target) => {
            try {
              const result = await prepareSessionPatchArchive({
                cfg,
                commitGuard: params.targets[target.index]!.commitGuard,
                context: params.context,
                loadGatewayModelCatalogSnapshot: () => catalogs.load(target.targetAgentId),
                personalModelSelection,
                ...(pluginOwnerId ? { pluginOwnerId } : {}),
                target,
              });
              if (result.ok) {
                target.archivePreparation = result.value;
              } else {
                outcomes[target.index] = result;
              }
            } catch (error) {
              outcomes[target.index] = {
                ok: false,
                error: unexpectedPatchError(target.key, error),
              };
            }
          }),
      );
      timing?.mark("lifecycleAdmission");
      await runExclusiveSessionLifecycleMutation({
        targets: prepared.map((target) => ({
          scope: target.storePath,
          identities: target.lifecycleIdentities,
        })),
        prepare: async () => {
          for (const target of prepared) {
            target.archivePreparation?.drain.handoffToMutation();
          }
        },
        finalize: releaseArchiveDrains,
        run: async () => {
          timing?.mark();

          try {
            const groups = new Map<string, PreparedPatchTarget[]>();
            for (const target of prepared) {
              if (target.fullPatch.archived === true && !target.archivePreparation) {
                continue;
              }
              const groupKey = `${target.storePath}\0${target.targetAgentId}`;
              const group = groups.get(groupKey) ?? [];
              group.push(target);
              groups.set(groupKey, group);
            }
            await Promise.all(
              [...groups.values()].map(async (group) => {
                const first = group[0]!;
                const groupTiming = params.diagnostics?.scope("snapshot");
                try {
                  // Keep every resolver candidate for queued alias revalidation. Label
                  // uniqueness needs only the requested label's owners, not the full store.
                  const selectedSessionKeys = group.flatMap((target) => [
                    target.key,
                    target.canonicalKey,
                    ...target.initialStoreKeys,
                  ]);
                  const requestedLabel = parseSessionLabel(first.fullPatch.label);
                  const archiveTransitions = new Map<number, ArchiveTransition>();
                  const commitGuards = new Set<() => ErrorShape | undefined>();
                  const projectGroup = async (
                    entries: SqliteLifecycleTargetSnapshot,
                    admission: "admitted" | "detached",
                    catalogPreparation?: SessionPatchCatalogResult,
                  ): Promise<GroupMutationOperation> => {
                    const workingStore = Object.fromEntries(
                      entries.flatMap(({ entry, sessionKey }) =>
                        isInternalSessionEffectsKey(sessionKey)
                          ? []
                          : [[sessionKey, entry] as const],
                      ),
                    );
                    const labelOwners = new SessionLabelOwnerIndex(workingStore);
                    const replacements: SessionEntryCanonicalReplacement[] = [];
                    const projectedOutcomes: MutationOutcome[] = [];
                    let committedGroupOutcomes: MutationOutcome[] | undefined;
                    let externalPreparationStarted = false;
                    const projectTargets = async (
                      startIndex: number,
                    ): Promise<GroupMutationOperation> => {
                      for (let groupIndex = startIndex; groupIndex < group.length; groupIndex++) {
                        const target = group[groupIndex]!;
                        let continuationStarted = false;
                        try {
                          const authorityError = params.targets[target.index]!.commitGuard();
                          if (authorityError) {
                            projectedOutcomes.push({ ok: false, error: authorityError });
                            continue;
                          }
                          // Preflight facts can stale behind the writer queue; resolve this snapshot
                          // again so a new legacy alias is rejected rather than promoted or deleted.
                          const {
                            entry: existingEntry,
                            primaryKey,
                            target: currentTarget,
                          } = resolveCanonicalGatewaySessionStoreKey({
                            cfg,
                            key: target.key,
                            store: workingStore,
                            ...(target.requestedAgentId
                              ? { agentId: target.requestedAgentId }
                              : {}),
                          });
                          const projectionError = resolveSessionPatchProjectionError({
                            cfg,
                            client,
                            target,
                            existingEntry,
                            primaryKey,
                          });
                          if (projectionError) {
                            projectedOutcomes.push({ ok: false, error: projectionError });
                            continue;
                          }
                          const candidateKeys = currentTarget.storeKeys;
                          const unreadAck = resolveSessionUnreadAck(
                            existingEntry,
                            target.fullPatch,
                          );
                          if (unreadAck.kind === "missing") {
                            projectedOutcomes.push({
                              ok: false,
                              error: sessionChangedError(target.key),
                            });
                            continue;
                          }
                          if (unreadAck.kind === "stale") {
                            const authorizationFailure =
                              params.targets[target.index]!.commitGuard();
                            if (authorizationFailure) {
                              projectedOutcomes.push({ ok: false, error: authorizationFailure });
                              continue;
                            }
                            // A newer explicit marker owns the session until a later activation.
                            projectedOutcomes.push({
                              ok: true,
                              applied: false,
                              accessChanged: false,
                              entry: unreadAck.entry,
                            });
                            continue;
                          }
                          let acpPatch: PreparedAcpSessionPatch | undefined;
                          const currentSelection =
                            getCommittedSessionExecutionSelection(existingEntry);
                          if (
                            existingEntry &&
                            currentSelection &&
                            isAcpExecutionSelection(currentSelection) &&
                            isAcpModelSelectionPatch(target.fullPatch)
                          ) {
                            const preparedAcp = await prepareAcpSessionPatch({
                              cfg,
                              sessionKey: primaryKey,
                              agentId: target.targetAgentId,
                              entry: existingEntry,
                              patch: target.fullPatch,
                              assertCurrent: () => {
                                const error = params.targets[target.index]!.commitGuard();
                                if (error) {
                                  throw new SessionMutationAuthorizationChangedError(error);
                                }
                              },
                            });
                            if (!preparedAcp.ok) {
                              projectedOutcomes.push(preparedAcp);
                              continue;
                            }
                            acpPatch = preparedAcp.prepared;
                          }
                          const projectionParams = {
                            agentId: target.targetAgentId,
                            // Detached preparation must not replay earlier controls or restoration
                            // when a later target needs the catalog.
                            mode: externalPreparationStarted ? "ordered" : "prepare",
                            catalog: catalogPreparation,
                            projection: {
                              cfg,
                              creation,
                              existingEntry,
                              isLabelInUse: (label) =>
                                labelOwners.isLabelInUse(label, candidateKeys),
                              storeKey: primaryKey,
                              agentId: target.requestedAgentId,
                              patch: target.fullPatch,
                              ...(acpPatch ? { preparedExecution: acpPatch.execution } : {}),
                              archivedBy: target.archiveActor,
                              personalModelSelection,
                            },
                          } satisfies Parameters<typeof catalogs.project>[0];
                          const projection = await catalogs.project(projectionParams);
                          if (projection.kind === "model-catalog") {
                            // No external work has started. Discard this provisional
                            // projection and read fresh rows after catalog preparation.
                            return { result: projection };
                          }
                          const projected = projection.result;
                          if (!projected.ok) {
                            projectedOutcomes.push(projected);
                            continue;
                          }
                          const runtimeSelection = await prepareSessionPatchRuntimeSelection({
                            cfg,
                            agentId: target.targetAgentId,
                            patch: target.fullPatch,
                            entry: projected.entry,
                            execution: projected.execution,
                            placement: { context: params.context, sessionKey: primaryKey },
                          });
                          if (!runtimeSelection.ok) {
                            projectedOutcomes.push(runtimeSelection);
                            continue;
                          }
                          const authorizationFailure = params.targets[target.index]!.commitGuard();
                          if (authorizationFailure) {
                            projectedOutcomes.push({ ok: false, error: authorizationFailure });
                            continue;
                          }
                          if (
                            existingEntry &&
                            typeof target.fullPatch.archived === "boolean" &&
                            (existingEntry.worktree ||
                              existingEntry.archivedAt !== undefined ||
                              target.fullPatch.archived)
                          ) {
                            const worktreeTiming = params.diagnostics?.scope("worktree");
                            let transition: ArchiveTransition;
                            try {
                              externalPreparationStarted = true;
                              transition = await prepareSessionPatchArchiveTransition({
                                archived: target.fullPatch.archived,
                                entry: existingEntry,
                                context: params.context,
                                scope: {
                                  agentId: target.targetAgentId,
                                  sessionKey: primaryKey,
                                  storePath: target.storePath,
                                },
                                authorize: params.targets[target.index]!.commitGuard,
                                preparation: target.archivePreparation,
                              });
                            } finally {
                              worktreeTiming?.finish();
                            }
                            archiveTransitions.set(target.index, transition);
                          }
                          if (permissionRuntime && existingEntry?.sessionId) {
                            const permission =
                              permissionRuntime.prepareSessionPatchPermissionChange({
                                context: params.context,
                                sessionId: existingEntry.sessionId,
                                sessionKey: target.canonicalKey,
                                agentId: target.targetAgentId,
                                assertCurrent: params.targets[target.index]!.commitGuard,
                              });
                            if (!permission.ok) {
                              projectedOutcomes.push(permission);
                              continue;
                            }
                            target.permissionChange = permission.change;
                          }
                          const previousSessionKeys = candidateKeys.filter(
                            (sessionKey) => sessionKey !== primaryKey && workingStore[sessionKey],
                          );
                          const recordProjection = (
                            entry: SessionEntry,
                            validate: (() => ErrorShape | undefined) | undefined,
                          ) => {
                            commitGuards.add(params.targets[target.index]!.commitGuard);
                            if (validate) {
                              commitGuards.add(validate);
                            }
                            replacements.push({
                              entry,
                              previousSessionKeys,
                              sessionKey: primaryKey,
                            });
                            const cloned = labelOwners.replaceEntry(
                              candidateKeys,
                              primaryKey,
                              entry,
                            );
                            projectedOutcomes.push({
                              ok: true,
                              applied: true,
                              // The replacement writer validates this row snapshot at COMMIT.
                              // Unknown generations and canonical moves still invalidate access.
                              accessChanged:
                                primaryKey !== target.canonicalKey ||
                                previousSessionKeys.length > 0 ||
                                hasSessionReadAccessChanged(existingEntry, entry),
                              entry: cloned,
                            });
                          };
                          if (acpPatch) {
                            const preparedExecution = acpPatch.execution;
                            externalPreparationStarted = true;
                            const applied = await applyAcpSessionPatch({
                              prepared: acpPatch,
                              selectionCommitted: () => {
                                const outcome = committedGroupOutcomes?.[groupIndex];
                                return outcome?.ok === true && outcome.applied;
                              },
                              commitAccepted: async (accepted) => {
                                const acceptedProjection = await catalogs.project({
                                  ...projectionParams,
                                  mode: "ordered",
                                  projection: {
                                    ...projectionParams.projection,
                                    preparedExecution: {
                                      ...preparedExecution,
                                      selection: accepted,
                                    },
                                  },
                                });
                                if (acceptedProjection.kind !== "complete") {
                                  throw new Error("Accepted model projection did not finish");
                                }
                                if (!acceptedProjection.result.ok) {
                                  throw new SessionMutationAuthorizationChangedError(
                                    acceptedProjection.result.error,
                                  );
                                }
                                const acceptedEntry = acceptedProjection.result.entry;
                                const acceptedRuntime = await prepareSessionPatchRuntimeSelection({
                                  cfg,
                                  agentId: target.targetAgentId,
                                  patch: target.fullPatch,
                                  entry: acceptedEntry,
                                  execution: acceptedProjection.result.execution,
                                  placement: { context: params.context, sessionKey: primaryKey },
                                });
                                if (!acceptedRuntime.ok) {
                                  throw new SessionMutationAuthorizationChangedError(
                                    acceptedRuntime.error,
                                  );
                                }
                                continuationStarted = true;
                                acceptedEntry.updatedAt = Date.now();
                                recordProjection(acceptedEntry, acceptedRuntime.validate);
                                return {
                                  ok: true,
                                  operation: await projectTargets(groupIndex + 1),
                                };
                              },
                            });
                            if (!applied.ok) {
                              if (continuationStarted) {
                                if (committedGroupOutcomes) {
                                  applicationErrors.set(target.index, applied.error);
                                  return {
                                    result: { kind: "complete", outcomes: committedGroupOutcomes },
                                  };
                                }
                                throw new SessionMutationAuthorizationChangedError(applied.error);
                              }
                              projectedOutcomes.push(applied);
                              continue;
                            }
                            return applied.operation;
                          }
                          recordProjection(projected.entry, runtimeSelection.validate);
                        } catch (error) {
                          if (continuationStarted) {
                            throw error;
                          }
                          projectedOutcomes.push({
                            ok: false,
                            error: unexpectedPatchError(target.key, error),
                          });
                        }
                      }
                      if (admission === "admitted") {
                        return {
                          replacements,
                          result: { kind: "complete", outcomes: projectedOutcomes },
                        };
                      }
                      // Detached ACP actors must enclose the physical combined commit,
                      // not only projection of the accepted backend result.
                      groupTiming?.mark("commit");
                      committedGroupOutcomes = replacements.length
                        ? await applySessionEntryCanonicalReplacements({
                            ...groupStore,
                            update: (currentEntries) => {
                              assertLifecycleTargetSnapshotUnchanged(
                                entries,
                                currentEntries,
                                "session patch",
                              );
                              return { replacements, result: projectedOutcomes };
                            },
                          })
                        : projectedOutcomes;
                      return { result: { kind: "complete", outcomes: committedGroupOutcomes } };
                    };
                    return await projectTargets(0);
                  };
                  const groupStore = {
                    assertCommitAllowed: () => {
                      // Fresh selections remain human-owned through the final commit;
                      // existing session pins are intentionally not rebound to the caller.
                      personalModelSelection?.assertCurrent();
                      for (const guard of commitGuards) {
                        const error = guard();
                        if (error) {
                          throw new SessionMutationAuthorizationChangedError(error);
                        }
                      }
                      for (const transition of archiveTransitions.values()) {
                        transition.assertCommitAllowed();
                      }
                    },
                    agentId: first.targetAgentId,
                    sessionKeys: selectedSessionKeys,
                    ...(requestedLabel.ok ? { includeLabelOwners: requestedLabel.label } : {}),
                    storePath: first.storePath,
                    skipMaintenance: true,
                  };
                  const targetKeys = new Set(selectedSessionKeys);
                  const applyGroup = async (catalog?: SessionPatchCatalogResult) => {
                    groupTiming?.mark("snapshot");
                    const admitted =
                      await applySessionEntryCanonicalReplacements<GroupAdmissionResult>({
                        ...groupStore,
                        update: (entries) => {
                          // Model and reset requests prepare live execution ownership,
                          // including ACP controls for ordinary-looking session keys.
                          const needsExternalPreparation =
                            first.fullPatch.model !== undefined ||
                            first.fullPatch.agentRuntime !== undefined ||
                            (typeof first.fullPatch.archived === "boolean" &&
                              entries.some(
                                ({ sessionKey, entry }) =>
                                  targetKeys.has(sessionKey) && entry.worktree,
                              ));
                          if (needsExternalPreparation) {
                            return { result: { kind: "detached", snapshot: entries } };
                          }
                          // Ordinary metadata projection and commit retain one writer admission.
                          groupTiming?.mark("projection");
                          return projectGroup(entries, "admitted", catalog).then((operation) => {
                            groupTiming?.mark("commit");
                            return operation;
                          });
                        },
                      });
                    if (admitted.kind !== "detached") {
                      return admitted;
                    }
                    groupTiming?.mark("projection");
                    const operation = await projectGroup(admitted.snapshot, "detached", catalog);
                    return operation.result;
                  };
                  let result = await applyGroup();
                  if (result.kind === "model-catalog") {
                    for (const target of group) {
                      target.permissionChange?.finish();
                      target.permissionChange = undefined;
                    }
                    commitGuards.clear();
                    archiveTransitions.clear();
                    groupTiming?.mark();
                    const catalog = await catalogs.prepare(first.targetAgentId);
                    result = await applyGroup(catalog);
                  }
                  if (result.kind !== "complete") {
                    throw new Error("Session patch catalog preparation did not complete");
                  }
                  const groupOutcomes = result.outcomes;
                  for (const [groupIndex, target] of group.entries()) {
                    const outcome = groupOutcomes[groupIndex]!;
                    outcomes[target.index] = outcome;
                    if (
                      outcome.ok &&
                      outcome.applied &&
                      ("agentRuntime" in target.fullPatch || "model" in target.fullPatch)
                    ) {
                      refreshSessionPatchQueuedSelection({
                        cfg,
                        entry: outcome.entry,
                        patch: target.fullPatch,
                        sessionKey: target.canonicalKey,
                        agentId: target.targetAgentId,
                        catalog: (await catalogs.available(target.targetAgentId))?.entries,
                      });
                    }
                    const afterCommit = archiveTransitions.get(target.index)?.afterCommit;
                    if (outcome.ok && outcome.applied && afterCommit) {
                      groupTiming?.mark("worktreeCleanup");
                      await afterCommit(outcome.entry);
                    }
                  }
                } catch (error) {
                  for (const target of group) {
                    outcomes[target.index] = {
                      ok: false,
                      error: unexpectedPatchError(target.key, error),
                    };
                  }
                } finally {
                  groupTiming?.finish();
                }
              }),
            );
            // Keep runtime acknowledgement in the mutation lane. A second browser
            // must not persist a newer mode and then have this older update win.
            timing?.mark("permissions");
            for (const target of prepared) {
              const outcome = outcomes[target.index];
              if (!target.permissionChange || !outcome?.ok || !outcome.applied) {
                continue;
              }
              const error = await target.permissionChange.apply(
                outcome.entry.permissionMode ?? null,
              );
              if (error) {
                applicationErrors.set(target.index, error);
              }
            }
          } finally {
            timing?.mark("lifecycleFinalize");
          }
        },
      });
    } finally {
      timing?.mark("cleanup");
      for (const target of prepared) {
        target.permissionChange?.finish();
      }
      await releaseArchiveDrains();
    }
  }

  timing?.mark("effects");
  await publishSessionPatchEffects({
    cfg,
    context: params.context,
    callerScopes,
    callerCanManageCron,
    category: params.patch.category,
    targets: prepared.flatMap((target) => {
      const outcome = outcomes[target.index];
      return outcome?.ok && outcome.applied
        ? [{ target, entry: outcome.entry, accessChanged: outcome.accessChanged }]
        : [];
    }),
  });
  timing?.finish();

  // Runtime application can fail after commit. Publish every saved field's
  // normal effects before returning the application error to the caller.
  for (const [index, error] of applicationErrors) {
    outcomes[index] = { ok: false, error };
  }
  return {
    ok: true,
    cfg,
    outcomes: outcomes as MutationOutcome[],
    preparedByIndex,
    catalogs,
  };
}
