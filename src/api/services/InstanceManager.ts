// services/InstanceManager.ts - Gerenciador de instâncias WhatsApp

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../utils/Logger';
import { WhatsAppInstance } from './WhatsAppInstance';
import { SessionManager } from './SessionManager';
import { CacheManager } from './CacheManager';

/**
 * Interface para configuração de instância
 */
export interface InstanceConfig {
  id: string;
  name: string;
  webhookUrl?: string;
  settings?: {
    rejectCall?: boolean;
    msgRetryCounterCache?: boolean;
    userDevicesCache?: boolean;
    groupMetadataCache?: boolean;
    printQRInTerminal?: boolean;
    browser?: [string, string, string];
    version?: [number, number, number];
  };
}

/**
 * Interface para dados da instância
 */
export interface InstanceData {
  id: string;
  name: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr_code';
  qrCode?: string;
  qrCodeExpiresAt?: Date;
  webhookUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  lastSeen?: Date;
  phoneNumber?: string;
  profileName?: string;
  settings: InstanceConfig['settings'];
  config?: InstanceConfig; // Adicionando config opcional
}

/**
 * Interface para resultado de operações
 */
export interface OperationResult {
  success: boolean;
  error?: string;
  message?: string; // Adicionando message opcional
  code?: string;
  status?: string;
  qrCode?: string;
  expiresAt?: Date;
}

/**
 * Gerenciador de instâncias WhatsApp
 * Implementa padrão Singleton
 */
export class InstanceManager extends EventEmitter {
  private static instance: InstanceManager;
  private instances: Map<string, WhatsAppInstance> = new Map();
  private sessionManager: SessionManager;
  private cacheManager: CacheManager;
  private readonly maxInstances: number = 50;

  private constructor() {
    super();
    this.sessionManager = SessionManager.getInstance();
    this.cacheManager = CacheManager.getInstance();
    
    Logger.info('🚀 InstanceManager inicializado');
    
    // Carrega instâncias salvas
    this.loadSavedInstances();
    
    // Configura limpeza automática
    this.setupCleanupTasks();
  }

  /**
   * Obtém a instância singleton
   */
  public static getInstance(): InstanceManager {
    if (!InstanceManager.instance) {
      InstanceManager.instance = new InstanceManager();
    }
    return InstanceManager.instance;
  }

  /**
   * Cria uma nova instância WhatsApp
   */
  public async createInstance(config: InstanceConfig): Promise<InstanceData> {
    try {
      // Verifica limite de instâncias
      if (this.instances.size >= this.maxInstances) {
        throw new Error(`Limite máximo de ${this.maxInstances} instâncias atingido`);
      }

      // Verifica se já existe instância com o mesmo nome
      const existingByName = Array.from(this.instances.values())
        .find(instance => instance.getData().name === config.name);
      
      if (existingByName) {
        throw new Error(`Já existe uma instância com o nome: ${config.name}`);
      }

      // Verifica se ID já existe
      if (this.instances.has(config.id)) {
        throw new Error(`Instância com ID ${config.id} já existe`);
      }

      Logger.info(`📱 Criando nova instância: ${config.name} (ID: ${config.id})`);

      // Cria a instância WhatsApp
      const whatsappInstance = new WhatsAppInstance(config, this.sessionManager, this.cacheManager);
      
      // Configura event listeners
      this.setupInstanceEventListeners(whatsappInstance);
      
      // Adiciona ao mapa de instâncias
      this.instances.set(config.id, whatsappInstance);
      
      // Salva no armazenamento persistente
      await this.sessionManager.saveInstanceConfig(config.id, config);
      
      const instanceData = whatsappInstance.getData();
      
      Logger.info(`✅ Instância criada: ${config.name} (ID: ${config.id})`);
      
      // Emite evento de criação
      this.emit('instance:created', instanceData);
      
      return instanceData;
      
    } catch (error) {
      Logger.error(`❌ Erro ao criar instância ${config.name}:`, error);
      throw error;
    }
  }

  /**
   * Obtém uma instância específica
   */
  public async getInstance(instanceId: string): Promise<InstanceData | null> {
    const instance = this.instances.get(instanceId);
    return instance ? instance.getData() : null;
  }

  /**
   * Obtém todas as instâncias
   */
  public async getAllInstances(): Promise<InstanceData[]> {
    return Array.from(this.instances.values()).map(instance => instance.getData());
  }

  /**
   * Conecta uma instância
   */
  public async connectInstance(instanceId: string): Promise<OperationResult> {
    try {
      console.log('🔍 [INSTANCE_MANAGER] connectInstance chamado para:', instanceId);
      
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        console.log('🔍 [INSTANCE_MANAGER] Instância não encontrada:', instanceId);
        return {
          success: false,
          error: 'Instância não encontrada',
          code: 'INSTANCE_NOT_FOUND'
        };
      }

      const data = instance.getData();
      console.log('🔍 [INSTANCE_MANAGER] Status da instância:', data.status);
      
      // ✅ CORREÇÃO: Retornar o status real da instância, não hardcoded 'connected'
      if (data.status === 'connected') {
        console.log('🔍 [INSTANCE_MANAGER] Instância já conectada - retornando status real');
        return {
          success: true,
          error: 'Instância já está conectada',
          status: data.status // Retorna o status real da instância
        };
      }
      
      if (data.status === 'qr_code') {
        console.log('🔍 [INSTANCE_MANAGER] Instância com QR ativo - retornando status real');
        return {
          success: true,
          error: 'QR code já está sendo gerado',
          status: data.status // Retorna o status real da instância
        };
      }

      Logger.info(`🔌 Conectando instância: ${data.name} (ID: ${instanceId})`);
      
      // Inicia conexão
      console.log('🔍 [INSTANCE_MANAGER] Chamando instance.connect()...');
      const result = await instance.connect();
      console.log('🔍 [INSTANCE_MANAGER] Resultado do connect:', result);
      
      // ✅ CORREÇÃO: Só emite 'instance:connected' quando status for realmente 'connected'
      // Não emite quando status for 'connecting' ou 'qr_code' - esses eventos vêm dos listeners
      if (result.success && result.status === 'connected') {
        Logger.info(`✅ Instância conectada: ${data.name} (ID: ${instanceId})`);
        this.emit('instance:connected', instanceId, result);
      } else if (result.success) {
        Logger.info(`🔌 Instância iniciando conexão: ${data.name} (ID: ${instanceId}) - Status: ${result.status}`);
        // Não emite 'connected' - aguarda eventos do WhatsAppInstance
      }
      
      return result;
      
    } catch (error) {
      console.log('🔍 [INSTANCE_MANAGER] Erro no connectInstance:', error);
      Logger.error(`❌ Erro ao conectar instância ${instanceId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'CONNECTION_ERROR'
      };
    }
  }

  /**
   * Desconecta uma instância
   */
  public async disconnectInstance(instanceId: string): Promise<OperationResult> {
    try {
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        return {
          success: false,
          error: 'Instância não encontrada',
          code: 'INSTANCE_NOT_FOUND'
        };
      }

      const data = instance.getData();
      
      Logger.info(`🔌 Desconectando instância: ${data.name} (ID: ${instanceId})`);
      
      // Desconecta
      const result = await instance.disconnect();
      
      if (result.success) {
        Logger.info(`✅ Instância desconectada: ${data.name} (ID: ${instanceId})`);
        this.emit('instance:disconnected', instanceId, result);
      }
      
      return result;
      
    } catch (error) {
      Logger.error(`❌ Erro ao desconectar instância ${instanceId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'DISCONNECTION_ERROR'
      };
    }
  }

  /**
   * Reinicia uma instância
   */
  public async restartInstance(instanceId: string): Promise<OperationResult> {
    try {
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        return {
          success: false,
          error: 'Instância não encontrada',
          code: 'INSTANCE_NOT_FOUND'
        };
      }

      const data = instance.getData();
      
      Logger.info(`🔄 Reiniciando instância: ${data.name} (ID: ${instanceId})`);
      
      // Desconecta primeiro se estiver conectada
      if (data.status !== 'disconnected') {
        const disconnectResult = await instance.disconnect();
        if (!disconnectResult.success) {
          return {
            success: false,
            error: 'Falha ao desconectar antes do restart',
            code: 'DISCONNECT_FAILED'
          };
        }
      }
      
      // Aguarda um momento para garantir desconexão completa
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Reconecta
      const connectResult = await instance.connect();
      
      if (connectResult.success) {
        Logger.info(`✅ Instância reiniciada: ${data.name} (ID: ${instanceId})`);
        this.emit('instance:restarted', instanceId, connectResult);
      }
      
      return connectResult;
      
    } catch (error) {
      Logger.error(`❌ Erro ao reiniciar instância ${instanceId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'RESTART_ERROR'
      };
    }
  }

  /**
   * Remove uma instância
   */
  public async removeInstance(instanceId: string): Promise<OperationResult> {
    try {
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        return {
          success: false,
          error: 'Instância não encontrada',
          code: 'INSTANCE_NOT_FOUND'
        };
      }

      const data = instance.getData();
      
      Logger.info(`🗑️ Removendo instância: ${data.name} (ID: ${instanceId})`);
      
      // Desconecta se estiver conectada
      if (data.status !== 'disconnected') {
        await instance.disconnect();
      }
      
      // Remove do mapa
      this.instances.delete(instanceId);
      
      // Remove dados persistentes
      await this.sessionManager.removeInstanceData(instanceId);
      
      // Limpa cache
      await this.cacheManager.clearInstanceCache(instanceId);
      
      Logger.info(`✅ Instância removida: ${data.name} (ID: ${instanceId})`);
      
      this.emit('instance:removed', instanceId);
      
      return {
        success: true,
        status: 'removed'
      };
      
    } catch (error) {
      Logger.error(`❌ Erro ao remover instância ${instanceId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'REMOVAL_ERROR'
      };
    }
  }

  /**
   * Gera novo QR code para uma instância
   */
  public async generateNewQRCode(instanceId: string): Promise<OperationResult> {
    try {
      const instance = this.instances.get(instanceId);
      
      if (!instance) {
        return {
          success: false,
          error: 'Instância não encontrada',
          code: 'INSTANCE_NOT_FOUND'
        };
      }

      Logger.info(`🔄 Gerando novo QR code para instância: ${instanceId}`);
      
      const result = await instance.generateNewQRCode();
      
      if (result.success) {
        this.emit('instance:qr_updated', instanceId, result.qrCode);
      }
      
      return result;
      
    } catch (error) {
      Logger.error(`❌ Erro ao gerar novo QR code para instância ${instanceId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'QR_GENERATION_ERROR'
      };
    }
  }

  /**
   * Configura event listeners para uma instância
   */
  private setupInstanceEventListeners(instance: WhatsAppInstance): void {
    const instanceId = instance.getData().id;
    
    instance.on('status_changed', (status) => {
      this.emit('instance:status_changed', instanceId, status);
    });
    
    instance.on('qr_code', (qrData) => {
      // Se vier objeto, extrai a string qr; se vier string, usa diretamente
      const qrString = typeof qrData === 'string' ? qrData : qrData.qr;
      const expiresAt = typeof qrData === 'object' ? qrData.expiresAt : undefined;
      
      this.emit('instance:qr_code', instanceId, {
        qr: qrString,
        expiresAt: expiresAt
      });
    });
    
    instance.on('connected', () => {
      this.emit('instance:connected', instanceId);
    });
    
    instance.on('disconnected', (reason) => {
      this.emit('instance:disconnected', instanceId, reason);
    });
    
    instance.on('error', (error) => {
      this.emit('instance:error', instanceId, error);
    });
  }

  /**
   * Carrega instâncias salvas
   */
  private async loadSavedInstances(): Promise<void> {
    try {
      Logger.info('📂 Carregando instâncias salvas...');
      
      const savedConfigs = await this.sessionManager.getAllInstanceConfigs();
      
      for (const config of savedConfigs) {
        try {
          const instance = new WhatsAppInstance(config, this.sessionManager, this.cacheManager);
          this.setupInstanceEventListeners(instance);
          this.instances.set(config.id, instance);
          
          Logger.info(`✅ Instância carregada: ${config.name} (ID: ${config.id})`);
        } catch (error) {
          Logger.error(`❌ Erro ao carregar instância ${config.id}:`, error);
        }
      }
      
      Logger.info(`📂 ${this.instances.size} instâncias carregadas`);
      
    } catch (error) {
      Logger.error('❌ Erro ao carregar instâncias salvas:', error);
    }
  }

  /**
   * Configura tarefas de limpeza automática
   */
  private setupCleanupTasks(): void {
    // Limpeza de QR codes expirados a cada 5 minutos
    setInterval(() => {
      this.cleanupExpiredQRCodes();
    }, 5 * 60 * 1000);
    
    // Limpeza de cache a cada hora
    setInterval(() => {
      this.cacheManager.cleanup();
    }, 60 * 60 * 1000);
  }

  /**
   * Limpa QR codes expirados
   */
  private async cleanupExpiredQRCodes(): Promise<void> {
    const now = new Date();
    
    for (const [instanceId, instance] of this.instances) {
      const data = instance.getData();
      
      if (data.qrCodeExpiresAt && now > data.qrCodeExpiresAt) {
        Logger.info(`🧹 Limpando QR code expirado da instância: ${instanceId}`);
        // Método clearExpiredQRCode foi removido na simplificação
        // O ciclo de QR agora é gerenciado automaticamente pelo WhatsAppInstance
        Logger.debug(`QR code da instância ${instanceId} será renovado automaticamente pelo ciclo`);
      }
    }
  }

  /**
   * Obtém estatísticas das instâncias
   */
  public getStats(): {
    total: number;
    connected: number;
    disconnected: number;
    connecting: number;
    qrCode: number;
  } {
    const instances = Array.from(this.instances.values());
    
    return {
      total: instances.length,
      connected: instances.filter(i => i.getData().status === 'connected').length,
      disconnected: instances.filter(i => i.getData().status === 'disconnected').length,
      connecting: instances.filter(i => i.getData().status === 'connecting').length,
      qrCode: instances.filter(i => i.getData().status === 'qr_code').length
    };
  }
}