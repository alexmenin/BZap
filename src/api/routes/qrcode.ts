// routes/qrcode.ts - Rotas para geração e obtenção de QR code

import { Router, Request, Response } from 'express';
import { InstanceManager } from '../services/InstanceManager';
import { Logger } from '../../utils/Logger';
import { QRCodeGenerator } from '../../utils/QRCodeGenerator';

const router = Router();
const instanceManager = InstanceManager.getInstance();

/**
 * Interface para resposta de QR code
 */
interface QRCodeResponse {
  instanceId: string;
  qrCode: string;
  qrCodeImage?: string;
  status: 'qr_code' | 'connecting' | 'connected';
  expiresAt?: Date;
}

/**
 * GET /api/qrcode/:instanceId
 * Obtém o QR code de uma instância específica
 */
router.get('/:instanceId', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;
    const { format = 'text' } = req.query;

    Logger.info(`📱 Solicitando QR code para instância: ${instanceId}`);

    const instance = await instanceManager.getInstance(instanceId);
    
    if (!instance) {
      return res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
    }

    if (!instance.qrCode) {
      return res.status(400).json({
        error: 'QR code não disponível. Certifique-se de que a instância está no estado correto.',
        code: 'QR_CODE_NOT_AVAILABLE',
        status: instance.status
      });
    }

    const response: QRCodeResponse = {
      instanceId: instance.id,
      qrCode: instance.qrCode,
      status: instance.status as any,
      expiresAt: instance.qrCodeExpiresAt
    };

    // Processa diferentes formatos de QR code
    try {
      switch (format) {
        case 'image':
        case 'png':
          const qrCodeImage = await QRCodeGenerator.generateQRDataURL(instance.qrCode, {
            width: 256,
            margin: 2
          });
          response.qrCodeImage = qrCodeImage;
          
          // Se solicitado apenas PNG, retorna diretamente como imagem
          if (format === 'png') {
            const base64Data = qrCodeImage.replace(/^data:image\/png;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Length', buffer.length);
            return res.send(buffer);
          }
          break;
          
        case 'svg':
          const qrCodeSVG = await QRCodeGenerator.generateQRSVG(instance.qrCode, {
            width: 256,
            margin: 2
          });
          
          res.setHeader('Content-Type', 'image/svg+xml');
          return res.send(qrCodeSVG);
          
        case 'dataurl':
          const qrCodeDataURL = await QRCodeGenerator.generateQRDataURL(instance.qrCode, {
            width: 256,
            margin: 2
          });
          response.qrCodeImage = qrCodeDataURL;
          break;
          
        case 'base64':
          const qrCodeBase64 = await QRCodeGenerator.generateQRImage(instance.qrCode, {
            width: 256,
            margin: 2
          });
          response.qrCodeImage = qrCodeBase64;
          break;
          
        default:
          // Formato text (padrão)
          break;
      }
      
      Logger.info(`✅ QR code gerado no formato '${format}' para instância: ${instanceId}`);
    } catch (qrError) {
      Logger.error(`❌ Erro ao gerar QR code no formato '${format}':`, qrError);
      // Continua com o texto mesmo se outros formatos falharem
    }

    Logger.info(`✅ QR code obtido com sucesso para instância: ${instanceId}`);

    return res.json({
      success: true,
      data: response
    });

  } catch (error) {
    Logger.error(`❌ Erro ao obter QR code da instância ${req.params.instanceId}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /api/qrcode/:instanceId/generate
 * Força a geração de um novo QR code para a instância
 */
router.post('/:instanceId/generate', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;

    Logger.info(`🔄 Gerando novo QR code para instância: ${instanceId}`);

    const result = await instanceManager.generateNewQRCode(instanceId);
    
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        code: result.code
      });
    }

    const response: QRCodeResponse = {
      instanceId,
      qrCode: result.qrCode!,
      status: result.status as any,
      expiresAt: result.expiresAt
    };

    Logger.info(`✅ Novo QR code gerado para instância: ${instanceId}`);

    return res.json({
      success: true,
      data: response,
      message: 'Novo QR code gerado com sucesso'
    });

  } catch (error) {
    Logger.error(`❌ Erro ao gerar novo QR code da instância ${req.params.instanceId}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/qrcode/:instanceId/status
 * Verifica o status do QR code e da conexão
 */
router.get('/:instanceId/status', async (req: Request, res: Response) => {
  try {
    const { instanceId } = req.params;

    const instance = await instanceManager.getInstance(instanceId);
    
    if (!instance) {
      return res.status(404).json({
        error: 'Instância não encontrada',
        code: 'INSTANCE_NOT_FOUND'
      });
    }

    const response = {
      instanceId: instance.id,
      status: instance.status,
      hasQRCode: !!instance.qrCode,
      qrCodeExpired: instance.qrCodeExpiresAt ? new Date() > instance.qrCodeExpiresAt : false,
      lastUpdate: instance.updatedAt,
      connectionInfo: {
        isConnected: instance.status === 'connected',
        canGenerateQR: ['disconnected', 'qr_code'].includes(instance.status),
        needsQRScan: instance.status === 'qr_code'
      }
    };

    return res.json({
      success: true,
      data: response
    });

  } catch (error) {
    Logger.error(`❌ Erro ao verificar status do QR code da instância ${req.params.instanceId}:`, error);
    return res.status(500).json({
      error: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * WebSocket endpoint para atualizações em tempo real do QR code
 * Esta rota será implementada no WebSocket handler
 */
router.get('/:instanceId/stream', (req: Request, res: Response) => {
  return res.status(501).json({
    error: 'Endpoint de streaming não implementado',
    code: 'NOT_IMPLEMENTED',
    message: 'Use WebSocket para atualizações em tempo real do QR code'
  });
});

export default router;