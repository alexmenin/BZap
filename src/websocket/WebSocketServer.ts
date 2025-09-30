// WebSocketServer.ts - Servidor WebSocket para comunicação com o frontend

import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Logger } from '../utils/Logger';
import { EventEmitter } from 'events';

export interface WebSocketEvents {
  'instance_status_update': (instanceId: string, status: string, data?: any) => void;
  'qr_code_generated': (instanceId: string, qrCode: string, expiresAt?: Date) => void;
  'instance_connected': (instanceId: string, phoneNumber?: string) => void;
  'instance_disconnected': (instanceId: string, reason?: string) => void;
  'message_received': (instanceId: string, message: any) => void;
}

/**
 * Servidor WebSocket para comunicação em tempo real com o frontend
 */
export class WebSocketServer extends EventEmitter {
  private io: SocketIOServer;
  private connectedClients: Map<string, any> = new Map();
  private getInstanceStatusCallback?: (instanceId: string) => any;
  private getQRCodeCallback?: (instanceId: string) => string | null;

  constructor(httpServer: HttpServer) {
    super();
    
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling']
    });

    this.setupEventHandlers();
    Logger.info('🔌 WebSocket Server inicializado');
  }

  /**
   * Configura os handlers de eventos do Socket.IO
   */
  private setupEventHandlers(): void {
    this.io.on('connection', (socket) => {
      Logger.info(`🔗 Cliente conectado: ${socket.id}`);
      this.connectedClients.set(socket.id, socket);

      // Handler para cliente se inscrever em updates de uma instância específica
      socket.on('subscribe_instance', (instanceId: string) => {
        socket.join(`instance_${instanceId}`);
        Logger.info(`📡 Cliente ${socket.id} inscrito na instância ${instanceId}`);
      });

      // Handler para cliente se desinscrever de uma instância
      socket.on('unsubscribe_instance', (instanceId: string) => {
        socket.leave(`instance_${instanceId}`);
        Logger.info(`📡 Cliente ${socket.id} desinscrito da instância ${instanceId}`);
      });

      // Handler para solicitar status atual de uma instância
      socket.on('get_instance_status', (instanceId: string) => {
        if (this.getInstanceStatusCallback) {
          const status = this.getInstanceStatusCallback(instanceId);
          socket.emit('instance_status_response', {
            instanceId,
            status,
            timestamp: new Date().toISOString()
          });
        } else {
          socket.emit('error', { message: 'Callback de status não configurado' });
        }
      });

      // Handler para solicitar QR code atual de uma instância
      socket.on('get_qr_code', (instanceId: string) => {
        if (this.getQRCodeCallback) {
          const qrCode = this.getQRCodeCallback(instanceId);
          socket.emit('qr_code_response', {
            instanceId,
            qrCode,
            timestamp: new Date().toISOString()
          });
        } else {
          socket.emit('error', { message: 'Callback de QR code não configurado' });
        }
      });

      // Handler de desconexão
      socket.on('disconnect', (reason) => {
        Logger.info(`🔌 Cliente desconectado: ${socket.id}, motivo: ${reason}`);
        this.connectedClients.delete(socket.id);
      });

      // Envia lista de instâncias conectadas ao cliente
      socket.emit('connected', {
        message: 'Conectado ao servidor WebSocket',
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Envia atualização de status de instância para clientes inscritos
   */
  public emitInstanceStatusUpdate(instanceId: string, status: string, data?: any): void {
    const payload = {
      instanceId,
      status,
      data,
      timestamp: new Date().toISOString()
    };

    this.io.to(`instance_${instanceId}`).emit('instance_status_update', payload);
    Logger.debug(`📡 Status update enviado para instância ${instanceId}: ${status}`);
  }

  /**
   * Envia QR code gerado para clientes inscritos
   */
  public emitQRCodeGenerated(instanceId: string, qrCode: string, expiresAt?: Date): void {
    const payload = {
      instanceId,
      qr: qrCode, // Mudança: usar 'qr' em vez de 'qrCode' para compatibilidade com frontend
      qrCode, // Manter ambos para compatibilidade
      expiresAt: expiresAt?.toISOString(),
      timestamp: new Date().toISOString()
    };

    this.io.to(`instance_${instanceId}`).emit('qr_code_generated', payload);
    Logger.info(`📱 QR Code enviado via WebSocket para instância ${instanceId}`);
  }

  /**
   * Envia notificação de instância conectada
   */
  public emitInstanceConnected(instanceId: string, phoneNumber?: string): void {
    const payload = {
      instanceId,
      phoneNumber,
      timestamp: new Date().toISOString()
    };

    this.io.to(`instance_${instanceId}`).emit('instance_connected', payload);
    Logger.info(`✅ Instância conectada notificada via WebSocket: ${instanceId}`);
  }

  /**
   * Envia notificação de instância desconectada
   */
  public emitInstanceDisconnected(instanceId: string, reason?: string): void {
    const payload = {
      instanceId,
      reason,
      timestamp: new Date().toISOString()
    };

    this.io.to(`instance_${instanceId}`).emit('instance_disconnected', payload);
    Logger.info(`❌ Instância desconectada notificada via WebSocket: ${instanceId}`);
  }

  /**
   * Envia mensagem recebida para clientes inscritos
   */
  public emitMessageReceived(instanceId: string, message: any): void {
    const payload = {
      instanceId,
      message,
      timestamp: new Date().toISOString()
    };

    this.io.to(`instance_${instanceId}`).emit('message_received', payload);
    Logger.debug(`💬 Mensagem enviada via WebSocket para instância ${instanceId}`);
  }

  /**
   * Envia resposta direta para um cliente específico
   */
  public emitToClient(clientId: string, event: string, data: any): void {
    const socket = this.connectedClients.get(clientId);
    if (socket) {
      socket.emit(event, data);
      Logger.debug(`📤 Evento ${event} enviado para cliente ${clientId}`);
    }
  }

  /**
   * Configura callback para obter status da instância
   */
  public onGetInstanceStatus(callback: (instanceId: string) => any): void {
    this.getInstanceStatusCallback = callback;
  }

  /**
   * Configura callback para obter QR code
   */
  public onGetQRCode(callback: (instanceId: string) => string | null): void {
    this.getQRCodeCallback = callback;
  }

  /**
   * Broadcast para todos os clientes conectados
   */
  public broadcast(event: string, data: any): void {
    this.io.emit(event, data);
    Logger.debug(`📢 Broadcast do evento ${event} para todos os clientes`);
  }

  /**
   * Obtém número de clientes conectados
   */
  public getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Obtém lista de salas ativas
   */
  public getActiveRooms(): string[] {
    return Array.from(this.io.sockets.adapter.rooms.keys())
      .filter(room => room.startsWith('instance_'));
  }

  /**
   * Fecha o servidor WebSocket
   */
  public close(): void {
    this.io.close();
    this.connectedClients.clear();
    Logger.info('🔌 WebSocket Server fechado');
  }
}