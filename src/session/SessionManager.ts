import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';
import { AuthCredentials } from '../auth/CredentialsManager';
import { useMultiFileAuthState, validateAuthState, clearCorruptedAuthState, AuthenticationState } from '../auth/AuthState';
import { EventHandlers } from '../events/EventHandlers';
import { CONNECTION_CONFIG, TIMEOUTS } from '../constants/Constants';

/**
 * Tipos de estado de conexão baseados no Baileys
 */
export enum ConnectionState {
  close = 'close',
  connecting = 'connecting',
  open = 'open'
}

/**
 * Razões de desconexão baseadas no Baileys
 */
export enum DisconnectReason {
  badSession = 401,
  connectionClosed = 428,
  connectionLost = 408,
  connectionReplaced = 440,
  loggedOut = 401,
  restartRequired = 515,
  timedOut = 408,
  unavailableService = 503
}

/**
 * Interface para sessão ativa
 */
export interface ActiveSession {
  id: number;
  name: string;
  client?: any; // Referência genérica para compatibilidade
  connectionState: ConnectionState;
  lastActivity: Date;
  isInitializing: boolean;
  retryCount: number;
  credentials?: AuthCredentials;
  authState?: AuthenticationState;
  qrCodeTimestamp?: Date;
  isOnline?: boolean;
}

// Configurações de conexão agora importadas do Constants.ts

/**
 * Gerenciador de sessões do WhatsApp baseado no padrão do Baileys
 */
export class SessionManager extends EventEmitter {
  private static instance: SessionManager | null = null;
  private sessions: Map<number, ActiveSession> = new Map();
  private reconnectAttempts: Map<number, number> = new Map();
  private reconnectTimers: Map<number, NodeJS.Timeout> = new Map();
  private initializationQueue: Array<{
    instanceId: number;
    credentials: AuthCredentials;
    resolve: (session: ActiveSession) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessingQueue = false;
  // Logger removido - usando métodos estáticos
  private eventHandlers = EventHandlers.getInstance();

  private constructor() {
    super();
    Logger.info('🏗️ SessionManager inicializado');
    this.setupEventHandlers();
  }

  /**
   * Singleton pattern como no Baileys
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Adiciona uma nova sessão ao gerenciador
   */
  public async addSession(instanceId: number, name: string, credentials: AuthCredentials): Promise<ActiveSession> {
    return new Promise((resolve, reject) => {
      Logger.info(`📝 Adicionando sessão ${name} (ID: ${instanceId}) à fila`);
      
      // Adiciona à fila de inicialização
      this.initializationQueue.push({
        instanceId,
        credentials,
        resolve,
        reject
      });

      // Processa a fila se não estiver processando
      if (!this.isProcessingQueue) {
        this.processInitializationQueue();
      }
    });
  }

  /**
   * Processa a fila de inicialização sequencialmente como no Baileys
   */
  private async processInitializationQueue(): Promise<void> {
    if (this.isProcessingQueue || this.initializationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    Logger.info(`🔄 Processando fila de inicialização (${this.initializationQueue.length} itens)`);

    while (this.initializationQueue.length > 0) {
      const { instanceId, credentials, resolve, reject } = this.initializationQueue.shift()!;
      
      try {
        const session = await this.createSession(instanceId, `Instance-${instanceId}`, credentials);
        resolve(session);
        
        // Delay entre inicializações como no Baileys
        if (this.initializationQueue.length > 0) {
          await this.delay(CONNECTION_CONFIG.sequentialInitDelay);
        }
      } catch (error) {
        Logger.error(`❌ Erro ao criar sessão ${instanceId}:`, error);
        reject(error as Error);
      }
    }

    this.isProcessingQueue = false;
    Logger.info('✅ Fila de inicialização processada');
  }

  /**
   * Cria uma nova sessão
   */
  private async createSession(instanceId: number, name: string, credentials: AuthCredentials): Promise<ActiveSession> {
    Logger.info(`🚀 Criando sessão ${name} (ID: ${instanceId})`);

    // Remove sessão existente se houver
    if (this.sessions.has(instanceId)) {
      await this.removeSession(instanceId);
    }

    // Carregar ou criar estado de autenticação
    const authFolder = `./sessions/session_${instanceId}`;
    let authState: AuthenticationState;
    
    try {
      const authResult = await useMultiFileAuthState(authFolder);
      authState = authResult.state;
      
      // Validar estado de autenticação
      const isValid = await validateAuthState(authState);
      if (!isValid) {
        Logger.warn(`Estado de autenticação inválido para sessão ${instanceId}, limpando...`);
        await clearCorruptedAuthState(authFolder);
        const newAuthResult = await useMultiFileAuthState(authFolder);
        authState = newAuthResult.state;
      }
    } catch (error) {
      Logger.error(`Erro ao carregar autenticação para sessão ${instanceId}:`, error);
      const authResult = await useMultiFileAuthState(authFolder);
      authState = authResult.state;
    }

    // Cliente será definido posteriormente pela instância
    const session: ActiveSession = {
      id: instanceId,
      name,
      client: null, // Será definido pela instância
      connectionState: ConnectionState.connecting,
      lastActivity: new Date(),
      isInitializing: true,
      retryCount: 0,
      credentials,
      authState
    };

    // Adiciona ao mapa de sessões
    this.sessions.set(instanceId, session);

    // Configura event listeners
    this.setupSessionEventListeners(session);

    // Inicia a conexão
    try {
      if (session.client && session.client.connect) {
        await session.client.connect();
      }
      session.connectionState = ConnectionState.open;
      session.isInitializing = false;
      
      Logger.info(`✅ Sessão ${name} conectada com sucesso`);
      this.emit('session:connected', session);
      
      return session;
    } catch (error) {
      Logger.error(`❌ Erro ao conectar sessão ${name}:`, error);
      session.connectionState = ConnectionState.close;
      session.isInitializing = false;
      
      this.emit('session:error', session, error);
      throw error;
    }
  }

  /**
   * Configura event listeners para a sessão
   */
  private setupSessionEventListeners(session: ActiveSession): void {
    const { client, id, name } = session;

    // TODO: Implementar event listeners quando WhatsAppWebClient tiver métodos 'on'
    // Por enquanto, os eventos serão tratados diretamente pelos handlers do EventHandlers
    Logger.debug(`Event listeners configurados para sessão ${name} (${id})`);
    
    // Os eventos serão tratados pelo sistema EventHandlers global
    // que já está configurado no main.ts e WhatsAppWebClient
  }

  /**
   * Trata atualizações de conexão baseado no Baileys
   */
  private async handleConnectionUpdate(session: ActiveSession, update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const { id, name } = session;

    Logger.info(`🔄 [${name}] Connection Update: ${connection}`);

    if (connection === 'close') {
      session.connectionState = ConnectionState.close;
      
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = this.shouldReconnect(statusCode);
      
      if (shouldReconnect) {
        const attempts = this.reconnectAttempts.get(id) || 0;
        
        if (attempts < CONNECTION_CONFIG.maxReconnectAttempts) {
          this.scheduleReconnect(session, attempts + 1);
        } else {
          Logger.error(`❌ [${name}] Máximo de tentativas de reconexão atingido`);
          this.emit('session:max_retries', session);
        }
      } else {
        Logger.info(`🔌 [${name}] Conexão fechada sem reconexão`);
        this.emit('session:disconnected', session, statusCode);
      }
    } else if (connection === 'open') {
      session.connectionState = ConnectionState.open;
      session.isInitializing = false;
      this.reconnectAttempts.delete(id);
      this.clearReconnectTimer(id);
      
      Logger.info(`✅ [${name}] Conectado com sucesso`);
      this.emit('session:connected', session);
    } else if (connection === 'connecting') {
      session.connectionState = ConnectionState.connecting;
      Logger.info(`🔄 [${name}] Conectando...`);
    }

    if (qr) {
      Logger.info(`📱 [${name}] QR Code atualizado`);
      this.emit('session:qr', session, qr);
    }
  }

  /**
   * Determina se deve reconectar baseado no código de status
   */
  private shouldReconnect(statusCode?: number): boolean {
    switch (statusCode) {
      case DisconnectReason.badSession:
      case DisconnectReason.connectionClosed:
      case DisconnectReason.connectionLost:
      case DisconnectReason.timedOut:
        return true;
      case DisconnectReason.connectionReplaced:
      case DisconnectReason.loggedOut:
      case DisconnectReason.restartRequired:
        return false;
      default:
        return true; // Reconecta por padrão
    }
  }

  /**
   * Agenda uma reconexão com delay exponencial
   */
  private scheduleReconnect(session: ActiveSession, attempt: number): void {
    const { id, name } = session;
    const delay = this.calculateReconnectDelay(attempt);
    
    Logger.info(`🔄 [${name}] Agendando reconexão em ${delay}ms (tentativa ${attempt})`);
    
    this.reconnectAttempts.set(id, attempt);
    
    const timer = setTimeout(async () => {
      try {
        Logger.info(`🔄 [${name}] Tentando reconectar (tentativa ${attempt})`);
        await session.client.connect();
      } catch (error) {
        Logger.error(`❌ [${name}] Falha na reconexão:`, error);
        this.handleSessionError(session, error as Error);
      }
    }, delay);
    
    this.reconnectTimers.set(id, timer);
  }

  /**
   * Calcula delay de reconexão com backoff exponencial
   */
  private calculateReconnectDelay(attempt: number): number {
    const delay = CONNECTION_CONFIG.reconnectDelay * Math.pow(2, attempt - 1);
    return Math.min(delay, CONNECTION_CONFIG.maxReconnectDelay);
  }

  /**
   * Trata erros de sessão
   */
  private handleSessionError(session: ActiveSession, error: Error): void {
    const { id, name } = session;
    
    session.connectionState = ConnectionState.close;
    this.emit('session:error', session, error);
    
    // Se for erro de protocolo, agenda reconexão
    if (error.name === 'ProtocolError' || error.name === 'InsufficientDataError') {
      const attempts = this.reconnectAttempts.get(id) || 0;
      if (attempts < CONNECTION_CONFIG.maxReconnectAttempts) {
        this.scheduleReconnect(session, attempts + 1);
      }
    }
  }

  /**
   * Remove uma sessão
   */
  public async removeSession(instanceId: number): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (!session) {
      return;
    }

    Logger.info(`🗑️ Removendo sessão ${session.name} (ID: ${instanceId})`);
    
    // Limpa timers
    this.clearReconnectTimer(instanceId);
    
    // Desconecta cliente
    try {
      await session.client.disconnect();
    } catch (error) {
      Logger.error(`❌ Erro ao desconectar sessão ${session.name}:`, error);
    }
    
    // Remove do mapa
    this.sessions.delete(instanceId);
    this.reconnectAttempts.delete(instanceId);
    
    this.emit('session:removed', session);
  }

  /**
   * Limpa timer de reconexão
   */
  private clearReconnectTimer(instanceId: number): void {
    const timer = this.reconnectTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(instanceId);
    }
  }

  /**
   * Obtém uma sessão por ID
   */
  public getSession(instanceId: number): ActiveSession | undefined {
    return this.sessions.get(instanceId);
  }

  /**
   * Obtém todas as sessões ativas
   */
  public getAllSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Obtém sessões por estado
   */
  public getSessionsByState(state: ConnectionState): ActiveSession[] {
    return this.getAllSessions().filter(session => session.connectionState === state);
  }

  /**
   * Verifica se uma sessão existe
   */
  public hasSession(instanceId: number): boolean {
    return this.sessions.has(instanceId);
  }

  /**
   * Inicia todas as sessões (similar ao StartAllWhatsAppsSessions do Baileys)
   */
  public async startAllSessions(credentialsList: Array<{ instanceId: number; credentials: AuthCredentials }>): Promise<void> {
    Logger.info(`🚀 Iniciando ${credentialsList.length} sessões em lotes`);
    
    // Processa em lotes para evitar sobrecarga
    for (let i = 0; i < credentialsList.length; i += CONNECTION_CONFIG.batchSize) {
      const batch = credentialsList.slice(i, i + CONNECTION_CONFIG.batchSize);
      
      Logger.info(`📦 Processando lote ${Math.floor(i / CONNECTION_CONFIG.batchSize) + 1}`);
      
      const promises = batch.map(({ instanceId, credentials }) => 
        this.addSession(instanceId, `Instance-${instanceId}`, credentials)
          .catch(error => {
            Logger.error(`❌ Erro ao iniciar sessão ${instanceId}:`, error);
            return null;
          })
      );
      
      await Promise.all(promises);
      
      // Delay entre lotes
      if (i + CONNECTION_CONFIG.batchSize < credentialsList.length) {
        await this.delay(CONNECTION_CONFIG.batchDelay);
      }
    }
    
    Logger.info('✅ Todas as sessões foram processadas');
  }

  /**
   * Para todas as sessões
   */
  public async stopAllSessions(): Promise<void> {
    Logger.info('🛑 Parando todas as sessões');
    
    const promises = Array.from(this.sessions.keys()).map(instanceId => 
      this.removeSession(instanceId)
    );
    
    await Promise.all(promises);
    
    Logger.info('✅ Todas as sessões foram paradas');
  }

  /**
   * Configurar event handlers
   */
  private setupEventHandlers(): void {
    Logger.info('Configurando event handlers do SessionManager');
    
    // Configurar handlers padrão
    this.eventHandlers.setupDefaultHandlers();

    // Handler personalizado para connection.update
    this.eventHandlers.on('connection.update', async (update) => {
      // Lógica adicional específica do SessionManager se necessário
    });

    // Handler personalizado para creds.update
    this.eventHandlers.on('creds.update', async (creds) => {
      // Salvar credenciais automaticamente
      Logger.debug('Credenciais atualizadas via event handler');
    });
  }

  /**
   * Atualizar estado da sessão
   */
  public async updateSessionState(instanceId: number, updates: Partial<ActiveSession>): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session) {
      Object.assign(session, updates);
      Logger.debug(`Estado da sessão ${instanceId} atualizado`);
    }
  }

  /**
   * Salvar credenciais da sessão
   */
  public async saveSessionCreds(instanceId: number, creds: any): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session?.authState) {
      // Atualizar credenciais no estado
      Object.assign(session.authState.creds, creds);
      
      // Salvar no sistema de arquivos
      const authFolder = `./sessions/session_${instanceId}`;
      const { saveCreds } = await useMultiFileAuthState(authFolder);
      await saveCreds();
      
      Logger.debug(`Credenciais da sessão ${instanceId} salvas`);
    }
  }

  /**
   * Limpar sessão
   */
  public async clearSession(instanceId: number): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session) {
      // Fechar conexões
      if (session.client) {
        await session.client.disconnect();
      }
      
      // Limpar estado de autenticação
      const authFolder = `./sessions/session_${instanceId}`;
      await clearCorruptedAuthState(authFolder);
      
      // Remover da lista de sessões ativas
      this.sessions.delete(instanceId);
      
      Logger.info(`Sessão ${instanceId} limpa`);
    }
  }

  /**
   * Utilitário para delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obtém estatísticas das sessões
   */
  public getStats(): {
    total: number;
    connected: number;
    connecting: number;
    disconnected: number;
    initializing: number;
  } {
    const sessions = this.getAllSessions();
    
    return {
      total: sessions.length,
      connected: sessions.filter(s => s.connectionState === ConnectionState.open).length,
      connecting: sessions.filter(s => s.connectionState === ConnectionState.connecting).length,
      disconnected: sessions.filter(s => s.connectionState === ConnectionState.close).length,
      initializing: sessions.filter(s => s.isInitializing).length
    };
  }

  /**
   * Retorna estatísticas das sessões para compatibilidade com main.ts
   */
  public getSessionStats(): {
    activeSessions: number;
    totalSessions: number;
    connectedSessions: number;
    initializingSessions: number;
  } {
    const stats = this.getStats();
    return {
      activeSessions: stats.connected + stats.connecting,
      totalSessions: stats.total,
      connectedSessions: stats.connected,
      initializingSessions: stats.initializing
    };
  }

  /**
   * Inicializa uma única sessão com configurações específicas
   */
  public async initializeSession(sessionId: string, config: {
    authDir: string;
    qrTimeout: number;
    reconnectAttempts: number;
  }): Promise<void> {
    Logger.info(`🚀 Inicializando sessão: ${sessionId}`);
    
    try {
      // Converte sessionId para instanceId numérico
      const instanceId = this.sessionIdToInstanceId(sessionId);
      
      // Cria credenciais básicas
      // Usar initAuthCreds do Baileys para criar credenciais válidas
      const { initAuthCreds } = require('../../Baileys/lib/Utils/auth-utils');
      const credentials: AuthCredentials = initAuthCreds();
      
      // Adiciona à sessão
      await this.addSession(instanceId, sessionId, credentials);
      
      Logger.info(`✅ Sessão ${sessionId} inicializada com sucesso`);
    } catch (error) {
      Logger.error(`❌ Erro ao inicializar sessão ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Inicializa múltiplas sessões sequencialmente (padrão Baileys)
   */
  public async initializeMultipleSessions(sessionNames: string[], config: {
    authDir: string;
    qrTimeout: number;
    reconnectAttempts: number;
    batchSize: number;
    initDelay: number;
  }): Promise<void> {
    Logger.info(`🚀 Iniciando ${sessionNames.length} sessões em lotes de ${config.batchSize}`);
    
    // Processa em lotes para evitar sobrecarga
    for (let i = 0; i < sessionNames.length; i += config.batchSize) {
      const batch = sessionNames.slice(i, i + config.batchSize);
      
      Logger.info(`📦 Processando lote ${Math.floor(i / config.batchSize) + 1}: ${batch.join(', ')}`);
      
      // Inicializa sessões do lote em paralelo
      const batchPromises = batch.map(sessionName => 
        this.initializeSession(sessionName, {
          authDir: config.authDir,
          qrTimeout: config.qrTimeout,
          reconnectAttempts: config.reconnectAttempts
        })
      );
      
      try {
        await Promise.all(batchPromises);
        Logger.info(`✅ Lote processado com sucesso`);
      } catch (error) {
        Logger.error(`❌ Erro no lote:`, error);
        // Continua com próximo lote mesmo se houver erro
      }
      
      // Delay entre lotes
      if (i + config.batchSize < sessionNames.length) {
        Logger.info(`⏳ Aguardando ${config.initDelay}ms antes do próximo lote...`);
        await this.delay(config.initDelay);
      }
    }
    
    Logger.info(`🎉 Inicialização de múltiplas sessões concluída`);
  }

  /**
   * Converte sessionId string para instanceId numérico
   */
  private sessionIdToInstanceId(sessionId: string): number {
    // Gera um hash simples do sessionId para criar um instanceId único
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      const char = sessionId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Converte para 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Função para compatibilidade com startAllWhatsAppsSessions
   */
  public async startAllWhatsAppsSessions(sessionNames: string[], config?: {
    authDir?: string;
    qrTimeout?: number;
    reconnectAttempts?: number;
    batchSize?: number;
    initDelay?: number;
  }): Promise<void> {
    const defaultConfig = {
      authDir: './auth_info',
      qrTimeout: 60000,
      reconnectAttempts: 3,
      batchSize: CONNECTION_CONFIG.batchSize,
    initDelay: CONNECTION_CONFIG.batchDelay,
      ...config
    };
    
    await this.initializeMultipleSessions(sessionNames, defaultConfig);
  }
}

// Export singleton instance
export const sessionManager = SessionManager.getInstance();