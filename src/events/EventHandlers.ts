// EventHandlers.ts - Sistema de event handlers baseado no padrão Baileys
import { Logger } from '../utils/Logger';
import { SessionManager } from '../api/services/SessionManager';
import { ConnectionState, DisconnectReason } from '../connection/ConnectionEventDetector';
import { AuthenticationState } from '../auth/AuthState';
import { waproto } from '@wppconnect/wa-proto';

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
        this.sessionManager = SessionManager.getInstance();
      }
      await this.sessionManager.removeInstanceData(instanceId.toString());
      shouldReconnect = false;
    } else if (error.message.includes('408') || error.message.includes('timeout')) {
      Logger.warn(`[${instanceId}] Timeout - tentando reconectar`);
      delay = 10000; // 10 segundos para timeout
    } else if (error.message.includes('503')) {
      Logger.warn(`[${instanceId}] Serviço indisponível - aguardando`);
      delay = 30000; // 30 segundos para serviço indisponível
    }

    if (shouldReconnect) {
      Logger.info(`[${instanceId}] Agendando reconexão em ${delay}ms`);
      // A reconexão será gerenciada pelo ConnectionEventDetector
      // Não precisamos gerenciar isso aqui
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

    // Não há necessidade de atualizar estado da sessão aqui
    // O SessionManager atual gerencia apenas autenticação
    Logger.info(`[${instanceId}] Instância conectada e pronta`);
  }

  // Handler para QR Code
  private async handleQRCode(instanceId: number, qr: string): Promise<void> {
    Logger.info(`[${instanceId}] QR Code gerado`);
    
    // O QR code é gerenciado pelo ConnectionEventDetector
    // Não há necessidade de salvar na sessão aqui
    Logger.info(`[${instanceId}] QR Code disponível para escaneamento`);
  }

  // Handler para mensagens (simplificado - apenas log)
  public async handleMessagesUpsert(
    instanceId: number,
    messageUpsert: MessageUpsert
  ): Promise<void> {
    Logger.debug(`[${instanceId}] Mensagens recebidas: ${messageUpsert.messages.length} mensagens`);
    // Removido processamento de mensagens - foco apenas em handshake e QR
  }

  // Handler para creds.update
  public async handleCredsUpdate(
    instanceId: number,
    creds: Partial<AuthenticationState['creds']>
  ): Promise<void> {
    Logger.info(`[${instanceId}] Credenciais atualizadas`);
    
    try {
      if (!this.sessionManager) {
        this.sessionManager = SessionManager.getInstance();
      }
      
      // Converter as credenciais para o formato esperado pelo SessionManager
      const convertedCreds: any = {};
      
      if (creds.noiseKey) {
        convertedCreds.noiseKey = Buffer.from(creds.noiseKey.private);
      }
      
      if (creds.signedIdentityKey) {
        convertedCreds.signedIdentityKey = Buffer.from(creds.signedIdentityKey.private);
      }
      
      if (creds.signedPreKey) {
        convertedCreds.signedPreKey = Buffer.from(creds.signedPreKey.keyPair.private);
      }
      
      // Copiar outros campos diretamente
      Object.keys(creds).forEach(key => {
        if (!['noiseKey', 'signedIdentityKey', 'signedPreKey'].includes(key)) {
          convertedCreds[key] = (creds as any)[key];
        }
      });
      
      await this.sessionManager.updateCredentials(instanceId.toString(), convertedCreds);
      
    } catch (error) {
      Logger.error(`[${instanceId}] Erro ao salvar credenciais:`, error);
    }
  }

  // Handlers simplificados - removidos para focar apenas em handshake e QR
  // Mantidos apenas logs básicos para debug

  // Configurar handlers essenciais para handshake e QR
  public setupDefaultHandlers(): void {
    Logger.info('Configurando event handlers essenciais para handshake e QR');

    // Handler essencial para connection.update
    this.on('connection.update', async (update) => {
      Logger.debug('Connection update recebido:', update);
    });

    // Handler essencial para creds.update
    this.on('creds.update', async (creds) => {
      Logger.debug('Credenciais atualizadas automaticamente');
    });

    Logger.info('Event handlers essenciais configurados');
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