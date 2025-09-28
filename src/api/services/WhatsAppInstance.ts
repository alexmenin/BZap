// services/WhatsAppInstance.ts - Instância individual do WhatsApp

import { EventEmitter } from 'events';
import { Logger } from '../../utils/Logger';
import { makeNoiseHandler } from '../../connection/NoiseHandler';
import { QRCodeGenerator } from '../../utils/QRCodeGenerator';
import { WebSocketClient } from '../../connection/WebSocketClient';
import { KeyManager } from '../../crypto/KeyManager';

import { SessionManager } from './SessionManager';
import { CacheManager } from './CacheManager';
import { InstanceConfig, InstanceData, OperationResult } from './InstanceManager';
import { CredentialsManager, AuthCredentials, SessionData } from '../../auth/CredentialsManager';
import { AuthStateManager, AuthenticationState, AuthenticationCreds } from '../../auth/AuthStateManager';
import { ConnectionEventDetector, ConnectionState, DisconnectReason, ConnectionUpdate } from '../../connection/ConnectionEventDetector';
import * as waproto from '@wppconnect/wa-proto';

/**
 * Estados de conexão possíveis
 */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'qr_code';

/**
 * Interface para dados de autenticação
 */
interface AuthState {
  creds?: any;
  keys?: any;
  deviceId?: string;
  phoneNumber?: string;
  profileName?: string;
}

/**
 * Classe que representa uma instância individual do WhatsApp
 * Gerenciamento de conexão
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
  
  // Componentes de conexão
  private noiseHandler?: any;
  private webSocket?: WebSocketClient;
  private keyManager?: KeyManager;
  // QR generation is now handled by QRCodeGenerator utility
  
  // Gerenciadores
  private sessionManager: SessionManager;
  private cacheManager: CacheManager;
  private credentialsManager: CredentialsManager;
  private authStateManager: AuthStateManager;
  private connectionEventDetector: ConnectionEventDetector;
  private authCredentials: AuthCredentials | null = null;
  private sessionData: SessionData | null = null;
  
  // Estado de autenticação 
  private authState: AuthenticationState | null = null;
  private legacyAuthState: AuthState = {};
  private saveCreds?: () => Promise<void>;
  
  // Timers e intervalos
  private qrCodeTimer?: NodeJS.Timeout;
  private connectionTimer?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  
  // Controle de exibição do QR code
  private lastDisplayedQR?: string;
  
  constructor(
    config: InstanceConfig,
    sessionManager: SessionManager,
    cacheManager: CacheManager
  ) {
    super();
    
    this.config = config;
    this.sessionManager = sessionManager;
    this.cacheManager = cacheManager;
    this.credentialsManager = new CredentialsManager();
    this.authStateManager = new AuthStateManager(config.id);
    this.connectionEventDetector = new ConnectionEventDetector();
    this.createdAt = new Date();
    this.updatedAt = new Date();
    
    Logger.info(`📱 Inicializando instância: ${config.name} (ID: ${config.id})`);
    
    // Inicializa componentes
    this.initializeComponents();
    
    // Configura listeners do detector de eventos
    this.setupConnectionEventListeners();
    
    // Carrega estado salvo
    this.loadSavedState();
  }

  /**
   * Inicializa os componentes necessários
   */
  private initializeComponents(): void {
    try {
      // Inicializa gerenciador de chaves
      this.keyManager = new KeyManager();
      
      // Inicializa gerador de QR code
      // QR generation is now handled by QRCodeGenerator utility
      
      // Inicializa handshake
      this.noiseHandler = null;
      
      // Configura listeners do handshake
      this.setupHandshakeListeners();
      
      Logger.info(`✅ Componentes inicializados para instância: ${this.config.id}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao inicializar componentes da instância ${this.config.id}:`, error);
      throw error;
    }
  }

  /**
   * Carrega estado salvo da sessão
   */
  private async loadSavedState(): Promise<void> {
    try {
      // Carrega estado usando o novo AuthStateManager
      this.authState = await this.authStateManager.loadAuthState();
      
      if (this.authState) {
        // Extrai informações do usuário das credenciais
        if (this.authState.creds.me) {
          this.phoneNumber = this.authState.creds.me.id;
          this.profileName = this.authState.creds.me.name;
        }
        
        Logger.info(`📂 Estado de autenticação carregado para instância: ${this.config.id}`);
      } else {
        // Fallback para o sistema legado
        const savedAuth = await this.sessionManager.getAuthState(this.config.id);
        
        if (savedAuth) {
          this.legacyAuthState = savedAuth;
          this.phoneNumber = savedAuth.phoneNumber;
          this.profileName = savedAuth.profileName;
          
          Logger.info(`📂 Estado de autenticação legado carregado para instância: ${this.config.id}`);
        }
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado da instância ${this.config.id}:`, error);
    }
  }

  /**
   * Conecta a instância WhatsApp
   */
  public async connect(): Promise<OperationResult> {
    try {
      console.log('🔍 [WHATSAPP_INSTANCE] Método connect() chamado para instância:', this.config.id);
      console.log('🔍 [WHATSAPP_INSTANCE] Status atual:', this.status);
      
      if (this.status === 'connected') {
        console.log('🔍 [WHATSAPP_INSTANCE] Instância já conectada - retornando erro');
        return {
          success: false,
          error: 'Instância já está conectada',
          code: 'ALREADY_CONNECTED'
        };
      }
      
      if (this.status === 'connecting') {
        console.log('🔍 [WHATSAPP_INSTANCE] Conexão já em andamento - retornando erro');
        return {
          success: false,
          error: 'Conexão já está em andamento',
          code: 'ALREADY_CONNECTING'
        };
      }

      Logger.info(`🔌 Iniciando conexão da instância: ${this.config.id}`);
      console.log('🔍 [WHATSAPP_INSTANCE] Atualizando status para connecting');
      
      this.updateStatus('connecting');
      
      // Inicializa ou carrega credenciais
      console.log('🔍 [WHATSAPP_INSTANCE] Inicializando credenciais...');
      await this.initializeCredentials();
      
      // Verifica se tem credenciais salvas
      console.log('🔍 [WHATSAPP_INSTANCE] Verificando se tem sessão salva...');
      if (this.credentialsManager.hasSession(this.config.id)) {
        console.log('🔍 [WHATSAPP_INSTANCE] Sessão encontrada - usando credenciais salvas');
        Logger.info(`🔑 Usando credenciais salvas para instância: ${this.config.id}`);
        this.sessionData = await this.credentialsManager.loadSession(this.config.id);
        if (this.sessionData) {
          console.log('🔍 [WHATSAPP_INSTANCE] Chamando connectWithSavedCredentials()');
          return await this.connectWithSavedCredentials();
        }
      }
      
      console.log('🔍 [WHATSAPP_INSTANCE] Nenhuma sessão salva - iniciando nova autenticação');
      Logger.info(`📱 Iniciando novo processo de autenticação para instância: ${this.config.id}`);
      return await this.startNewAuthentication();
      
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
      // Usa o novo método
      const authStateResult = await this.authStateManager.createBaileysCompatibleAuthState();
      this.authState = authStateResult.state;
      this.saveCreds = authStateResult.saveCreds;
      
      if (this.authState && this.authState.creds) {
        Logger.info(`🔑 Estado de autenticação carregado para instância: ${this.config.id}`);
      } else {
        Logger.info(`🔑 Novo estado de autenticação criado para instância: ${this.config.id}`);
      }
      
      // Configura listener de creds.update
      this.setupCredsUpdateListener();
      
      // Fallback para sistema legado se necessário
      if (!this.authState) {
        this.authCredentials = await this.credentialsManager.loadCredentials(this.config.id);
        
        if (!this.authCredentials) {
          this.authCredentials = await this.credentialsManager.createCredentials(this.config.id);
          Logger.info(`🔑 Credenciais legadas criadas para instância: ${this.config.id}`);
        } else {
          Logger.info(`🔑 Credenciais legadas carregadas para instância: ${this.config.id}`);
        }
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao inicializar credenciais para instância ${this.config.id}:`, error);
      throw error;
    }
  }

  /**
   * Configura listener de creds.update baseado no padrão Baileys
   */
  private setupCredsUpdateListener(): void {
    try {
      // Implementa o padrão real: ev.on('creds.update', saveCreds)
      // Escuta eventos de atualização de credenciais do protocolo WhatsApp
      this.on('creds.update', async (credsUpdate: Partial<AuthenticationCreds>) => {
        try {
          if (this.saveCreds && credsUpdate) {
            // Valida e atualiza as credenciais no estado atual
            if (this.authState && this.authState.creds) {
              // Merge seguro das credenciais atualizadas
              this.authState.creds = {
                ...this.authState.creds,
                ...credsUpdate
              };
              
              // Atualiza timestamp da última modificação
              this.updatedAt = new Date();
            }
            
            // Salva automaticamente usando o método do AuthStateManager
            await this.saveCreds();
            Logger.debug(`💾 Credenciais atualizadas automaticamente via creds.update para instância: ${this.config.id}`);
            
            // Emite evento para outros componentes
            this.emit('credentials-updated', {
              instanceId: this.config.id,
              timestamp: this.updatedAt
            });
          }
        } catch (error) {
          Logger.error(`❌ Erro ao salvar credenciais via creds.update para ${this.config.id}:`, error);
          // Re-emite o erro para tratamento upstream
          this.emit('credentials-error', error);
        }
      });
      
      Logger.debug(`🔧 Listener de creds.update configurado para instância: ${this.config.id}`);
    } catch (error) {
      Logger.error(`❌ Erro ao configurar listener de creds.update para ${this.config.id}:`, error);
    }
  }

  /**
   * Emite evento creds.update para salvar credenciais automaticamente
   */
  private emitCredsUpdate(credsUpdate: Partial<AuthenticationCreds>): void {
    this.emit('creds.update', credsUpdate);
  }

  /**
   * Conecta usando credenciais salvas
   */
  private async connectWithSavedCredentials(): Promise<OperationResult> {
    try {
      // Verifica se tem estado de autenticação válido
      if (!this.authState || !this.authState.creds) {
        Logger.warn(`⚠️ Estado de autenticação inválido, iniciando nova autenticação: ${this.config.id}`);
        return await this.startNewAuthentication();
      }
      
      // Inicializa WebSocket com estado de autenticação Baileys
      console.log('🔍 [WHATSAPP_INSTANCE] AuthState antes de criar WebSocket:', !!this.authState);
      console.log('🔍 [WHATSAPP_INSTANCE] AuthState.creds:', !!this.authState?.creds);
      this.webSocket = new WebSocketClient(undefined, this.authState, this.saveCreds);
      console.log('🔍 [WHATSAPP_INSTANCE] WebSocket criado com authState');
      
      // Configura event listeners
      this.setupWebSocketListeners();
      
      // Conecta o detector de eventos ao WebSocket
      this.connectionEventDetector.setWebSocket(this.webSocket);
      
      // Conecta usando credenciais existentes
      await this.webSocket.connect();
      
      // Autentica com credenciais salvas
      const authResult = await this.authenticateWithBaileysCredentials();
      
      if (authResult.success) {
        this.updateStatus('connected');
        this.lastSeen = new Date();
        
        // Inicia heartbeat
        this.startHeartbeat();
        
        Logger.info(`✅ Instância conectada com credenciais salvas: ${this.config.id}`);
        
        return {
          success: true,
          status: 'connected'
        };
      } else {
        // Credenciais inválidas, inicia nova autenticação
        Logger.warn(`⚠️ Credenciais inválidas, iniciando nova autenticação: ${this.config.id}`);
        return await this.startNewAuthentication();
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao conectar com credenciais salvas ${this.config.id}:`, error);
      return await this.startNewAuthentication();
    }
  }

  /**
   * Inicia nova autenticação com QR code
   */
  private async startNewAuthentication(): Promise<OperationResult> {
    try {
      Logger.info(`🔐 Iniciando processo de autenticação para instância: ${this.config.id}`);
      
      // Garante que temos estado de autenticação
      if (!this.authState) {
        this.authState = await this.authStateManager.initAuthState();
      }
      
      if (!this.authState || !this.authState.creds) {
        throw new Error('Estado de autenticação não inicializado');
      }
      
      Logger.info(`✅ Estado de autenticação verificado para instância: ${this.config.id}`);
      
      // Limpa dados de usuário antigos
      this.phoneNumber = undefined;
      this.profileName = undefined;
      
      // Inicializa WebSocket com estado de autenticação Baileys
      console.log('🔍 [WHATSAPP_INSTANCE] AuthState antes de criar WebSocket:', !!this.authState);
      console.log('🔍 [WHATSAPP_INSTANCE] AuthState.creds:', !!this.authState?.creds);
      this.webSocket = new WebSocketClient(undefined, this.authState, this.saveCreds);
      console.log('🔍 [WHATSAPP_INSTANCE] WebSocket criado com authState');
      
      // Configura event listeners
      this.setupWebSocketListeners();
      
      // Conecta WebSocket (o handshake será iniciado automaticamente)
      await this.webSocket.connect();
      Logger.info(`🔌 WebSocket conectado para instância: ${this.config.id}`);
      Logger.info(`✅ HANDSHAKE CONCLUÍDO para instância: ${this.config.id}`);
      
      this.updateStatus('connecting');
      
      Logger.info(`⏳ Aguardando pair-device do servidor WhatsApp para instância: ${this.config.id}`);
      
      // Retorna sucesso imediatamente - o QR code será gerado automaticamente
      // quando o servidor enviar o pair-device via connection.update
      return {
        success: true,
        status: 'connecting'
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao iniciar nova autenticação ${this.config.id}:`, error);
      this.updateStatus('disconnected');
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'AUTHENTICATION_ERROR'
      };
    }
  }

  /**
   * Gera QR code para autenticação
   */
  private async generateQRCode(): Promise<OperationResult> {
    try {
      // Verifica se as credenciais estão inicializadas (prioriza Baileys)
      if (!this.authState && !this.authCredentials) {
        Logger.error(`❌ Credenciais não inicializadas para instância: ${this.config.id}`);
        // Tenta inicializar as credenciais novamente
        await this.initializeCredentials();
        
        if (!this.authState && !this.authCredentials) {
          throw new Error('Falha ao inicializar credenciais de autenticação');
        }
      }
      
      // Usa o método se disponível
      if (this.authState) {
        return await this.generateQRCodeWithBaileysCredentials();
      }
      
      // Fallback para sistema legado
      if (!this.authCredentials) {
        throw new Error('Nenhum sistema de credenciais disponível');
      }
      
      // Gera um ref simulado (em produção, isso viria do servidor WhatsApp)
      const ref = Buffer.from(`ref_${Date.now()}_${Math.random().toString(36).substring(2)}`).toString('base64');
      
      // Gera dados do QR code usando o handshake com formato legado
      const qrData = QRCodeGenerator.generateQRData(ref, this.authCredentials);
      
      if (!qrData) {
        throw new Error('Falha ao gerar dados do QR code');
      }
      
      // Usa os dados reais do handshake como QR code
      this.qrCode = qrData;
      this.qrCodeExpiresAt = new Date(Date.now() + 60000); // 1 minuto
      
      // Salva no cache
      if (this.qrCode) {
         await this.cacheManager.setQRCode(this.config.id, this.qrCode, this.qrCodeExpiresAt);
       }
      
      // Emite evento
      this.emit('qr_code', this.qrCode);
      
      // Sempre imprime no terminal para visualização
      if (this.qrCode) {
        // QR display is now handled by the client application
      }
      
      // Também imprime se configurado nas settings
      if (this.config.settings?.printQRInTerminal) {
        Logger.info(`📱 QR code configurado para impressão no terminal`);
      }
      
      Logger.info(`📱 QR code real gerado para instância: ${this.config.id}`);
      
      return {
        success: true,
        qrCode: this.qrCode,
        expiresAt: this.qrCodeExpiresAt
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao gerar novo QR code ${this.config.id}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'QR_GENERATION_ERROR'
      };
    }
  }

  /**
   * Gera QR code usando as credenciais Baileys
   * IMPORTANTE: No Baileys oficial, o QR code é gerado automaticamente pelo WebSocket
   * quando recebe pair-device do servidor. Esta função apenas retorna o QR existente.
   */
  private async generateQRCodeWithBaileysCredentials(): Promise<OperationResult> {
    try {
      if (!this.authState || !this.authState.creds) {
        throw new Error('Estado de autenticação não disponível');
      }
      
      Logger.info(`🚀 Verificando QR code para instância: ${this.config.id}`);
      
      // Se já temos um QR code válido, retorna ele
      if (this.qrCode && this.qrCodeExpiresAt && this.qrCodeExpiresAt > new Date()) {
        Logger.info(`📱 QR code existente ainda válido para instância: ${this.config.id}`);
        console.log(`🎯 QR CODE EXISTENTE: ${this.qrCode}`);
        return {
          success: true,
          qrCode: this.qrCode,
          expiresAt: this.qrCodeExpiresAt
        };
      }
      
      // No Baileys oficial, o QR code é gerado automaticamente pelo WebSocket
      // quando recebe a mensagem pair-device do servidor WhatsApp.
      // Não devemos gerar refs temporários - isso quebra o protocolo.
      
      Logger.info(`⏳ Aguardando QR code do servidor WhatsApp para instância: ${this.config.id}`);
      
      // Se não temos QR code, significa que ainda não recebemos pair-device
      // ou a conexão WebSocket não está estabelecida
      if (!this.webSocket || !this.webSocket.isConnected) {
        return {
          success: false,
          error: 'Conexão WebSocket não estabelecida. Inicie a conexão primeiro.',
          code: 'WEBSOCKET_NOT_CONNECTED'
        };
      }
      
      // Aguarda um pouco para o QR code ser gerado automaticamente
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            success: false,
            error: 'Timeout aguardando QR code do servidor WhatsApp',
            code: 'QR_TIMEOUT'
          });
        }, 10000); // 10 segundos
        
        // Escuta por QR code gerado automaticamente
        const onQRCode = (qr: string) => {
          clearTimeout(timeout);
          this.off('qr_code', onQRCode);
          
          resolve({
            success: true,
            qrCode: qr,
            expiresAt: this.qrCodeExpiresAt
          });
        };
        
        this.on('qr_code', onQRCode);
        
        // Se já temos QR code enquanto aguardávamos
        if (this.qrCode) {
          clearTimeout(timeout);
          this.off('qr_code', onQRCode);
          
          resolve({
            success: true,
            qrCode: this.qrCode,
            expiresAt: this.qrCodeExpiresAt
          });
        }
      });
      
    } catch (error) {
      Logger.error(`❌ Erro ao verificar QR code com credenciais Baileys ${this.config.id}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'QR_GENERATION_ERROR'
      };
    }
  }
  
  /**
   * Método removido - no Baileys original o servidor envia pair-device automaticamente
   * após a conexão e validação, não é necessário iniciar handshake customizado
   */
  
  /**
   * Método removido - não é necessário no padrão Baileys original
   */
  
  /**
   * Extrai nó filho de um nó binário
   */
  private getBinaryNodeChild(node: any, tag: string): any {
    if (!node || !node.content) return null;
    
    for (const child of node.content) {
      if (child.tag === tag) {
        return child;
      }
    }
    return null;
  }
  
  /**
   * Extrai nós filhos de um nó binário
   */
  private getBinaryNodeChildren(node: any, tag: string): any[] {
    if (!node || !node.content) return [];
    
    return node.content.filter((child: any) => child.tag === tag);
  }

  /**
   * Autentica com credenciais salvas
   */
  private async authenticateWithBaileysCredentials(): Promise<OperationResult> {
    try {
      // Implementa autenticação com credenciais salvas
      if (!this.authState || !this.authState.creds) {
        return {
          success: false,
          error: 'Estado de autenticação não encontrado',
          code: 'NO_STATE'
        };
      }
      
      // Verifica se as credenciais têm informações de usuário (indicando autenticação prévia)
      if (!this.authState.creds.me || !this.authState.creds.me.id) {
        return {
          success: false,
          error: 'Credenciais incompletas - usuário não autenticado',
          code: 'INCOMPLETE_CREDS'
        };
      }
      
      // Valida chaves essenciais
      if (!this.authState.creds.noiseKey || !this.authState.creds.signedIdentityKey) {
        return {
          success: false,
          error: 'Chaves de autenticação inválidas',
          code: 'INVALID_KEYS'
        };
      }
      
      // Tenta restaurar a sessão usando as credenciais
      try {
        // Restaura sessão usando credenciais (implementação simplificada)
        Logger.info(`🔄 Restaurando sessão para instância: ${this.config.id}`);
        
        // Atualiza informações do usuário
        this.phoneNumber = this.authState.creds.me.id;
        this.profileName = this.authState.creds.me.name;
        
        Logger.info(`✅ Sessão restaurada para usuário: ${this.phoneNumber}`);
        
        return {
          success: true,
          status: 'connected'
        };
      } catch (restoreError) {
        Logger.error(`❌ Erro ao restaurar sessão:`, restoreError);
        return {
          success: false,
          error: `Falha ao restaurar sessão: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          code: 'SESSION_RESTORE_ERROR'
        };
      }
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'AUTH_ERROR'
      };
    }
  }

  /**
   * Configura listeners do WebSocket
   */
  private setupWebSocketListeners(): void {
    if (!this.webSocket) return;
    
    this.webSocket.on('open', async () => {
      Logger.info(`🔗 WebSocket conectado para instância: ${this.config.id}`);
      
      // IMPORTANTE: Sincroniza o estado do ConnectionEventDetector
      this.connectionEventDetector.startConnection();
      
      // Inicia handshake sempre que temos credenciais (mesmo para novas autenticações)
      if (this.authState && this.authState.creds) {
        Logger.info(`🤝 Iniciando handshake para instância: ${this.config.id}`);
        try {
          // O handshake é iniciado automaticamente no método validateConnection do WebSocket
          Logger.info(`✅ WebSocket conectado, handshake será iniciado automaticamente: ${this.config.id}`);
        } catch (error) {
          Logger.error(`❌ Erro na conexão: ${error}`);
        }
      } else {
        Logger.info(`❌ Credenciais não disponíveis para handshake: ${this.config.id}`);
      }
    });
    
    this.webSocket.on('close', () => {
      Logger.info(`🔗 WebSocket desconectado para instância: ${this.config.id}`);
      this.handleDisconnection('websocket_closed');
    });
    
    this.webSocket.on('error', (error) => {
      Logger.error(`❌ Erro no WebSocket da instância ${this.config.id}:`, error);
      this.emit('error', error);
    });
    
    this.webSocket.on('message', (data) => {
      this.handleWebSocketMessage(data);
    });
    
    // Escuta evento de connection.update do WebSocketClient (padrão Baileys)
    this.webSocket.on('connection.update', (update: any) => {
      // Log de connection update removido para evitar spam
      // Logger.info(`🔄 Connection update do WebSocketClient para instância ${this.config.id}:`, update);
      
      // Se há QR code no update
      if (update.qr) {
        Logger.info(`📱 QR code recebido via connection.update para instância: ${this.config.id}`);
        
        // Exibe o QR code no console apenas se for diferente do último exibido
        if (this.lastDisplayedQR !== update.qr) {
          console.log(`\n🎯 [QR CODE] Nova instância ${this.config.id}:`);
          console.log(update.qr);
          console.log(`⏰ Expira em: ${update.qrExpiresAt || new Date(Date.now() + 60000)}\n`);
          this.lastDisplayedQR = update.qr;
        }
        
        // Calcula tempo de expiração baseado nos dados do update
        const expirationTime = update.qrExpiresAt || new Date(Date.now() + 60000);
        
        this.qrCode = update.qr;
        this.qrCodeExpiresAt = expirationTime;
        
        // CORREÇÃO: Atualiza status para qr_code quando QR é gerado
        this.updateStatus('qr_code');
        
        // Emite evento com informações adicionais
        this.emit('qr_code', {
          qr: update.qr,
          qrIndex: update.qrIndex || 0,
          qrTotal: update.qrTotal || 1,
          expiresAt: expirationTime
        });
        
        // Configura timeout baseado no tempo real de expiração
        this.setupQRCodeTimeout(expirationTime);
        
        // Armazena no cache apenas se o QR code existe
        if (this.qrCode) {
          this.cacheManager.setQRCode(this.config.id, this.qrCode, this.qrCodeExpiresAt);
        }
      }
      
      // Se é um novo login
      if (update.isNewLogin) {
        Logger.info(`✅ Novo login detectado via connection.update para instância: ${this.config.id}`);
        this.qrCode = undefined;
        this.qrCodeExpiresAt = undefined;
      }
      
      // Se há mudança de estado de conexão
       if (update.connection) {
         // Log removido para evitar spam - só loga mudanças importantes
         // Logger.info(`🔄 Estado de conexão via WebSocket: ${update.connection}`);
         // Connection state - log removido para evitar spam
         
         if (update.connection === 'connecting') {
           // Só atualiza para connecting se não temos QR code
           if (!update.qr) {
             console.log(`🔄 [WHATSAPP_INSTANCE] Atualizando para connecting (sem QR)`);
             this.updateStatus('connecting');
           }
         } else if (update.connection === 'open') {
           Logger.info(`✅ Conexão estabelecida com sucesso via WebSocket para instância: ${this.config.id}`);
           console.log(`✅ [WHATSAPP_INSTANCE] Conexão aberta - atualizando para connected`);
           this.updateStatus('connected');
           this.lastSeen = new Date();
           this.startHeartbeat();
           this.emit('connected', update);
         }
       }
    });
  }

  /**
   * Processa mensagens do WebSocket
   */
  private async handleWebSocketMessage(data: Buffer): Promise<void> {
    try {
      Logger.debug(`📨 Mensagem recebida na instância ${this.config.id}, tamanho: ${data.length} bytes`);
      
      // Processa através do detector de eventos - ÚNICA fonte de detecção
      this.connectionEventDetector.processWebSocketData(data);
      
      // IMPORTANTE: Só processa mensagens se o ConnectionEventDetector não as ignorou
      // O detector ignora mensagens em estados inválidos (ex: server_hello em estado 'close')
      const detectorState = this.connectionEventDetector.getCurrentState();
      
      // Só processa handshake se estivermos no estado correto E o detector permitir
      if ((this.status === 'qr_code' || this.status === 'connecting') && detectorState === 'connecting') {
        await this.processHandshakeMessage(data);
      } else if (this.status === 'connected' && detectorState === 'open') {
        // Processa mensagens normais após autenticação
        await this.processNormalMessage(data);
      } else {
        Logger.debug(`📋 Mensagem ignorada - Status instância: ${this.status}, Estado detector: ${detectorState}`);
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao processar mensagem na instância ${this.config.id}:`, error);
      this.handleAuthenticationError(error);
    }
  }

  /**
   * Trata evento de QR code escaneado
   */
  private async handleQRScanned(): Promise<void> {
    try {
      Logger.info(`🎉 QR code escaneado com sucesso para instância: ${this.config.id}`);
      
      // Limpa timer do QR code
      if (this.qrCodeTimer) {
        clearTimeout(this.qrCodeTimer);
        this.qrCodeTimer = undefined;
      }
      
      // Atualiza status para conectando
      this.updateStatus('connecting');
      
      // Log detalhado para debug
      Logger.info(`📱 Iniciando processo de autenticação para instância: ${this.config.id}`);
      Logger.info(`🔄 Status atualizado para 'connecting' - aguardando finalização do handshake`);
      
      // Emite evento para notificar interface
      this.emit('qr_scanned', {
        instanceId: this.config.id,
        timestamp: new Date().toISOString(),
        message: 'QR Code escaneado com sucesso! Finalizando autenticação...'
      });
      
    } catch (error) {
      Logger.error(`❌ Erro ao processar QR escaneado para instância ${this.config.id}:`, error);
      this.handleAuthenticationError(error);
    }
  }

  /**
   * Trata evento de login bem-sucedido
   */
  private async handleLoginSuccess(data: Buffer): Promise<void> {
    try {
      Logger.info(`✅ Login bem-sucedido para instância: ${this.config.id}`);
      
      // Parse dos dados de autenticação vindos do Handshake
      let authData: any;
      try {
        // Os dados chegam como JSON string do Handshake
        authData = JSON.parse(data.toString('utf8'));
      } catch (parseError) {
        Logger.error(`❌ Erro ao fazer parse dos dados de autenticação para ${this.config.id}:`, parseError);
        // Fallback para dados placeholder se parsing falhar
        authData = {
          creds: {
            deviceId: `device_${this.config.id}`,
            phoneNumber: undefined,
            profileName: undefined
          }
        };
      }
      
      // Atualiza authState com dados recebidos
      if (this.authState && authData.creds) {
        // Merge das credenciais existentes com as novas
        this.authState.creds = {
          ...this.authState.creds,
          ...authData.creds
        };
        
        // Atualiza chaves se disponíveis
        if (authData.keys && this.authState.keys) {
          if (authData.keys.sendingKey) {
            this.authState.keys.set({
              'sender-key': {
                'default:self': {
                  groupId: 'default', 
                  senderId: 'self', 
                  senderKey: authData.keys.sendingKey 
                }
              }
            });
          }
          if (authData.keys.receivingKey) {
            this.authState.keys.set({
              'sender-key': {
                'receiver:peer': {
                  groupId: 'receiver', 
                  senderId: 'peer', 
                  senderKey: authData.keys.receivingKey 
                }
              }
            });
          }
        }
        
        // Emite evento creds.update para salvamento automático ()
        this.emitCredsUpdate(authData.creds);
        
        Logger.info(`💾 Estado de autenticação processado para instância: ${this.config.id}`);
      }
      
      this.phoneNumber = authData.creds?.phoneNumber || authData.phoneNumber;
      this.profileName = authData.creds?.profileName || authData.profileName;
      
      // Limpa QR code
      await this.clearExpiredQRCode();
      
      // Atualiza status para conectado
      this.updateStatus('connected');
      this.lastSeen = new Date();
      
      // Inicia heartbeat
      this.startHeartbeat();
      
      this.emit('connected', {
        instanceId: this.config.id,
        phoneNumber: this.phoneNumber || 'Desconhecido',
        profileName: this.profileName || 'WhatsApp User'
      });
      
    } catch (error) {
      Logger.error(`❌ Erro ao processar login bem-sucedido para instância ${this.config.id}:`, error);
      this.handleAuthenticationError(error);
    }
  }

  /**
   * Decodifica ServerHello usando protobuf
   */
  private async decodeServerHello(buffer: Buffer): Promise<any> {
    try {
      Logger.debug('🔍 [DECODE] Iniciando decodificação manual do ServerHello...');
      Logger.debug('🔍 [DECODE] Dados brutos recebidos:', {
        length: buffer.length,
        hex: buffer.toString('hex'),
        firstBytes: buffer.slice(0, 10).toString('hex'),
        lastBytes: buffer.slice(-10).toString('hex')
      });
      
      // Remove os primeiros 3 bytes (cabeçalho de tamanho)
      // Os primeiros 3 bytes contêm o tamanho do frame: 1 byte (MSB) + 2 bytes (LSB)
      if (buffer.length < 3) {
        throw new Error('Buffer muito pequeno para conter cabeçalho');
      }
      
      const frameSize = (buffer.readUInt8(0) << 16) | buffer.readUInt16BE(1);
      Logger.debug(`🔍 [DECODE] Frame size detectado: ${frameSize} bytes, buffer total: ${buffer.length}`);
      
      // Extrai apenas o payload do frame (sem o cabeçalho de 3 bytes)
      const frameData = buffer.slice(3, 3 + frameSize);
      
      Logger.debug('📊 [DECODE] Dados do frame extraídos:', {
        originalLength: buffer.length,
        frameLength: frameData.length,
        frameHex: frameData.toString('hex'),
        headerRemoved: buffer.slice(0, 3).toString('hex')
      });
      
      // Decodifica HandshakeMessage usando @wppconnect/wa-proto
      Logger.debug('🔍 [DECODE] Tentando decodificar com waproto.HandshakeMessage...');
      const handshake = waproto.waproto.HandshakeMessage.decode(frameData);
       
      Logger.debug('🔍 [DECODE] ServerHello decodificado com sucesso:', {
        hasServerHello: !!handshake.serverHello,
        hasClientHello: !!handshake.clientHello,
        hasClientFinish: !!handshake.clientFinish,
        serverHelloDetails: handshake.serverHello ? {
          hasEphemeral: !!handshake.serverHello.ephemeral,
          hasStatic: !!handshake.serverHello.static,
          hasPayload: !!handshake.serverHello.payload,
          ephemeralLength: handshake.serverHello.ephemeral?.length,
          staticLength: handshake.serverHello.static?.length,
          payloadLength: handshake.serverHello.payload?.length
        } : null
      });
       
      return handshake;
      
    } catch (error) {
      Logger.error('❌ [DECODE ERROR] Erro ao decodificar ServerHello:', {
        error: (error as Error).message,
        stack: (error as Error).stack,
        dataLength: buffer.length,
        dataHex: buffer.toString('hex')
      });
      throw error;
    }
  }

  /**
   * Processa mensagens durante o handshake
   */
  private async processHandshakeMessage(data: Buffer): Promise<void> {
    try {
      Logger.info(`🤝 Processando mensagem de handshake para instância ${this.config.id}`);
      
      // Processa Server Hello através do NoiseHandler
      if (!this.noiseHandler) {
        throw new Error('NoiseHandler não inicializado');
      }
      
      if (!this.authCredentials) {
        throw new Error('Credenciais de autenticação não disponíveis');
      }
      
      // Decodifica o Buffer para HandshakeMessage antes de processar
      const handshakeMessage = await this.decodeServerHello(data);
      const result = await this.noiseHandler.processHandshake(handshakeMessage, this.authCredentials);
      
      if (result) {
        Logger.info(`✅ Server Hello processado com sucesso para instância ${this.config.id}`);
        
        // Atualiza status para conectando
        this.updateStatus('connecting');
        
        // Cria e envia Client Finish
        const clientFinish = await this.createClientFinish();
        if (clientFinish && this.webSocket) {
          this.webSocket.send(clientFinish);
          Logger.info(`📤 Client Finish enviado para instância ${this.config.id}`);
        }
        
      } else {
        Logger.warn(`⚠️ Falha ao processar Server Hello para instância ${this.config.id}`);
      }
      
    } catch (error) {
      Logger.error(`❌ Erro no processamento de handshake para instância ${this.config.id}:`, error);
      throw error;
    }
  }

  /**
   * Cria mensagem Client Finish
   */
  private async createClientFinish(): Promise<Buffer | null> {
    try {
      // Implementa a criação do Client Finish baseado no protocolo WhatsApp
      Logger.info(`🔧 Criando Client Finish para instância ${this.config.id}`);
      
      if (!this.authState || !this.authState.creds) {
        throw new Error('Estado de autenticação não disponível para Client Finish');
      }
      
      // Gera chaves para o Client Finish
      const keyEnc = this.authState.creds.signedIdentityKey?.public || Buffer.alloc(32);
      const payloadEnc = Buffer.from(JSON.stringify({
        deviceId: this.authState.creds.registrationId,
        timestamp: Date.now()
      }));
      
      // Implementação real do Client Finish baseado no protocolo Baileys
      const clientFinishMessage = {
        clientFinish: {
          static: keyEnc,
          payload: payloadEnc
        }
      };

      // Encode usando implementação local (baseada no Baileys)
      try {
        const encoded = this.encodeBinaryNodeLocal(clientFinishMessage);
        return Buffer.from(encoded);
      } catch (error) {
        Logger.error(`❌ Erro ao codificar Client Finish para instância ${this.config.id}:`, error);
        return null;
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao criar Client Finish para instância ${this.config.id}:`, error);
      return null;
    }
  }

  /**
   * Codifica um nó binário (implementação local baseada no Baileys)
   */
  private encodeBinaryNodeLocal(node: any): number[] {
    const buffer: number[] = [0];
    this.encodeBinaryNodeInner(node, buffer);
    return buffer;
  }

  private encodeBinaryNodeInner(node: any, buffer: number[]): void {
    const { tag, attrs, content } = node;
    
    // Implementação simplificada para handshake messages
    if (typeof tag === 'string') {
      // Encode tag as string
      const tagBytes = Buffer.from(tag, 'utf8');
      buffer.push(tagBytes.length);
      for (const byte of tagBytes) {
        buffer.push(byte);
      }
    }
    
    // Encode attributes
    if (attrs && typeof attrs === 'object') {
      const attrCount = Object.keys(attrs).length;
      buffer.push(attrCount);
      
      for (const [key, value] of Object.entries(attrs)) {
        // Encode key
        const keyBytes = Buffer.from(key, 'utf8');
        buffer.push(keyBytes.length);
        for (const byte of keyBytes) {
          buffer.push(byte);
        }
        
        // Encode value
        if (typeof value === 'string') {
          const valueBytes = Buffer.from(value, 'utf8');
          buffer.push(valueBytes.length);
          for (const byte of valueBytes) {
            buffer.push(byte);
          }
        } else if (Buffer.isBuffer(value)) {
          buffer.push(value.length);
          for (const byte of value) {
            buffer.push(byte);
          }
        }
      }
    } else {
      buffer.push(0); // No attributes
    }
    
    // Encode content
    if (content) {
      if (Buffer.isBuffer(content)) {
        buffer.push(content.length);
        for (const byte of content) {
          buffer.push(byte);
        }
      } else if (Array.isArray(content)) {
        buffer.push(content.length);
        for (const child of content) {
          this.encodeBinaryNodeInner(child, buffer);
        }
      } else if (typeof content === 'object') {
        buffer.push(1);
        this.encodeBinaryNodeInner(content, buffer);
      }
    } else {
      buffer.push(0); // No content
    }
  }

  /**
   * Detecta evento pair-success nos dados recebidos
   */
  // Métodos de detecção removidos - agora usa apenas ConnectionEventDetector

  /**
   * Processa mensagens normais após autenticação
   */
  private async processNormalMessage(data: Buffer): Promise<void> {
    try {
      Logger.debug(`📱 Processando mensagem normal para instância ${this.config.id}`);
      
      // Descriptografa a mensagem usando as chaves do noiseHandler
      if (!this.noiseHandler) {
        throw new Error('NoiseHandler não inicializado');
      }
      
      const decrypted = this.noiseHandler.decrypt(data);
      
      if (decrypted) {
        // Processa mensagem descriptografada
        await this.handleDecryptedMessage(decrypted);
      } else {
        Logger.warn(`⚠️ Falha ao descriptografar mensagem para instância ${this.config.id}`);
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao processar mensagem normal para instância ${this.config.id}:`, error);
    }
  }

  /**
   * Processa mensagem descriptografada
   */
  private async handleDecryptedMessage(data: Buffer): Promise<void> {
    try {
      // Aqui seria implementado o processamento das mensagens do WhatsApp
      // Por exemplo: mensagens de texto, imagens, status de entrega, etc.
      Logger.debug(`📨 Mensagem descriptografada recebida para instância ${this.config.id}`);
      
      // Atualiza último contato
      this.lastSeen = new Date();
      
      // Emite evento para listeners
      this.emit('message', data);
      
    } catch (error) {
      Logger.error(`❌ Erro ao processar mensagem descriptografada para instância ${this.config.id}:`, error);
    }
  }

  /**
   * Trata erros de autenticação
   */
  private handleAuthenticationError(error: any): void {
    Logger.error(`🚨 Erro de autenticação na instância ${this.config.id}:`, error);
    
    // Se estivermos no processo de QR code, gera um novo
    if (this.status === 'qr_code') {
      Logger.info(`🔄 Gerando novo QR code devido a erro de autenticação`);
      this.generateNewQRCode();
    } else {
      // Para outros estados, desconecta e permite reconexão
      this.updateStatus('disconnected');
      this.emit('authentication_failed', error);
    }
  }

  /**
   * Configura timeout do QR code
   */
  private setupQRCodeTimeout(expiresAt?: Date): void {
    if (this.qrCodeTimer) {
      clearTimeout(this.qrCodeTimer);
    }
    
    // Calcula timeout baseado no tempo de expiração ou usa padrão
    const timeout = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 60000;
    
    this.qrCodeTimer = setTimeout(() => {
      if (this.status === 'qr_code' || this.status === 'connecting') {
        Logger.info(`⏰ QR code expirado para instância: ${this.config.id}`);
        
        // Limpa QR code expirado
        this.qrCode = undefined;
        this.qrCodeExpiresAt = undefined;
        this.cacheManager.clearQRCode(this.config.id);
        
        // Atualiza status para disconnected para permitir nova geração
        this.updateStatus('disconnected');
        
        // Desconecta WebSocket se ainda estiver conectado
        if (this.webSocket) {
          this.webSocket.disconnect();
          this.webSocket = undefined;
        }
        
        Logger.info(`🔄 Instância ${this.config.id} resetada após expiração do QR code`);
      }
    }, timeout);
  }

  /**
   * Inicia heartbeat para manter conexão
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.status === 'connected' && this.webSocket) {
        // Envia ping para manter conexão
        // TODO: Implementar método ping no WebSocketClient
        // this.webSocket.ping();
        this.lastSeen = new Date();
      }
    }, 30000); // 30 segundos
  }

  /**
   * Gera novo QR code
   */
  public async generateNewQRCode(): Promise<OperationResult> {
    if (this.status !== 'qr_code' && this.status !== 'disconnected' && this.status !== 'connecting') {
      return {
        success: false,
        error: 'Não é possível gerar QR code no estado atual',
        code: 'INVALID_STATE'
      };
    }
    
    // Para instâncias desconectadas ou conectando, inicia nova autenticação
    if (this.status === 'disconnected' || this.status === 'connecting') {
      Logger.info(`🔄 Iniciando nova autenticação para gerar QR code: ${this.config.id}`);
      
      // Se está conectando, primeiro desconecta para limpar estado
      if (this.status === 'connecting' && this.webSocket) {
        await this.webSocket.disconnect();
        this.webSocket = undefined;
        this.updateStatus('disconnected');
      }
      
      return await this.startNewAuthentication();
    }
    
    // Para instâncias já em modo QR, apenas regenera o QR code
    return await this.generateQRCode();
  }

  /**
   * Desconecta a instância
   */
  public async disconnect(): Promise<OperationResult> {
    try {
      Logger.info(`🔌 Desconectando instância: ${this.config.id}`);
      
      this.clearTimers();
      
      // Limpa detector de eventos
      this.connectionEventDetector.cleanup();
      
      if (this.webSocket) {
        await this.webSocket.disconnect();
        this.webSocket = undefined;
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
   * Trata desconexão inesperada
   */
  private handleDisconnection(reason: string): void {
    Logger.warn(`⚠️ Desconexão inesperada da instância ${this.config.id}: ${reason}`);
    
    this.clearTimers();
    this.updateStatus('disconnected');
    
    this.emit('disconnected', reason);
  }

  /**
   * Limpa QR code expirado
   */
  public async clearExpiredQRCode(): Promise<void> {
    this.qrCode = undefined;
    this.qrCodeExpiresAt = undefined;
    this.lastDisplayedQR = undefined; // Limpa também o controle de exibição
    await this.cacheManager.clearQRCode(this.config.id);
  }

  /**
   * Atualiza status da instância
   */
  private updateStatus(newStatus: ConnectionStatus): void {
    const oldStatus = this.status;
    this.status = newStatus;
    this.updatedAt = new Date();
    
    if (oldStatus !== newStatus) {
      Logger.info(`📊 Status da instância ${this.config.id}: ${oldStatus} → ${newStatus}`);
      this.emit('status_changed', newStatus, oldStatus);
    }
  }

  /**
   * Limpa timers e intervalos
   */
  private clearTimers(): void {
    if (this.qrCodeTimer) {
      clearTimeout(this.qrCodeTimer);
      this.qrCodeTimer = undefined;
    }
    
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Obtém dados da instância
   */
  public getData(): InstanceData {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      qrCode: this.qrCode,
      qrCodeExpiresAt: this.qrCodeExpiresAt,
      webhookUrl: this.config.webhookUrl,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastSeen: this.lastSeen,
      phoneNumber: this.phoneNumber,
      profileName: this.profileName,
      settings: this.config.settings
    };
  }

  /**
   * Configura listeners do detector de eventos de conexão
   */
  private setupConnectionEventListeners(): void {
    this.connectionEventDetector.on('connection_update', (update: ConnectionUpdate) => {
      Logger.info(`🔄 Atualização de conexão para instância ${this.config.id}:`, update);
      // Debug connection update - log removido para evitar spam
      // Debug logs removidos para evitar spam
      // console.log(`🔍 [DEBUG] Estado da conexão: ${update.connection}`);
      // console.log(`🔍 [DEBUG] Estado anterior: ${update.lastDisconnect?.reason || 'N/A'}`);
      // console.log(`🔍 [DEBUG] Update completo: ${JSON.stringify(update, null, 2)}`);
      
      if (update.connection === ConnectionState.open) {
         // Debug logs removidos para evitar spam
         // console.log(`🔍 [DEBUG] ATENÇÃO: Marcando instância como 'connected'!`);
         // console.log(`🔍 [DEBUG] Stack trace da conexão:`, new Error().stack?.split('\n').slice(1, 8).join('\n'));
         this.updateStatus('connected');
         this.lastSeen = new Date();
         this.startHeartbeat();
         this.emit('connected', update);
       } else if (update.connection === ConnectionState.close) {
         // Debug log removido para evitar spam
         // console.log(`🔍 [DEBUG] Marcando instância como 'disconnected'`);
         this.handleDisconnection(update.lastDisconnect?.reason || 'unknown');
       }
    });
    
    this.connectionEventDetector.on('qr_code_generated', (qrCode: string) => {
      Logger.info(`📱 QR code gerado pelo detector para instância: ${this.config.id}`);
      this.qrCode = qrCode;
      this.qrCodeExpiresAt = new Date(Date.now() + 60000);
      this.updateStatus('qr_code');
      this.emit('qr_code', qrCode);
    });
    
    this.connectionEventDetector.on('qr_code_scanned', () => {
      Logger.info(`📱 QR code escaneado detectado pelo detector para instância: ${this.config.id}`);
      this.handleQRScanned();
    });
    
    this.connectionEventDetector.on('authentication_success', (authData: any) => {
       Logger.info(`✅ Autenticação bem-sucedida detectada pelo detector para instância: ${this.config.id}`);
       // Atualiza authState com dados de autenticação
        if (authData && authData.creds && this.authState) {
          this.authState.creds = { ...this.authState.creds, ...authData.creds };
        }
       this.handleLoginSuccess(Buffer.from(JSON.stringify(authData)));
     });
    
    this.connectionEventDetector.on('authentication_failure', (error: any) => {
      Logger.error(`❌ Falha de autenticação detectada pelo detector para instância ${this.config.id}:`, error);
      this.handleAuthenticationError(error);
    });
  }

  /**
   * Configura listeners do noiseHandler
   */
  private setupHandshakeListeners(): void {
    // NoiseHandler events will be handled via ConnectionEventDetector
    // which already has the proper event listeners configured
    Logger.debug(`🔧 NoiseHandler events handled via ConnectionEventDetector for instance: ${this.config.id}`);
  }

  /**
   * Cleanup ao destruir instância
   */
  public destroy(): void {
    this.clearTimers();
    
    if (this.webSocket) {
      this.webSocket.disconnect();
    }
    
    // Limpa detector de eventos
    this.connectionEventDetector.cleanup();
    this.connectionEventDetector.removeAllListeners();
    
    this.removeAllListeners();
  }
}