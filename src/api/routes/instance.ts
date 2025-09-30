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
    
    // Obtém a instância
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
      console.log('🔍 [ROUTE] Instância já conectando - retornando status atual');
      return res.json({
        success: true,
        message: 'Conexão já está em andamento',
        data: {
          id,
          status: 'connecting'
        }
      });
    }

    console.log('🔍 [ROUTE] Iniciando processo de conexão...');
    console.log('🔍 [ROUTE] Chamando instanceManager.connectInstance...');
    
    // Inicia a conexão de forma assíncrona
    instanceManager.connectInstance(id).catch(error => {
      Logger.error(`❌ Erro na conexão assíncrona da instância ${id}:`, error);
    });
    
    console.log('🔍 [ROUTE] Conexão iniciada, retornando resposta imediata');
    
    // Retorna imediatamente - QR code e status updates virão via WebSocket
    return res.json({
      success: true,
      message: 'Conexão iniciada com sucesso - aguarde o QR code via WebSocket',
      data: {
        id,
        status: 'connecting'
      }
    });

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
    
    // Inicia nova conexão de forma assíncrona
    instanceManager.connectInstance(id).catch(error => {
      Logger.error(`❌ Erro na reconexão assíncrona da instância ${id}:`, error);
    });
    
    console.log('🔄 [ROUTE] Reset iniciado, retornando resposta imediata');
    
    // Retorna imediatamente - QR code e status updates virão via SSE/Webhook
    return res.json({
      success: true,
      message: 'Processo de reset iniciado com sucesso',
      data: {
        id,
        status: 'connecting'
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

// Rota SSE removida - substituída por WebSocket
// A comunicação em tempo real agora é feita via WebSocket Server

export default router;