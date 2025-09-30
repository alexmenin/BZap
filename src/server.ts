// server.ts - Servidor Express principal da API WhatsApp

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { createServer, Server as HttpServer } from 'http';
import { config } from 'dotenv';
import { Logger } from './utils/Logger';
import { InstanceManager } from './api/services/InstanceManager';
import { CacheManager } from './api/services/CacheManager';
import { WebSocketServer } from './websocket/WebSocketServer';

// Importa rotas
import instanceRoutes from './api/routes/instance';

// Carrega variáveis de ambiente
config();

/**
 * Interface para configuração do servidor
 */
interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  rateLimit: {
    windowMs: number;
    max: number;
  };
}

/**
 * Interface para resposta de erro
 */
interface ErrorResponse {
  error: string;
  code?: string;
  message?: string;
  timestamp: string;
  path: string;
}

/**
 * Classe principal do servidor API
 */
class WhatsAppAPIServer {
  private app: Application;
  private config: ServerConfig;
  private instanceManager: InstanceManager;
  private cacheManager: CacheManager;
  private server?: HttpServer;
  private webSocketServer?: WebSocketServer;

  constructor() {
    this.app = express();
    this.config = this.loadConfig();
    
    // Inicializa gerenciadores
    this.instanceManager = InstanceManager.getInstance();
    this.cacheManager = CacheManager.getInstance();
    
    this.setupMiddlewares();
    this.setupRoutes();
    this.setupErrorHandling();
    this.setupGracefulShutdown();
    
    Logger.info('🚀 Servidor WhatsApp API inicializado');
  }

  /**
   * Carrega configuração do servidor
   */
  private loadConfig(): ServerConfig {
    return {
      port: parseInt(process.env.PORT || '3000', 10),
      host: process.env.HOST || '0.0.0.0',
      corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['*'],
      rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000', 10), // 15 minutos
        max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10) // 100 requests por janela
      }
    };
  }

  /**
   * Configura middlewares
   */
  private setupMiddlewares(): void {
    // Segurança
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      crossOriginEmbedderPolicy: false
    }));

    // CORS
    this.app.use(cors({
      origin: this.config.corsOrigins.includes('*') ? true : this.config.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
    }));

    // Parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Logging
    this.app.use(morgan('combined', {
      stream: {
        write: (message: string) => {
          Logger.info(message.trim());
        }
      }
    }));

    // Middleware de request ID
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      req.headers['x-request-id'] = req.headers['x-request-id'] || 
        Math.random().toString(36).substring(2, 15);
      res.setHeader('X-Request-ID', req.headers['x-request-id']);
      next();
    });

    // Middleware de timeout
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setTimeout(30000, () => {
        res.status(408).json({
          error: 'Request timeout',
          code: 'TIMEOUT',
          message: 'A requisição demorou muito para ser processada',
          timestamp: new Date().toISOString(),
          path: req.path
        } as ErrorResponse);
      });
      next();
    });

    Logger.info('✅ Middlewares configurados');
  }

  /**
   * Configura rotas da API (simplificadas - foco em handshake e QR)
   */
  private setupRoutes(): void {
    // Rota de health check (essencial)
    this.app.get('/health', (req: Request, res: Response) => {
      const stats = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        instances: this.instanceManager.getStats(),
        version: process.env.npm_package_version || '1.0.0'
      };

      res.json(stats);
    });

    // Rota de informações da API (simplificada)
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        name: 'WhatsApp Handshake & QR API',
        version: process.env.npm_package_version || '1.0.0',
        description: 'API focada em handshake e geração de QR code WhatsApp',
        endpoints: {
          instances: '/api/instance',
          health: '/health'
        },
        timestamp: new Date().toISOString()
      });
    });

    // Rotas essenciais da API
    this.app.use('/api/instance', instanceRoutes);

    // Servir arquivos estáticos da interface web
    const publicPath = path.join(__dirname, '..', 'public');
    this.app.use(express.static(publicPath));
    
    // Rota para SPA - redireciona todas as rotas não-API para index.html
    this.app.get('*', (req: Request, res: Response, next: NextFunction) => {
      // Se for uma rota da API, prosseguir para 404
      if (req.path.startsWith('/api/')) {
        return next();
      }
      
      // Servir index.html para rotas da interface
      res.sendFile(path.join(publicPath, 'index.html'));
    });

    // Rota 404
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: 'Endpoint não encontrado',
        code: 'NOT_FOUND',
        message: `Rota ${req.method} ${req.originalUrl} não existe`,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
      } as ErrorResponse);
    });

    Logger.info('✅ Rotas essenciais configuradas (handshake + QR)');
  }

  /**
   * Configura integração entre WebSocket Server e InstanceManager
   */
  private setupWebSocketIntegration(): void {
    if (!this.webSocketServer) return;

    // Escuta eventos do InstanceManager para repassar via WebSocket
    this.instanceManager.on('instance:status_changed', (instanceId: string, status: string, data?: any) => {
      this.webSocketServer!.emitInstanceStatusUpdate(instanceId, status, data);
    });

    this.instanceManager.on('instance:qr_code', (instanceId: string, qrCode: any) => {
      this.webSocketServer!.emitQRCodeGenerated(instanceId, qrCode.qr || qrCode, qrCode.expiresAt);
    });

    this.instanceManager.on('instance:connected', (instanceId: string, phoneNumber?: string) => {
      this.webSocketServer!.emitInstanceConnected(instanceId, phoneNumber);
    });

    this.instanceManager.on('instance:disconnected', (instanceId: string, reason?: string) => {
      this.webSocketServer!.emitInstanceDisconnected(instanceId, reason);
    });

    // Escuta requests do WebSocket Server
    this.webSocketServer.on('get_instance_status_request', async (instanceId: string, clientId: string) => {
      try {
        const instance = await this.instanceManager.getInstance(instanceId);
        if (instance) {
          this.webSocketServer!.emitToClient(clientId, 'instance_status_response', {
            instanceId,
            status: instance.status,
            phoneNumber: instance.phoneNumber,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        Logger.error(`Erro ao buscar status da instância ${instanceId}:`, error);
      }
    });

    this.webSocketServer.on('get_qr_code_request', async (instanceId: string, clientId: string) => {
      try {
        const instance = await this.instanceManager.getInstance(instanceId);
        if (instance && instance.qrCode) {
          this.webSocketServer!.emitToClient(clientId, 'qr_code_response', {
            instanceId,
            qrCode: instance.qrCode,
            expiresAt: instance.qrCodeExpiresAt?.toISOString(),
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        Logger.error(`Erro ao buscar QR code da instância ${instanceId}:`, error);
      }
    });

    Logger.info('🔗 Integração WebSocket configurada');
  }

  /**
   * Configura callbacks do WebSocket Server
   */
  private setupWebSocketCallbacks(): void {
    if (!this.webSocketServer) return;

    // Configura callback para obter status da instância
    this.webSocketServer.onGetInstanceStatus(async (instanceId: string) => {
      try {
        const instance = await this.instanceManager.getInstance(instanceId);
        if (instance) {
          return {
            status: instance.status,
            phoneNumber: instance.phoneNumber,
            isConnected: instance.status === 'connected',
            lastSeen: instance.lastSeen,
            timestamp: new Date().toISOString()
          };
        }
        return null;
      } catch (error) {
        Logger.error(`Erro ao obter status da instância ${instanceId}:`, error);
        return null;
      }
    });

    // Configura callback para obter QR code da instância
    this.webSocketServer.onGetQRCode(async (instanceId: string) => {
      try {
        Logger.info(`🔍 Callback QR code chamado para instância: ${instanceId}`);
        const result = await this.instanceManager.connectInstance(instanceId);
        Logger.info(`🔍 Resultado do connectInstance:`, result);
        
        if (result.success) {
          // Se a conexão foi bem-sucedida, buscar a instância para obter o QR code
          const instance = await this.instanceManager.getInstance(instanceId);
          if (instance && instance.qrCode) {
            Logger.info(`✅ QR code encontrado para instância ${instanceId}`);
            return instance.qrCode;
          }
        }
        
        Logger.warn(`⚠️ QR code não encontrado para instância ${instanceId}`);
        return null;
      } catch (error) {
        Logger.error(`❌ Erro ao obter QR code da instância ${instanceId}:`, error);
        return null;
      }
    });

    Logger.info('✅ Callbacks do WebSocket configurados');
  }

  /**
   * Configura tratamento de erros
   */
  private setupErrorHandling(): void {
    // Handler de erros global
    this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
      Logger.error('❌ Erro não tratado:', error);

      // Não envia resposta se já foi enviada
      if (res.headersSent) {
        return next(error);
      }

      const errorResponse: ErrorResponse = {
        error: 'Erro interno do servidor',
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Algo deu errado',
        timestamp: new Date().toISOString(),
        path: req.path
      };

      res.status(500).json(errorResponse);
    });

    // Handlers de processo
    process.on('uncaughtException', (error: Error) => {
      Logger.error('❌ Exceção não capturada:', error);
      this.gracefulShutdown('SIGTERM');
    });

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      Logger.error('❌ Promise rejeitada não tratada:', reason);
      Logger.error('Promise:', promise);
    });

    Logger.info('✅ Tratamento de erros configurado');
  }

  /**
   * Configura shutdown graceful
   */
  private setupGracefulShutdown(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

    signals.forEach((signal) => {
      process.on(signal, () => {
        Logger.info(`📡 Sinal ${signal} recebido, iniciando shutdown graceful...`);
        this.gracefulShutdown(signal);
      });
    });
  }

  /**
   * Executa shutdown graceful
   */
  private async gracefulShutdown(signal: string): Promise<void> {
    Logger.info(`🛑 Iniciando shutdown graceful (${signal})...`);

    try {
      // Para de aceitar novas conexões
      if (this.server) {
        this.server.close(() => {
          Logger.info('🔌 Servidor HTTP fechado');
        });
      }

      // Desconecta todas as instâncias
      const instances = await this.instanceManager.getAllInstances();
      for (const instance of instances) {
        if (instance.status === 'connected') {
          Logger.info(`🔌 Desconectando instância: ${instance.name}`);
          await this.instanceManager.disconnectInstance(instance.id);
        }
      }

      // Para timer de limpeza do cache
      this.cacheManager.stopCleanupTimer();

      Logger.info('✅ Shutdown graceful concluído');
      process.exit(0);

    } catch (error) {
      Logger.error('❌ Erro durante shutdown graceful:', error);
      process.exit(1);
    }
  }

  /**
   * Inicia o servidor
   */
  public start(): void {
    // Cria servidor HTTP
    const httpServer = createServer(this.app);
    
    // Inicializa WebSocket Server
    this.webSocketServer = new WebSocketServer(httpServer);
    this.setupWebSocketIntegration();
    this.setupWebSocketCallbacks();
    
    this.server = httpServer.listen(this.config.port, this.config.host, () => {
      Logger.info(`🚀 Servidor rodando em http://${this.config.host}:${this.config.port}`);
      Logger.info(`🔌 WebSocket Server ativo na mesma porta`);
      Logger.info(`📚 Documentação disponível em http://${this.config.host}:${this.config.port}/api/docs`);
      Logger.info(`❤️ Health check em http://${this.config.host}:${this.config.port}/health`);
      
      // Log de configurações importantes
      Logger.info(`⚙️ Configurações:`);
      Logger.info(`   - CORS Origins: ${this.config.corsOrigins.join(', ')}`);
      Logger.info(`   - Rate Limit: ${this.config.rateLimit.max} requests/${this.config.rateLimit.windowMs}ms`);
      Logger.info(`   - Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    this.server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        Logger.error(`❌ Porta ${this.config.port} já está em uso`);
      } else {
        Logger.error('❌ Erro no servidor:', error);
      }
      process.exit(1);
    });
  }

  /**
   * Para o servidor
   */
  public stop(): void {
    if (this.webSocketServer) {
      this.webSocketServer.close();
    }
    
    if (this.server) {
      this.server.close(() => {
        Logger.info('🛑 Servidor parado');
      });
    }
  }

  /**
   * Obtém instância do WebSocket Server
   */
  public getWebSocketServer(): WebSocketServer | undefined {
    return this.webSocketServer;
  }

  /**
   * Obtém instância do app Express
   */
  public getApp(): Application {
    return this.app;
  }
}

// Inicia o servidor se este arquivo for executado diretamente
if (require.main === module) {
  const server = new WhatsAppAPIServer();
  server.start();
}

export default WhatsAppAPIServer;
export { WhatsAppAPIServer };