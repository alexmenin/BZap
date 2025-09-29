// main.ts - Controlador principal de múltiplas instâncias WhatsApp

import { Logger, LogLevel } from './utils/Logger';
import { InstanceManager } from './api/services/InstanceManager';
import { WhatsAppInstance } from './api/services/WhatsAppInstance';
import { SessionManager } from './api/services/SessionManager';
import { EventHandlers } from './events/EventHandlers';
import * as path from 'path';
import { promises as fs } from 'fs';
import { EventEmitter } from 'events';

/**
 * Interface para configuração do controlador principal
 */
interface MultiInstanceConfig {
  logLevel: LogLevel;
  enableVerbose: boolean;
  authDir: string;
  maxInstances: number;
  batchSize: number;
  initDelay: number;
  autoStart: boolean;
  healthCheckInterval: number;
  cleanupInterval: number;
  instanceTimeout: number;
}

/**
 * Controlador principal de múltiplas instâncias WhatsApp
 * Responsável por inicializar, gerenciar e monitorar todas as instâncias
 */
class MultiInstanceController extends EventEmitter {
  private instanceManager: InstanceManager;
  private sessionManager: SessionManager;
  private eventHandlers: EventHandlers;
  private config: MultiInstanceConfig;
  private instances: Map<string, any> = new Map(); // Usando tipo genérico por compatibilidade
  private healthCheckTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private isInitialized: boolean = false;
  private startupQueue: string[] = [];
  private processingQueue: boolean = false;

  constructor(config: Partial<MultiInstanceConfig> = {}) {
    super();
    
    this.config = {
      logLevel: LogLevel.INFO,
      enableVerbose: false,
      authDir: './auth_info',
      maxInstances: 50,
      batchSize: 5,
      initDelay: 2000,
      autoStart: true,
      healthCheckInterval: 30000, // 30 segundos
      cleanupInterval: 300000, // 5 minutos
      instanceTimeout: 600000, // 10 minutos
      ...config
    };

    // Configura logger global
    Logger.configure({
      level: this.config.logLevel,
      enableColors: true,
      enableTimestamp: true,
      enableBinaryDump: this.config.enableVerbose
    });

    if (this.config.enableVerbose) {
      Logger.enableVerbose();
    }

    // Inicializa gerenciadores principais
    this.instanceManager = InstanceManager.getInstance();
    this.sessionManager = SessionManager.getInstance();
    this.eventHandlers = EventHandlers.getInstance();

    this.setupControllerEvents();
    
    Logger.info('MultiInstanceController inicializado');
  }

  /**
   * Configura eventos do controlador principal
   */
  private setupControllerEvents(): void {
    // Eventos do gerenciador de instâncias
    this.instanceManager.on('instance.created', this.handleInstanceCreated.bind(this));
    this.instanceManager.on('instance.destroyed', this.handleInstanceDestroyed.bind(this));
    this.instanceManager.on('instance.error', this.handleInstanceError.bind(this));
    
    // Eventos globais do sistema
    process.on('SIGINT', this.gracefulShutdown.bind(this));
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('uncaughtException', this.handleUncaughtException.bind(this));
    process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
  }

  /**
   * Inicializa o controlador e todos os sistemas
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      Logger.warn('Controlador já foi inicializado');
      return;
    }

    try {
      Logger.info('Inicializando MultiInstanceController...');
      
      // Cria diretório de autenticação se não existir
      await this.ensureAuthDirectory();
      
      // Inicializa gerenciadores
      // Managers já são inicializados no construtor
      // await this.sessionManager.initialize();
      // await this.eventHandlers.initialize();
      
      // Carrega instâncias existentes
      await this.loadExistingInstances();
      
      // Inicia monitoramento
      this.startHealthCheck();
      this.startCleanupTimer();
      
      // Auto-start se configurado
      if (this.config.autoStart) {
        await this.startQueuedInstances();
      }
      
      this.isInitialized = true;
      Logger.info('MultiInstanceController inicializado com sucesso');
      this.emit('controller.ready');
      
    } catch (error) {
      Logger.error('Erro ao inicializar controlador:', error);
      throw error;
    }
  }

  /**
   * Cria uma nova instância WhatsApp
   */
  public async createInstance(instanceId: string, config?: any): Promise<any> {
    if (this.instances.has(instanceId)) {
      throw new Error(`Instância ${instanceId} já existe`);
    }

    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(`Limite máximo de instâncias atingido (${this.config.maxInstances})`);
    }

    try {
      Logger.info(`Criando instância: ${instanceId}`);
      
      const instanceConfig = {
        id: instanceId,
        name: `Instance-${instanceId}`,
        ...config
      };
      
      const instance = await this.instanceManager.createInstance(instanceConfig);
      
      this.instances.set(instanceId, instance);
      this.emit('instance.created', instanceId, instance);
      
      return instance;
      
    } catch (error) {
      Logger.error(`Erro ao criar instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Remove uma instância
   */
  public async destroyInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instância ${instanceId} não encontrada`);
    }

    try {
      Logger.info(`Removendo instância: ${instanceId}`);
      
      // Remove a instância do manager
      // await this.instanceManager.removeInstance(instanceId); // Método será implementado
      this.instances.delete(instanceId);
      
      this.emit('instance.destroyed', instanceId);
      
    } catch (error) {
      Logger.error(`Erro ao remover instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Obtém uma instância específica
   */
  public getInstance(instanceId: string): any | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Lista todas as instâncias
   */
  public getAllInstances(): Map<string, any> {
    return new Map(this.instances);
  }

  /**
   * Obtém estatísticas do controlador
   */
  public getStats(): any {
    const instanceStats = Array.from(this.instances.entries()).map(([id, instance]) => ({
      id,
      status: 'active', // Simplificado por enquanto
      uptime: 0, // Simplificado por enquanto
      lastActivity: Date.now() // Simplificado por enquanto
    }));

    return {
      totalInstances: this.instances.size,
      maxInstances: this.config.maxInstances,
      isInitialized: this.isInitialized,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      instances: instanceStats
    };
   }

   /**
    * Métodos auxiliares privados
    */
   private async ensureAuthDirectory(): Promise<void> {
     try {
       await fs.mkdir(this.config.authDir, { recursive: true });
       Logger.info(`Diretório de autenticação criado: ${this.config.authDir}`);
     } catch (error) {
       Logger.error('Erro ao criar diretório de autenticação:', error);
       throw error;
     }
   }

   private async loadExistingInstances(): Promise<void> {
     try {
       const authDirs = await fs.readdir(this.config.authDir, { withFileTypes: true });
       const instanceDirs = authDirs.filter(dir => dir.isDirectory()).map(dir => dir.name);
       
       Logger.info(`Encontradas ${instanceDirs.length} instâncias existentes`);
       
       for (const instanceId of instanceDirs) {
         this.startupQueue.push(instanceId);
       }
       
     } catch (error) {
       Logger.warn('Erro ao carregar instâncias existentes:', error);
     }
   }

   private async startQueuedInstances(): Promise<void> {
     if (this.processingQueue || this.startupQueue.length === 0) {
       return;
     }

     this.processingQueue = true;
     Logger.info(`Iniciando ${this.startupQueue.length} instâncias em lote...`);

     try {
       const batches = [];
       for (let i = 0; i < this.startupQueue.length; i += this.config.batchSize) {
         batches.push(this.startupQueue.slice(i, i + this.config.batchSize));
       }

       for (const batch of batches) {
         const promises = batch.map(instanceId => 
           this.createInstance(instanceId).catch(error => {
             Logger.error(`Erro ao iniciar instância ${instanceId}:`, error);
             return null;
           })
         );

         await Promise.all(promises);
         
         if (batches.indexOf(batch) < batches.length - 1) {
           await new Promise(resolve => setTimeout(resolve, this.config.initDelay));
         }
       }

       this.startupQueue = [];
       
     } finally {
       this.processingQueue = false;
     }
   }

   private startHealthCheck(): void {
     this.healthCheckTimer = setInterval(() => {
       this.performHealthCheck();
     }, this.config.healthCheckInterval);
   }

   private startCleanupTimer(): void {
     this.cleanupTimer = setInterval(() => {
       this.performCleanup();
     }, this.config.cleanupInterval);
   }

   private async performHealthCheck(): Promise<void> {
     const unhealthyInstances = [];
     
     for (const [instanceId, instance] of Array.from(this.instances.entries())) {
       try {
         // Simplificado - assume que instâncias existentes estão saudáveis
         const isHealthy = true;
         if (!isHealthy) {
           unhealthyInstances.push(instanceId);
         }
       } catch (error) {
         Logger.warn(`Health check falhou para instância ${instanceId}:`, error);
         unhealthyInstances.push(instanceId);
       }
     }

     if (unhealthyInstances.length > 0) {
       Logger.warn(`${unhealthyInstances.length} instâncias não saudáveis detectadas`);
       this.emit('health.check.failed', unhealthyInstances);
     }
   }

   private async performCleanup(): Promise<void> {
     const now = Date.now();
     const instancesToCleanup = [];

     for (const [instanceId, instance] of Array.from(this.instances.entries())) {
       // Simplificado - assume atividade recente para todas as instâncias
       const lastActivity = now;
       if (now - lastActivity > this.config.instanceTimeout) {
         instancesToCleanup.push(instanceId);
       }
     }

     for (const instanceId of instancesToCleanup) {
       Logger.info(`Limpando instância inativa: ${instanceId}`);
       await this.destroyInstance(instanceId).catch(error => {
         Logger.error(`Erro ao limpar instância ${instanceId}:`, error);
       });
     }
   }

  /**
   * Handlers de eventos do controlador
   */
  private handleInstanceCreated(instanceId: string, instance: WhatsAppInstance): void {
    Logger.info(`Instância criada: ${instanceId}`);
    this.emit('instance.created', instanceId, instance);
  }

  private handleInstanceDestroyed(instanceId: string): void {
    Logger.info(`Instância removida: ${instanceId}`);
    this.emit('instance.destroyed', instanceId);
  }

  private handleInstanceError(instanceId: string, error: Error): void {
    Logger.error(`Erro na instância ${instanceId}:`, error);
    this.emit('instance.error', instanceId, error);
  }

  private handleUncaughtException(error: Error): void {
    Logger.error('Exceção não capturada:', error);
    this.gracefulShutdown();
  }

  private handleUnhandledRejection(reason: any, promise: Promise<any>): void {
    Logger.error('Promise rejeitada não tratada:', reason);
    this.gracefulShutdown();
  }

  /**
   * Shutdown gracioso do controlador
   */
  public async gracefulShutdown(): Promise<void> {
    Logger.info('Iniciando shutdown gracioso...');
    
    try {
      // Para timers
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
      }
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
      }
      
      // Desconecta todas as instâncias
      const shutdownPromises = Array.from(this.instances.keys()).map(instanceId => 
        this.destroyInstance(instanceId).catch(error => {
          Logger.error(`Erro ao desconectar instância ${instanceId}:`, error);
        })
      );
      
      await Promise.all(shutdownPromises);
      
      Logger.info('Shutdown concluído');
      this.emit('controller.shutdown');
      
    } catch (error) {
      Logger.error('Erro durante shutdown:', error);
    } finally {
      process.exit(0);
    }
  }

}

/**
 * Instância global do controlador
 */
let globalController: MultiInstanceController | null = null;

/**
 * Função global para obter instância singleton do controlador
 */
function getGlobalController(): MultiInstanceController {
  if (!globalController) {
    globalController = new MultiInstanceController();
  }
  return globalController;
}

/**
 * Função principal - Inicializa o controlador de múltiplas instâncias
 */
async function main(): Promise<void> {
  try {
    Logger.separator('INICIANDO CONTROLADOR MULTI-INSTÂNCIA');
    Logger.info('🚀 Inicializando MultiInstanceController...');
    
    // Cria e inicializa o controlador principal
    const controller = getGlobalController();
    
    // Configura tratamento de sinais
    process.on('SIGINT', async () => {
      Logger.info('\n👋 Encerrando aplicação...');
      await controller.gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      Logger.info('\n👋 Encerrando aplicação...');
      await controller.gracefulShutdown();
    });

    // Inicializa o controlador
    await controller.initialize();
    
    // Configura eventos do controlador
    controller.on('controller.ready', () => {
      Logger.info('✨ Controlador pronto para gerenciar instâncias');
      Logger.info('📊 Use as rotas API para criar e gerenciar instâncias WhatsApp');
    });

    controller.on('instance.created', (instanceId: string) => {
      Logger.info(`📱 Nova instância criada: ${instanceId}`);
    });

    controller.on('instance.destroyed', (instanceId: string) => {
      Logger.info(`🗑️  Instância removida: ${instanceId}`);
    });

    controller.on('instance.error', (instanceId: string, error: Error) => {
      Logger.error(`❌ Erro na instância ${instanceId}:`, error);
    });

    controller.on('health.check.failed', (unhealthyInstances: string[]) => {
      Logger.warn(`⚠️  Instâncias não saudáveis: ${unhealthyInstances.join(', ')}`);
    });

    // Mantém aplicação rodando
    Logger.info('✨ MultiInstanceController iniciado com sucesso!');
    Logger.info('📡 Sistema pronto para gerenciar múltiplas instâncias WhatsApp');
    Logger.info('🔧 Use as rotas API para criar, gerenciar e monitorar instâncias');
    
    // Exibe estatísticas periodicamente
    setInterval(() => {
      const stats = controller.getStats();
      Logger.stats('Status do Controlador', {
        instâncias_ativas: stats.totalInstances,
        limite_máximo: stats.maxInstances,
        uptime: `${Math.floor(stats.uptime / 60)}min`,
        memória_usada: `${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB`
      });
    }, 60000); // A cada 1 minuto

  } catch (error) {
    Logger.error('❌ Erro fatal no controlador:', error);
    process.exit(1);
  }
}

// Executa aplicação se for o módulo principal
if (require.main === module) {
  main().catch(error => {
    Logger.error('❌ Erro fatal:', error);
    process.exit(1);
  });
}

// Exports para uso em outros módulos
export { 
  MultiInstanceController,
  MultiInstanceConfig,
  getGlobalController
};

export default main;