// QRCodeGenerator.ts - Utilitário para geração de QR codes WhatsApp
import { Logger } from './Logger';
import { AuthCredentials } from '../auth/CredentialsManager';
import * as QRCode from 'qrcode';

/**
 * Utilitário para geração de QR codes no formato WhatsApp/Baileys
 */
export class QRCodeGenerator {
  /**
   * Verifica se os dados são uma mensagem pair-device
   */
  public static isPairDeviceMessage(node: any): boolean {
    try {
      // Verifica se é um BinaryNode com tag 'iq' e atributos corretos
      if (!node || typeof node !== 'object') {
        return false;
      }
      
      // Verifica se tem a estrutura de um BinaryNode
      if (!node.tag || !node.attrs) {
        return false;
      }
      
      // Verifica se é uma mensagem iq do tipo set com pair-device
      return node.tag === 'iq' && 
             node.attrs.type === 'set' && 
             node.content && 
             Array.isArray(node.content) &&
             node.content.some((child: any) => 
               child && child.tag === 'pair-device'
             );
    } catch (error) {
      Logger.error('Erro ao verificar mensagem pair-device:', error);
      return false;
    }
  }

  /**
   * Extrai referência QR dos dados pair-device
   */
  private static extractQRReference(data: Buffer): Buffer {
    try {
      // Procura pelo padrão de início do QR
      const startPattern = Buffer.from([0x0a, 0x14]); // Padrão comum em mensagens pair-device
      const startIndex = data.indexOf(startPattern);
      
      if (startIndex === -1) {
        throw new Error('Padrão de início QR não encontrado');
      }
      
      // Extrai os próximos 20 bytes após o padrão (referência QR típica)
      const refStart = startIndex + startPattern.length;
      const refEnd = refStart + 20;
      
      if (refEnd > data.length) {
        throw new Error('Dados insuficientes para extrair referência QR');
      }
      
      return data.slice(refStart, refEnd);
    } catch (error) {
      Logger.error('Erro ao extrair referência QR:', error);
      throw error;
    }
  }

  /**
   * Gera QR code usando credenciais do Baileys
   */
  public static generateQRCode(pairDeviceData: any, credentials: AuthCredentials): string | null {
    try {
      Logger.handshake('QR_GENERATION', 'Iniciando geração de QR code...');
      
      // Verifica se as credenciais estão presentes
      if (!credentials) {
        Logger.error('Credenciais não fornecidas para geração do QR code');
        return null;
      }
      
      // Verifica se as credenciais necessárias estão presentes
      if (!credentials.noiseKey?.public || !credentials.signedIdentityKey?.public || !credentials.advSecretKey) {
        Logger.error('Credenciais incompletas para geração do QR code');
        return null;
      }
      
      // Extrai referência QR dos dados pair-device
      let qrRef: Buffer;
      if (Buffer.isBuffer(pairDeviceData)) {
        qrRef = this.extractQRReference(pairDeviceData);
      } else {
        Logger.error('Dados pair-device inválidos');
        return null;
      }
      
      // Converte referência para base64
      const ref = qrRef.toString('base64');
      
      // Gera dados do QR code
      return this.generateQRData(ref, credentials);
      
    } catch (error) {
      Logger.error('Erro ao gerar QR code:', error);
      return null;
    }
  }

  /**
   * Gera dados do QR code usando credenciais do Baileys
   */
  public static generateQRData(ref: string, credentials: AuthCredentials): string {
    try {
      Logger.handshake('QR_DATA', 'Gerando dados do QR code...');
      
      // Verifica se as credenciais foram passadas
      if (!credentials) {
        throw new Error('Credenciais não fornecidas para geração do QR code');
      }
      
      // Verifica se as credenciais necessárias estão presentes (seguindo padrão Baileys)
      if (!credentials.noiseKey || !credentials.noiseKey.public) {
        throw new Error('noiseKey não encontrado nas credenciais');
      }
      
      if (!credentials.signedIdentityKey || !credentials.signedIdentityKey.public) {
        throw new Error('signedIdentityKey não encontrado nas credenciais');
      }
      
      if (!credentials.advSecretKey) {
        throw new Error('advSecretKey não encontrado nas credenciais');
      }
      
      // Usa as chaves das credenciais Baileys (formato oficial)
      const noiseKeyB64 = Buffer.from(credentials.noiseKey.public).toString('base64');
      const identityKeyB64 = Buffer.from(credentials.signedIdentityKey.public).toString('base64');
      const advB64 = Buffer.from(credentials.advSecretKey).toString('base64');
      
      // Constrói QR code no formato exato do Baileys: [ref, noiseKeyB64, identityKeyB64, advB64].join(',')
      const qrString = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
      
      Logger.handshake('QR_GENERATION', 'QR code gerado no formato oficial Baileys');
      Logger.crypto('NOISE_KEY', `Usando noiseKey das credenciais: ${noiseKeyB64.substring(0, 20)}...`);
      
      return qrString;
      
    } catch (error) {
      Logger.error('Erro ao gerar dados do QR:', error);
      throw error;
    }
  }

  /**
   * Gera QR code como Data URL
   */
  public static async generateQRDataURL(qrData: string, options?: QRCode.QRCodeToDataURLOptions): Promise<string> {
    try {
      const dataURL = await QRCode.toDataURL(qrData, {
        type: 'image/png',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        ...options
      });
      Logger.info('QR code DataURL gerado com sucesso');
      return dataURL;
    } catch (error) {
      Logger.error('Erro ao gerar QR code DataURL:', error);
      throw error;
    }
  }

  /**
   * Gera QR code como SVG
   */
  public static async generateQRSVG(qrData: string, options?: QRCode.QRCodeToStringOptions): Promise<string> {
    try {
      const svg = await QRCode.toString(qrData, {
        type: 'svg',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        ...options
      });
      Logger.info('QR code SVG gerado com sucesso');
      return svg;
    } catch (error) {
      Logger.error('Erro ao gerar QR code SVG:', error);
      throw error;
    }
  }

  /**
   * Gera QR code como imagem base64
   */
  public static async generateQRImage(qrData: string, options?: QRCode.QRCodeToBufferOptions): Promise<string> {
    try {
      const buffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        ...options
      });
      const base64 = buffer.toString('base64');
      Logger.info('QR code imagem base64 gerada com sucesso');
      return base64;
    } catch (error) {
      Logger.error('Erro ao gerar QR code imagem:', error);
      throw error;
    }
  }
}