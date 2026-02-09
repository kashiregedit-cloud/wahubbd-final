import type makeWASocket from '@adiwajshing/baileys';
import type {
  BaileysEventEmitter,
  Chat,
  ChatUpdate,
  GroupParticipant,
  Contact,
  ParticipantAction,
  WAMessage,
} from '@adiwajshing/baileys';
import type { GroupMetadata } from '@adiwajshing/baileys/lib/Types/GroupMetadata';
import type { Label } from '@adiwajshing/baileys/lib/Types/Label';
import type { LabelAssociation } from '@adiwajshing/baileys/lib/Types/LabelAssociation';
import { IGroupRepository } from '@waha/core/engines/noweb/store/IGroupRepository';
import { ILabelAssociationRepository } from '@waha/core/engines/noweb/store/ILabelAssociationsRepository';
import { ILabelsRepository } from '@waha/core/engines/noweb/store/ILabelsRepository';
import {
  isLidUser,
  isPnUser,
  JidFilter,
  jidsFromKey,
} from '@waha/core/utils/jids';
import {
  GetChatMessagesFilter,
  OverviewFilter,
} from '@waha/structures/chats.dto';
import { LidToPhoneNumber } from '@waha/structures/lids.dto';
import {
  LimitOffsetParams,
  PaginationParams,
  SortOrder,
} from '@waha/structures/pagination.dto';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { waitUntil } from '@waha/utils/promiseTimeout';
import * as lodash from 'lodash';
import { toNumber } from 'lodash';
import { Logger } from 'pino';

import { IChatRepository } from './IChatRepository';
import { IContactRepository } from './IContactRepository';
import { IMessagesRepository } from './IMessagesRepository';
import { INowebLidPNRepository, LidToPN } from './INowebLidPNRepository';
import { INowebStorage } from './INowebStorage';
import { INowebStore } from './INowebStore';
import { LabelAssociationType } from '../labels/LabelAssociationType';
import esm from '@waha/vendor/esm';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AsyncLock = require('async-lock');

type ms = number;
const HOUR: ms = 60 * 60 * 1000;

export class NowebPersistentStore implements INowebStore {
  private socket: ReturnType<typeof makeWASocket>;
  private chatRepo: IChatRepository;
  private groupRepo: IGroupRepository;
  private contactRepo: IContactRepository;
  private messagesRepo: IMessagesRepository;
  private labelsRepo: ILabelsRepository;
  private labelAssociationsRepo: ILabelAssociationRepository;
  private lidRepo: INowebLidPNRepository;
  public presences: any;

  private lock: any = new AsyncLock({
    maxPending: Infinity,
    maxExecutionTime: 60_000,
  });

  private groupsFetchLock: any = new AsyncLock({
    timeout: 5_000,
    maxPending: Infinity,
    maxExecutionTime: 60_000,
  });

  private lastTimeGroupUpdate: Date = new Date(0);
  private lastTimeGroupFetch: Date = new Date(0);
  private GROUP_METADATA_CACHE_TIME = 24 * HOUR;

  constructor(
    private logger: Logger,
    public storage: INowebStorage,
    private jids: JidFilter,
  ) {
    this.socket = null;
    this.chatRepo = storage.getChatRepository();
    this.groupRepo = storage.getGroupRepository();
    this.contactRepo = storage.getContactsRepository();
    this.messagesRepo = storage.getMessagesRepository();
    this.labelsRepo = storage.getLabelsRepository();
    this.labelAssociationsRepo = storage.getLabelAssociationRepository();
    this.lidRepo = storage.getLidPNRepository();
    this.presences = {};
  }

  init(): Promise<void> {
    return this.storage.init();
  }

  bind(ev: BaileysEventEmitter, socket: any) {
    this.logger.warn('NowebPersistentStore: Binding events - V2 DEBUG MARKER');
    // All
    ev.on('messaging-history.set', (data) => this.onMessagingHistorySet(data));
    // Messages
    ev.on('messages.upsert', (data) => {
      this.withLock('messages', () => this.onMessagesUpsert(data));
      this.withNoLock('lids', async () => {
        const messages: WAMessage[] = data.messages;
        if (!messages) {
          return;
        }
        const contacts: Partial<Contact>[] = messages
          .map((message) => {
            if (!message.key) {
              return null;
            }
            const jids = jidsFromKey(message.key);
            if (!jids) {
              return null;
            }
            let { lid, pn } = jids;
            // 123 => 123@s.whatsapp.net
            if (pn && !pn.includes('@')) {
              pn = `${pn}@s.whatsapp.net`;
            }
            // 123@c.us => 123@s.whatsapp.net
            if (pn && !isPnUser(pn)) {
              pn = esm.b.jidNormalizedUser(pn);
            }
            // 999@lid
            return {
              id: message.key.remoteJid,
              lid: lid,
              jid: pn,
            };
          })
          .filter(Boolean);
        const lids = await this.handleLidPNUpdates(contacts);
        this.logger.debug(
          `messages.upsert - '${lids.length}' synced lid to pn mapping`,
        );
      });
    });
    ev.on('messages.update', (data) =>
      this.withLock('messages', () => this.onMessageUpdate(data)),
    );
    ev.on('messages.delete', (data) =>
      this.withLock('messages', () => this.onMessageDelete(data)),
    );
    ev.on('messages.reaction', (data) =>
      this.withLock('messages', () => this.onMessageReaction(data)),
    );
    ev.on('message-receipt.update', (data) =>
      this.withLock('messages', () => this.onMessageReceiptUpdate(data)),
    );
    // Chats
    ev.on('chats.upsert', (data) =>
      this.withLock('chats', () => this.onChatUpsert(data)),
    );
    ev.on('chats.update', (data) =>
      this.withLock('chats', () => this.onChatUpdate(data)),
    );
    ev.on('chats.delete', (data) =>
      this.withLock('chats', () => this.onChatDelete(data)),
    );
    // Groups
    ev.on('groups.upsert', (data) =>
      this.withLock('groups', () => this.onGroupUpsert(data)),
    );
    ev.on('groups.update', (data) => {
      this.withLock('groups', () => this.onGroupUpdate(data));
      this.withNoLock('lids', async () => {
        const participants = lodash.flatMap(data, (g) => g?.participants || []);
        const lids = await this.handleLidPNUpdates(participants);
        this.logger.debug(
          `groups.update - '${lids.length}' synced lid to pn mapping`,
        );
      });
    });
    ev.on('group-participants.update', (data) =>
      this.withLock(`group-${data.id}`, () =>
        this.onGroupParticipantsUpdate(data),
      ),
    );

    // Lids
    ev.on('lid-mapping.update', (data) => {
      this.withLock('lids', async () => {
        const lids = await this.handleLidPNUpdates([data]);
        this.logger.debug(
          `lid-mapping.update - '${lids.length}' synced lid to pn mapping`,
        );
      });
    });

    // Contacts
    ev.on('contacts.upsert', (data) => {
      this.withLock('contacts', async () => {
        const upserts = await this.onContactsUpsert(data);
        this.withNoLock('lids', async () => {
          const lids = await this.handleLidPNUpdates(upserts);
          this.logger.debug(
            `contacts.upsert - '${lids.length}' synced lid to pn mapping`,
          );
        });
      });
    });
    ev.on('contacts.update', (data) => {
      this.withLock('contacts', async () => {
        const upserts = await this.onContactUpdate(data);
        this.withNoLock('lids', async () => {
          const lids = await this.handleLidPNUpdates(upserts);
          this.logger.debug(
            `contacts.update - '${lids.length}' synced lid to pn mapping`,
          );
        });
      });
    });
    ev.on('labels.edit', (data) => this.onLabelsEdit(data));
    ev.on('labels.association', ({ association, type }) =>
      this.onLabelsAssociation(association, type),
    );
    // Presence
    ev.on('presence.update', (data) => this.onPresenceUpdate(data));
    this.socket = socket;
  }

  async close(): Promise<void> {
    await this.storage?.close().catch((error) => {
      this.logger.warn(`Failed to close storage: ${error}`);
    });
    return;
  }

  private async onMessagingHistorySet(history) {
    const { contacts, chats, messages } = history;
    this.logger.debug(
      `history sync keys: ${Object.keys(history).join(', ')}`,
    );

    await Promise.all([
      this.withLock('contacts', async () => {
        await this.onContactsUpsert(contacts);
        this.logger.info(`history sync - '${contacts.length}' synced contacts`);
      }),
      this.withNoLock('lids', async () => {
        const lids = await this.handleLidPNUpdates(contacts);
        this.logger.info(
          `history sync - '${lids.length}' synced lid to pn mapping`,
        );
      }),
      this.withLock('chats', () => this.onChatUpsert(chats)),
      this.withLock('messages', () => this.syncMessagesHistory(messages)),
    ]);
  }

  private async syncMessagesHistory(messages) {
    this.withNoLock('lids', async () => {
      const lids: LidToPN[] = [];
      for (const msg of messages) {
        const jids = jidsFromKey(msg.key);
        if (jids && jids.lid && jids.pn) {
          lids.push({ id: jids.lid, pn: jids.pn });
        }
      }
      if (lids.length > 0) {
        const uniqueLids = lodash.uniqBy(lids, 'id');
        await this.lidRepo.saveLids(uniqueLids);
        this.logger.info(
          `history sync - '${uniqueLids.length}' synced lid to pn mapping from messages`,
        );
      }
    });

    const realMessages = messages.filter(esm.b.isRealMessage);
    messages = messages.filter((msg) => this.jids.include(msg.key.remoteJid));
    await this.messagesRepo.upsert(realMessages);
    this.logger.info(
      `history sync - '${messages.length}' got messages, '${realMessages.length}' real messages`,
    );
  }

  private async onMessagesUpsert(update) {
    const type = update.type;
    this.logger.debug(`messages.upsert type: ${type}, count: ${update.messages?.length}`);
    if (type !== 'notify' && type !== 'append') {
      this.logger.debug(`unexpected type for messages.upsert: '${type}'`);
      return;
    }
    let messages = update.messages;
    this.withNoLock('lids', async () => {
      const lids: LidToPN[] = [];
      for (const msg of messages) {
        const jids = jidsFromKey(msg.key);
        if (jids && jids.lid && jids.pn) {
          lids.push({ id: jids.lid, pn: jids.pn });
        }
      }
      if (lids.length > 0) {
        const uniqueLids = lodash.uniqBy(lids, 'id');
        await this.lidRepo.saveLids(uniqueLids);
        this.logger.debug(
          `messages.upsert - '${uniqueLids.length}' synced lid to pn mapping`,
        );
      }
    });
    messages = messages.filter((msg) => this.jids.include(msg.key.remoteJid));
    const realMessages = messages.filter(esm.b.isRealMessage);
    await this.messagesRepo.upsert(realMessages);
    this.logger.debug(
      `messages.upsert - ${messages.length} got messages, ${realMessages.length} real messages`,
    );
  }

  private async onMessageUpdate(updates) {
    this.withNoLock('lids', async () => {
      const lids: LidToPN[] = [];
      for (const update of updates) {
        const jids = jidsFromKey(update.key);
        if (jids && jids.lid && jids.pn) {
          lids.push({ id: jids.lid, pn: jids.pn });
        }
      }
      if (lids.length > 0) {
        const uniqueLids = lodash.uniqBy(lids, 'id');
        await this.lidRepo.saveLids(uniqueLids);
        this.logger.debug(
          `messages.update - '${uniqueLids.length}' synced lid to pn mapping`,
        );
      }
    });

    for (const update of updates) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const jid = esm.b.jidNormalizedUser(update.key.remoteJid!);
      if (!this.jids.include(jid)) {
        continue;
      }
      if (!update.key.id) {
        continue;
      }
      if (!jid) {
        this.logger.warn(
          `got message update for unknown jid. update: '${JSON.stringify(
            update,
          )}'`,
        );
        continue;
      }
      const message = await this.messagesRepo.getByJidById(jid, update.key.id);
      if (!message) {
        this.logger.warn(
          `got update for non-existent message. update: '${JSON.stringify(
            update,
          )}'`,
        );
        continue;
      }
      const fields = { ...update.update };
      // check if fields has only "status" field
      const onlyStatusField =
        Object.keys(fields).length === 1 &&
        'status' in fields &&
        fields.status !== null;
      if (onlyStatusField) {
        // if so, check the message don't have a newer status
        if (message.status >= fields.status) {
          continue;
        }
      }

      // It can overwrite the key, so we need to delete it
      delete fields['key'];
      Object.assign(message, fields);
      // In case of revoked messages - remove it
      // TODO: May be we should save the flag instead of completely removing the message
      const isYetRealMessage = esm.b.isRealMessage(message) || false;
      if (isYetRealMessage) {
        await this.messagesRepo.upsertOne(message);
      } else {
        await this.messagesRepo.deleteByJidByIds(jid, [update.key.id]);
      }
    }
  }

  private async onMessageDelete(item) {
    if ('all' in item) {
      await this.messagesRepo.deleteAllByJid(item.jid);
      return;
    }
    const jid = esm.b.jidNormalizedUser(item.keys[0].remoteJid);
    const ids = item.keys.map((key) => key.id);
    await this.messagesRepo.deleteByJidByIds(jid, ids);
  }

  private async onChatUpsert(chats: Chat[]) {
    for (const chat of chats) {
      delete chat['messages'];
      chat.conversationTimestamp = toNumber(chat.conversationTimestamp) || null;
    }
    chats = chats.filter((chat) => this.jids.include(chat.id));
    await this.chatRepo.upsertMany(chats);
    this.logger.info(`store sync - '${chats.length}' synced chats`);
  }

  private async onGroupUpsert(groups: GroupMetadata[]) {
    for (const group of groups) {
      if (!this.jids.include(group.id)) {
        continue;
      }
      await this.groupRepo.save(group);
    }
    this.logger.info(`store sync - '${groups.length}' synced groups`);
  }

  private async onGroupUpdate(groups: Partial<GroupMetadata>[]) {
    for (const update of groups) {
      if (!this.jids.include(update.id)) {
        continue;
      }
      let group = await this.groupRepo.getById(update.id);
      group = Object.assign(group || {}, update) as GroupMetadata;
      await this.groupRepo.save(group);
    }
    this.logger.info(`store sync - '${groups.length}' updated groups`);
    this.lastTimeGroupUpdate = new Date();
  }

  private async onGroupParticipantsUpdate(data) {
    const id: string = data.id;
    if (!this.jids.include(id)) {
      return;
    }
    const participants: string[] = data.participants;
    const action: ParticipantAction = data.action;

    if (action == 'remove') {
      // Remove the group if the current user is removed
      const myJid = this.socket?.authState?.creds?.me?.id;
      const participantsIncludesMe = lodash.find(participants, (p) =>
        esm.b.areJidsSameUser(p, myJid),
      );
      if (participantsIncludesMe) {
        await this.groupRepo.deleteById(id);
        return;
      }
    }

    let group = await this.groupRepo.getById(id);
    if (!group) {
      group = { id: id, participants: [] } as GroupMetadata;
    }
    if (!group.participants) {
      group.participants = [];
    }

    const participantsById = new DefaultMap<string, GroupParticipant>((key) => {
      return { id: key, admin: null } as GroupParticipant;
    });
    for (const participant of group.participants) {
      participantsById.set(participant.id, participant);
    }

    for (const participant of participants) {
      this.participantUpdate(participantsById, participant, action);
    }
    group.participants = Array.from(participantsById.values());
    await this.groupRepo.save(group);
  }

  private participantUpdate(
    participantsById: DefaultMap<string, GroupParticipant>,
    participant: string,
    action: ParticipantAction,
  ) {
    switch (action) {
      case 'add':
        // if there's no participant - add it (by id)
        participantsById.get(participant);
        break;
      case 'remove':
        // remove the participant (by id)
        participantsById.delete(participant);
        break;
      case 'promote':
        // set admin: admin
        participantsById.get(participant).admin = 'admin';
        break;
      case 'demote':
        participantsById.get(participant).admin = null;
        break;
    }
  }

  private async onChatUpdate(updates: ChatUpdate[]) {
    for (const update of updates) {
      if (!this.jids.include(update.id)) {
        continue;
      }
      const chat = (await this.chatRepo.getById(update.id)) || ({} as Chat);
      Object.assign(chat, update);
      chat.conversationTimestamp = toNumber(chat.conversationTimestamp) || null;
      delete chat['messages'];
      await this.chatRepo.save(chat);
    }
  }

  private async onChatDelete(ids: string[]) {
    for (const id of ids) {
      await this.chatRepo.deleteById(id);
      await this.messagesRepo.deleteAllByJid(id);
    }
  }

  private withLock(key, fn) {
    return this.lock.acquire(key, fn);
  }

  private withNoLock(key, fn) {
    return fn();
  }

  private async onContactsUpsert(contacts: Contact[]) {
    const upserts = [];
    const ids = contacts.map((c) => c.id);
    const contactById = await this.contactRepo.getEntitiesByIds(ids);
    for (const update of contacts) {
      if (!this.jids.include(update.id)) {
        continue;
      }
      const contact = contactById.get(update.id) || {};
      // remove undefined from data
      Object.keys(update).forEach(
        (key) => update[key] === undefined && delete update[key],
      );
      const result = { ...contact, ...update };
      upserts.push(result);
    }
    await this.contactRepo.upsertMany(upserts);
    return upserts;
  }

  private async onContactUpdate(updates: Partial<Contact>[]) {
    const upserts = [];
    for (const update of updates) {
      if (!this.jids.include(update.id)) {
        continue;
      }
      let contact = await this.contactRepo.getById(update.id);

      if (!contact) {
        this.logger.warn(
          `got update for non-existent contact. update: '${JSON.stringify(
            update,
          )}'`,
        );
        contact = {} as Contact;
        // TODO: Find contact by hash if not found
        //  find contact by attrs.hash, when user is not saved as a contact
        //  check the in-memory for that
      }
      Object.assign(contact, update);

      if (update.imgUrl === 'changed') {
        contact.imgUrl = this.socket
          ? await this.socket?.profilePictureUrl(contact.id).catch((error) => {
              this.logger.warn(
                `failed to get profile picture for contact '${contact.id}': ${error}`,
              );
              return undefined;
            })
          : undefined;
      } else if (update.imgUrl === 'removed') {
        delete contact.imgUrl;
      }
      upserts.push(contact);
    }
    await this.onContactsUpsert(upserts);
    return upserts;
  }

  private async onMessageReaction(reactions) {
    for (const { key, reaction } of reactions) {
      if (!this.jids.include(key.remoteJid)) {
        continue;
      }
      const msg = await this.messagesRepo.getByJidById(key.remoteJid, key.id);
      if (!msg) {
        this.logger.warn(
          `got reaction update for non-existent message. key: '${JSON.stringify(
            key,
          )}'`,
        );
        continue;
      }
      esm.b.updateMessageWithReaction(msg, reaction);
      await this.messagesRepo.upsertOne(msg);
    }
  }

  private async onMessageReceiptUpdate(updates) {
    for (const { key, receipt } of updates) {
      if (!this.jids.include(key.remoteJid)) {
        continue;
      }
      const msg = await this.messagesRepo.getByJidById(key.remoteJid, key.id);
      if (!msg) {
        this.logger.warn(
          `got receipt update for non-existent message. key: '${JSON.stringify(
            key,
          )}'`,
        );
        continue;
      }
      esm.b.updateMessageWithReceipt(msg, receipt);
      await this.messagesRepo.upsertOne(msg);
    }
  }

  private async onLabelsEdit(label: Label) {
    this.logger.info(`labels.edit - ${JSON.stringify(label)}`);
    try {
      if (label.deleted) {
        await this.labelsRepo.deleteById(label.id);
        await this.labelAssociationsRepo.deleteByLabelId(label.id);
      } else {
        // Ensure id is string
        if (typeof label.id !== 'string') {
          label.id = String(label.id);
        }
        await this.labelsRepo.save(label);
        this.logger.info(`labels.edit - saved label ${label.id}`);
      }
    } catch (error) {
      this.logger.error(`labels.edit - failed to process label: ${error}`);
    }
  }

  private async onLabelsAssociation(
    association: LabelAssociation,
    type: 'add' | 'remove',
  ) {
    this.logger.info(
      `labels.association - ${type} - ${JSON.stringify(association)}`,
    );
    if (type === 'remove') {
      await this.labelAssociationsRepo.deleteOne(association);
    } else {
      await this.labelAssociationsRepo.save(association);
    }
  }

  private async onPresenceUpdate({ id, presences: update }) {
    if (!this.jids.include(id)) {
      return;
    }
    this.presences[id] = this.presences[id] || {};
    Object.assign(this.presences[id], update);
  }

  async loadMessage(jid: string, id: string) {
    let data;
    if (!jid) {
      data = await this.messagesRepo.getById(id);
    } else {
      data = await this.messagesRepo.getByJidById(jid, id);
    }
    if (!data) {
      return null;
    }
    return esm.b.proto.WebMessageInfo.create(data);
  }

  getMessagesByJid(
    chatId: string,
    filter: GetChatMessagesFilter,
    pagination: PaginationParams,
  ): Promise<any> {
    pagination.sortBy = 'messageTimestamp';
    pagination.sortOrder = pagination.sortOrder || SortOrder.DESC;
    return this.messagesRepo.getAllByJid(chatId, filter, pagination);
  }

  getMessageById(chatId: string, messageId: string): Promise<any> {
    return this.messagesRepo.getByJidById(chatId, messageId);
  }

  getChats(
    pagination: PaginationParams,
    broadcast: boolean,
    filter?: OverviewFilter,
  ): Promise<Chat[]> {
    pagination.sortBy ||= 'conversationTimestamp';
    pagination.sortOrder ||= SortOrder.DESC;
    return this.chatRepo.getAllWithMessages(pagination, broadcast, filter);
  }

  async getChat(jid: string): Promise<Chat | null> {
    return await this.chatRepo.getById(jid);
  }

  private shouldFetchGroup(): boolean {
    const timePassed = new Date().getTime() - this.lastTimeGroupFetch.getTime();
    return timePassed > this.GROUP_METADATA_CACHE_TIME;
  }

  private async fetchGroups() {
    await this.groupsFetchLock.acquire('groups-fetch', async () => {
      if (!this.shouldFetchGroup()) {
        // Update has been done by another request
        return;
      }
      const lastTimeGroupUpdate = this.lastTimeGroupUpdate;
      await this.groupRepo.deleteAll();
      await this.socket?.groupFetchAllParticipating();
      // Wait until the groups update is done
      await waitUntil(
        async () => this.lastTimeGroupUpdate > lastTimeGroupUpdate,
        100,
        5_000,
      );
      this.lastTimeGroupFetch = new Date();
    });
  }

  resetGroupsCache() {
    this.lastTimeGroupFetch = new Date(0);
  }

  async getGroups(pagination: PaginationParams): Promise<GroupMetadata[]> {
    if (this.shouldFetchGroup()) {
      await this.fetchGroups();
    }
    return this.groupRepo.getAll(pagination);
  }

  getContactById(jid) {
    return this.contactRepo.getById(jid);
  }

  getContacts(pagination: PaginationParams) {
    return this.contactRepo.getAll(pagination);
  }

  async getLabels(): Promise<Label[]> {
    const labels = await this.labelsRepo.getAll();
    this.logger.debug(`getLabels - found ${labels.length} labels`);
    return labels;
  }

  getLabelById(labelId: string): Promise<Label | null> {
    return this.labelsRepo.getById(labelId);
  }

  async getChatsByLabelId(labelId: string): Promise<Chat[]> {
    const associations =
      await this.labelAssociationsRepo.getAssociationsByLabelId(
        labelId,
        LabelAssociationType.Chat,
      );
    const ids = associations.map((association) => association.chatId);

    const resolvedIds: string[] = [];
    for (const id of ids) {
      resolvedIds.push(id);
      if (isLidUser(id)) {
        let pn = await this.lidRepo.findPNByLid(id);
        if (!pn) {
          // Fallback: Try to find in contacts
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const repo = this.contactRepo as any;
          if (typeof repo.findByLid === 'function') {
            const contact = await repo.findByLid(id);
            if (contact && isPnUser(contact.id)) {
              pn = contact.id;
              // Update mapping
              await this.lidRepo.saveLids([{ id: id, pn: pn }]);
            }
          }
        }
        if (pn) {
          resolvedIds.push(pn);
        }
      }
    }
    return await this.chatRepo.getAllByIds(lodash.uniq(resolvedIds));
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    const chatIds = [chatId];
    if (isLidUser(chatId)) {
      let pn = await this.lidRepo.findPNByLid(chatId);
      if (!pn) {
        // Fallback: Try to find in contacts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = this.contactRepo as any;
        if (typeof repo.findByLid === 'function') {
          const contact = await repo.findByLid(chatId);
          if (contact && isPnUser(contact.id)) {
            pn = contact.id;
            // Update mapping
            await this.lidRepo.saveLids([{ id: chatId, pn: pn }]);
          }
        }
      }
      if (pn) {
        chatIds.push(pn);
      }
    } else if (isPnUser(chatId)) {
      const lid = await this.lidRepo.findLidByPN(chatId);
      if (lid) {
        chatIds.push(lid);
      }
    }

    const allAssociations: LabelAssociation[] = [];
    for (const id of chatIds) {
      const associations =
        await this.labelAssociationsRepo.getAssociationsByChatId(id);
      allAssociations.push(...associations);
    }

    const ids = lodash.uniq(
      allAssociations.map((association) => association.labelId),
    );
    return await this.labelsRepo.getAllByIds(ids);
  }

  //
  // Lid methods
  //
  private async handleLidPNUpdates(contacts: Array<Partial<Contact>>) {
    let lids: LidToPN[] = [];
    for (const contact of contacts) {
      // contact.id = pn, contact.lid = lid
      if (isPnUser(contact.id) && isLidUser(contact.lid)) {
        lids.push({
          pn: contact.id,
          id: contact.lid,
        });
      }
      // contact.phoneNumber = pn, contact.lid = lid
      else if (isPnUser(contact.phoneNumber) && isLidUser(contact.lid)) {
        lids.push({
          pn: contact.phoneNumber,
          id: contact.lid,
        });
      }
      // contact.phoneNumber = pn, contact.id = lid
      else if (isPnUser(contact.phoneNumber) && isLidUser(contact.id)) {
        lids.push({
          pn: contact.phoneNumber,
          id: contact.id,
        });
      }
    }
    // make lids unique by id
    lids = lodash.uniqBy(lids, 'id');
    if (lids.length > 0) {
      await this.lidRepo.saveLids(lids);
    }
    return lids;
  }

  async getAllLids(
    pagination?: LimitOffsetParams,
  ): Promise<LidToPhoneNumber[]> {
    const lids = await this.lidRepo.getAllLids(pagination);
    return lids.map((value) => {
      return {
        lid: value.id,
        pn: value.pn,
      };
    });
  }

  getLidsCount(): Promise<number> {
    return this.lidRepo.getLidsCount();
  }

  findPNByLid(lid: string): Promise<string | null> {
    return this.lidRepo.findPNByLid(lid);
  }

  findLidByPN(pn: string): Promise<string | null> {
    return this.lidRepo.findLidByPN(pn);
  }
}
