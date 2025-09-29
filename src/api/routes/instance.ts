// routes/instance.ts - Rotas para gerenciamento de instâncias WhatsApp

import { Router, Request, Response } from 'express';
import { InstanceManager } from '../services/InstanceManager';
import { Logger } from '../../utils/Logger';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const instanceManager = InstanceManager.getInstance();

/**
 * Interface para criação de instância (simplificada)
 */
interface CreateInstanceRequest {
  name: string;
  // Removido webhookUrl e settings complexas - foco apenas em handshake/QR
}

/**
 * Interface para resposta de instância (simplificada)
 */
interface InstanceResponse {
  id: string;
  name: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr_code';
  qrCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * POST /api/instance
 * Cria uma nova instância WhatsApp
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name }: CreateInstanceRequest = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Nome da instância é obrigatório',
        code: 'INVALID_NAME'
      });
    }

    // Gera ID único para a instância
    const instanceId = uuidv4();

    Logger.info(`🚀 Criando nova instância: ${name} (ID: ${instanceId})`);

    // Cria a instância (simplificada - sem webhooks e settings complexas)
    const instance = await instanceManager.createInstance({
      id: instanceId,
      name
    });

    const response: InstanceResponse = {
      id: instance.id,
      name: instance.name,
      status: instance.status,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt
    };

    Logger.info(`✅ Instância criada com sucesso: ${name} (ID: ${instanceId})`);

    return res.status(201).json({
      success: true,
      data: response,
      message: 'Instância criada com sucesso'
    });

  } catch (error) {
    Logger.error('❌ Erro ao criar instância:', error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/instance
 * Lista todas as instâncias
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const instances = await instanceManager.getAllInstances();
    
    const response: InstanceResponse[] = instances.map(instance => ({
      id: instance.id,
      name: instance.name,
      status: instance.status,
      qrCode: instance.qrCode,
      webhookUrl: instance.webhookUrl,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt
    }));

    res.json({
      success: true,
      data: response,
      count: response.length
    });

  } catch (error) {
    Logger.error('❌ Erro ao listar instâncias:', error);
    res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/instance/:id
 * Obtém informações de uma instância específica
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const instance = await instanceManager.getInstance(id);
    
    if (!instance) {
      return res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
    }

    const response: InstanceResponse = {
      id: instance.id,
      name: instance.name,
      status: instance.status,
      qrCode: instance.qrCode,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt
    };

    return res.json({
      success: true,
      data: response
    });

  } catch (error) {
    Logger.error(`❌ Erro ao obter instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/instance/:id/connect
 * Conecta uma instância WhatsApp e aguarda QR code
 */
router.post('/:id/connect', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    console.log('🔍 [ROUTE] POST /connect chamado para instância:', id);
    Logger.info(`🔌 Conectando instância: ${id}`);
    
    // Obtém a instância para escutar eventos
    console.log('🔍 [ROUTE] Obtendo dados da instância...');
    const instanceData = await instanceManager.getInstance(id);
    if (!instanceData) {
      console.log('🔍 [ROUTE] Instância não encontrada:', id);
      return res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
    }

    console.log('🔍 [ROUTE] Status da instância:', instanceData.status);

    // Se já está conectada, retorna imediatamente
    if (instanceData.status === 'connected') {
      console.log('🔍 [ROUTE] Instância já conectada - retornando');
      return res.json({
        success: true,
        message: 'Instância já está conectada',
        data: {
          id,
          status: 'connected'
        }
      });
    }

    // Se já está conectando, retorna imediatamente
    if (instanceData.status === 'connecting') {
      console.log('🔍 [ROUTE] Instância já conectando - retornando erro');
      return res.status(400).json({
        error: 'Conexão já está em andamento',
        code: 'ALREADY_CONNECTING'
      });
    }

    console.log('🔍 [ROUTE] Iniciando processo de conexão...');
    // Inicia o processo de conexão
    console.log('🔍 [ROUTE] Chamando instanceManager.connectInstance...');
    const connectPromise = instanceManager.connectInstance(id);
    console.log('🔍 [ROUTE] connectInstance chamado, aguardando resultado...');
    
    // Aguarda o QR code ser gerado via evento connection.update
    const qrCodePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout aguardando QR code'));
      }, 30000); // 30 segundos de timeout

      // Escuta o evento de QR code da instância
      const onQrCode = (qrCode: string) => {
        clearTimeout(timeout);
        instanceManager.off('instance:qr_code', onQrCode);
        resolve(qrCode);
      };

      instanceManager.on('instance:qr_code', (instanceId: string, qrCode: string) => {
        if (instanceId === id) {
          onQrCode(qrCode);
        }
      });
    });

    // Executa conexão e aguarda QR code em paralelo
    const [connectResult] = await Promise.allSettled([connectPromise, qrCodePromise]);
    
    if (connectResult.status === 'rejected') {
      Logger.error(`❌ Erro na conexão da instância ${id}:`, connectResult.reason);
      return res.status(500).json({
        error: 'Erro ao iniciar conexão',
        code: 'CONNECTION_ERROR'
      });
    }

    const result = connectResult.value;
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    // Aguarda o QR code ser gerado
    try {
      const qrCode = await qrCodePromise;
      
      return res.json({
        success: true,
        message: 'Conexão iniciada e QR code gerado com sucesso',
        data: {
          id,
          status: 'qr_code',
          qrCode: qrCode
        }
      });
    } catch (qrError) {
      Logger.warn(`⚠️ Timeout aguardando QR code para instância ${id}`);
      
      // Retorna sucesso mesmo sem QR code, pois a conexão foi iniciada
      return res.json({
        success: true,
        message: 'Conexão iniciada com sucesso',
        data: {
          id,
          status: result.status,
          qrCode: result.qrCode
        }
      });
    }

  } catch (error) {
    Logger.error(`❌ Erro ao conectar instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/instance/:id/reset
 * Reinicia a conexão de uma instância WhatsApp e gera novos QR codes
 */
router.post('/:id/reset', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    console.log('🔄 [ROUTE] POST /reset chamado para instância:', id);
    Logger.info(`🔄 Reiniciando instância: ${id}`);
    
    // Obtém a instância
    console.log('🔄 [ROUTE] Obtendo dados da instância...');
    const instanceData = await instanceManager.getInstance(id);
    if (!instanceData) {
      console.log('🔄 [ROUTE] Instância não encontrada:', id);
      return res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
    }

    console.log('🔄 [ROUTE] Status atual da instância:', instanceData.status);

    // Primeiro desconecta se estiver conectada
    if (instanceData.status === 'connected' || instanceData.status === 'connecting') {
      console.log('🔄 [ROUTE] Desconectando instância antes do reset...');
      await instanceManager.disconnectInstance(id);
    }

    console.log('🔄 [ROUTE] Iniciando nova conexão após reset...');
    // Inicia nova conexão
    const connectPromise = instanceManager.connectInstance(id);
    
    // Aguarda o QR code ser gerado via evento connection.update
    const qrCodePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout aguardando QR code após reset'));
      }, 30000); // 30 segundos de timeout

      // Escuta o evento de QR code da instância
      const onQrCode = (qrCode: string) => {
        clearTimeout(timeout);
        instanceManager.off('instance:qr_code', onQrCode);
        resolve(qrCode);
      };

      instanceManager.on('instance:qr_code', (instanceId: string, qrCode: string) => {
        if (instanceId === id) {
          onQrCode(qrCode);
        }
      });
    });

    // Executa conexão e aguarda QR code em paralelo
    const [connectResult] = await Promise.allSettled([connectPromise, qrCodePromise]);
    
    if (connectResult.status === 'rejected') {
      Logger.error(`❌ Erro no reset da instância ${id}:`, connectResult.reason);
      return res.status(500).json({
        error: 'Erro ao reiniciar conexão',
        code: 'RESET_ERROR'
      });
    }

    const result = connectResult.value;
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    // Aguarda o QR code ser gerado
    try {
      const qrCode = await qrCodePromise;
      
      return res.json({
        success: true,
        message: 'Conexão reiniciada e novos QR codes gerados com sucesso',
        data: {
          id,
          status: 'qr_code',
          qrCode: qrCode
        }
      });
    } catch (qrError) {
      Logger.warn(`⚠️ Timeout aguardando QR code após reset para instância ${id}`);
      
      // Retorna sucesso mesmo sem QR code, pois a conexão foi reiniciada
      return res.json({
        success: true,
        message: 'Conexão reiniciada com sucesso',
        data: {
          id,
          status: result.status,
          qrCode: result.qrCode
        }
      });
    }

  } catch (error) {
    Logger.error(`❌ Erro ao reiniciar instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/instance/:id/disconnect
 * Desconecta uma instância WhatsApp
 */
router.post('/:id/disconnect', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    Logger.info(`🔌 Desconectando instância: ${id}`);
    
    const result = await instanceManager.disconnectInstance(id);
    
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    return res.json({
      success: true,
      message: 'Instância desconectada com sucesso',
      data: {
        id,
        status: result.status
      }
    });

  } catch (error) {
    Logger.error(`❌ Erro ao desconectar instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /api/instance/:id/restart
 * Reinicia uma instância WhatsApp
 */
router.post('/:id/restart', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    Logger.info(`🔄 Reiniciando instância: ${id}`);
    
    const result = await instanceManager.restartInstance(id);
    
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    return res.json({
      success: true,
      message: 'Instância reiniciada com sucesso',
      data: {
        id,
        status: result.status,
        qrCode: result.qrCode
      }
    });

  } catch (error) {
    Logger.error(`❌ Erro ao reiniciar instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * DELETE /api/instance/:id
 * Remove uma instância
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    Logger.info(`🗑️ Removendo instância: ${id}`);
    
    const result = await instanceManager.removeInstance(id);
    
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    return res.json({
      success: true,
      message: 'Instância removida com sucesso'
    });

  } catch (error) {
    Logger.error(`❌ Erro ao remover instância ${req.params.id}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/instance/:id/events
 * Server-Sent Events para atualizações em tempo real da instância
 */
router.get('/:id/events', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    // Verifica se a instância existe
    const instance = await instanceManager.getInstance(id);
    if (!instance) {
      res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
      return;
    }

    // Configura headers para Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Envia evento inicial com estado atual
    const sendEvent = (eventType: string, data: any) => {
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Envia estado inicial
    sendEvent('instance_status', {
      instanceId: id,
      status: instance.status,
      qrCode: instance.qrCode,
      qrCodeExpiresAt: instance.qrCodeExpiresAt,
      timestamp: new Date().toISOString()
    });

    Logger.info(`📡 Cliente SSE conectado para instância: ${id}`);

    // Listeners para eventos da instância
    const onQRCode = (instanceId: string, qrCode: any) => {
      if (instanceId === id) {
        Logger.info(`📱 Enviando QR code via SSE para instância: ${id}`);
        sendEvent('qr_code', {
          instanceId,
          qrCode,
          timestamp: new Date().toISOString()
        });
      }
    };

    const onQRUpdated = (instanceId: string, qrCode: any) => {
      if (instanceId === id) {
        Logger.info(`🔄 Enviando QR code atualizado via SSE para instância: ${id}`);
        sendEvent('qr_code', {
          instanceId,
          qrCode,
          timestamp: new Date().toISOString()
        });
      }
    };

    const onStatusChanged = (instanceId: string, status: string) => {
      if (instanceId === id) {
        Logger.info(`🔄 Enviando mudança de status via SSE para instância: ${id} - ${status}`);
        sendEvent('status_changed', {
          instanceId,
          status,
          timestamp: new Date().toISOString()
        });
      }
    };

    const onConnected = (instanceId: string) => {
      if (instanceId === id) {
        Logger.info(`✅ Enviando evento de conexão via SSE para instância: ${id}`);
        sendEvent('connected', {
          instanceId,
          timestamp: new Date().toISOString()
        });
      }
    };

    const onDisconnected = (instanceId: string, reason: string) => {
      if (instanceId === id) {
        Logger.info(`❌ Enviando evento de desconexão via SSE para instância: ${id}`);
        sendEvent('disconnected', {
          instanceId,
          reason,
          timestamp: new Date().toISOString()
        });
      }
    };

    // Registra listeners
    instanceManager.on('instance:qr_code', onQRCode);
    instanceManager.on('instance:qr_updated', onQRUpdated);
    instanceManager.on('instance:status_changed', onStatusChanged);
    instanceManager.on('instance:connected', onConnected);
    instanceManager.on('instance:disconnected', onDisconnected);

    // Heartbeat para manter conexão viva
    const heartbeat = setInterval(() => {
      sendEvent('heartbeat', {
        timestamp: new Date().toISOString()
      });
    }, 30000); // 30 segundos

    // Cleanup quando cliente desconecta
    req.on('close', () => {
      Logger.info(`📡 Cliente SSE desconectado para instância: ${id}`);
      
      // Remove listeners
      instanceManager.off('instance:qr_code', onQRCode);
      instanceManager.off('instance:qr_updated', onQRUpdated);
      instanceManager.off('instance:status_changed', onStatusChanged);
      instanceManager.off('instance:connected', onConnected);
      instanceManager.off('instance:disconnected', onDisconnected);
      
      // Limpa heartbeat
      clearInterval(heartbeat);
    });

  } catch (error) {
    Logger.error(`❌ Erro ao configurar SSE para instância ${id}:`, error);
    res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
    return;
  }
});

export default router;