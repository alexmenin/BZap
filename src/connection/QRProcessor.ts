// QRProcessor.ts - Processador direto de QR codes seguindo padrão Baileys 100%

import { EventEmitter } from 'events';
import { binaryNodeToString } from '../protocol/WABinary/decode';

/**
 * Processador direto de QR codes seguindo exatamente o padrão Baileys
 * Esta classe processa diretamente os frames decodificados e gera QR codes
 */
export class QRProcessor extends EventEmitter {
  private authState: any;
  private sendNode: (node: any) => Promise<void>;

  constructor(authState: any, sendNode: (node: any) => Promise<void>) {
    super();
    this.authState = authState;
    this.sendNode = sendNode;
  }

  /**
   * Processa frame decodificado diretamente
   */
  public processFrame(frame: any): boolean {
    try {
      if (frame?.tag === 'iq' && frame?.attrs?.type === 'set') {
        const pairDeviceChild = this.getBinaryNodeChild(frame, 'pair-device');
        if (pairDeviceChild) {
          this.processarPairDevice(frame);
          return true;
        }
      }
      return false;
    } catch (error) {
      // Erro ao processar frame - silencioso para evitar spam
      return false;
    }
  }

  /**
   * Processa pair-device seguindo exatamente o padrão Baileys
   */
  private async processarPairDevice(stanza: any): Promise<void> {
    try {
      // Resposta IQ
      const response = {
        tag: 'iq',
        attrs: {
          to: stanza.attrs.from,
          type: 'result',
          id: stanza.attrs.id
        },
        content: []
      };
      
      await this.sendNode(response);
      
      // Processa refs
      const pairDeviceNode = this.getBinaryNodeChild(stanza, 'pair-device');
      const refNodes = this.getBinaryNodeChildren(pairDeviceNode, 'ref');
      
      if (refNodes.length === 0) {
        return;
      }
      
      // Prepara chaves
      const noiseKeyB64 = Buffer.from(this.authState.creds.noiseKey.public).toString('base64');
      const identityKeyB64 = Buffer.from(this.authState.creds.signedIdentityKey.public).toString('base64');
      const advB64 = Buffer.from(this.authState.creds.advSecretKey).toString('base64');
      
      // Processa cada ref
      for (let index = 0; index < refNodes.length; index++) {
        const refNode = refNodes[index];
        
        if (refNode.content.length === 0) {
          continue;
        }
        
        let ref: string;
        
        // Extrai ref
        if (Buffer.isBuffer(refNode.content)) {
          if (refNode.content.length === 16) {
            ref = refNode.content.toString('base64');
          } else {
            try {
              const hexString = refNode.content.toString('hex');
              const decoded = Buffer.from(hexString, 'hex').toString('base64');
              ref = decoded;
            } catch {
              ref = refNode.content.toString('base64');
            }
          }
        } else if (typeof refNode.content === 'string') {
          if (refNode.content.length === 32 && /^[0-9a-fA-F]+$/.test(refNode.content)) {
            ref = Buffer.from(refNode.content, 'hex').toString('base64');
          } else {
            ref = refNode.content;
          }
        } else {
          return;
        }
        
        // Constrói QR (formato oficial Baileys)
        const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
        
        console.log(`📱 QR CODE GERADO: ${qr}`);
        
        // Emite QR com status qrcode (padrão Baileys)
        this.emit('connection.update', { 
          qr,
          connection: 'connecting',
          qrIndex: index + 1,
          qrTotal: refNodes.length
        });
        
        // Aguarda antes do próximo QR
        if (index < refNodes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 20000));
        }
      }
      
    } catch (error) {
      console.error('❌ [QR_PROCESSOR] Erro no processamento:', error);
      console.error('❌ [QR_PROCESSOR] Stack:', error instanceof Error ? error.stack : 'Stack não disponível');
    }
  }

  /**
   * Busca nó filho específico
   */
  private getBinaryNodeChild(node: any, childTag: string): any {
    if (!node || !node.content || !Array.isArray(node.content)) {
      return null;
    }
    
    return node.content.find((child: any) => child && child.tag === childTag);
  }

  /**
   * Busca todos os nós filhos com tag específica
   */
  private getBinaryNodeChildren(node: any, childTag: string): any[] {
    if (!node || !node.content || !Array.isArray(node.content)) {
      return [];
    }
    
    return node.content.filter((child: any) => child && child.tag === childTag);
  }
}