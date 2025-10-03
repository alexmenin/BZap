// services/WhatsAppInstance.ts - Instância individual do WhatsApp (Simplificada)

import { EventEmitter } from 'events';
import { Logger } from '../../utils/Logger';
import { WebSocketClient, ConnectionUpdate } from '../../connection/WebSocketClient';
import { SessionManager } from './SessionManager';
import { CacheManager } from './CacheManager';
import { InstanceConfig, InstanceData, OperationResult } from './InstanceManager';
import { AuthStateManager, AuthenticationState, AuthenticationCreds } from '../../auth/AuthStateManager';

/**
 * Estados de conexão possíveis
 */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'qr_code';

/**
 * Classe que representa uma instância individual do WhatsApp
 * Versão simplificada que delega toda a complexidade para o WebSocketClient
 */
export class WhatsAppInstance extends EventEmitter {
  private config: InstanceConfig;
  private status: ConnectionStatus = 'disconnected';
  private qrCode?: string;
  private qrCodeExpiresAt?: Date;
  private createdAt: Date;
  private updatedAt: Date;
  private lastSeen?: Date;
  private phoneNumber?: string;
  private profileName?: string;
  
  // Ciclo de QR Code (igual ao Baileys)
  private qrRefs: string[] = [];
  private currentQRIndex = 0;
  
  // Componente principal - WebSocketClient faz tudo
  private webSocket?: WebSocketClient;
  
  // Gerenciadores
  private sessionManager: SessionManager;
  private cacheManager: CacheManager;
  private authStateManager: AuthStateManager;
  
  // Estado de autenticação 
  private authState: AuthenticationState | null = null;
  private saveCreds?: () => Promise<void>;
  
  // Timers
  private qrCodeTimer?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  
  constructor(
    config: InstanceConfig,
    sessionManager: SessionManager,
    cacheManager: CacheManager
  ) {
    super();
    
    this.config = config;
    this.sessionManager = sessionManager;
    this.cacheManager = cacheManager;
    this.authStateManager = new AuthStateManager(config.id);
    this.createdAt = new Date();
    this.updatedAt = new Date();
    
    Logger.info(`📱 Inicializando instância simplificada: ${config.name} (ID: ${config.id})`);
    
    // Carrega estado salvo
    this.loadSavedState();
  }

  /**
   * Carrega estado salvo da sessão
   */
  private async loadSavedState(): Promise<void> {
    try {
      // Carrega estado usando o AuthStateManager
      this.authState = await this.authStateManager.loadAuthState();
      
      if (this.authState) {
        // Extrai informações do usuário das credenciais
        if (this.authState.creds.me) {
          this.phoneNumber = this.authState.creds.me.id;
          this.profileName = this.authState.creds.me.name;
        }
        
        Logger.info(`📂 Estado de autenticação carregado para instância: ${this.config.id}`);
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado da instância ${this.config.id}:`, error);
    }
  }

  /**
   * Conecta a instância WhatsApp - Versão Simplificada
   */
  public async connect(): Promise<OperationResult> {
    try {
      Logger.info(`🔌 Iniciando conexão simplificada da instância: ${this.config.id}`);
      
      if (this.status === 'connected') {
        return {
          success: false,
          error: 'Instância já está conectada',
          code: 'ALREADY_CONNECTED'
        };
      }
      
      if (this.status === 'connecting') {
        return {
          success: false,
          error: 'Conexão já está em andamento',
          code: 'ALREADY_CONNECTING'
        };
      }

      // Cleanup do WebSocket anterior se existir
      if (this.webSocket) {
        await this.cleanupWebSocket();
      }

      this.updateStatus('connecting');
      
      // Inicializa credenciais ANTES de criar o WebSocketClient
      await this.initializeCredentials();
      
      // Cria WebSocketClient - ELE faz todo o trabalho pesado
      this.webSocket = new WebSocketClient(undefined, this.authState || undefined, this.saveCreds, this.config.id);
      
      // Configura listeners para eventos do WebSocketClient
      this.setupWebSocketListeners();
      
      // Conecta - o WebSocketClient cuida de tudo (handshake, noise, etc.)
      await this.webSocket.connect();
      
      Logger.info(`✅ WebSocketClient conectado para instância: ${this.config.id}`);
      
      return {
        success: true,
        status: 'connecting' // Status será atualizado pelos eventos
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao conectar instância ${this.config.id}:`, error);
      this.updateStatus('disconnected');
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'CONNECTION_ERROR'
      };
    }
  }

  /**
   * Inicializa sistema de credenciais
   */
  private async initializeCredentials(): Promise<void> {
    try {
      // Fluxo compatível com Baileys/Whatsmeow:
      // Sempre tenta carregar o authState persistido; se não existir, inicializa e salva automaticamente.
      const { state, saveCreds } = await this.authStateManager.useMultiFileAuthState(this.config.id);
      this.authState = state;
      this.saveCreds = saveCreds;

      if (this.authState?.creds?.me) {
        this.phoneNumber = this.authState.creds.me.id;
        this.profileName = this.authState.creds.me.name;
      }

      const isRegistered = !!this.authState?.creds?.registered;
      Logger.info(`🔑 AuthState carregado (ou inicializado) para instância: ${this.config.id} | registered=${isRegistered}`);
      Logger.debug(`📱 Device ID: ${this.authState?.creds?.me?.id || 'N/A'}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao inicializar credenciais para instância ${this.config.id}:`, error);
      throw error;
    }
  }

  /**
   * Configura listeners para eventos do WebSocketClient
   * Esta é a ÚNICA integração necessária - o WebSocketClient faz todo o resto
   */
  private setupWebSocketListeners(): void {
    if (!this.webSocket) return;

    // Escuta atualizações de conexão do WebSocketClient
    this.webSocket.on('connection.update', (update: ConnectionUpdate) => {
      Logger.info(`🔄 Connection update para instância ${this.config.id}:`, update);
      
      // Ciclo de QR Code recebido (novo formato)
      if (update.qrRefs && Array.isArray(update.qrRefs)) {
        this.startQRCodeCycle(update.qrRefs);
        Logger.info(`📱 Ciclo de QR Code iniciado com ${update.qrRefs.length} refs para instância: ${this.config.id}`);
      }
      
      // QR Code simples (compatibilidade com formato antigo)
      else if (update.qr) {
        this.qrCode = update.qr;
        this.qrCodeExpiresAt = new Date(Date.now() + 60000); // 1 minuto
        this.updateStatus('qr_code');
        
        // Salva no cache
        this.cacheManager.setQRCode(this.config.id, this.qrCode, this.qrCodeExpiresAt);
        
        // Emite para o frontend (formato compatível)
        this.emit('qr_code', { qr: this.qrCode, expiresAt: this.qrCodeExpiresAt });
        
        Logger.info(`📱 QR Code simples recebido para instância: ${this.config.id}`);
      }
      
      // Conexão estabelecida
      if (update.connection === 'open') {
        // Limpa ciclo de QR quando conectar
        if (this.qrCodeTimer) clearTimeout(this.qrCodeTimer);
        this.qrRefs = [];
        this.currentQRIndex = 0;
        this.qrCode = undefined;
        this.qrCodeExpiresAt = undefined;
        
        this.updateStatus('connected');
        this.lastSeen = new Date();
        this.startHeartbeat();
        
        // Emite evento de conexão
        this.emit('connected', { id: this.config.id });
        
        Logger.info(`✅ Instância conectada: ${this.config.id}`);
      }
      
      // Conexão fechada
      if (update.connection === 'close') {
        this.updateStatus('disconnected');
        this.stopHeartbeat();
        
        // Emite evento de desconexão
        this.emit('disconnected', { 
          id: this.config.id,
          reason: update.lastDisconnect?.error?.message || 'unknown'
        });
        
        Logger.info(`❌ Instância desconectada: ${this.config.id}`);
      }
    });

    // Escuta atualizações de credenciais do WebSocketClient
    this.webSocket.on('creds.update', async (creds: Partial<AuthenticationCreds>) => {
      try {
        if (this.authState && this.authState.creds) {
          // Merge das credenciais atualizadas
          this.authState.creds = {
            ...this.authState.creds,
            ...creds
          };
          
          // Atualiza informações do usuário se disponível
          if (this.authState.creds.me) {
            this.phoneNumber = this.authState.creds.me.id;
            this.profileName = this.authState.creds.me.name;
          }
          
          this.updatedAt = new Date();
        }
        
        // Salva automaticamente
        if (this.saveCreds) {
          await this.saveCreds();
          Logger.debug(`💾 Credenciais atualizadas para instância: ${this.config.id}`);
        }
        
        // Emite evento para outros componentes
        this.emit('credentials-updated', {
          instanceId: this.config.id,
          timestamp: this.updatedAt
        });
        
      } catch (error) {
        Logger.error(`❌ Erro ao salvar credenciais para ${this.config.id}:`, error);
        this.emit('credentials-error', error);
      }
    });

    // Escuta outros eventos importantes do WebSocketClient
    this.webSocket.on('error', (error: Error) => {
      Logger.error(`❌ Erro no WebSocket da instância ${this.config.id}:`, error);
      this.emit('error', error);
    });

    this.webSocket.on('disconnected', (code: number, reason: string) => {
      Logger.warn(`⚠️ WebSocket desconectado para instância ${this.config.id}: ${code} - ${reason}`);
      this.updateStatus('disconnected');
      this.emit('disconnected', { id: this.config.id, reason });
    });
  }

  /**
   * Desconecta a instância - Versão Simplificada
   */
  public async disconnect(): Promise<OperationResult> {
    try {
      Logger.info(`🔌 Desconectando instância: ${this.config.id}`);
      
      if (this.status === 'disconnected') {
        return {
          success: false,
          error: 'Instância já está desconectada',
          code: 'ALREADY_DISCONNECTED'
        };
      }
      
      // Para timers
      this.stopHeartbeat();
      this.clearQRCodeTimer();
      
      // Desconecta WebSocket
      if (this.webSocket) {
        await this.webSocket.disconnect();
      }
      
      this.updateStatus('disconnected');
      
      Logger.info(`✅ Instância desconectada: ${this.config.id}`);
      
      return {
        success: true,
        status: 'disconnected'
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao desconectar instância ${this.config.id}:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'DISCONNECTION_ERROR'
      };
    }
  }

  /**
   * Gera novo QR Code - Versão Simplificada
   * Agora apenas limpa o QR atual e espera novo connection.update.qr
   */
  public async generateNewQRCode(): Promise<OperationResult> {
    try {
      Logger.info(`🔄 Solicitando novo QR Code para instância: ${this.config.id}`);
      
      if (this.status !== 'qr_code' && this.status !== 'connecting') {
        return {
          success: false,
          error: 'Instância deve estar em modo QR ou conectando para gerar novo QR',
          code: 'INVALID_STATUS'
        };
      }
      
      // Limpa QR atual e ciclo
      this.qrCode = undefined;
      this.qrCodeExpiresAt = undefined;
      this.qrRefs = [];
      this.currentQRIndex = 0;
      this.clearQRCodeTimer();
      
      // Remove do cache
      await this.cacheManager.clearQRCode(this.config.id);
      
      // O WebSocketClient automaticamente gerará um novo QR
      // via connection.update quando necessário
      
      Logger.info(`🔄 QR Code limpo, aguardando novo do WebSocketClient: ${this.config.id}`);
      
      return {
        success: true,
        message: 'Novo QR Code será gerado automaticamente'
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao gerar novo QR Code ${this.config.id}:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'QR_GENERATION_ERROR'
      };
    }
  }

  /**
   * Inicia ciclo de QR Code (igual ao Baileys)
   * Recebe lista de refs e controla a expiração automática
   */
  private startQRCodeCycle(refs: string[]): void {
    Logger.info(`🔄 Iniciando ciclo de QR Code com ${refs.length} refs para instância: ${this.config.id}`);
    
    this.qrRefs = refs;
    this.currentQRIndex = 0;
    this.showNextQRCode();
  }

  /**
   * Mostra próximo QR Code do ciclo
   */
  private showNextQRCode(): void {
    if (this.currentQRIndex >= this.qrRefs.length) {
      Logger.warn(`⏰ Todos os QR Codes expiraram para instância: ${this.config.id}`);
      this.updateStatus('disconnected');
      this.emit('qr_expired', { instanceId: this.config.id });
      return;
    }

    const qr = this.qrRefs[this.currentQRIndex];
    const expiresAt = new Date(Date.now() + 20000); // cada ref dura ~20s

    this.qrCode = qr;
    this.qrCodeExpiresAt = expiresAt;
    this.updateStatus('qr_code');

    // Salva no cache
    this.cacheManager.setQRCode(this.config.id, this.qrCode, this.qrCodeExpiresAt);

    // Emite para o frontend com formato { qr, expiresAt }
    this.emit('qr_code', { qr, expiresAt });

    Logger.info(`📱 QR Code ${this.currentQRIndex + 1}/${this.qrRefs.length} exibido para instância: ${this.config.id}`);

    // Limpa timer anterior se existir
    if (this.qrCodeTimer) clearTimeout(this.qrCodeTimer);
    
    // Agenda próximo QR Code
    this.qrCodeTimer = setTimeout(() => {
      this.currentQRIndex++;
      this.showNextQRCode();
    }, 20000);
  }

  /**
   * Reinicia a instância - Versão Simplificada
   */
  public async restart(): Promise<OperationResult> {
    try {
      Logger.info(`🔄 Reiniciando instância: ${this.config.id}`);
      
      // Desconecta primeiro
      await this.disconnect();
      
      // Aguarda um pouco
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Reconecta
      return await this.connect();
      
    } catch (error) {
      Logger.error(`❌ Erro ao reiniciar instância ${this.config.id}:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'RESTART_ERROR'
      };
    }
  }

  /**
   * Reseta a instância (limpa credenciais) - Versão Simplificada
   */
  public async reset(): Promise<OperationResult> {
    try {
      Logger.info(`🔄 Resetando instância: ${this.config.id}`);
      
      // Desconecta primeiro
      await this.disconnect();
      
      // Limpa credenciais
      await this.authStateManager.removeAuthState();
      this.authState = null;
      this.phoneNumber = undefined;
      this.profileName = undefined;
      
      // Limpa ciclo de QR Code
      this.qrRefs = [];
      this.currentQRIndex = 0;
      this.qrCode = undefined;
      this.qrCodeExpiresAt = undefined;
      
      // Limpa cache
      await this.cacheManager.clearQRCode(this.config.id);
      
      Logger.info(`✅ Instância resetada: ${this.config.id}`);
      
      return {
        success: true,
        message: 'Instância resetada com sucesso'
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao resetar instância ${this.config.id}:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'RESET_ERROR'
      };
    }
  }

  /**
   * Retorna dados da instância
   */
  public getData(): InstanceData {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      qrCode: this.qrCode,
      qrCodeExpiresAt: this.qrCodeExpiresAt,
      phoneNumber: this.phoneNumber,
      profileName: this.profileName,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastSeen: this.lastSeen,
      settings: this.config.settings,
      config: this.config
    };
  }

  /**
   * Atualiza status da instância
   */
  private updateStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      const oldStatus = this.status;
      this.status = newStatus;
      this.updatedAt = new Date();
      
      Logger.info(`📊 Status da instância ${this.config.id}: ${oldStatus} → ${newStatus}`);
      
      // Emite evento de mudança de status
      this.emit('status_changed', {
        instanceId: this.config.id,
        oldStatus,
        newStatus,
        timestamp: this.updatedAt
      });
    }
  }

  /**
   * Inicia heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      this.lastSeen = new Date();
      this.emit('heartbeat', {
        instanceId: this.config.id,
        timestamp: this.lastSeen
      });
    }, 30000); // 30 segundos
  }

  /**
   * Para heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Limpa timer do QR Code
   */
  private clearQRCodeTimer(): void {
    if (this.qrCodeTimer) {
      clearTimeout(this.qrCodeTimer);
      this.qrCodeTimer = undefined;
    }
  }

  /**
   * Cleanup do WebSocket
   */
  private async cleanupWebSocket(): Promise<void> {
    if (this.webSocket) {
      try {
        // Remove todos os listeners
        this.webSocket.removeAllListeners();
        
        // Desconecta se ainda conectado
        if (this.webSocket.isConnected) {
          await this.webSocket.disconnect();
        }
        
        Logger.debug(`🧹 WebSocket limpo para instância: ${this.config.id}`);
      } catch (error) {
        Logger.error(`❌ Erro no cleanup do WebSocket ${this.config.id}:`, error);
      } finally {
        this.webSocket = undefined;
      }
    }
  }

  /**
   * Verifica se o WebSocket está ativo
   */
  private isWebSocketActive(): boolean {
    return this.webSocket?.isConnected === true;
  }

  /**
   * Cleanup geral da instância
   */
  public async cleanup(): Promise<void> {
    try {
      Logger.info(`🧹 Fazendo cleanup da instância: ${this.config.id}`);
      
      // Para todos os timers
      this.stopHeartbeat();
      this.clearQRCodeTimer();
      
      // Cleanup do WebSocket
      await this.cleanupWebSocket();
      
      // Remove todos os listeners
      this.removeAllListeners();
      
      Logger.info(`✅ Cleanup concluído para instância: ${this.config.id}`);
      
    } catch (error) {
      Logger.error(`❌ Erro no cleanup da instância ${this.config.id}:`, error);
    }
  }
}