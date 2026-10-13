import { z } from 'zod';
import {
  bookmarkInputSchema,
  skillInputSchema,
  skillRequestInputSchema,
  updateInputSchema,
} from '../../shared/skills';
import {
  createGroupSchema,
  decideJoinSchema,
  groupMemberSchema,
  groupMembersSchema,
  groupRefSchema,
  joinRequestSchema,
  setRoleSchema,
  updateGroupSchema,
} from '../../shared/groups';
import { copyFile, stat } from 'node:fs/promises';
import { IpcChannel, PreloadChannel, type LockStatus, type SystemInfo } from '../../shared/ipc';
import { fileRefSchema, sendBytesSchema, sendPathSchema } from '../../shared/files';
import {
  endCallSchema,
  markConnectedSchema,
  sendSignalSchema,
  startCallSchema,
} from '../../shared/calls';
import {
  accountInputSchema,
  deviceRefSchema,
  emptyRequestSchema,
  networkTestSchema,
  requestAddressSchema,
  requestNearbySchema,
  setVerifiedSchema,
} from '../../shared/ipc-schemas';
import { settingUpdateSchema } from '../../shared/settings';
import {
  conversationRefSchema,
  deleteMessageSchema,
  editMessageSchema,
  listConversationsSchema,
  listMessagesSchema,
  messagePositionSchema,
  reactSchema,
  searchSchema,
  sendMessageSchema,
  setActiveSchema,
  setDraftSchema,
  setFlagsSchema,
} from '../../shared/chat';
import type { AppServices } from '../app-services';
import type { DatabaseHandle } from '../db/connection';
import { runIntegrityCheck } from '../db/integrity';
import { migrations } from '../db/migrations';
import type { AppPaths } from '../platform/paths';
import { entry, IpcRequestError, type RouteEntry } from './router';

export interface RouteDeps {
  database: DatabaseHandle;
  services: AppServices;
  paths: AppPaths;
  appInfo: SystemInfo['app'];
  os: SystemInfo['os'];
  onSettingsChanged(): void;
  onAccountChanged(): void;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  /** Shows a save dialog; resolves with the chosen path or null. */
  chooseSavePath(defaultName: string): Promise<string | null>;
  /** Shows a folder picker; resolves with the chosen folder or null. */
  chooseFolder(title: string, buttonLabel: string): Promise<string | null>;
  /** Restarts the app (after a restore or wipe has been scheduled). */
  relaunch(): void;
  onLockChanged(): void;
}

export function buildRoutes(deps: RouteDeps): RouteEntry[] {
  const { services } = deps;
  const lockStatus = (): LockStatus => ({
    enabled: services.lock.enabled,
    locked: services.lock.locked,
    retryAfterMs: services.lock.retryAfterMs(),
  });
  return [
    entry({
      channel: IpcChannel.settingsGetAll,
      schema: emptyRequestSchema,
      handle: () => services.settings.getAll(),
    }),
    entry({
      channel: IpcChannel.settingsSet,
      schema: settingUpdateSchema,
      handle: (update) => {
        const next = services.settings.set(update);
        services.onSettingChanged(update.key);
        deps.onSettingsChanged();
        return next;
      },
    }),
    entry({
      channel: IpcChannel.systemInfo,
      schema: emptyRequestSchema,
      handle: async (): Promise<SystemInfo> => {
        const { sqlite } = deps.database;
        return {
          app: deps.appInfo,
          runtime: {
            electron: process.versions.electron ?? 'unknown',
            chrome: process.versions.chrome ?? 'unknown',
            node: process.versions.node,
            v8: process.versions.v8,
          },
          os: deps.os,
          paths: deps.paths,
          database: {
            schemaVersion: deps.database.migration.currentVersion,
            latestKnownVersion: migrations.length,
            sqliteVersion: (sqlite.prepare('SELECT sqlite_version() AS v').get() as { v: string })
              .v,
            journalMode: String(sqlite.pragma('journal_mode', { simple: true })),
            sizeBytes: await fileSize(deps.paths.database),
          },
          networkMode: 'lan-only',
        };
      },
    }),
    entry({
      channel: IpcChannel.dbIntegrityCheck,
      schema: emptyRequestSchema,
      handle: () => runIntegrityCheck(deps.database.sqlite),
    }),
    entry({
      channel: IpcChannel.openDataDirectory,
      schema: emptyRequestSchema,
      handle: async () => {
        const error = await deps.openPath(deps.paths.userData);
        if (error) throw new IpcRequestError('unavailable', 'Could not open the data folder.');
        return null;
      },
    }),
    entry({
      channel: IpcChannel.accountGet,
      schema: emptyRequestSchema,
      handle: () => services.identity.getAccount(),
    }),
    entry({
      channel: IpcChannel.accountSave,
      schema: accountInputSchema,
      handle: (input) => {
        const account = services.identity.saveAccount(input);
        services.onAccountChanged();
        deps.onAccountChanged();
        return account;
      },
    }),
    entry({
      channel: IpcChannel.identityGet,
      schema: emptyRequestSchema,
      handle: () => services.identity.info(),
    }),
    entry({
      channel: IpcChannel.contactsList,
      schema: emptyRequestSchema,
      handle: () => services.contacts.list(),
    }),
    entry({
      channel: IpcChannel.contactsRequestNearby,
      schema: requestNearbySchema,
      handle: ({ deviceId, note }) => services.contacts.requestNearby(deviceId, note),
    }),
    entry({
      channel: IpcChannel.contactsRequestAddress,
      schema: requestAddressSchema,
      handle: ({ host, port, note }) => services.contacts.request(host, port, null, note),
    }),
    entry({
      channel: IpcChannel.contactsAccept,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => services.contacts.accept(deviceId),
    }),
    entry({
      channel: IpcChannel.contactsDecline,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => {
        services.contacts.decline(deviceId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.contactsBlock,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => {
        services.contacts.block(deviceId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.contactsUnblock,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => {
        services.contacts.unblock(deviceId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.contactsRemove,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => {
        services.contacts.remove(deviceId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.contactsSetVerified,
      schema: setVerifiedSchema,
      handle: ({ deviceId, verified }) => services.contacts.setVerified(deviceId, verified),
    }),
    entry({
      channel: IpcChannel.nearbyList,
      schema: emptyRequestSchema,
      handle: () => services.contacts.nearby(),
    }),
    entry({
      channel: IpcChannel.networkStatus,
      schema: emptyRequestSchema,
      handle: () => services.networkStatus(),
    }),
    entry({
      channel: IpcChannel.networkTest,
      schema: networkTestSchema,
      handle: ({ host, port }) => services.peers.testConnection(host, port),
    }),
    entry({
      channel: IpcChannel.chatListConversations,
      schema: listConversationsSchema,
      handle: ({ archived }) => services.chat.listConversations(archived),
    }),
    entry({
      channel: IpcChannel.chatGetConversation,
      schema: conversationRefSchema,
      handle: ({ conversationId }) => services.chat.getConversation(conversationId),
    }),
    entry({
      channel: IpcChannel.chatOpenDirect,
      schema: deviceRefSchema,
      handle: ({ deviceId }) => services.chat.openDirect(deviceId),
    }),
    entry({
      channel: IpcChannel.chatListMessages,
      schema: listMessagesSchema,
      handle: ({ conversationId, before, limit }) =>
        services.chat.listMessages(conversationId, before, limit),
    }),
    entry({
      channel: IpcChannel.chatSend,
      schema: sendMessageSchema,
      handle: ({ conversationId, body, replyToId, mentions }) =>
        services.chat.send(conversationId, body, replyToId, mentions ? { mentions } : {}),
    }),
    entry({
      channel: IpcChannel.chatEdit,
      schema: editMessageSchema,
      handle: ({ messageId, body }) => services.chat.edit(messageId, body),
    }),
    entry({
      channel: IpcChannel.chatDelete,
      schema: deleteMessageSchema,
      handle: ({ messageId, forEveryone }) => {
        services.chat.delete(messageId, forEveryone);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.chatReact,
      schema: reactSchema,
      handle: ({ messageId, emoji, on }) => services.chat.react(messageId, emoji, on),
    }),
    entry({
      channel: IpcChannel.chatMarkRead,
      schema: conversationRefSchema,
      handle: ({ conversationId }) => {
        services.chat.markRead(conversationId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.chatSetActive,
      schema: setActiveSchema,
      handle: ({ conversationId }) => {
        services.chat.setActive(conversationId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.chatSetDraft,
      schema: setDraftSchema,
      handle: ({ conversationId, draft }) => {
        services.chat.setDraft(conversationId, draft);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.chatSetFlags,
      schema: setFlagsSchema,
      handle: ({ conversationId, ...flags }) =>
        services.chat.setFlags(conversationId, stripUndefined(flags)),
    }),
    entry({
      channel: IpcChannel.chatTyping,
      schema: conversationRefSchema,
      handle: ({ conversationId }) => {
        services.chat.typing(conversationId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.chatSearch,
      schema: searchSchema,
      handle: ({ query, conversationId }) => services.chat.search(query, conversationId),
    }),
    entry({
      channel: IpcChannel.chatMessagePosition,
      schema: messagePositionSchema,
      handle: ({ conversationId, messageId }) =>
        services.chat.messagePosition(conversationId, messageId),
    }),
    entry({
      channel: PreloadChannel.filesSendPath,
      schema: sendPathSchema,
      handle: ({ conversationId, path }) => services.transfers.sendPath(conversationId, path),
    }),
    entry({
      channel: IpcChannel.filesSendBytes,
      schema: sendBytesSchema,
      handle: ({ conversationId, name, mime, kind, durationMs, data }) =>
        services.transfers.sendBytes(conversationId, name, mime, kind, durationMs, data),
    }),
    entry({
      channel: IpcChannel.filesAccept,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        await services.transfers.accept(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesDecline,
      schema: fileRefSchema,
      handle: ({ fileId }) => {
        services.transfers.decline(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesPause,
      schema: fileRefSchema,
      handle: ({ fileId }) => {
        services.transfers.pause(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesResume,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        await services.transfers.resume(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesCancel,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        await services.transfers.cancel(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesSaveAs,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        const { path, name } = services.transfers.pathForUser(fileId);
        const target = await deps.chooseSavePath(name);
        if (!target) return { saved: false };
        await copyFile(path, target);
        return { saved: true };
      },
    }),
    entry({
      channel: IpcChannel.filesShowInFolder,
      schema: fileRefSchema,
      handle: ({ fileId }) => {
        deps.showItemInFolder(services.transfers.pathForUser(fileId).path);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesOpen,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        const { path, executable } = services.transfers.pathForUser(fileId);
        if (executable) {
          throw new IpcRequestError(
            'rejected',
            'MeshTalk does not open programs or scripts. Use Show in folder if you trust it.',
          );
        }
        const error = await deps.openPath(path);
        if (error)
          throw new IpcRequestError('unavailable', 'No app on this computer can open this file.');
        return null;
      },
    }),
    entry({
      channel: IpcChannel.filesRemove,
      schema: fileRefSchema,
      handle: async ({ fileId }) => {
        await services.transfers.remove(fileId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.transfersList,
      schema: emptyRequestSchema,
      handle: () => services.transfers.list(),
    }),
    entry({
      channel: IpcChannel.storageUsage,
      schema: emptyRequestSchema,
      handle: async () => ({
        ...(await services.transfers.usage()),
        databaseBytes: await fileSize(deps.paths.database),
      }),
    }),
    entry({
      channel: IpcChannel.storageClearPartial,
      schema: emptyRequestSchema,
      handle: async () => ({ removed: await services.transfers.clearPartial() }),
    }),
    entry({
      channel: IpcChannel.callStart,
      schema: startCallSchema,
      handle: ({ conversationId, kind }) => services.calls.start(conversationId, kind),
    }),
    entry({
      channel: IpcChannel.callSignal,
      schema: sendSignalSchema,
      handle: ({ callId, signal }) => {
        services.calls.signal(callId, signal);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.callEnd,
      schema: endCallSchema,
      handle: ({ callId, reason }) => {
        services.calls.end(callId, reason);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.callConnected,
      schema: markConnectedSchema,
      handle: ({ callId, relayed }) => {
        services.calls.markConnected(callId, relayed);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.callHistory,
      schema: emptyRequestSchema,
      handle: () => ({ calls: services.calls.history(), missed: services.calls.missedCount() }),
    }),
    entry({
      channel: IpcChannel.callMarkSeen,
      schema: emptyRequestSchema,
      handle: () => {
        services.calls.markSeen();
        return null;
      },
    }),
    entry({
      channel: IpcChannel.groupsList,
      schema: emptyRequestSchema,
      handle: () => services.groups.list(),
    }),
    entry({
      channel: IpcChannel.groupsGet,
      schema: groupRefSchema,
      handle: ({ groupId }) => services.groups.details(groupId),
    }),
    entry({
      channel: IpcChannel.groupsCreate,
      schema: createGroupSchema,
      handle: (input) => services.groups.create(input),
    }),
    entry({
      channel: IpcChannel.groupsUpdate,
      schema: updateGroupSchema,
      handle: ({ groupId, ...fields }) => services.groups.update(groupId, stripUndefined(fields)),
    }),
    entry({
      channel: IpcChannel.groupsInvite,
      schema: groupMembersSchema,
      handle: ({ groupId, deviceIds }) => services.groups.invite(groupId, deviceIds),
    }),
    entry({
      channel: IpcChannel.groupsRemoveMember,
      schema: groupMemberSchema,
      handle: ({ groupId, deviceId }) => services.groups.removeMember(groupId, deviceId),
    }),
    entry({
      channel: IpcChannel.groupsSetRole,
      schema: setRoleSchema,
      handle: ({ groupId, deviceId, role }) => services.groups.setRole(groupId, deviceId, role),
    }),
    entry({
      channel: IpcChannel.groupsTransferOwnership,
      schema: groupMemberSchema,
      handle: ({ groupId, deviceId }) => services.groups.transferOwnership(groupId, deviceId),
    }),
    entry({
      channel: IpcChannel.groupsLeave,
      schema: groupRefSchema,
      handle: ({ groupId }) => {
        services.groups.leave(groupId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.groupsDelete,
      schema: groupRefSchema,
      handle: ({ groupId }) => {
        services.groups.deleteGroup(groupId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.groupsAcceptInvite,
      schema: groupRefSchema,
      handle: ({ groupId }) => services.groups.acceptInvite(groupId),
    }),
    entry({
      channel: IpcChannel.groupsDeclineInvite,
      schema: groupRefSchema,
      handle: ({ groupId }) => {
        services.groups.declineInvite(groupId);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.groupsDiscover,
      schema: emptyRequestSchema,
      handle: () => services.groups.discover(),
    }),
    entry({
      channel: IpcChannel.groupsRequestJoin,
      schema: joinRequestSchema,
      handle: ({ groupId, adminDeviceId, note }) => {
        services.groups.requestJoin(groupId, adminDeviceId, note);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.groupsDecideJoin,
      schema: decideJoinSchema,
      handle: ({ groupId, deviceId, approve }) =>
        services.groups.decideJoin(groupId, deviceId, approve),
    }),
    entry({
      channel: IpcChannel.skillsMine,
      schema: emptyRequestSchema,
      handle: () => ({ skills: services.skills.mySkills(), updates: services.skills.myUpdates() }),
    }),
    entry({
      channel: IpcChannel.skillsSave,
      schema: skillInputSchema,
      handle: (input) => services.skills.saveSkill(input),
    }),
    entry({
      channel: IpcChannel.skillsDelete,
      schema: idSchema,
      handle: ({ id }) => {
        services.skills.deleteSkill(id);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.skillsPostUpdate,
      schema: updateInputSchema,
      handle: (input) => services.skills.postUpdate(input),
    }),
    entry({
      channel: IpcChannel.skillsDeleteUpdate,
      schema: idSchema,
      handle: ({ id }) => {
        services.skills.deleteUpdate(id);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.skillsDirectory,
      schema: emptyRequestSchema,
      handle: () => ({ profiles: services.skills.profiles(), similar: services.skills.similar() }),
    }),
    entry({
      channel: IpcChannel.skillsSearch,
      schema: z.object({ query: z.string().trim().max(200) }).strict(),
      handle: ({ query }) => services.skills.search(query),
    }),
    entry({
      channel: IpcChannel.skillsRefresh,
      schema: emptyRequestSchema,
      handle: () => ({ asked: services.skills.refresh() }),
    }),
    entry({
      channel: IpcChannel.skillsRequest,
      schema: skillRequestInputSchema,
      handle: ({ deviceId, kind, topic, note }) =>
        services.skills.sendRequest(deviceId, kind, topic, note),
    }),
    entry({
      channel: IpcChannel.skillsRespond,
      schema: z.object({ id: z.string().uuid(), accept: z.boolean() }).strict(),
      handle: ({ id, accept }) => {
        services.skills.respond(id, accept);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.skillsRequests,
      schema: emptyRequestSchema,
      handle: () => services.skills.requests(),
    }),
    entry({
      channel: IpcChannel.bookmarksList,
      schema: emptyRequestSchema,
      handle: () => services.skills.bookmarks(),
    }),
    entry({
      channel: IpcChannel.bookmarksAdd,
      schema: bookmarkInputSchema,
      handle: (input) => services.skills.addBookmark(input),
    }),
    entry({
      channel: IpcChannel.bookmarksRemove,
      schema: idSchema,
      handle: ({ id }) => {
        services.skills.removeBookmark(id);
        return null;
      },
    }),
    entry({
      channel: IpcChannel.lockStatus,
      schema: emptyRequestSchema,
      handle: () => lockStatus(),
    }),
    entry({
      channel: IpcChannel.lockUnlock,
      schema: z.object({ pin: z.string().max(128) }).strict(),
      handle: async ({ pin }) => {
        await services.lock.unlock(pin);
        deps.onLockChanged();
        return lockStatus();
      },
    }),
    entry({
      channel: IpcChannel.lockNow,
      schema: emptyRequestSchema,
      handle: () => {
        if (services.lock.lock()) deps.onLockChanged();
        return lockStatus();
      },
    }),
    entry({
      channel: IpcChannel.lockSetPin,
      schema: z
        .object({ pin: z.string().max(128), currentPin: z.string().max(128).nullable() })
        .strict(),
      handle: async ({ pin, currentPin }) => {
        await services.lock.setPin(pin, currentPin);
        deps.onLockChanged();
        return lockStatus();
      },
    }),
    entry({
      channel: IpcChannel.lockDisable,
      schema: z.object({ pin: z.string().max(128) }).strict(),
      handle: async ({ pin }) => {
        await services.lock.disable(pin);
        deps.onLockChanged();
        return lockStatus();
      },
    }),
    entry({
      channel: IpcChannel.dataBackup,
      schema: z.object({ passphrase: z.string().max(256).nullable() }).strict(),
      handle: async ({ passphrase }) => {
        const target = await deps.chooseFolder(
          'Choose where to save the backup',
          'Save backup here',
        );
        if (!target) return null;
        const { path, manifest } = await services.backups.create(target, passphrase);
        return { path, fileCount: manifest.fileCount, fileBytes: manifest.fileBytes };
      },
    }),
    entry({
      channel: IpcChannel.dataChooseBackup,
      schema: emptyRequestSchema,
      handle: async () => {
        const path = await deps.chooseFolder('Choose a MeshTalk backup folder', 'Use this backup');
        if (!path) return null;
        const m = await services.backups.inspect(path);
        return {
          path,
          createdAt: m.createdAt,
          appVersion: m.appVersion,
          fileCount: m.fileCount,
          fileBytes: m.fileBytes,
          hasIdentity: m.hasIdentity,
          sameDevice: m.deviceId === services.identity.deviceId,
        };
      },
    }),
    entry({
      channel: IpcChannel.dataRestore,
      schema: z
        .object({ path: z.string().min(1).max(4096), passphrase: z.string().max(256).nullable() })
        .strict(),
      handle: async ({ path, passphrase }) => {
        const result = await services.backups.stageRestore(path, passphrase);
        if (!result.needsPassphrase) setTimeout(() => deps.relaunch(), 300);
        return result;
      },
    }),
    entry({
      channel: IpcChannel.dataExport,
      schema: emptyRequestSchema,
      handle: async () => {
        const target = await deps.chooseFolder('Choose where to save the export', 'Export here');
        if (!target) return null;
        return { path: await services.backups.exportJson(target, () => services.collectExport()) };
      },
    }),
    entry({
      channel: IpcChannel.dataWipe,
      schema: z.object({ confirm: z.literal('DELETE') }).strict(),
      handle: async () => {
        await services.backups.requestWipe();
        setTimeout(() => deps.relaunch(), 300);
        return null;
      },
    }),
  ];
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** zod's optional fields produce `undefined`; exactOptionalPropertyTypes wants them absent. */
function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

const idSchema = z.object({ id: z.string().uuid() }).strict();
