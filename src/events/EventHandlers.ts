// EventHandlers.ts - Sistema de event handlers baseado no padrão Baileys
import { Logger } from '../utils/Logger';
import { SessionManager, ConnectionState, DisconnectReason } from '../session/SessionManager';
import { AuthenticationState } from '../auth/AuthState';
import { waproto } from '@wppconnect/wa-proto';
import { getKeyAuthor, getStatusFromReceiptType } from '../utils/generics';

// Interfaces para os eventos
export interface ConnectionUpdate {
  connection?: ConnectionState;
  lastDisconnect?: {
    error?: Error;
    date?: Date;
  };
  isNewLogin?: boolean;
  qr?: string;
  receivedPendingNotifications?: boolean;
  isOnline?: boolean;
}

export interface MessageUpsert {
  messages: WAMessage[];
  type: 'append' | 'notify' | 'prepend';
}

// Usando tipos proto do Baileys-master
export type WAMessage = waproto.IWebMessageInfo;
export type MessageKey = waproto.IMessageKey;
export type MessageContent = waproto.IMessage;
export type MessageStatus = waproto.WebMessageInfo.Status;
export type HistorySyncType = waproto.HistorySync.HistorySyncType;
export type Reaction = waproto.IReaction;

export interface ChatUpdate {
  id: string;
  conversationTimestamp?: number;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  muteEndTime?: number;
  name?: string;
  description?: string;
  ephemeralExpiration?: number;
  ephemeralSettingTimestamp?: number;
}

// Interfaces para contatos
export interface Contact {
  id: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
  imgUrl?: string;
  status?: string;
}
export type ContactUpdate = Partial<Contact>;

// Interfaces para grupos
export interface GroupMetadata {
  id: string;
  owner?: string;
  subject: string;
  subjectOwner?: string;
  subjectTime?: number;
  creation?: number;
  desc?: string;
  descOwner?: string;
  descId?: string;
  restrict?: boolean;
  announce?: boolean;
  size?: number;
  participants: GroupParticipant[];
  ephemeralDuration?: number;
  inviteCode?: string;
}

export interface GroupParticipant {
  id: string;
  admin?: 'admin' | 'superadmin' | null;
}
export type GroupUpdate = Partial<GroupMetadata>;

// Mapa de eventos do Baileys
// Mapa de eventos usando tipos proto do Baileys-master
export interface BaileysEventMap {
  'connection.update': ConnectionUpdate;
  'creds.update': Partial<AuthenticationState['creds']>;
  'messaging-history.set': {
    chats: waproto.IConversation[];
    contacts: Contact[];
    messages: WAMessage[];
    isLatest?: boolean;
    progress?: number;
  };
  'chats.upsert': waproto.IConversation[];
  'chats.update': ChatUpdate[];
  'chats.delete': string[];
  'presence.update': {
    id: string;
    presences: { [participant: string]: { lastKnownPresence: string; lastSeen?: number } };
  };
  'contacts.upsert': Contact[];
  'contacts.update': ContactUpdate[];
  'messages.delete': {
    keys: MessageKey[];
  };
  'messages.update': {
    key: MessageKey;
    update: Partial<WAMessage>;
  }[];
  'messages.upsert': MessageUpsert;
  'message-receipt.update': {
    key: MessageKey;
    receipt: {
      userJid: string;
      receiptTimestamp?: number;
      readTimestamp?: number;
      deliveryTimestamp?: number;
      playedTimestamp?: number;
    };
  }[];
  'groups.upsert': GroupMetadata[];
  'groups.update': GroupUpdate[];
  'group-participants.update': {
    id: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
  };
  'blocklist.set': {
    blocklist: string[];
  };
  'blocklist.update': {
    blocklist: string[];
    type: 'add' | 'remove';
  };
  'labels.association': any;
  'labels.edit': any;
  'call': any[];
}

// Classe principal para gerenciar event handlers
export class EventHandlers {
  private static instance: EventHandlers;
  private sessionManager?: SessionManager;
  private eventListeners: Map<string, Function[]> = new Map();

  private constructor() {
    // SessionManager será inicializado quando necessário para evitar dependência circular
  }

  public static getInstance(): EventHandlers {
    if (!EventHandlers.instance) {
      EventHandlers.instance = new EventHandlers();
    }
    return EventHandlers.instance;
  }

  // Registrar listener para evento
  public on<T extends keyof BaileysEventMap>(
    event: T,
    listener: (data: BaileysEventMap[T]) => void | Promise<void>
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(listener);
    Logger.debug(`Event listener registrado para: ${event}`);
  }

  // Remover listener
  public off<T extends keyof BaileysEventMap>(
    event: T,
    listener: (data: BaileysEventMap[T]) => void | Promise<void>
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
        Logger.debug(`Event listener removido para: ${event}`);
      }
    }
  }

  // Emitir evento
  public async emit<T extends keyof BaileysEventMap>(
    event: T,
    data: BaileysEventMap[T]
  ): Promise<void> {
    const listeners = this.eventListeners.get(event);
    if (listeners && listeners.length > 0) {
      Logger.debug(`Emitindo evento: ${event}`);
      
      // Executar todos os listeners
      const promises = listeners.map(async (listener) => {
        try {
          await listener(data);
        } catch (error) {
          Logger.error(`Erro no listener do evento ${event}:`, error);
        }
      });
      
      await Promise.all(promises);
    }
  }

  // Handler para connection.update
  public async handleConnectionUpdate(
    instanceId: number,
    update: ConnectionUpdate
  ): Promise<void> {
    Logger.info(`[${instanceId}] Connection update:`, {
      connection: update.connection,
      isNewLogin: update.isNewLogin,
      qr: !!update.qr,
      isOnline: update.isOnline
    });

    // Emitir evento
    await this.emit('connection.update', update);

    // Processar diferentes estados de conexão
    if (update.connection === ConnectionState.close) {
      await this.handleConnectionClose(instanceId, update.lastDisconnect);
    } else if (update.connection === ConnectionState.open) {
      await this.handleConnectionOpen(instanceId, update);
    } else if (update.qr) {
      await this.handleQRCode(instanceId, update.qr);
    }
  }

  // Handler para fechamento de conexão
  private async handleConnectionClose(
    instanceId: number,
    lastDisconnect?: ConnectionUpdate['lastDisconnect']
  ): Promise<void> {
    if (!lastDisconnect?.error) {
      Logger.info(`[${instanceId}] Conexão fechada sem erro`);
      return;
    }

    const error = lastDisconnect.error;
    Logger.warn(`[${instanceId}] Conexão fechada com erro:`, error.message);

    // Determinar razão da desconexão e ação
    let shouldReconnect = true;
    let delay = 5000; // 5 segundos padrão

    // Mapear erros para razões de desconexão
    if (error.message.includes('401')) {
      Logger.error(`[${instanceId}] Sessão inválida - limpando estado`);
      if (!this.sessionManager) {
        const { SessionManager } = await import('../session/SessionManager');
        this.sessionManager = SessionManager.getInstance();
      }
      await this.sessionManager.clearSession(instanceId);
      shouldReconnect = false;
    } else if (error.message.includes('408') || error.message.includes('timeout')) {
      Logger.warn(`[${instanceId}] Timeout - tentando reconectar`);
      delay = 10000; // 10 segundos para timeout
    } else if (error.message.includes('503')) {
      Logger.warn(`[${instanceId}] Serviço indisponível - aguardando`);
      delay = 30000; // 30 segundos para serviço indisponível
    }

    if (shouldReconnect) {
      if (!this.sessionManager) {
        const { SessionManager } = await import('../session/SessionManager');
        this.sessionManager = SessionManager.getInstance();
      }
      
      const session = this.sessionManager.getSession(instanceId);
      if (session) {
        const attempts = 1; // Primeira tentativa de reconexão
        setTimeout(() => {
          this.sessionManager!['scheduleReconnect'](session, attempts);
        }, delay);
      }
    }
  }

  // Handler para conexão aberta
  private async handleConnectionOpen(
    instanceId: number,
    update: ConnectionUpdate
  ): Promise<void> {
    Logger.info(`[${instanceId}] Conexão estabelecida com sucesso`);
    
    if (update.isNewLogin) {
      Logger.info(`[${instanceId}] Novo login detectado`);
    }

    // Atualizar estado da sessão
    if (!this.sessionManager) {
      const { SessionManager } = await import('../session/SessionManager');
      this.sessionManager = SessionManager.getInstance();
    }
    
    await this.sessionManager.updateSessionState(instanceId, {
      connectionState: ConnectionState.open,
      isOnline: update.isOnline || false,
      lastActivity: new Date()
    });
  }

  // Handler para QR Code
  private async handleQRCode(instanceId: number, qr: string): Promise<void> {
    Logger.info(`[${instanceId}] QR Code gerado`);
    
    // Salvar timestamp do QR code na sessão
    if (!this.sessionManager) {
      const { SessionManager } = await import('../session/SessionManager');
      this.sessionManager = SessionManager.getInstance();
    }
    
    await this.sessionManager.updateSessionState(instanceId, {
      qrCodeTimestamp: new Date()
    });
  }

  // Handler para messages.upsert
  public async handleMessagesUpsert(
    instanceId: number,
    messageUpsert: MessageUpsert
  ): Promise<void> {
    Logger.debug(`[${instanceId}] Messages upsert: ${messageUpsert.messages.length} mensagens`);

    // Emitir evento
    await this.emit('messages.upsert', messageUpsert);

    // Processar cada mensagem
    for (const message of messageUpsert.messages) {
      await this.processMessage(instanceId, message);
    }
  }

  // Processar mensagem individual
  private async processMessage(instanceId: number, message: WAMessage): Promise<void> {
    try {
      const { key, messageTimestamp, pushName } = message;
      
      Logger.debug(`[${instanceId}] Processando mensagem:`, {
        from: key.remoteJid,
        id: key.id,
        fromMe: key.fromMe,
        timestamp: messageTimestamp,
        pushName
      });

      // Aqui você pode adicionar lógica específica para processar mensagens
      // Por exemplo: salvar no banco de dados, responder automaticamente, etc.
      
    } catch (error) {
      Logger.error(`[${instanceId}] Erro ao processar mensagem:`, error);
    }
  }

  // Handler para creds.update
  public async handleCredsUpdate(
    instanceId: number,
    creds: Partial<AuthenticationState['creds']>
  ): Promise<void> {
    Logger.debug(`[${instanceId}] Credenciais atualizadas`);

    // Emitir evento
    await this.emit('creds.update', creds);

    // Salvar credenciais atualizadas
    if (!this.sessionManager) {
      const { SessionManager } = await import('../session/SessionManager');
      this.sessionManager = SessionManager.getInstance();
    }
    
    await this.sessionManager.saveSessionCreds(instanceId, creds);
  }

  // Handler para chats.upsert
  public async handleChatsUpsert(instanceId: number, chats: any[]): Promise<void> {
    Logger.debug(`[${instanceId}] Chats upsert: ${chats.length} chats`);
    await this.emit('chats.upsert', chats);
  }

  // Handler para chats.update
  public async handleChatsUpdate(instanceId: number, updates: ChatUpdate[]): Promise<void> {
    Logger.debug(`[${instanceId}] Chats update: ${updates.length} atualizações`);
    await this.emit('chats.update', updates);
  }

  // Handler para contacts.upsert
  public async handleContactsUpsert(instanceId: number, contacts: Contact[]): Promise<void> {
    Logger.debug(`[${instanceId}] Contacts upsert: ${contacts.length} contatos`);
    await this.emit('contacts.upsert', contacts);
  }

  // Handler para groups.upsert
  public async handleGroupsUpsert(instanceId: number, groups: GroupMetadata[]): Promise<void> {
    Logger.debug(`[${instanceId}] Groups upsert: ${groups.length} grupos`);
    await this.emit('groups.upsert', groups);
  }

  // Handler para presence.update
  public async handlePresenceUpdate(
    instanceId: number,
    presence: BaileysEventMap['presence.update']
  ): Promise<void> {
    Logger.debug(`[${instanceId}] Presence update para: ${presence.id}`);
    await this.emit('presence.update', presence);
  }

  // Configurar todos os event handlers padrão
  public setupDefaultHandlers(): void {
    Logger.info('Configurando event handlers padrão');

    // Handler padrão para connection.update
    this.on('connection.update', async (update) => {
      // Lógica padrão já implementada nos métodos específicos
    });

    // Handler padrão para messages.upsert
    this.on('messages.upsert', async (messageUpsert) => {
      // Log básico das mensagens recebidas
      for (const message of messageUpsert.messages) {
        if (!message.key.fromMe) {
          Logger.info('Nova mensagem recebida:', {
            from: message.key.remoteJid,
            id: message.key.id,
            pushName: message.pushName
          });
        }
      }
    });

    // Handler padrão para creds.update
    this.on('creds.update', async (creds) => {
      Logger.debug('Credenciais atualizadas automaticamente');
    });

    Logger.info('Event handlers padrão configurados');
  }

  // Limpar todos os listeners
  public clearAllListeners(): void {
    this.eventListeners.clear();
    Logger.info('Todos os event listeners foram limpos');
  }

  // Obter estatísticas dos listeners
  public getListenerStats(): { [event: string]: number } {
    const stats: { [event: string]: number } = {};
    
    for (const [event, listeners] of this.eventListeners.entries()) {
      stats[event] = listeners.length;
    }
    
    return stats;
  }
}

// Exportar instância singleton
export const eventHandlers = EventHandlers.getInstance();